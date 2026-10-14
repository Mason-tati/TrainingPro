// WP-19 · E5 — Enterprise Express Route Foundation tests.
// Verifies the isolated Express Router: it is an Express Router, exports only the router,
// registers exactly the 19 required routes with the exact verbs/paths, each handler delegates
// to the matching controller method, handlers never throw, imports only express + ./controller,
// and the router is unwired (never registered / never imported by production).
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const R = require(path.join(EDIR, 'routes.js'));
const controller = require(path.join(EDIR, 'controller.js'));

// verb+path → { ctrl: controller method, src: request field extractor (or null) }
const SPEC = [
  { method: 'post', path: '/', ctrl: 'create', src: (req) => req.body },
  { method: 'put', path: '/:id', ctrl: 'update', src: (req) => req.body },
  { method: 'delete', path: '/:id', ctrl: 'delete', src: (req) => req.params.id },
  { method: 'get', path: '/health', ctrl: 'health', src: null },
  { method: 'get', path: '/capabilities', ctrl: 'capabilities', src: null },
  { method: 'get', path: '/snapshot/:id', ctrl: 'snapshot', src: (req) => req.params.id },
  { method: 'get', path: '/', ctrl: 'list', src: (req) => req.query },
  { method: 'get', path: '/:id', ctrl: 'get', src: (req) => req.params.id },
  { method: 'post', path: '/search', ctrl: 'search', src: (req) => req.body },
  { method: 'post', path: '/validate', ctrl: 'validate', src: (req) => req.body },
  { method: 'post', path: '/clone', ctrl: 'clone', src: (req) => req.body },
  { method: 'post', path: '/archive', ctrl: 'archive', src: (req) => req.body },
  { method: 'post', path: '/restore', ctrl: 'restore', src: (req) => req.body },
  { method: 'post', path: '/version', ctrl: 'version', src: (req) => req.body },
  { method: 'post', path: '/approve', ctrl: 'approve', src: (req) => req.body },
  { method: 'post', path: '/review', ctrl: 'review', src: (req) => req.body },
  { method: 'post', path: '/access', ctrl: 'access', src: (req) => req.body },
  { method: 'post', path: '/storage', ctrl: 'storage', src: (req) => req.body },
  { method: 'post', path: '/compliance', ctrl: 'compliance', src: (req) => req.body },
];

function handlerFor(router, method, p) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === p && layer.route.methods[method]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  return null;
}
function invoke(handler, req) {
  let captured;
  const res = { json: (v) => { captured = v; return res; } };
  handler(req, res);
  return captured;
}
const mkReq = (body) => ({ body, params: { id: 'ID-1' }, query: { q: '1' } });

// ---------------------------------------------------------------------------
// router structure
// ---------------------------------------------------------------------------

test('E5-1. export is an Express Router (function with a route stack)', () => {
  assert.equal(typeof R, 'function');
  assert.ok(Array.isArray(R.stack));
  assert.ok(R.stack.length > 0);
});

test('E5-2. exports ONLY the router (the Express router itself, not a methods object)', () => {
  assert.equal(typeof R, 'function'); // the router function, not a plain object of named exports
  assert.ok(Array.isArray(R.stack)); // it is an Express router
  // controller methods are NOT re-exported on the router
  assert.equal(R.create, undefined);
  assert.equal(R.health, undefined);
  assert.equal(R.compliance, undefined);
});

test('E5-3. registers exactly 19 routes', () => {
  const routes = R.stack.filter((l) => l.route);
  assert.equal(routes.length, 19);
});

test('E5-4. every required route exists with the exact verb + path', () => {
  const present = new Set();
  for (const l of R.stack) {
    if (l.route) for (const m of Object.keys(l.route.methods)) if (l.route.methods[m]) present.add(`${m} ${l.route.path}`);
  }
  const expected = SPEC.map((s) => `${s.method} ${s.path}`);
  assert.deepEqual([...present].sort(), expected.slice().sort());
});

test('E5-5. specific GET paths are registered BEFORE the parameterized GET /:id', () => {
  const order = R.stack.filter((l) => l.route && l.route.methods.get).map((l) => l.route.path);
  assert.ok(order.indexOf('/health') < order.indexOf('/:id'), '/health before /:id');
  assert.ok(order.indexOf('/capabilities') < order.indexOf('/:id'), '/capabilities before /:id');
});

// ---------------------------------------------------------------------------
// delegation (invoking each handler covers it)
// ---------------------------------------------------------------------------

test('E5-6. POST / delegates to controller.create', () => {
  const body = { title: 'T' };
  assert.deepEqual(invoke(handlerFor(R, 'post', '/'), mkReq(body)), controller.create(body));
});

test('E5-7. PUT /:id delegates to controller.update', () => {
  const body = { a: 1 };
  assert.deepEqual(invoke(handlerFor(R, 'put', '/:id'), mkReq(body)), controller.update(body));
});

test('E5-8. DELETE /:id delegates to controller.delete (via req.params.id)', () => {
  const req = mkReq({});
  assert.deepEqual(invoke(handlerFor(R, 'delete', '/:id'), req), controller.delete(req.params.id));
});

test('E5-9. GET /:id delegates to controller.get (via req.params.id)', () => {
  const req = mkReq({});
  assert.deepEqual(invoke(handlerFor(R, 'get', '/:id'), req), controller.get(req.params.id));
});

test('E5-10. GET / delegates to controller.list (via req.query)', () => {
  const req = mkReq({});
  assert.deepEqual(invoke(handlerFor(R, 'get', '/'), req), controller.list(req.query));
});

test('E5-11. GET /snapshot/:id delegates to controller.snapshot (via req.params.id)', () => {
  const req = mkReq({});
  assert.deepEqual(invoke(handlerFor(R, 'get', '/snapshot/:id'), req), controller.snapshot(req.params.id));
});

test('E5-12. POST /search / /validate / /clone delegate', () => {
  const body = { title: 'X' };
  assert.deepEqual(invoke(handlerFor(R, 'post', '/search'), mkReq(body)), controller.search(body));
  assert.deepEqual(invoke(handlerFor(R, 'post', '/validate'), mkReq(body)), controller.validate(body));
  assert.deepEqual(invoke(handlerFor(R, 'post', '/clone'), mkReq(body)), controller.clone(body));
});

test('E5-13. POST /archive / /restore delegate', () => {
  const body = { a: 1 };
  const archived = invoke(handlerFor(R, 'post', '/archive'), mkReq(body));
  assert.deepEqual(archived, controller.archive(body));
  assert.ok(Object.isFrozen(archived)); // archive → freeze delegation preserved through the route
  assert.deepEqual(invoke(handlerFor(R, 'post', '/restore'), mkReq(body)), controller.restore(body));
});

test('E5-14. POST /version / /approve / /review delegate', () => {
  assert.deepEqual(invoke(handlerFor(R, 'post', '/version'), mkReq({ scheme: 'SEMANTIC', major: 1 })), controller.version({ scheme: 'SEMANTIC', major: 1 }));
  assert.deepEqual(invoke(handlerFor(R, 'post', '/approve'), mkReq({ workflow: 'NONE' })), controller.approve({ workflow: 'NONE' }));
  assert.deepEqual(invoke(handlerFor(R, 'post', '/review'), mkReq({ workflow: 'NONE' })), controller.review({ workflow: 'NONE' }));
});

test('E5-15. POST /access / /storage / /compliance delegate', () => {
  assert.deepEqual(invoke(handlerFor(R, 'post', '/access'), mkReq({ accessType: 'REVIEWER', permissions: ['read'] })), controller.access({ accessType: 'REVIEWER', permissions: ['read'] }));
  assert.deepEqual(invoke(handlerFor(R, 'post', '/storage'), mkReq({ storageType: 'LOCAL_PRIVATE' })), controller.storage({ storageType: 'LOCAL_PRIVATE' }));
  assert.deepEqual(invoke(handlerFor(R, 'post', '/compliance'), mkReq({ framework: 'ISO9001' })), controller.compliance({ framework: 'ISO9001' }));
});

test('E5-16. GET /health delegates to controller.health', () => {
  const h = invoke(handlerFor(R, 'get', '/health'), mkReq({}));
  assert.deepEqual(h, controller.health());
  assert.equal(h.healthy, true);
});

test('E5-17. GET /capabilities delegates to controller.capabilities', () => {
  const caps = invoke(handlerFor(R, 'get', '/capabilities'), mkReq({}));
  assert.deepEqual(caps, controller.capabilities());
  assert.equal(caps.length, 16);
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E5-18. deterministic + never throws: every handler tolerates Express-shaped hostile requests', () => {
  const bodies = [undefined, null, 5, 'x', {}, [], { title: {} }];
  for (const s of SPEC) {
    const h = handlerFor(R, s.method, s.path);
    assert.ok(typeof h === 'function', `${s.method} ${s.path} handler`);
    for (const body of bodies) {
      const req = { body, params: { id: undefined }, query: {} };
      let out;
      try { out = invoke(h, req); } catch (e) { assert.fail(`${s.method} ${s.path} threw: ${e && e.message}`); }
      // deterministic: same request → same delegated output
      const again = invoke(h, req);
      assert.deepEqual(again, out);
    }
  }
});

test('E5-19. routes.js imports ONLY express + ./controller', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/)/;
  const src = fs.readFileSync(path.join(EDIR, 'routes.js'), 'utf8');
  assert.ok(!FORBIDDEN.test(src), 'no forbidden production import');
  const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
  assert.equal(requires.length, 2, 'exactly two requires');
  const targets = requires.map((r) => r.replace(/require\((['"])(.*?)\1\)/, '$2')).sort();
  assert.deepEqual(targets, ['./controller', 'express']);
  // no listener / server wiring in the source
  assert.ok(!/\b(createServer|\.listen\()/.test(src), 'no server/listen wiring');
});

test('E5-20. router is UNWIRED: not registered, and no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f)); // top-level lib only
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!src.replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
