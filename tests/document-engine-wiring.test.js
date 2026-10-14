// WP-21 · Phase 1 — Enterprise Document Engine Persistence Composition Root tests.
// Verifies the wiring composition root: exact export surface; flag-derived disabled state; the
// shared DB handle is obtained via database/db.js getDb() (never a new sqlite connection); fresh
// repository/service/composition graphs via dependency injection; construction degrades safely to
// null when the DB is unavailable; health/capabilities/status; never throws under hostile inputs;
// no database writes during construction; import whitelist; and the unwired guarantee.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const W = require(path.join(EDIR, 'wiring.js'));
const featureFlag = require(path.join(EDIR, 'feature-flag.js'));

const REPO_KEYS = [
  'documentRepository', 'versionRepository', 'metadataRepository', 'relationshipRepository',
  'approvalRepository', 'distributionRepository', 'accessRepository', 'notificationRepository',
  'validationRepository', 'complianceRepository', 'searchRepository',
];
const SERVICE_KEYS = [
  'documentService', 'versionService', 'metadataService', 'relationshipService', 'approvalService',
  'distributionService', 'accessService', 'notificationService', 'validationService',
  'complianceService', 'searchService',
];

// A minimal fake sqlite connection satisfying BaseRepository's contract (run/get/all functions).
// Records call counts so tests can prove construction performs NO database access.
function makeFakeDb() {
  const calls = { run: 0, get: 0, all: 0 };
  return {
    calls,
    run() { calls.run += 1; },
    get() { calls.get += 1; },
    all() { calls.all += 1; },
  };
}
const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };

// ---------------------------------------------------------------------------
// export surface
// ---------------------------------------------------------------------------

test('P1-1. export surface is exact (eight functions)', () => {
  assert.deepEqual(Object.keys(W).sort(), [
    'capabilities', 'createComposition', 'createRepositories', 'createServices',
    'getDatabaseConnection', 'getStatus', 'health', 'isWiringEnabled',
  ]);
});

test('P1-2. every export is a function', () => {
  for (const k of Object.keys(W)) assert.equal(typeof W[k], 'function', `${k} is a function`);
});

// ---------------------------------------------------------------------------
// feature flag (OFF)
// ---------------------------------------------------------------------------

test('P1-3. isWiringEnabled derives from feature-flag.isEnabled() and is false', () => {
  assert.equal(W.isWiringEnabled(), false);
  assert.equal(W.isWiringEnabled(), featureFlag.isEnabled());
});

test('P1-4. feature flag remains OFF after exercising the whole module', () => {
  W.createComposition();
  W.createServices();
  W.createRepositories();
  W.health();
  assert.equal(featureFlag.isEnabled(), false);
  assert.equal(W.isWiringEnabled(), false);
});

// ---------------------------------------------------------------------------
// database connection
// ---------------------------------------------------------------------------

test('P1-5. getDatabaseConnection never throws and returns null when DB not initialised', () => {
  let conn;
  noThrow(() => { conn = W.getDatabaseConnection(); }, 'getDatabaseConnection');
  // In the isolated test process the app DB is not initialised, so getDb() throws → null.
  assert.equal(conn, null);
});

test('P1-6. getDatabaseConnection uses database/db.js (no new sqlite connection created)', () => {
  const src = fs.readFileSync(path.join(EDIR, 'wiring.js'), 'utf8');
  assert.ok(!/require\(['"]sqlite3['"]\)/.test(src), 'does not import sqlite3');
  assert.ok(!/new\s+sqlite3/.test(src), 'does not construct a sqlite3 database');
  assert.ok(/require\(['"]\.\.\/\.\.\/database\/db['"]\)/.test(src), 'imports ../../database/db');
  assert.ok(/\.getDb\(\)/.test(src), 'uses getDb()');
  assert.ok(!/\binitDb\b/.test(src), 'never calls initDb (no migrations)');
});

// ---------------------------------------------------------------------------
// createRepositories
// ---------------------------------------------------------------------------

test('P1-7. createRepositories(fakeDb) builds all 11 repositories via DI', () => {
  const repos = W.createRepositories(makeFakeDb());
  assert.deepEqual(Object.keys(repos).sort(), REPO_KEYS.slice().sort());
  for (const k of REPO_KEYS) {
    assert.ok(repos[k] && typeof repos[k] === 'object', `${k} constructed`);
  }
});

test('P1-8. createRepositories() with no DB degrades safely to null repositories (never throws)', () => {
  let repos;
  noThrow(() => { repos = W.createRepositories(); }, 'createRepositories()');
  assert.deepEqual(Object.keys(repos).sort(), REPO_KEYS.slice().sort());
  for (const k of REPO_KEYS) assert.equal(repos[k], null, `${k} is null when DB unavailable`);
});

test('P1-9. createRepositories returns a FRESH object with fresh instances every call', () => {
  const db = makeFakeDb();
  const a = W.createRepositories(db);
  const b = W.createRepositories(db);
  assert.notEqual(a, b);
  assert.notEqual(a.documentRepository, b.documentRepository);
});

test('P1-10. createRepositories injects the provided db into the repositories (DI)', () => {
  const db = makeFakeDb();
  const repos = W.createRepositories(db);
  assert.equal(repos.documentRepository.db, db, 'repository holds the injected connection');
});

// ---------------------------------------------------------------------------
// createServices
// ---------------------------------------------------------------------------

test('P1-11. createServices(repos) builds all 11 services via DI', () => {
  const services = W.createServices(W.createRepositories(makeFakeDb()));
  assert.deepEqual(Object.keys(services).sort(), SERVICE_KEYS.slice().sort());
  for (const k of SERVICE_KEYS) assert.ok(services[k] && typeof services[k] === 'object', `${k} constructed`);
});

test('P1-12. createServices() with no repos degrades safely (never throws, null services)', () => {
  let services;
  noThrow(() => { services = W.createServices(); }, 'createServices()');
  assert.deepEqual(Object.keys(services).sort(), SERVICE_KEYS.slice().sort());
  for (const k of SERVICE_KEYS) assert.equal(services[k], null, `${k} is null when repos unavailable`);
});

test('P1-13. createServices tolerates hostile repos argument (null → null services, no throw)', () => {
  let services;
  noThrow(() => { services = W.createServices(null); }, 'createServices(null)');
  for (const k of SERVICE_KEYS) assert.equal(services[k], null);
});

test('P1-14. createServices returns a FRESH object with fresh instances every call', () => {
  const repos = W.createRepositories(makeFakeDb());
  const a = W.createServices(repos);
  const b = W.createServices(repos);
  assert.notEqual(a, b);
  assert.notEqual(a.documentService, b.documentService);
});

test('P1-15. createServices injects the repository into the service (DI)', () => {
  const repos = W.createRepositories(makeFakeDb());
  const services = W.createServices(repos);
  assert.equal(services.documentService.repository, repos.documentRepository, 'service holds injected repository');
});

// ---------------------------------------------------------------------------
// createComposition
// ---------------------------------------------------------------------------

test('P1-16. createComposition returns the expected graph shape', () => {
  const c = W.createComposition();
  assert.deepEqual(Object.keys(c).sort(), ['db', 'enabled', 'repositories', 'services', 'status']);
  assert.equal(c.enabled, false);
  assert.deepEqual(c.status, { wired: false, production: false, mode: 'FOUNDATION' });
  assert.deepEqual(Object.keys(c.repositories).sort(), REPO_KEYS.slice().sort());
  assert.deepEqual(Object.keys(c.services).sort(), SERVICE_KEYS.slice().sort());
});

test('P1-17. createComposition({db}) injects the connection through repositories and services', () => {
  const db = makeFakeDb();
  const c = W.createComposition({ db });
  assert.equal(c.db, db);
  assert.equal(c.enabled, false);
  assert.ok(c.repositories.documentRepository, 'repositories built from injected db');
  assert.equal(c.repositories.documentRepository.db, db);
  assert.ok(c.services.documentService, 'services built from those repositories');
});

test('P1-18. createComposition returns a FRESH graph every call', () => {
  const db = makeFakeDb();
  const a = W.createComposition({ db });
  const b = W.createComposition({ db });
  assert.notEqual(a, b);
  assert.notEqual(a.repositories, b.repositories);
  assert.notEqual(a.status, b.status);
});

test('P1-19. createComposition performs NO database access during construction', () => {
  const db = makeFakeDb();
  W.createComposition({ db });
  assert.deepEqual(db.calls, { run: 0, get: 0, all: 0 }, 'no run/get/all invoked while wiring');
});

// ---------------------------------------------------------------------------
// health / capabilities / status
// ---------------------------------------------------------------------------

test('P1-20. health returns the expected descriptor + fresh copy', () => {
  assert.deepEqual(W.health(), {
    ready: true, enabled: false, databaseAvailable: true, repositoriesAvailable: true, servicesAvailable: true,
  });
  const a = W.health();
  const b = W.health();
  assert.notEqual(a, b);
  a.ready = false;
  assert.equal(W.health().ready, true);
});

test('P1-21. capabilities returns four fresh entries (copy-on-read)', () => {
  const caps = W.capabilities();
  assert.deepEqual(caps.map((c) => c.name), [
    'database-connection', 'repositories', 'services', 'feature-flag-disabled',
  ]);
  assert.ok(caps.every((c) => c.available === true));
  const a = W.capabilities();
  const b = W.capabilities();
  assert.notEqual(a, b);
  assert.notEqual(a[0], b[0]);
  a[0].available = false;
  assert.equal(W.capabilities()[0].available, true);
});

test('P1-22. getStatus returns the expected status + fresh copy', () => {
  assert.deepEqual(W.getStatus(), { enabled: false, wired: false, production: false, mode: 'FOUNDATION' });
  const a = W.getStatus();
  const b = W.getStatus();
  assert.notEqual(a, b);
  a.mode = 'HACKED';
  assert.equal(W.getStatus().mode, 'FOUNDATION');
});

// ---------------------------------------------------------------------------
// robustness: never throws under hostile inputs
// ---------------------------------------------------------------------------

test('P1-23. every export tolerates hostile arguments without throwing', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], Object.freeze({ a: 1 }), Object.freeze([1]), () => {}];
  for (const h of hostile) {
    noThrow(() => W.isWiringEnabled(h), 'isWiringEnabled');
    noThrow(() => W.getDatabaseConnection(h), 'getDatabaseConnection');
    noThrow(() => W.createRepositories(h), 'createRepositories');
    noThrow(() => W.createServices(h), 'createServices');
    noThrow(() => W.createComposition(h), 'createComposition');
    noThrow(() => W.health(h), 'health');
    noThrow(() => W.capabilities(h), 'capabilities');
    noThrow(() => W.getStatus(h), 'getStatus');
  }
});

test('P1-24. createComposition with hostile options falls back to the shared connection safely', () => {
  for (const h of [null, 5, 'x', [], true]) {
    const c = W.createComposition(h);
    assert.equal(c.enabled, false);
    assert.deepEqual(c.status, { wired: false, production: false, mode: 'FOUNDATION' });
    assert.deepEqual(Object.keys(c.repositories).sort(), REPO_KEYS.slice().sort());
  }
});

// ---------------------------------------------------------------------------
// import discipline + unwired
// ---------------------------------------------------------------------------

test('P1-25. wiring.js imports ONLY the allowed modules (flag, db, 11 repos, 11 services)', () => {
  const src = fs.readFileSync(path.join(EDIR, 'wiring.js'), 'utf8');
  const targets = (src.match(/require\((['"])(.*?)\1\)/g) || [])
    .map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  const expected = [
    './runtime-feature-flag', '../../database/db',
    ...REPO_KEYS.map((k) => `./repositories/${k.replace(/Repository$/, '')}-repository`),
    ...SERVICE_KEYS.map((k) => `./services/${k.replace(/Service$/, '')}-service`),
  ].sort();
  assert.deepEqual(targets, expected);
  assert.equal(targets.length, 24);
  // forbidden production surfaces
  assert.ok(!/require\(['"]express['"]\)/.test(src), 'no express');
  assert.ok(!/require\(['"]sqlite3['"]\)/.test(src), 'no sqlite3');
  assert.ok(!/require\(['"][^'"]*(\/routes\/|\/server\b|\/app\b|\/controllers?\/|\/middleware\/)[^'"]*['"]\)/.test(src), 'no routes/server/app/controller/middleware');
  assert.ok(!/\bapp\.use\(|\.listen\(|createServer|express\.Router\(/.test(src), 'no server/mount wiring');
});

test('P1-26. wiring is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
