const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const bcrypt = require('bcryptjs');
const { performance } = require('node:perf_hooks');
const { initDb, dbGet, dbRun } = require('./database/db');
const logger = require('./lib/logger');
const requestContext = require('./lib/request-context');
const monitoring = require('./lib/monitoring');
const securityConfig = require('./lib/security/config'); // WP-13 S2 — session/cookie config source
const { createLoginRateLimiter } = require('./lib/security/rate-limit'); // WP-13 S3 — login throttle (report-only by default)
const { createSecurityHeaders } = require('./lib/security/headers'); // WP-13 S5 — security headers + same-origin CORS (opt-in)
const securityEvents = require('./lib/security/events'); // WP-13 S7 — security event alignment (allow-listed metadata)

const app = express();
// WP-09 M5 — PORT is env-overridable (default 3000, identical when unset).
// Enables lifecycle testing on an ephemeral port and standard PaaS port injection.
const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 3000;

// WP-08 L2 — request correlation. Assign/echo X-Request-Id and run each request
// inside an AsyncLocalStorage context. This middleware ONLY establishes context
// and the response header; it does not log, time, or inspect auth (later commits).
app.use((req, res, next) => {
  const incoming = req.headers['x-request-id'];
  const requestId = incoming && String(incoming).trim() ? String(incoming).trim() : logger.generateRequestId();
  res.setHeader('X-Request-Id', requestId);
  requestContext.run(
    { requestId, actor: 'anonymous', tenantId: null, module: 'System', startTime: Date.now() },
    () => next()
  );
});

// WP-08 L3 — request/response lifecycle logging. Placed immediately after the
// correlation middleware so every log carries the request context. Emits
// HTTP_REQUEST_START / HTTP_REQUEST_COMPLETE / HTTP_REQUEST_ERROR through the
// existing logger only (redaction + schema validation + context are automatic).
// Never logs bodies; never throws; never touches the response.
// WP-09 M1: every monitoring route under /health (current and future — /health,
// /health/live, /health/ready, /health/metrics, …) skips request logging so
// probe traffic never floods the log stream.
const SKIP_LOG_PATHS = new Set(['/favicon.ico']);
function isSkippedLogPath(p) {
  return SKIP_LOG_PATHS.has(p) || p === '/health' || p.startsWith('/health/');
}
function isStaticAssetPath(p) {
  // Anything the static middleware serves (not an API route, not the SPA shell route)
  return !p.startsWith('/api/') && /\.[a-z0-9]+$/i.test(p);
}
app.use((req, res, next) => {
  try {
    const path0 = req.path || req.url || '';
    if (isSkippedLogPath(path0)) return next();

    // WP-09 M3 — served-request counter for /health/metrics (business traffic
    // only: monitoring probes and favicon are skipped above). Never throws.
    try { monitoring.incrementRequestsServed(); } catch { /* counter must never break requests */ }

    const start = performance.now();
    const ctx = requestContext.get() || {};

    // Static assets: skip logging on success; still log failures (>=400).
    const staticAsset = isStaticAssetPath(path0);

    if (!staticAsset) {
      logger.info('HTTP_REQUEST_START', {
        message: 'Incoming HTTP request',
        method: req.method,
        path: path0,
        query: Object.keys(req.query || {}).length ? Object.keys(req.query) : undefined, // key names only, never values
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        contentLength: req.headers['content-length'] ? Number(req.headers['content-length']) : 0,
      });
    }

    let completed = false;
    res.on('finish', () => {
      if (completed) return; // exactly one completion event
      completed = true;
      try {
        if (staticAsset && res.statusCode < 400) return; // successful static asset → skip
        const durationMs = Math.round(performance.now() - start);
        const responseBytes = Number(res.getHeader('content-length')) || 0;
        // finish fires outside the ALS context — re-enter the captured context so
        // the record keeps its requestId/actor/tenantId/module.
        requestContext.run(ctx, () => {
          logger.info('HTTP_REQUEST_COMPLETE', {
            message: 'HTTP request completed',
            statusCode: res.statusCode,
            durationMs,
            method: req.method,
            path: path0,
            responseBytes,
          });
        });
      } catch { /* logging must never affect the request */ }
    });

    req.__l3 = { start, ctx, path0 }; // handed to the error handler (L3 error event)
    next();
  } catch {
    next(); // middleware itself must never break request processing
  }
});

// Maximum practical body limit: Content Studio Training Manuals can embed many/large base64 images. A JSON
// body is parsed as a single string, so the hard ceiling is V8's max string length (~512 MiB); 500mb sits
// just under it — anything larger cannot be JSON-parsed regardless of this limit. (File uploads use multer.)
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb', parameterLimit: 1000000 }));
// WP-13 S5 — security headers + same-origin CORS. Mounted early so it applies to
// static assets and every route. All security headers are opt-in (off by default);
// CORS only acts on same-origin Origin requests, so default behaviour is unchanged.
app.use(createSecurityHeaders(securityConfig));
// WP-09 M1 — monitoring endpoints. Mounted BEFORE the static middleware and SPA
// catch-all so /health* always answers with truthful JSON, never index.html.
app.use('/health', require('./routes/monitoring'));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // Never cache the HTML shell, so new pages/menu items appear without a hard refresh
    // (JS/CSS are cache-busted via ?v=, so they can still cache normally)
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));
// WP-13 S2 — build express-session options from the security config (S1). With
// the default config this is byte-for-byte the previous behaviour: the same
// secret, resave/saveUninitialized, and cookie maxAge; `secure` defaults to
// false, which is identical to omitting it (express-session's default).
function buildSessionOptions(cfg, store) {
  return {
    store,
    secret: cfg.session.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000, secure: cfg.cookies.SECURE_COOKIES },
  };
}
// WP-13 S2 — enable Express "trust proxy" ONLY when explicitly configured;
// otherwise leave the app's default untouched.
function applyTrustProxy(appInstance, cfg) {
  if (cfg.proxy.TRUST_PROXY) appInstance.set('trust proxy', 1);
}
const sessionStore = new SQLiteStore({ db: 'sessions.db', dir: process.env.SESSION_DB_DIR || path.join(__dirname, 'database') });
applyTrustProxy(app, securityConfig);
app.use(session(buildSessionOptions(securityConfig, sessionStore)));

// WP-08 L5 — bind the authenticated USERNAME (never the session id) into the
// request context so every log record carries the real actor. Anticipated by L2
// ("future authentication middleware will update the context"). No behaviour change.
app.use((req, res, next) => {
  try {
    if (req.session && req.session.user && req.session.user.username) {
      requestContext.set('actor', String(req.session.user.username));
      // WP-14 A3 — expose resolved RBAC context for FUTURE authorization
      // middleware. These are NOT read by the logger (no new log fields) and no
      // route enforces them yet.
      const su = req.session.user;
      if (Array.isArray(su.roles)) requestContext.set('roles', su.roles);
      if (Array.isArray(su.permissions)) requestContext.set('permissions', su.permissions);
      // R3 — stamp the tenant into the request/audit context. The log schema requires
      // tenantId to be a string (or null), so store the id as a string.
      requestContext.set('tenantId', String(su.tenantId || 1));
    }
  } catch { /* context must never break requests */ }
  next();
});

// WP-14 A4 — report-only authorization context. Seeds an EMPTY authorization
// result for every request (evaluates no permissions). A future WP's route-level
// authorize() middleware will populate/consume it. This NEVER denies, mutates, or
// changes any response — it only initialises request-context.
app.use(require('./lib/auth/authorize').initAuthorizationContext);

// WP-08 L5 — auth & security event logging, derived from method+path+status at
// response time (no route changes, no bodies, no credentials, no session ids).
// Exactly ONE event per matching response; auth endpoints classify before the
// generic 401/403 rules so no duplicates are possible.
app.use((req, res, next) => {
  try {
    const ctx = requestContext.get() || {};
    res.on('finish', () => {
      try {
        const p = (req.originalUrl || req.url || '').split('?')[0];
        const s = res.statusCode;
        let event = null, level = 'info', message = '';
        if (req.method === 'POST' && p === '/api/auth/login') {
          if (s === 200) { event = 'AUTH_LOGIN_SUCCESS'; message = 'User logged in'; }
          else if (s === 401) { event = 'AUTH_LOGIN_FAILURE'; level = 'warn'; message = 'Login attempt failed'; }
        } else if (req.method === 'POST' && p === '/api/auth/logout') {
          event = 'AUTH_LOGOUT'; message = 'User logged out';
        } else if (req.method === 'POST' && p === '/api/auth/change-password') {
          if (s === 200) { event = 'AUTH_PASSWORD_CHANGE_SUCCESS'; message = 'Password changed'; }
          else { event = 'AUTH_PASSWORD_CHANGE_FAILURE'; level = 'warn'; message = 'Password change failed'; }
        } else if (s === 401) {
          event = 'SECURITY_UNAUTHENTICATED_ACCESS'; level = 'warn'; message = 'Unauthenticated access to protected resource';
        } else if (s === 403) {
          event = 'SECURITY_ACCESS_DENIED'; level = 'warn'; message = 'Access denied';
        }
        if (!event) return;
        // Prefer the live session username (login sets it during the handler,
        // AFTER the actor middleware ran). Username only — never the session id.
        const username = req.session && req.session.user && req.session.user.username;
        const emitCtx = username ? { ...ctx, actor: String(username) } : ctx;
        requestContext.run(emitCtx, () => {
          logger[level](event, { message, method: req.method, path: p, statusCode: s });
        });
      } catch { /* logging must never affect authentication */ }
    });
  } catch { /* never break the request */ }
  next();
});

// WP-09 M3 — admin-only runtime metrics. Mounted AFTER the session + actor
// middlewares (unlike the probe router above) so req.session is available for
// the admin check. The probe router has no /metrics route, so requests fall
// through to here; probes themselves never pay the session cost.
app.use('/health', require('./routes/monitoring').metricsRouter);

// Log any 5xx response so we can identify the failing route (WP-08 L4: structured,
// metadata only — the response body is never logged). Skipped when the global
// error handler already emitted HTTP_REQUEST_ERROR for this response, so a single
// failure never produces duplicate error records.
app.use((req, res, next) => {
  const orig = res.json.bind(res);
  res.json = function(body) {
    if (res.statusCode >= 500 && !res.locals.__l4ErrorLogged) {
      try {
        logger.error('APPLICATION_ERROR', {
          message: 'Application error',
          statusCode: res.statusCode,
          method: req.method,
          // originalUrl (path only): req.path is prefix-stripped inside mounted routers
          path: (req.originalUrl || req.url || '').split('?')[0],
        });
      } catch { /* logging must never break the response */ }
    }
    return orig(body);
  };
  next();
});

// WP-13 S3 — login rate limiter runs BEFORE the auth router, only for the login
// POST. Report-only by default (never blocks); calls next() into the real route.
app.post('/api/auth/login', createLoginRateLimiter(securityConfig));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/staff', require('./routes/staff'));
app.use('/api/certs', require('./routes/certs'));
app.use('/api/classes', require('./routes/classes'));
app.use('/api/register', require('./routes/register'));
app.use('/api/requirements', require('./routes/requirements'));
app.use('/api/lookup', require('./routes/lookup'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/users', require('./routes/users'));
app.use('/api/import', require('./routes/import'));
app.use('/api/exams', require('./routes/exams'));
app.use('/api/audit', require('./routes/audit'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/me', require('./routes/me'));
app.use('/api/files', require('./routes/files'));
app.use('/api/trainers', require('./routes/trainers'));
app.use('/api/roster', require('./routes/roster'));
app.use('/api/forms', require('./routes/forms'));
app.use('/api/workflows', require('./routes/workflows'));
app.use('/api/translator', require('./routes/translator'));
app.use('/api/content', require('./routes/content'));
app.use('/api/imagegen', require('./routes/imagegen'));   // Generate Image from Page Content
app.use('/api/tenants', require('./routes/tenants'));     // R3 — tenant administration (scoped slice)
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/competency', require('./routes/competency'));
app.use('/api/kb', require('./routes/knowledgebase'));
app.use('/api/ai', require('./routes/ai'));
app.use('/api/powerpoints', require('./routes/powerpoints'));
app.use('/api/onboarding', require('./routes/onboarding'));
app.use('/api/leave',      require('./routes/leave'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/equipment',  require('./routes/equipment'));
app.use('/api/assignment',   require('./routes/assignment'));
app.use('/api/disciplinary', require('./routes/disciplinary'));
// WP-24 · Phase 8 — Controlled Single Server Mount Integration (gated; a strict no-op unless DOCUMENT_ENGINE_ENABLED is set).
require('./lib/document-engine/server-mount-integration').mount(app);
app.get('*', (req, res) => { res.set('Cache-Control', 'no-cache, no-store, must-revalidate'); res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// Global error handler — returns JSON so the frontend shows a readable message
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // WP-08 L4 — the legacy console.error('[Error]', …) line is replaced by the
  // structured HTTP_REQUEST_ERROR below (added in L3). The flag prevents the 5xx
  // response hook from emitting a second APPLICATION_ERROR for the same failure.
  res.locals.__l4ErrorLogged = true;
  // WP-08 L3 — structured error event (redaction/schema/context via the logger).
  // Never includes stacks/bodies; masked message only. Must never throw.
  try {
    const l3 = req.__l3 || {};
    const ctx = l3.ctx || requestContext.get() || {};
    const durationMs = l3.start != null ? Math.round(performance.now() - l3.start) : 0;
    requestContext.run(ctx, () => {
      logger.error('HTTP_REQUEST_ERROR', {
        message: 'HTTP request failed',
        statusCode: res.headersSent ? res.statusCode : 500,
        durationMs,
        method: req.method,
        path: l3.path0 || req.path,
        errorName: err && err.name ? String(err.name) : 'Error',
        maskedErrorMessage: err && err.message ? String(err.message) : 'Internal server error',
      });
    });
  } catch { /* logging must never affect the response */ }
  if (res.headersSent) return;
  // WP-13 S7 — opt-in generic 5xx body. Default (flag off) preserves the exact
  // current response. When on, the global handler returns a generic message
  // (structured error metadata is still logged above). 4xx are unaffected — they
  // are produced by route handlers, never this global 5xx handler.
  const genericErrors = securityConfig.errors.GENERIC_ERROR_RESPONSES === true;
  res.status(500).json({ error: genericErrors ? 'Internal server error' : (err.message || 'Internal server error') });
});

// Seed the default admin if none exists. Extracted so the same seed logic can be
// reused by the automated test bootstrap against an isolated temporary database.
// Behaviour on normal startup is unchanged.
async function ensureAdminSeed() {
  const existing = await dbGet("SELECT COUNT(*) as n FROM tblPswd WHERE UserName='admin'");
  if (!existing || existing.n === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await dbRun("INSERT INTO tblPswd (UserName,Password,HashPass,Admin,UserStatus,DateChanged) VALUES ('admin','admin123',?,1,'Active',date('now'))", [hash]);
    console.log('Default admin created: admin / admin123');
  }
}

// WP-13 S4 — report-only default-admin detection. Checks whether the seeded
// `admin` account still uses the default credential and, if so, emits ONE
// structured advisory warning. It NEVER blocks startup, disables the account, or
// logs the password/hash. Fully fenced: any failure fails open (emits nothing,
// continues). Gated by config.admin.ENABLE_DEFAULT_ADMIN_WARNING (default true).
async function detectDefaultAdmin() {
  try {
    if (securityConfig.admin.ENABLE_DEFAULT_ADMIN_WARNING !== true) return; // disabled → emit nothing
    const row = await dbGet(
      "SELECT UserName, Password, HashPass FROM tblPswd WHERE UserName='admin' AND (DateDeleted IS NULL OR DateDeleted='') AND UserStatus='Active'"
    );
    if (!row) return;
    const DEFAULT = 'admin123';
    let isDefault = false;
    if (row.HashPass && row.HashPass !== '$2a$10$placeholder') {
      try { isDefault = bcrypt.compareSync(DEFAULT, row.HashPass); } catch { isDefault = false; }
    }
    if (!isDefault && typeof row.Password === 'string') isDefault = row.Password === DEFAULT;
    if (!isDefault) return;
    // WP-13 S7 — route through the security-events alignment layer (same event
    // name, module, and metadata; allow-list filtered).
    securityEvents.defaultCredential({
      username: 'admin',
      action: 'default_credential_detected',
      severity: 'high',
      recommendation: 'Change the default admin password immediately.',
    });
  } catch { /* detection must never affect startup — fail open, emit nothing */ }
}

async function start() {
  await initDb();
  console.log('Database initialized.');
  // WP-09 M5 — structured lifecycle event: database initialisation complete.
  try {
    requestContext.run({ module: 'Infrastructure' }, () =>
      logger.info('APP_STARTED', { message: 'Application started — database initialised' }));
  } catch { /* lifecycle logging must never affect startup */ }

  await ensureAdminSeed();
  await detectDefaultAdmin(); // WP-13 S4 — report-only advisory; never blocks startup

  // R7 — when CONFIG_SECRET is configured, encrypt any API key still stored as plaintext
  // in tblConfig. No-op (and no lock-out) when CONFIG_SECRET is unset. Never blocks startup.
  try {
    const { dbAll } = require('./database/db');
    const { encryptExistingSecrets, isSecretConfigured } = require('./lib/secret-config');
    const r = await encryptExistingSecrets(dbAll, dbRun);
    if (isSecretConfigured()) console.log(`Secret config: encrypted ${r.encrypted} plaintext key(s) at rest.`);
  } catch { /* never block startup on secret migration */ }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎓 TrainTrack running at http://localhost:${PORT}`);
    console.log('   Login: admin / admin123\n');
    // WP-09 M5 — structured lifecycle event: server accepting connections.
    try {
      requestContext.run({ module: 'Infrastructure' }, () =>
        logger.info('APP_READY', { message: 'Application ready and listening' }));
    } catch { /* lifecycle logging must never affect startup */ }
  });

  // Nightly reminder digest — checks hourly, sends once per day if enabled
  const mailer = require('./lib/mailer');
  let lastDigestDay = null;
  setInterval(async () => {
    try {
      const cfg = await mailer.getConfig();
      if (cfg.digest_enabled !== '1') return;
      const now = new Date();
      const today = now.toISOString().split('T')[0];
      if (now.getHours() === 6 && lastDigestDay !== today) {
        lastDigestDay = today;
        const r = await mailer.sendDigest();
        console.log('Digest:', JSON.stringify(r));
      }
    } catch (e) { /* digest errors shouldn't crash the server */ }
  }, 60 * 60 * 1000);

  // Workflow scheduled checks (training_expiring / training_expired) — shortly after boot, then daily
  const { runScheduledChecks } = require('./lib/workflow');
  setTimeout(async () => {
    try { const r = await runScheduledChecks(); if (r.expiring || r.expired) console.log('Workflow checks:', JSON.stringify(r)); } catch (e) {}
  }, 90 * 1000);
  setInterval(async () => {
    try { await runScheduledChecks(); } catch (e) {}
  }, 24 * 60 * 60 * 1000);
}

// Only auto-start when run directly (node server.js / npm start / nodemon).
// When imported by automated tests, the app is exported without listening on
// PORT, so tests can start it on an ephemeral port against a temporary database.
if (require.main === module) {
  start().catch(e => {
    // WP-08 L4 — structured startup error (name + masked message, no stack).
    // Termination behaviour and exit code are unchanged.
    try {
      logger.error('STARTUP_ERROR', {
        message: 'Application startup failed',
        errorName: e && e.name ? String(e.name) : 'Error',
        maskedErrorMessage: e && e.message ? String(e.message) : String(e),
      });
    } catch { /* logging must never block shutdown */ }
    process.exit(1);
  });
}

module.exports = { app, start, ensureAdminSeed, detectDefaultAdmin, buildSessionOptions, applyTrustProxy };
