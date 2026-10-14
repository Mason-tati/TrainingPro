// WP-08 · L6 — AI / DB logging boundary placeholder tests.
// aiEvent (module=AI) and dbError (module=Infrastructure) use strict allow-lists:
// forbidden content (prompts, AI text, SQL, params, connection strings) is
// discarded by construction; the normal redaction + schema pipeline then applies.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const logger = require(path.join(__dirname, '..', '..', 'lib', 'logger.js'));
const { validateLogRecord } = require(path.join(__dirname, '..', '..', 'lib', 'log-schema.js'));

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

// 1/2/3. aiEvent: valid schema, module AI, allowed metadata preserved.
test('1-3. aiEvent emits schema-valid AI-module record with allowed metadata', () => {
  logger.aiEvent('AI_CALL', {
    provider: 'anthropic', model: 'claude-sonnet-4-6', agent: 'AI-DOC-001',
    operation: 'content-generate', inputTokens: 1200, outputTokens: 800,
    totalTokens: 2000, costUsd: 0.0342, status: 'ok', decisionStatus: 'draft',
    approvedBy: null, durationMs: 5120,
  });
  assert.equal(captured.length, 1);
  const rec = captured[0];
  assert.equal(validateLogRecord(rec).valid, true, 'schema-valid');
  assert.equal(rec.module, 'AI', 'module defaults to AI');
  assert.equal(rec.level, 'INFO');
  assert.equal(rec.message, 'AI event');
  assert.equal(rec.metadata.provider, 'anthropic');
  assert.equal(rec.metadata.model, 'claude-sonnet-4-6');
  assert.equal(rec.metadata.inputTokens, 1200);
  assert.equal(rec.metadata.costUsd, 0.0342);
  assert.equal(rec.metadata.decisionStatus, 'draft');
  assert.equal(rec.metadata.durationMs, 5120);
});

// 4. aiEvent discards every forbidden AI content field.
test('4. aiEvent discards prompt/completion/aiInput/aiOutput/rawResponse/documentText', () => {
  logger.aiEvent('AI_CALL', {
    model: 'claude-sonnet-4-6',
    prompt: 'SECRET PROMPT TEXT',
    completion: 'MODEL OUTPUT TEXT',
    aiInput: 'input text',
    aiOutput: 'output text',
    rawResponse: '{"secret":"payload"}',
    documentText: 'entire confidential document',
    unlistedField: 'also dropped',
  });
  const rec = captured[0];
  for (const k of ['prompt', 'completion', 'aiInput', 'aiOutput', 'rawResponse', 'documentText', 'unlistedField']) {
    assert.ok(!(k in rec.metadata), `${k} discarded`);
  }
  const s = JSON.stringify(rec);
  assert.ok(!s.includes('SECRET PROMPT TEXT') && !s.includes('MODEL OUTPUT TEXT') && !s.includes('confidential document'),
    'forbidden content nowhere in the record');
  assert.equal(rec.metadata.model, 'claude-sonnet-4-6', 'allowed field kept');
});

// 5. aiEvent redacts secrets inside allowed values.
test('5. aiEvent redacts secret patterns within allowed fields', () => {
  logger.aiEvent('AI_CALL', { errorMessage: 'auth failed for key sk-abcdEFGH12345 (a.person@example.com)' });
  const m = captured[0].metadata.errorMessage;
  assert.ok(!m.includes('sk-abcdEFGH12345'), 'API key masked');
  assert.ok(m.includes('[REDACTED]'));
  assert.ok(!m.includes('a.person@example.com') && m.includes('a***@example.com'), 'email masked');
});

// 6/7/8. dbError: valid schema, module Infrastructure, allowed metadata preserved.
test('6-8. dbError emits schema-valid Infrastructure ERROR record with allowed metadata', () => {
  logger.dbError('DATABASE_ERROR', {
    operation: 'insert', table: 'tblStaff', entity: 'Employee',
    errorName: 'SQLITE_CONSTRAINT', errorMessage: 'constraint failed',
    durationMs: 12, retryable: false, status: 'failed',
  });
  assert.equal(captured.length, 1);
  const rec = captured[0];
  assert.equal(validateLogRecord(rec).valid, true, 'schema-valid');
  assert.equal(rec.module, 'Infrastructure', 'module defaults to Infrastructure');
  assert.equal(rec.level, 'ERROR');
  assert.equal(rec.message, 'Database operation failed');
  assert.equal(rec.metadata.operation, 'insert');
  assert.equal(rec.metadata.table, 'tblStaff');
  assert.equal(rec.metadata.errorName, 'SQLITE_CONSTRAINT');
  assert.equal(rec.metadata.retryable, false);
});

// 9. dbError discards SQL/params/connection material.
test('9. dbError discards sql/query/params/values/connectionString/databaseUrl', () => {
  logger.dbError('DATABASE_ERROR', {
    operation: 'select',
    sql: 'SELECT * FROM tblPswd WHERE UserName=?',
    query: 'SELECT HashPass FROM tblPswd',
    params: ['admin', 'hunter2'],
    values: { password: 'hunter2' },
    connectionString: 'sqlite://user:pass@host/db',
    databaseUrl: 'postgres://u:p@h:5432/db',
    password: 'hunter2',
    token: 'abc.def',
  });
  const rec = captured[0];
  for (const k of ['sql', 'query', 'params', 'values', 'connectionString', 'databaseUrl', 'password', 'token']) {
    assert.ok(!(k in rec.metadata), `${k} discarded`);
  }
  const s = JSON.stringify(rec);
  assert.ok(!/SELECT /.test(s), 'no SQL text anywhere');
  assert.ok(!s.includes('hunter2'), 'no parameter values anywhere');
  assert.ok(!s.includes('5432'), 'no connection detail anywhere');
});

// 10. dbError redacts secrets inside allowed values.
test('10. dbError redacts secret patterns within allowed fields', () => {
  logger.dbError('DATABASE_ERROR', { errorMessage: 'failed with Bearer supersecrettoken for a.person@example.com' });
  const m = captured[0].metadata.errorMessage;
  assert.ok(m.includes('[REDACTED]'), 'bearer token masked');
  assert.ok(!m.includes('a.person@example.com'), 'email masked');
});

// 11. Logger failure never throws.
test('11. aiEvent/dbError never throw, even with a failing sink or bad input', () => {
  logger.__setSink(() => { throw new Error('sink boom'); });
  assert.doesNotThrow(() => logger.aiEvent('AI_CALL', { model: 'x' }));
  assert.doesNotThrow(() => logger.dbError('DATABASE_ERROR', { operation: 'x' }));
  logger.__setSink((rec) => captured.push(rec));
  assert.doesNotThrow(() => logger.aiEvent('AI_CALL', null));
  assert.doesNotThrow(() => logger.dbError('DATABASE_ERROR', undefined));
  assert.doesNotThrow(() => logger.aiEvent('AI_CALL', 'not-an-object'));
  // and records emitted from degenerate input are still schema-valid
  for (const rec of captured) assert.equal(validateLogRecord(rec).valid, true);
});

// 12. Normal logger methods still work unchanged.
test('12. normal logger methods are unchanged', () => {
  logger.info('plain.event', { a: 1, message: 'hello' });
  const rec = captured[0];
  assert.equal(validateLogRecord(rec).valid, true);
  assert.equal(rec.module, 'System', 'default module still System');
  assert.equal(rec.message, 'hello');
  assert.equal(rec.metadata.a, 1);
  logger.error('plain.error', { password: 'p' });
  assert.equal(captured[1].metadata.password, '[REDACTED]', 'redaction unchanged');
});
