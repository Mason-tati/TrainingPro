// WP-09 · M1 — Monitoring foundation (dependency-free, Node core only).
//
// Provides the health-summary and liveness snapshots served by
// routes/monitoring.js. No database, filesystem, AI, SMTP, network, timers,
// caches, or global mutable state — every call computes a fresh snapshot from
// the process itself. Output is a fixed, additive-only JSON shape containing no
// hostnames, versions, environment values, paths, or secrets.
'use strict';

// Process start time, derived (not stored) so the module holds no mutable state.
function startedAtIso() {
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

// Summary used by GET /health — liveness plus uptime context.
function getHealthSummary() {
  return {
    status: 'ok',
    uptimeSec: Math.round(process.uptime()),
    startedAt: startedAtIso(),
    timestamp: new Date().toISOString(),
  };
}

// Pure liveness used by GET /health/live — the process answers, nothing more.
function getLiveness() {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
  };
}

// ── WP-09 · M2 — readiness ────────────────────────────────────────────────
// Readiness = the app can do useful work NOW: the database answers a trivial
// query and the uploads storage path is accessible. Each check is individually
// try/catch fenced with a bounded timeout, so readiness can never throw or
// hang. Results are cached for a short TTL so probe storms cannot amplify DB
// load. The response exposes ONLY status words and a latency number — never
// paths, filenames, hostnames, connection strings, or config values.
const fs = require('node:fs');
const path = require('node:path');

const CHECK_TIMEOUT_MS = 1000;
const CACHE_TTL_MS = 5000;
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads'); // internal only — never emitted

let _cache = { at: 0, result: null };

// Race a promise against a bounded timeout (timer always cleared; never leaks).
function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('check timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Database: SELECT 1 through the existing helper. ok + latency, or down.
async function checkDatabase() {
  const t0 = Date.now();
  try {
    const { dbGet } = require('../database/db');
    await withTimeout(dbGet('SELECT 1 AS ok'), CHECK_TIMEOUT_MS);
    return { status: 'ok', latencyMs: Date.now() - t0 };
  } catch {
    return { status: 'down', latencyMs: Date.now() - t0 };
  }
}

// Storage: uploads directory exists and is writable. Path never disclosed.
async function checkStorage() {
  try {
    await withTimeout(fs.promises.access(UPLOADS_DIR, fs.constants.R_OK | fs.constants.W_OK), CHECK_TIMEOUT_MS);
    return { status: 'ok' };
  } catch {
    return { status: 'down' };
  }
}

// ── WP-09 · M4 — dependency status placeholders (informational only) ───────
// Configuration-PRESENCE checks: they never call the provider, never connect,
// never instantiate a client, and never read key/host VALUES into the result
// (SELECT 1 only). They report status words and do NOT gate readiness.

// AI provider: env key present, or a non-empty tblConfig api-key row exists.
async function checkAiProvider() {
  try {
    if (process.env.ANTHROPIC_API_KEY) return { status: 'configured' };
    const { dbGet } = require('../database/db');
    const row = await withTimeout(
      dbGet("SELECT 1 AS present FROM tblConfig WHERE ckey='anthropic_api_key' AND cvalue IS NOT NULL AND cvalue!=''"),
      CHECK_TIMEOUT_MS
    );
    return { status: row ? 'configured' : 'not-configured' };
  } catch {
    return { status: 'not-configured' };
  }
}

// SMTP: a non-empty smtp_host row exists in tblConfig. Host value never read.
async function checkSmtp() {
  try {
    const { dbGet } = require('../database/db');
    const row = await withTimeout(
      dbGet("SELECT 1 AS present FROM tblConfig WHERE ckey='smtp_host' AND cvalue IS NOT NULL AND cvalue!=''"),
      CHECK_TIMEOUT_MS
    );
    return { status: row ? 'configured' : 'not-configured' };
  } catch {
    return { status: 'not-configured' };
  }
}

// ── WP-09 · M5 — dependency state-transition events ────────────────────────
// Emitted ONLY when a gating check changes state (ok→down / down→ok) or when
// overall readiness transitions into not-ready — never per probe, so probe
// storms cannot spam the log stream. The first evaluation establishes a silent
// baseline. Metadata is limited to the check NAME and status word (no paths,
// hostnames, keys, config values, SQL or secrets). Module = Infrastructure.
const logger = require('./logger');
const requestContext = require('./request-context');

let _lastStatuses = null; // { database, storage, ready }

function emitInfra(level, event, fields) {
  try {
    const ctx = requestContext.get() || {};
    requestContext.run({ ...ctx, module: 'Infrastructure' }, () => logger[level](event, fields));
  } catch { /* monitoring events must never break readiness */ }
}

function recordTransitions(checks, ready) {
  try {
    if (_lastStatuses) {
      for (const name of ['database', 'storage']) {
        const prev = _lastStatuses[name];
        const curr = checks[name].status;
        if (prev === 'ok' && curr === 'down') {
          emitInfra('warn', 'MONITOR_DEPENDENCY_DEGRADED', { message: 'Dependency degraded', check: name, status: curr });
        } else if (prev === 'down' && curr === 'ok') {
          emitInfra('info', 'MONITOR_DEPENDENCY_RESTORED', { message: 'Dependency restored', check: name, status: curr });
        }
      }
      if (_lastStatuses.ready && !ready) {
        emitInfra('warn', 'MONITOR_READINESS_FAILED', { message: 'Readiness transitioned to not-ready' });
      }
    }
    _lastStatuses = { database: checks.database.status, storage: checks.storage.status, ready };
  } catch { /* never throw from transition tracking */ }
}

// Readiness snapshot (TTL-cached). Shape is stable and additive-only.
// M4: aiProvider and smtp are INFORMATIONAL placeholders — readiness gates on
// database + storage ONLY (AI/SMTP are optional capabilities; the core works
// without them, per Doc 06 principle 7).
async function getReadiness() {
  const now = Date.now();
  if (_cache.result && now - _cache.at < CACHE_TTL_MS) return _cache.result;
  const [database, storage, aiProvider, smtp] = await Promise.all([
    checkDatabase(), checkStorage(), checkAiProvider(), checkSmtp(),
  ]);
  const ready = database.status === 'ok' && storage.status === 'ok';
  const result = {
    status: ready ? 'ready' : 'not-ready',
    timestamp: new Date().toISOString(),
    checks: { database, storage, aiProvider, smtp },
  };
  recordTransitions(result.checks, ready); // M5 — state-change events only
  _cache = { at: now, result };
  return result;
}

// Test seam — deterministic cache reset (mirrors the logger's __ helpers).
function __clearReadinessCache() { _cache = { at: 0, result: null }; }

// ── WP-09 · M3 — runtime metrics ──────────────────────────────────────────
// Node-core process metrics for the admin-only /health/metrics endpoint.
// Numbers only (plus the node version string) — no environment variables,
// paths, hostnames, secrets, connection material, or PII.
const { monitorEventLoopDelay } = require('node:perf_hooks');

// Event-loop delay histogram — started once at module load; if unavailable on
// this runtime, metrics fall back to safe numeric defaults (0).
let _eld = null;
try { _eld = monitorEventLoopDelay({ resolution: 20 }); _eld.enable(); } catch { _eld = null; }

// Monotonic count of served business requests (incremented by the request-
// logging middleware for non-monitoring traffic; probes are not counted).
let _requestsServed = 0;
function incrementRequestsServed() { _requestsServed++; }

const toMB = (bytes) => Math.round((bytes / 1048576) * 10) / 10;
const safeNum = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

function getMetrics() {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    pid: process.pid,
    node: process.version,
    memory: {
      rssMB: safeNum(toMB(mem.rss)),
      heapUsedMB: safeNum(toMB(mem.heapUsed)),
      heapTotalMB: safeNum(toMB(mem.heapTotal)),
    },
    cpu: {
      userMs: safeNum(Math.round(cpu.user / 1000)),
      systemMs: safeNum(Math.round(cpu.system / 1000)),
    },
    eventLoopDelayMs: {
      mean: safeNum(_eld ? Math.round((_eld.mean / 1e6) * 100) / 100 : 0),
      max: safeNum(_eld ? Math.round((_eld.max / 1e6) * 100) / 100 : 0),
    },
    requestsServed: _requestsServed,
  };
}

module.exports = {
  getHealthSummary, getLiveness, getReadiness, __clearReadinessCache,
  getMetrics, incrementRequestsServed,
};
