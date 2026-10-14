// WP-08 · L2 — request-context (AsyncLocalStorage) unit tests + logger integration.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const rc = require(path.join(__dirname, '..', '..', 'lib', 'request-context.js'));
const logger = require(path.join(__dirname, '..', '..', 'lib', 'logger.js'));

afterEach(() => logger.__resetSink());

test('accessors return null outside any context', () => {
  assert.equal(rc.get(), null);
  assert.equal(rc.getRequestId(), null);
  assert.equal(rc.getActor(), null);
  assert.equal(rc.getTenantId(), null);
  assert.equal(rc.getModule(), null);
});

test('run() binds context and accessors read it', () => {
  rc.run({ requestId: 'req-1', actor: 'anonymous', tenantId: null, module: 'System', startTime: 1 }, () => {
    assert.equal(rc.getRequestId(), 'req-1');
    assert.equal(rc.getActor(), 'anonymous');
    assert.equal(rc.getTenantId(), null);
    assert.equal(rc.getModule(), 'System');
    assert.deepEqual(rc.get().startTime, 1);
  });
});

test('set() updates the current context only', () => {
  rc.run({ requestId: 'req-2', actor: 'anonymous', tenantId: null, module: 'System' }, () => {
    rc.set('actor', 'admin');
    rc.set('tenantId', 'tenant-9');
    assert.equal(rc.getActor(), 'admin');
    assert.equal(rc.getTenantId(), 'tenant-9');
  });
  assert.equal(rc.get(), null, 'context does not leak after run()');
});

test('4. nested async operations retain the same request id', async () => {
  await rc.run({ requestId: 'req-async', module: 'System' }, async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(rc.getRequestId(), 'req-async', 'id preserved across awaits');
    await (async () => { assert.equal(rc.getRequestId(), 'req-async'); })();
  });
});

test('5. parallel contexts are isolated', async () => {
  const seen = await Promise.all([
    rc.run({ requestId: 'A' }, async () => { await new Promise((r) => setTimeout(r, 5)); return rc.getRequestId(); }),
    rc.run({ requestId: 'B' }, async () => { await new Promise((r) => setTimeout(r, 2)); return rc.getRequestId(); }),
  ]);
  assert.deepEqual(seen, ['A', 'B']);
});

test('6. logger automatically reads AsyncLocalStorage values', () => {
  const rows = [];
  logger.__setSink((rec) => rows.push(rec));
  rc.run({ requestId: 'req-log', actor: 'admin', tenantId: 't1', module: 'Workforce' }, () => {
    logger.info('some.event', { extra: 1 });
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].requestId, 'req-log');
  assert.equal(rows[0].actor, 'admin');
  assert.equal(rows[0].tenantId, 't1');
  assert.equal(rows[0].module, 'Workforce');
  assert.equal(rows[0].metadata.extra, 1);
});

test('7. logger falls back to L1 defaults outside HTTP context', () => {
  const rows = [];
  logger.__setSink((rec) => rows.push(rec));
  logger.info('no.context', { a: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].requestId, null, 'requestId is null (schema default) when no context');
  assert.equal(rows[0].actor, 'anonymous', 'actor defaults to anonymous when no context');
  assert.equal(rows[0].module, 'System', 'module defaults to System when no context');
  assert.equal(rows[0].metadata.a, 1);
});
