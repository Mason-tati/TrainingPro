// WP-07 · C5 — Unit tests for remaining shared library helpers.
// Deterministic and offline: no real AI, no API key, no SMTP/email, no external
// services, and NO production database. The DB-touching helpers are exercised
// only on their safe-failure paths (the DB is intentionally never initialised in
// this process, so db access rejects and the helpers must degrade gracefully).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', '..');
const booking = require(path.join(ROOT, 'lib', 'booking.js'));
const workflow = require(path.join(ROOT, 'lib', 'workflow.js'));
const pdfout = require(path.join(ROOT, 'lib', 'pdfout.js'));
const audit = require(path.join(ROOT, 'lib', 'audit.js'));

// No key needed anywhere in this file.
delete process.env.ANTHROPIC_API_KEY;

// ── booking.overlaps (pure) ─────────────────────────────────────────────
test('booking.overlaps detects overlapping/adjacent/disjoint ranges', () => {
  assert.equal(booking.overlaps('09:00', '11:00', '10:00', '12:00'), true, 'partial overlap');
  assert.equal(booking.overlaps('08:00', '18:00', '12:00', '13:00'), true, 'containment');
  assert.equal(booking.overlaps('09:00', '10:00', '10:00', '11:00'), false, 'touching edges do not overlap');
  assert.equal(booking.overlaps('09:00', '10:00', '11:00', '12:00'), false, 'disjoint');
});

test('booking.overlaps treats missing times as a whole-day block', () => {
  assert.equal(booking.overlaps(null, null, '10:00', '11:00'), true, 'null range = all day');
  assert.equal(booking.overlaps('', '', '', ''), true, 'empty strings = all day both sides');
});

// ── workflow event catalogue (pure) ─────────────────────────────────────
test('1/2. WORKFLOW_EVENTS exists and contains the confirmed trigger events', () => {
  assert.ok(Array.isArray(workflow.WORKFLOW_EVENTS));
  assert.equal(workflow.WORKFLOW_EVENTS.length, 9);
  const keys = workflow.WORKFLOW_EVENTS.map((e) => e.key).sort();
  assert.deepEqual(keys, [
    'cert_awarded', 'class_booked', 'employee_added', 'exam_failed', 'exam_passed',
    'form_signoff', 'training_completed', 'training_expired', 'training_expiring',
  ]);
  for (const e of workflow.WORKFLOW_EVENTS) {
    assert.equal(typeof e.key, 'string');
    assert.equal(typeof e.label, 'string');
    assert.equal(typeof e.desc, 'string');
  }
});

// ── workflow.splitEmails (pure) ─────────────────────────────────────────
test('workflow.splitEmails parses/validates/filters addresses', () => {
  assert.deepEqual(workflow.splitEmails('a@b.com, c@d.com; e@f.com'), ['a@b.com', 'c@d.com', 'e@f.com']);
  assert.deepEqual(workflow.splitEmails('a@b.com notanemail x@y.co'), ['a@b.com', 'x@y.co']);
  assert.deepEqual(workflow.splitEmails(''), []);
  assert.deepEqual(workflow.splitEmails(null), []);
});

// ── workflow.fillTemplate (pure, additive export) ───────────────────────
test('workflow.fillTemplate substitutes vars and blanks missing ones', () => {
  assert.equal(workflow.fillTemplate('Hi {{name}}', { name: 'Bob' }), 'Hi Bob');
  assert.equal(workflow.fillTemplate('X {{a}} Y', {}), 'X  Y');
  assert.equal(workflow.fillTemplate('{{ spaced }}', { spaced: 'ok' }), 'ok');
  assert.equal(workflow.fillTemplate(null), '');
});

// ── workflow.resolveRecipients (pure/async, additive export) ────────────
test('workflow.resolveRecipients merges + dedupes recipients', async () => {
  assert.deepEqual(
    await workflow.resolveRecipients({ Recipients: 'a@b.com', NotifyEmployee: 1 }, { employeeEmail: 'e@x.com' }),
    ['a@b.com', 'e@x.com']
  );
  assert.deepEqual(
    await workflow.resolveRecipients({ Recipients: 'a@b.com', NotifyEmployee: 1 }, { employeeEmail: 'a@b.com' }),
    ['a@b.com'], // deduped
  );
  assert.deepEqual(
    await workflow.resolveRecipients({ Recipients: 'a@b.com', NotifySupervisor: 1 }, { supervisorEmail: 's@x.com' }),
    ['a@b.com', 's@x.com']
  );
  assert.deepEqual(await workflow.resolveRecipients({ Recipients: '' }, {}), []);
});

// 3. workflow.fireWorkflow is safe when its DB dependency fails.
test('3. fireWorkflow never throws when the DB is unavailable', async () => {
  // DB is not initialised in this process → dbAll rejects → fireWorkflow must
  // catch and return a summary array (and never reach the mailer / send email).
  const result = await workflow.fireWorkflow('employee_added', { vars: { Employee: 'Test' } });
  assert.ok(Array.isArray(result), 'returns a summary array');
  assert.ok(result.length >= 1 && typeof result[0].error === 'string', 'records the failure safely');
});

// ── pdfout.wrapText (pure, additive export) ─────────────────────────────
test('pdfout.wrapText wraps on spaces using measured width', () => {
  const font = { widthOfTextAtSize: (s) => s.length }; // 1 unit per char
  assert.deepEqual(pdfout.wrapText('hello world foo', font, 10, 5), ['hello', 'world', 'foo']);
});

test('pdfout.wrapText splits explicit newlines', () => {
  const font = { widthOfTextAtSize: (s) => s.length };
  assert.deepEqual(pdfout.wrapText('a\nb', font, 10, 1000), ['a', 'b']);
});

test('pdfout.wrapText character-wraps space-less scripts (e.g. Thai)', () => {
  const font = { widthOfTextAtSize: (s) => s.length };
  assert.deepEqual(pdfout.wrapText('abcdef', font, 10, 2), ['ab', 'cd', 'ef']);
});

test('pdfout.wrapText falls back safely when width measurement throws', () => {
  const font = { widthOfTextAtSize: () => { throw new Error('no glyph'); } };
  const lines = pdfout.wrapText('safety first', font, 10, 100000);
  assert.ok(Array.isArray(lines) && lines.length >= 1, 'produces lines without throwing');
});

// pdfout.buildPdfFromSegments — deterministic PDF header, guarded by font availability.
test('pdfout.buildPdfFromSegments emits a valid %PDF header (if a Unicode font is present)', async (t) => {
  const fontExists = ['C:/Windows/Fonts/tahoma.ttf', 'C:/Windows/Fonts/leelawui.ttf', 'C:/Windows/Fonts/arialuni.ttf']
    .some((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!fontExists) return t.skip('no Unicode-capable system font available in this environment');
  const buf = await pdfout.buildPdfFromSegments([{ source: 'Hello', target: 'สวัสดี' }], true, 'Title');
  assert.ok(Buffer.isBuffer(buf), 'returns a Buffer');
  assert.equal(buf.slice(0, 5).toString('latin1'), '%PDF-', 'valid PDF header');
});

// 4. audit.logAudit fails safely when the DB is unavailable.
test('4. audit.logAudit never throws when logging cannot complete', async () => {
  // DB not initialised → dbRun rejects → logAudit swallows the error.
  await assert.doesNotReject(
    () => audit.logAudit('tester', 'tblStaff', 'update', 1, 'Field', 'old', 'new')
  );
  const ret = await audit.logAudit('tester', 'tblStaff', 'delete', 2);
  assert.equal(ret, undefined, 'resolves to undefined (fire-and-forget)');
});
