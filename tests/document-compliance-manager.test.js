// WP-18 · E17 — Enterprise Document Compliance Engine Foundation tests.
// Exhaustively exercises the compliance manager (create/mark*/waive/expire/evaluate/validate/
// normalize/clone/freeze/merge/compare/snapshot) and the compliance history. Covers
// framework-flag derivation, evaluation drift-removal, every state transition, hostile inputs,
// never-throw, determinism, immutability, copy-on-read, futureReserved, export surface, and
// unwired. Pure in-memory — no auditing, no reporting, no persistence.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const M = require(path.join(EDIR, 'document-compliance-manager.js'));
const H = require(path.join(EDIR, 'document-compliance-history.js'));
const DC = require(path.join(ROOT, 'lib', 'document', 'document-compliance.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };
const CO_FIELDS = ['complianceId', 'framework', 'status', 'requiresDocumentControl', 'requiresVersionControl', 'requiresApproval', 'requiresReview', 'requiresAudit', 'requiresRetention', 'requiresTraining', 'requiresReadAcknowledgement', 'metadata', 'futureReserved'];
const ISO = DC.getDocumentCompliance('ISO9001');

// ---------------------------------------------------------------------------
// manager: create + evaluate
// ---------------------------------------------------------------------------

test('E17-1. createCompliance: structure, framework-flag derivation, coercion', () => {
  const a = M.createCompliance();
  assert.deepEqual(Object.keys(a), CO_FIELDS);
  assert.equal(a.status, 'PENDING');
  assert.equal(a.framework, 'NONE');
  assert.deepEqual(a.metadata, {});
  assert.deepEqual(a.futureReserved, []);
  // all flags from the framework (none explicit)
  const m = M.createCompliance({ framework: 'ISO9001' });
  assert.equal(m.requiresDocumentControl, ISO.requiresDocumentControl);
  assert.equal(m.requiresApproval, ISO.requiresApproval);
  assert.equal(m.requiresTraining, ISO.requiresTraining);
  assert.equal(m.requiresReadAcknowledgement, ISO.requiresReadAcknowledgement);
  // coercion of non-boolean / string fields
  const c = M.createCompliance({ complianceId: 5, requiresApproval: 'yes', metadata: [1], futureReserved: 'no' });
  assert.equal(c.complianceId, '5');
  assert.equal(c.requiresApproval, false); // non-true → false
  assert.deepEqual(c.metadata, {});
  assert.deepEqual(c.futureReserved, []);
  assert.equal(M.createCompliance({}, { framework: 'ISO14001' }).framework, 'ISO14001');
  assert.equal(M.createCompliance({}, { defaultStatus: 'COMPLIANT' }).status, 'COMPLIANT');
});

test('E17-2. createCompliance explicit flag overrides + evaluateCompliance removes drift', () => {
  const c = M.createCompliance({ framework: 'ISO9001', requiresDocumentControl: false, requiresVersionControl: false, requiresApproval: false, requiresReview: false, requiresAudit: false, requiresRetention: false, requiresTraining: false, requiresReadAcknowledgement: true });
  assert.equal(c.requiresApproval, false); // explicit kept (not from framework)
  assert.equal(c.requiresReadAcknowledgement, true);
  // evaluateCompliance forces every flag back to the framework value
  const ev = M.evaluateCompliance(c);
  assert.equal(ev.requiresDocumentControl, ISO.requiresDocumentControl);
  assert.equal(ev.requiresApproval, ISO.requiresApproval);
  assert.equal(ev.requiresTraining, ISO.requiresTraining);
  assert.equal(ev.requiresReadAcknowledgement, ISO.requiresReadAcknowledgement);
});

// ---------------------------------------------------------------------------
// manager: state transitions
// ---------------------------------------------------------------------------

test('E17-3. markCompliant / markNonCompliant / waiveCompliance', () => {
  const c = M.createCompliance({ framework: 'ISO9001' });
  assert.equal(M.markCompliant(c).valid, true);
  assert.equal(M.markCompliant(c).compliance.status, 'COMPLIANT');
  assert.equal(M.markNonCompliant(c).compliance.status, 'NON_COMPLIANT');
  assert.equal(M.waiveCompliance(c).compliance.status, 'WAIVED');
});

test('E17-4. expireCompliance + expired blocks all transitions', () => {
  const c = M.createCompliance({ framework: 'ISO9001' });
  const exp = M.expireCompliance(c);
  assert.equal(exp.valid, true);
  assert.equal(exp.compliance.status, 'EXPIRED');
  assert.equal(M.expireCompliance(exp.compliance).valid, false); // already expired
  assert.ok(M.expireCompliance(exp.compliance).errors.some((e) => e.code === 'ALREADY_EXPIRED'));
  assert.ok(M.markCompliant(exp.compliance).errors.some((e) => e.code === 'NOT_MODIFIABLE'));
  assert.ok(M.markNonCompliant(exp.compliance).errors.some((e) => e.code === 'NOT_MODIFIABLE'));
  assert.ok(M.waiveCompliance(exp.compliance).errors.some((e) => e.code === 'NOT_MODIFIABLE'));
});

// ---------------------------------------------------------------------------
// manager: validation
// ---------------------------------------------------------------------------

test('E17-5. validateCompliance: shape, framework, status, boolean fields, duplicates', () => {
  assert.equal(M.validateCompliance({ framework: 'ISO9001', status: 'COMPLIANT', requiresApproval: true }).valid, true);
  const nonObj = M.validateCompliance(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.errors[0].code, 'INVALID_COMPLIANCE');
  const codes = (a) => M.validateCompliance(a).errors.map((e) => e.code);
  const warns = (a) => M.validateCompliance(a).warnings.map((w) => w.code);
  assert.ok(warns({ status: 'COMPLIANT', framework: 'MADEUP' }).includes('UNKNOWN_FRAMEWORK'));
  assert.ok(codes({}).includes('MISSING_STATUS'));
  assert.ok(codes({ status: 'FOO' }).includes('INVALID_STATUS'));
  // boolean field type check: non-boolean → error; boolean → no error; absent → skip
  const bad = M.validateCompliance({ status: 'COMPLIANT', requiresApproval: 'yes', requiresReview: true });
  assert.ok(bad.errors.some((e) => e.code === 'INVALID_BOOLEAN' && e.field === 'requiresApproval'));
  assert.equal(bad.errors.some((e) => e.field === 'requiresReview'), false); // valid boolean
  assert.ok(warns({ status: 'COMPLIANT', futureReserved: ['a', 'a'] }).includes('DUPLICATE_ENTRY'));
});

// ---------------------------------------------------------------------------
// manager: normalize / merge / compare / clone / freeze / snapshot
// ---------------------------------------------------------------------------

test('E17-6. normalizeCompliance: trim strings, dedupe + sort arrays, normalize metadata', () => {
  const n = M.normalizeCompliance({ status: 'PENDING', complianceId: '  c1  ', metadata: { b: '  y  ', a: 1, nested: { z: 2 }, arr: [3, 1, 2] }, futureReserved: [{ k: 1 }, { k: 1 }, 'x', 'x'] });
  assert.equal(n.complianceId, 'c1');
  assert.deepEqual(n.metadata.nested, { z: 2 });
  assert.deepEqual(n.metadata.arr, [1, 2, 3]);
  assert.deepEqual(n.futureReserved, ['x', { k: 1 }]);
});

test('E17-7. mergeCompliance: strategies, array + object modes, non-object base', () => {
  assert.deepEqual(M.mergeCompliance({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
  assert.deepEqual(M.mergeCompliance({ a: 1 }, { a: 2 }), { a: 2 });
  assert.deepEqual(M.mergeCompliance({ a: 1 }, { a: 2 }, { strategy: 'keepExisting' }), { a: 1 });
  assert.deepEqual(M.mergeCompliance({ t: [1] }, { t: [2] }).t, [2]);
  assert.deepEqual(M.mergeCompliance({ t: [1] }, { t: [2] }, { strategy: 'keepExisting' }).t, [1]);
  assert.deepEqual(M.mergeCompliance({ t: [1] }, { t: [2] }, { arrays: 'append' }).t, [1, 2]);
  assert.deepEqual(M.mergeCompliance({ t: [1, 2] }, { t: [2, 3] }, { arrays: 'union' }).t, [1, 2, 3]);
  assert.deepEqual(M.mergeCompliance({ o: { a: 1 } }, { o: { b: 2 } }, { objects: 'merge' }).o, { a: 1, b: 2 });
  assert.deepEqual(M.mergeCompliance({ o: { a: 1 } }, { o: { b: 2 } }).o, { b: 2 });
  assert.deepEqual(M.mergeCompliance({ o: { a: 1 } }, { o: { b: 2 } }, { strategy: 'keepExisting' }).o, { a: 1 });
  assert.deepEqual(M.mergeCompliance(5, { a: 1 }), { a: 1 });
});

test('E17-8. compareCompliance: added/removed/modified/unchanged + deepEqual matrix', () => {
  const d = M.compareCompliance({ status: 'PENDING', complianceId: 'x', metadata: { a: 1 }, same: 1 }, { status: 'COMPLIANT', metadata: { a: 2 }, same: 1, extra: 9 });
  assert.deepEqual(d.added, ['extra']);
  assert.deepEqual(d.removed, ['complianceId']);
  assert.deepEqual(d.modified.sort(), ['metadata', 'status']);
  assert.deepEqual(d.unchanged, ['same']);
  assert.deepEqual(M.compareCompliance(5, 6), { added: [], removed: [], modified: [], unchanged: [] });
  const diff = (av, bv) => M.compareCompliance({ F: av }, { F: bv }).modified.length === 1;
  assert.equal(diff([1], [1, 2]), true);
  assert.equal(diff([1], [2]), true);
  assert.equal(diff([1], { x: 1 }), true);
  assert.equal(diff({ x: 1 }, [1]), true);
  assert.equal(diff({ a: 1 }, { a: 1, b: 2 }), true);
  assert.equal(diff({ a: 1 }, { b: 1 }), true);
  assert.equal(diff({ a: 1 }, { a: 2 }), true);
  assert.equal(diff(1, '1'), true);
  assert.equal(M.compareCompliance({ F: { a: [1] } }, { F: { a: [1] } }).unchanged.length, 1);
});

test('E17-9. clone / freeze / snapshot', () => {
  const src = { status: 'PENDING', metadata: { a: 1 }, futureReserved: ['x'] };
  const frozen = M.freezeCompliance(src);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.metadata) && Object.isFrozen(frozen.futureReserved));
  assert.equal(Object.isFrozen(src), false);
  assert.notEqual(M.cloneCompliance(src).metadata, src.metadata);
  assert.deepEqual(M.cloneCompliance(5), {});
  assert.deepEqual(M.freezeCompliance(5), {});
  const s1 = M.generateComplianceSnapshot(src);
  assert.equal(s1.schema, 'enterprise-compliance.v1');
  assert.equal(s1.digest.length, 8);
  assert.equal(s1.digest, M.generateComplianceSnapshot(src).digest);
  assert.ok(Object.isFrozen(s1) && Object.isFrozen(s1.compliance));
  assert.notEqual(s1.digest, M.generateComplianceSnapshot({ status: 'COMPLIANT' }).digest);
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

test('E17-10. createHistory + listCompliance: structure, coercion, complianceId variants', () => {
  const h = H.createHistory({ complianceId: 'C1', framework: 'ISO9001', compliance: [{ status: 'PENDING' }], metadata: { a: 1 }, futureReserved: ['r'] });
  assert.deepEqual(Object.keys(h), ['complianceId', 'framework', 'compliance', 'metadata', 'futureReserved']);
  assert.equal(h.complianceId, 'C1');
  assert.equal(H.listCompliance(h).length, 1);
  assert.equal(H.createHistory({}).complianceId, null);
  assert.equal(H.createHistory({ complianceId: null }).complianceId, null);
  assert.equal(H.createHistory({ complianceId: 7 }).complianceId, 7);
  assert.equal(H.createHistory({}).framework, 'NONE');
  assert.deepEqual(H.createHistory({ compliance: 'no', metadata: 5, futureReserved: 9 }).compliance, []);
});

test('E17-11. append / replace / remove / find', () => {
  const h = H.createHistory({ compliance: [{ complianceId: 'e1', status: 'PENDING' }] });
  const app = H.appendCompliance(h, { complianceId: 'e2', status: 'COMPLIANT' });
  assert.equal(app.compliance.length, 2);
  assert.equal(h.compliance.length, 1);
  const rep = H.replaceCompliance(app, 'e1', { complianceId: 'e1', status: 'WAIVED' });
  assert.equal(rep.compliance.find((x) => x.status === 'WAIVED') !== undefined, true);
  assert.equal(H.replaceCompliance(app, 'none', { complianceId: 'x' }).compliance.some((x) => x.complianceId === 'x'), false);
  const rem = H.removeCompliance(app, 'e1');
  assert.equal(rem.compliance.length, 1);
  assert.equal(H.removeCompliance(app, null).compliance.length, 2);
  assert.equal(H.findCompliance(app, 'e2').complianceId, 'e2');
  assert.equal(H.findCompliance(app, 'nope'), null);
  assert.equal(H.findCompliance(app, null), null);
});

test('E17-12. find latest / previous / next; key fallback; empty', () => {
  const h = H.createHistory({ compliance: [{ complianceId: 'e1' }, { complianceId: 'e2' }, { complianceId: 'e3' }] });
  assert.equal(H.findLatest(h).complianceId, 'e3');
  assert.equal(H.findLatest({ compliance: [] }), null);
  assert.equal(H.findPrevious(h, 'e2').complianceId, 'e1');
  assert.equal(H.findPrevious(h, 'e1'), null);
  assert.equal(H.findPrevious(h, 'nope'), null);
  assert.equal(H.findNext(h, 'e2').complianceId, 'e3');
  assert.equal(H.findNext(h, 'e3'), null);
  assert.equal(H.findNext(h, 'nope'), null);
  const noId = H.createHistory({ compliance: [{ status: 'COMPLIANT' }, { status: 'NON_COMPLIANT' }] });
  assert.equal(H.findCompliance(noId, 'COMPLIANT').status, 'COMPLIANT');
});

test('E17-13. compareHistory / validateHistory: keys, duplicates, per-compliance, nested deepEqual', () => {
  const a = H.createHistory({ compliance: [{ complianceId: 'e1' }, { complianceId: 'e2' }] });
  const b = H.createHistory({ compliance: [{ complianceId: 'e1', metadata: { edited: 1 } }, { complianceId: 'e3' }] });
  const d = H.compareHistory(a, b);
  assert.deepEqual(d.added, ['e3']);
  assert.deepEqual(d.removed, ['e2']);
  assert.deepEqual(d.modified, ['e1']);
  const same = { complianceId: 'k', metadata: { a: [1, 2] } };
  const A = H.createHistory({ compliance: [same, { complianceId: 'x', metadata: { a: 1 } }, { complianceId: 'y', futureReserved: ['p'] }, { complianceId: 'z', futureReserved: ['p'] }, { complianceId: 'w', metadata: { a: 1 } }] });
  const B = H.createHistory({ compliance: [same, { complianceId: 'x', metadata: { b: 1 } }, { complianceId: 'y', futureReserved: ['p', 'q'] }, { complianceId: 'z', futureReserved: ['q'] }, { complianceId: 'w', metadata: { a: 1, c: 2 } }] });
  const cmp = H.compareHistory(A, B);
  assert.deepEqual(cmp.unchanged, ['k']);
  assert.deepEqual(cmp.modified.sort(), ['w', 'x', 'y', 'z']);
  assert.equal(H.validateHistory({ compliance: [{ status: 'COMPLIANT', complianceId: 'e1' }] }).valid, true);
  const nonObj = H.validateHistory(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.errors[0].code, 'INVALID_HISTORY');
  assert.ok(H.validateHistory({ compliance: 'no' }).errors.some((e) => e.code === 'INVALID_COMPLIANCE_LIST'));
  const dup = H.validateHistory({ compliance: [{ status: 'COMPLIANT', complianceId: 'e1' }, { status: 'COMPLIANT', complianceId: 'e1' }] });
  assert.deepEqual(dup.duplicateCompliance, ['e1']);
  assert.ok(dup.errors.some((e) => e.code === 'DUPLICATE_COMPLIANCE'));
  const bubble = H.validateHistory({ compliance: [{ status: 'FOO', complianceId: 'e1', framework: 'MADEUP' }] });
  assert.ok(bubble.errors.some((e) => e.code === 'INVALID_STATUS'));
  assert.ok(bubble.warnings.some((w) => w.code === 'UNKNOWN_FRAMEWORK'));
  assert.ok(H.validateHistory({ compliance: [{}] }).errors.some((e) => e.code === 'MISSING_STATUS'));
});

test('E17-14. normalizeHistory / clone / freeze: normalized, immutable, caller-safe', () => {
  const h = { complianceId: 'C', framework: 'ISO9001', compliance: [{ status: 'PENDING', futureReserved: ['b', 'a'] }], metadata: { b: '  y  ', a: { n: 1 } }, futureReserved: ['z'] };
  const n = H.normalizeHistory(h);
  assert.deepEqual(Object.keys(n), ['complianceId', 'framework', 'compliance', 'metadata', 'futureReserved']);
  assert.deepEqual(n.compliance[0].futureReserved, ['a', 'b']);
  assert.equal(n.metadata.b, 'y');
  assert.deepEqual(n.metadata.a, { n: 1 });
  const frozen = H.freezeHistory(h);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.compliance) && Object.isFrozen(frozen.compliance[0]));
  assert.equal(Object.isFrozen(h), false);
  assert.deepEqual(H.cloneHistory(5), {});
  assert.notEqual(H.cloneHistory(h).compliance, h.compliance);
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E17-15. export surfaces are exact', () => {
  assert.deepEqual(Object.keys(M).sort(), ['cloneCompliance', 'compareCompliance', 'createCompliance', 'evaluateCompliance', 'expireCompliance', 'freezeCompliance', 'generateComplianceSnapshot', 'markCompliant', 'markNonCompliant', 'mergeCompliance', 'normalizeCompliance', 'validateCompliance', 'waiveCompliance']);
  assert.deepEqual(Object.keys(H).sort(), ['appendCompliance', 'cloneHistory', 'compareHistory', 'createHistory', 'findCompliance', 'findLatest', 'findNext', 'findPrevious', 'freezeHistory', 'listCompliance', 'normalizeHistory', 'removeCompliance', 'replaceCompliance', 'validateHistory']);
});

test('E17-16. never throws: every method tolerates hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { status: {} }, { metadata: 5 }, { compliance: 5 }, { requiresApproval: 'x' }];
  for (const a of hostile) {
    for (const fn of ['createCompliance', 'evaluateCompliance', 'validateCompliance', 'normalizeCompliance', 'cloneCompliance', 'freezeCompliance', 'generateComplianceSnapshot', 'markCompliant', 'markNonCompliant', 'waiveCompliance', 'expireCompliance']) {
      noThrow(() => M[fn](a), `M.${fn}`);
    }
    noThrow(() => M.mergeCompliance(a, a, a), 'M.mergeCompliance');
    noThrow(() => M.compareCompliance(a, a), 'M.compareCompliance');
    for (const fn of ['createHistory', 'findLatest', 'validateHistory', 'normalizeHistory', 'cloneHistory', 'freezeHistory', 'listCompliance']) {
      noThrow(() => H[fn](a), `H.${fn}`);
    }
    for (const fn of ['appendCompliance', 'removeCompliance', 'findCompliance', 'findPrevious', 'findNext']) {
      noThrow(() => H[fn](a, a), `H.${fn}`);
    }
    noThrow(() => H.replaceCompliance(a, a, a), 'H.replaceCompliance');
    noThrow(() => H.compareHistory(a, a), 'H.compareHistory');
  }
});

test('E17-17. deterministic + immutable; frozen input not mutated; futureReserved fresh', () => {
  const input = Object.freeze({ framework: 'ISO9001', status: 'PENDING', metadata: Object.freeze({ a: 1 }), futureReserved: Object.freeze(['r']) });
  const snap = JSON.parse(JSON.stringify(input));
  noThrow(() => M.createCompliance(input), 'create frozen');
  noThrow(() => M.markCompliant(input), 'mark frozen');
  noThrow(() => M.normalizeCompliance(input), 'normalize frozen');
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snap);
  assert.deepEqual(M.createCompliance({ status: 'PENDING' }), M.createCompliance({ status: 'PENDING' }));
  const a = M.createCompliance({ status: 'PENDING' });
  const b = M.createCompliance({ status: 'PENDING' });
  assert.notEqual(a.futureReserved, b.futureReserved);
});

// ---------------------------------------------------------------------------
// unwired requirement
// ---------------------------------------------------------------------------

test('E17-18. compliance modules import nothing from production', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/)/;
  for (const f of ['document-compliance-manager.js', 'document-compliance-history.js']) {
    const src = fs.readFileSync(path.join(EDIR, f), 'utf8');
    assert.ok(!FORBIDDEN.test(src), `${f} has no forbidden production import`);
    const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
    for (const r of requires) {
      assert.ok(/require\((['"])\.\.?\//.test(r), `${f} only uses relative foundation imports (found ${r})`);
    }
  }
});

test('E17-19. compliance engine is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});

test('E17-20. compliance evaluation is deterministic across identical inputs', () => {
  const input = { framework: 'ISO45001', requiresApproval: false, metadata: { a: 1 } };
  assert.deepEqual(M.evaluateCompliance(input), M.evaluateCompliance(input));
  assert.deepEqual(M.createCompliance(input), M.createCompliance(input));
  assert.equal(M.generateComplianceSnapshot(input).digest, M.generateComplianceSnapshot(input).digest);
});
