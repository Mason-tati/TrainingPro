// WP-08 · L1/L2.5 — Structured logger unit tests (deterministic, no wiring).
// Records now conform to the enterprise schema: fixed envelope + redacted metadata.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const logger = require(path.join(__dirname, '..', '..', 'lib', 'logger.js'));

let captured;
let restoreSink;
let restoreClock;
let restoreLevel;

beforeEach(() => {
  captured = [];
  restoreSink = logger.__setSink((rec) => captured.push(rec));
  restoreClock = logger.__setClock(() => '2026-01-01T00:00:00.000Z');
  restoreLevel = logger.__setLevel('debug');
});
afterEach(() => {
  logger.__setSink(restoreSink);
  logger.__setClock(restoreClock);
  logger.__setLevel(restoreLevel);
});

test('emits an enterprise-schema record with envelope + metadata', () => {
  logger.info('http.response', { reqId: 'r1', status: 200, durMs: 5 });
  assert.equal(captured.length, 1);
  const rec = captured[0];
  assert.equal(rec.schemaVersion, 1);
  assert.equal(rec.timestamp, '2026-01-01T00:00:00.000Z');
  assert.equal(rec.level, 'INFO');
  assert.equal(rec.event, 'http.response');
  assert.equal(rec.message, '');
  assert.equal(rec.module, 'System');
  assert.equal(rec.requestId, null);
  assert.equal(rec.tenantId, null);
  assert.equal(rec.actor, 'anonymous');
  assert.equal(typeof rec.pid, 'number');
  assert.equal(typeof rec.host, 'string');
  // caller fields land in metadata
  assert.equal(rec.metadata.reqId, 'r1');
  assert.equal(rec.metadata.status, 200);
});

test('a string second argument becomes the message', () => {
  logger.info('note', 'hello world');
  assert.equal(captured[0].message, 'hello world');
  assert.deepEqual(captured[0].metadata, {});
});

test('fields.message becomes the top-level message', () => {
  logger.info('note', { message: 'a message', other: 1 });
  assert.equal(captured[0].message, 'a message');
  assert.equal(captured[0].metadata.other, 1);
});

test('level gating suppresses lower-priority records (fatal is most severe)', () => {
  logger.__setLevel('warn');
  logger.info('x'); logger.debug('y'); logger.warn('z'); logger.error('e'); logger.fatal('f');
  assert.deepEqual(captured.map((r) => r.event), ['z', 'e', 'f']);
  assert.deepEqual(captured.map((r) => r.level), ['WARN', 'ERROR', 'FATAL']);
});

test('silent level suppresses everything', () => {
  logger.__setLevel('silent');
  logger.error('e'); logger.info('i'); logger.fatal('f');
  assert.equal(captured.length, 0);
});

test('format() produces valid JSON for the default transport', () => {
  logger.info('evt', { a: 1 });
  const parsed = JSON.parse(logger.format(captured[0]));
  assert.equal(parsed.event, 'evt');
  assert.equal(parsed.metadata.a, 1);
});

test('redaction removes all deny-listed keys in metadata (nested + arrays)', () => {
  logger.info('auth', {
    keep: 'ok',
    password: 'hunter2', HashPass: '$2a$10$abc', cookie: 'sid=abc',
    authorization: 'Bearer xyz', anthropic_api_key: 'sk-ant-123', token: 'abc.def',
    prompt: 'secret', completion: 'out',
    nested: { DOB: '1990-01-01', SS: '123-45-6789', medical: 'notes' },
    list: [{ password: 'p' }, { ok: 'kept' }],
  });
  const m = captured[0].metadata;
  assert.equal(m.keep, 'ok');
  for (const k of ['password', 'HashPass', 'cookie', 'authorization', 'anthropic_api_key', 'token', 'prompt', 'completion']) {
    assert.equal(m[k], '[REDACTED]', `${k} redacted`);
  }
  assert.equal(m.nested.DOB, '[REDACTED]');
  assert.equal(m.nested.SS, '[REDACTED]');
  assert.equal(m.nested.medical, '[REDACTED]');
  assert.equal(m.list[0].password, '[REDACTED]');
  assert.equal(m.list[1].ok, 'kept');
});

test('redaction masks sensitive value patterns in metadata free text', () => {
  logger.info('msg', {
    text: 'email a.person@example.com key sk-abcdEFGH12345 and Bearer supersecrettoken',
    phone: 'call 0412345678 now',
  });
  const m = captured[0].metadata;
  assert.ok(!/a\.person@example\.com/.test(m.text), 'email masked');
  assert.ok(m.text.includes('a***@example.com'));
  assert.ok(m.text.includes('[REDACTED]'), 'api key / bearer masked');
  assert.ok(!/0412345678/.test(m.phone), 'digit run masked');
});

test('long strings in metadata are truncated', () => {
  logger.info('big', { blob: 'x'.repeat(1200) });
  assert.ok(captured[0].metadata.blob.length < 600);
  assert.ok(captured[0].metadata.blob.includes('truncated'));
});

test('Error objects are logged as name + masked message only', () => {
  logger.error('http.error', { err: new Error('failed for a.person@example.com') });
  const m = captured[0].metadata;
  assert.equal(m.err.name, 'Error');
  assert.ok(m.err.message.includes('a***@example.com'));
  assert.equal(m.err.stack, undefined);
});

test('circular references do not throw', () => {
  const o = { a: 1 }; o.self = o;
  logger.info('cyc', { o });
  assert.equal(captured[0].metadata.o.a, 1);
  assert.equal(captured[0].metadata.o.self, '[Circular]');
});

test('every logger method produces a schema-valid record', () => {
  const { validateLogRecord } = require(path.join(__dirname, '..', '..', 'lib', 'log-schema.js'));
  for (const method of ['debug', 'info', 'warn', 'error', 'fatal']) {
    captured.length = 0;
    logger[method]('some.event', { a: 1 });
    const res = validateLogRecord(captured[0]);
    assert.equal(res.valid, true, `${method} produced valid schema: ${res.errors.join(',')}`);
  }
});
