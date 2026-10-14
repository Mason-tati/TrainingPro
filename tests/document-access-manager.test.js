// WP-18 · E15 — Enterprise Document Access Control Engine Foundation tests.
// Exhaustively exercises the access manager (create/grant/deny/revoke/expire/evaluate/
// validate/normalize/clone/freeze/merge/compare/snapshot) and the access history. Covers
// single + multiple permissions, grant/deny/partial-grant/revoke/expiry, capability-based
// evaluation, every derived state, hostile inputs, never-throw, determinism, immutability,
// copy-on-read, futureReserved, export surface, and unwired. Pure in-memory.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const M = require(path.join(EDIR, 'document-access-manager.js'));
const H = require(path.join(EDIR, 'document-access-history.js'));
const DA = require(path.join(ROOT, 'lib', 'document', 'document-access.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };
const AC_FIELDS = ['accessId', 'accessType', 'status', 'principal', 'principalType', 'permissions', 'grantedPermissions', 'deniedPermissions', 'effectivePermissions', 'requiresAuthentication', 'requiresActiveEmployment', 'decision', 'comments', 'metadata', 'futureReserved'];
// REVIEWER allows 'read' + 'review' but not 'edit' — used to exercise capability-based evaluation.
const REVIEWER_ALLOWED = DA.getDocumentAccess('REVIEWER').canRead === true && DA.getDocumentAccess('REVIEWER').canEdit !== true;

// ---------------------------------------------------------------------------
// manager: create + evaluation
// ---------------------------------------------------------------------------

test('E15-1. createAccess: full structure, coercion, type/requires defaults, effective computed', () => {
  assert.equal(REVIEWER_ALLOWED, true); // sanity: registry shape assumed below
  const a = M.createAccess();
  assert.deepEqual(Object.keys(a), AC_FIELDS);
  assert.equal(a.status, 'PENDING');
  assert.equal(a.accessType, 'NONE');
  assert.equal(a.requiresAuthentication, DA.getDocumentAccess('NONE').requiresAuthentication);
  assert.deepEqual(a.effectivePermissions, []);
  const c = M.createAccess({ accessType: 'REVIEWER', status: 'GRANTED', principal: 5, permissions: ['read', 'review', 'edit'], requiresAuthentication: false, metadata: [1], futureReserved: 'no' });
  assert.equal(c.principal, '5');
  assert.equal(c.requiresAuthentication, false); // explicit override
  assert.deepEqual(c.metadata, {});
  assert.deepEqual(c.effectivePermissions, ['read', 'review']); // 'edit' not a REVIEWER capability
  assert.equal(M.createAccess({}, { accessType: 'REVIEWER' }).accessType, 'REVIEWER');
  assert.equal(M.createAccess({}, { defaultStatus: 'EXPIRED' }).status, 'EXPIRED');
});

test('E15-2. evaluatePermissions: derived GRANTED / PARTIALLY_GRANTED / DENIED / PENDING', () => {
  assert.equal(M.evaluatePermissions({ accessType: 'REVIEWER', permissions: ['read', 'review'] }).status, 'GRANTED'); // all capable
  const partial = M.evaluatePermissions({ accessType: 'REVIEWER', permissions: ['read', 'edit'] });
  assert.equal(partial.status, 'PARTIALLY_GRANTED'); // edit not capable
  assert.deepEqual(partial.effectivePermissions, ['read']);
  assert.equal(M.evaluatePermissions({ accessType: 'NONE', permissions: ['read'] }).status, 'DENIED'); // NONE grants nothing
  assert.equal(M.evaluatePermissions({ accessType: 'REVIEWER', permissions: [] }).status, 'PENDING'); // nothing requested
  // explicit grant overrides a missing capability; explicit deny overrides a capability
  assert.deepEqual(M.evaluatePermissions({ accessType: 'NONE', permissions: ['edit'], grantedPermissions: ['edit'] }).effectivePermissions, ['edit']);
  assert.deepEqual(M.evaluatePermissions({ accessType: 'REVIEWER', permissions: ['read'], deniedPermissions: ['read'] }).effectivePermissions, []);
});

// ---------------------------------------------------------------------------
// manager: grant / deny / revoke / expire
// ---------------------------------------------------------------------------

test('E15-3. grantPermission: explicit grant, registration, GRANTED/partial', () => {
  const g = M.grantPermission(M.createAccess({ accessType: 'NONE' }), 'read', { comments: 'ok' });
  assert.equal(g.valid, true);
  assert.equal(g.access.status, 'GRANTED'); // single permission requested + granted
  assert.deepEqual(g.access.permissions, ['read']); // auto-registered
  assert.deepEqual(g.access.grantedPermissions, ['read']);
  assert.equal(g.access.decision, 'grant');
  assert.equal(g.access.comments, 'ok');
  // a second granted permission the type cannot supply is still effective via explicit grant
  const g2 = M.grantPermission(g.access, 'edit');
  assert.equal(g2.access.status, 'GRANTED');
  assert.deepEqual(g2.access.effectivePermissions.sort(), ['edit', 'read']);
  assert.ok(M.grantPermission(g.access, '  ').errors.some((e) => e.code === 'INVALID_PERMISSION'));
});

test('E15-4. denyPermission: deny wins over capability', () => {
  const d = M.denyPermission(M.createAccess({ accessType: 'REVIEWER', permissions: ['read'] }), 'read');
  assert.equal(d.valid, true);
  assert.equal(d.access.status, 'DENIED'); // only requested permission denied
  assert.deepEqual(d.access.effectivePermissions, []);
  assert.deepEqual(d.access.deniedPermissions, ['read']);
  // partial: deny one of two
  const two = M.createAccess({ accessType: 'REVIEWER', permissions: ['read', 'review'] });
  assert.equal(M.denyPermission(two, 'read').access.status, 'PARTIALLY_GRANTED');
});

test('E15-5. revokePermission: REVOKED when all revoked; PARTIALLY otherwise; NOT_APPLICABLE', () => {
  const granted = M.grantPermission(M.grantPermission(M.createAccess({ accessType: 'NONE' }), 'read').access, 'edit').access;
  // revoke one of two → still PARTIALLY_GRANTED (not fully denied → no REVOKED override)
  const partial = M.revokePermission(granted, 'read');
  assert.equal(partial.access.status, 'PARTIALLY_GRANTED');
  assert.deepEqual(partial.access.deniedPermissions, ['read']);
  // revoke the remaining → all denied → REVOKED
  const revoked = M.revokePermission(partial.access, 'edit');
  assert.equal(revoked.access.status, 'REVOKED');
  assert.equal(revoked.access.decision, 'revoke');
  assert.ok(M.revokePermission(granted, 'not-requested').errors.some((e) => e.code === 'NOT_APPLICABLE'));
});

test('E15-6. expireAccess + expired blocks all modifications', () => {
  const a = M.createAccess({ accessType: 'REVIEWER', permissions: ['read'] });
  const exp = M.expireAccess(a, { comments: 'ttl' });
  assert.equal(exp.valid, true);
  assert.equal(exp.access.status, 'EXPIRED');
  assert.equal(exp.access.decision, 'expire');
  assert.equal(M.expireAccess(exp.access).valid, false); // already expired
  assert.ok(M.grantPermission(exp.access, 'read').errors.some((e) => e.code === 'NOT_MODIFIABLE'));
  assert.ok(M.denyPermission(exp.access, 'read').errors.some((e) => e.code === 'NOT_MODIFIABLE'));
  assert.ok(M.revokePermission(exp.access, 'read').errors.some((e) => e.code === 'NOT_MODIFIABLE'));
});

// ---------------------------------------------------------------------------
// manager: validation
// ---------------------------------------------------------------------------

test('E15-7. validateAccess: shape, type, status, duplicates, grant/deny + effective consistency', () => {
  assert.equal(M.validateAccess({ accessType: 'REVIEWER', status: 'PENDING', permissions: ['read', 'review'] }).valid, true);
  const nonObj = M.validateAccess(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.errors[0].code, 'INVALID_ACCESS');
  const codes = (a) => M.validateAccess(a).errors.map((e) => e.code);
  const warns = (a) => M.validateAccess(a).warnings.map((w) => w.code);
  assert.ok(warns({ status: 'PENDING', accessType: 'MADEUP' }).includes('UNKNOWN_ACCESS_TYPE'));
  assert.ok(codes({}).includes('MISSING_STATUS'));
  assert.ok(codes({ status: 'FOO' }).includes('INVALID_STATUS'));
  assert.ok(codes({ status: 'PENDING', permissions: ['read', 'read'] }).includes('DUPLICATE_PERMISSION'));
  assert.ok(warns({ status: 'PENDING', permissions: ['bogus'] }).includes('UNKNOWN_PERMISSION'));
  assert.ok(warns({ status: 'PENDING', grantedPermissions: ['read'], deniedPermissions: ['read'] }).includes('GRANT_DENY_CONFLICT'));
  assert.ok(warns({ status: 'PENDING', effectivePermissions: ['read'], deniedPermissions: ['read'] }).includes('INCONSISTENT_EFFECTIVE'));
});

// ---------------------------------------------------------------------------
// manager: normalize / merge / compare / clone / freeze / snapshot
// ---------------------------------------------------------------------------

test('E15-8. normalizeAccess: trim strings, dedupe + sort arrays, normalize metadata', () => {
  const n = M.normalizeAccess({ status: 'PENDING', comments: '  c  ', permissions: [' read ', 'review', 'review', ''], metadata: { b: '  y  ', a: 1, nested: { z: 2 }, arr: [3, 1, 2] }, futureReserved: [{ k: 1 }, { k: 1 }, 'x', 'x'] });
  assert.equal(n.comments, 'c');
  assert.deepEqual(n.permissions, ['read', 'review']);
  assert.deepEqual(n.metadata.nested, { z: 2 });
  assert.deepEqual(n.metadata.arr, [1, 2, 3]);
  assert.deepEqual(n.futureReserved, ['x', { k: 1 }]);
});

test('E15-9. mergeAccess: strategies, array + object modes, non-object base', () => {
  assert.deepEqual(M.mergeAccess({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
  assert.deepEqual(M.mergeAccess({ a: 1 }, { a: 2 }), { a: 2 });
  assert.deepEqual(M.mergeAccess({ a: 1 }, { a: 2 }, { strategy: 'keepExisting' }), { a: 1 });
  assert.deepEqual(M.mergeAccess({ t: [1] }, { t: [2] }).t, [2]);
  assert.deepEqual(M.mergeAccess({ t: [1] }, { t: [2] }, { strategy: 'keepExisting' }).t, [1]);
  assert.deepEqual(M.mergeAccess({ t: [1] }, { t: [2] }, { arrays: 'append' }).t, [1, 2]);
  assert.deepEqual(M.mergeAccess({ t: [1, 2] }, { t: [2, 3] }, { arrays: 'union' }).t, [1, 2, 3]);
  assert.deepEqual(M.mergeAccess({ o: { a: 1 } }, { o: { b: 2 } }, { objects: 'merge' }).o, { a: 1, b: 2 });
  assert.deepEqual(M.mergeAccess({ o: { a: 1 } }, { o: { b: 2 } }).o, { b: 2 });
  assert.deepEqual(M.mergeAccess({ o: { a: 1 } }, { o: { b: 2 } }, { strategy: 'keepExisting' }).o, { a: 1 });
  assert.deepEqual(M.mergeAccess(5, { a: 1 }), { a: 1 });
});

test('E15-10. compareAccess: added/removed/modified/unchanged + deepEqual matrix', () => {
  const d = M.compareAccess({ status: 'PENDING', comments: 'x', metadata: { a: 1 }, same: 1 }, { status: 'GRANTED', metadata: { a: 2 }, same: 1, extra: 9 });
  assert.deepEqual(d.added, ['extra']);
  assert.deepEqual(d.removed, ['comments']);
  assert.deepEqual(d.modified.sort(), ['metadata', 'status']);
  assert.deepEqual(d.unchanged, ['same']);
  assert.deepEqual(M.compareAccess(5, 6), { added: [], removed: [], modified: [], unchanged: [] });
  const diff = (av, bv) => M.compareAccess({ F: av }, { F: bv }).modified.length === 1;
  assert.equal(diff([1], [1, 2]), true);
  assert.equal(diff([1], [2]), true);
  assert.equal(diff([1], { x: 1 }), true);
  assert.equal(diff({ x: 1 }, [1]), true);
  assert.equal(diff({ a: 1 }, { a: 1, b: 2 }), true);
  assert.equal(diff({ a: 1 }, { b: 1 }), true);
  assert.equal(diff({ a: 1 }, { a: 2 }), true);
  assert.equal(diff(1, '1'), true);
  assert.equal(M.compareAccess({ F: { a: [1] } }, { F: { a: [1] } }).unchanged.length, 1);
});

test('E15-11. clone / freeze / snapshot', () => {
  const src = { status: 'PENDING', metadata: { a: 1 }, permissions: ['read'] };
  const frozen = M.freezeAccess(src);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.metadata) && Object.isFrozen(frozen.permissions));
  assert.equal(Object.isFrozen(src), false);
  assert.notEqual(M.cloneAccess(src).metadata, src.metadata);
  assert.deepEqual(M.cloneAccess(5), {});
  assert.deepEqual(M.freezeAccess(5), {});
  const s1 = M.generateAccessSnapshot(src);
  assert.equal(s1.schema, 'enterprise-access.v1');
  assert.equal(s1.digest.length, 8);
  assert.equal(s1.digest, M.generateAccessSnapshot(src).digest);
  assert.ok(Object.isFrozen(s1) && Object.isFrozen(s1.access));
  assert.notEqual(s1.digest, M.generateAccessSnapshot({ status: 'GRANTED' }).digest);
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

test('E15-12. createHistory + listAccess: structure, coercion, accessId variants', () => {
  const h = H.createHistory({ accessId: 'A1', accessType: 'REVIEWER', access: [{ status: 'PENDING' }], metadata: { a: 1 }, futureReserved: ['r'] });
  assert.deepEqual(Object.keys(h), ['accessId', 'accessType', 'access', 'metadata', 'futureReserved']);
  assert.equal(h.accessId, 'A1');
  assert.equal(H.listAccess(h).length, 1);
  assert.equal(H.createHistory({}).accessId, null);
  assert.equal(H.createHistory({ accessId: null }).accessId, null);
  assert.equal(H.createHistory({ accessId: 7 }).accessId, 7);
  assert.equal(H.createHistory({}).accessType, 'NONE');
  assert.deepEqual(H.createHistory({ access: 'no', metadata: 5, futureReserved: 9 }).access, []);
});

test('E15-13. append / replace / remove / find', () => {
  const h = H.createHistory({ access: [{ accessId: 'e1', status: 'PENDING' }] });
  const app = H.appendAccess(h, { accessId: 'e2', status: 'GRANTED' });
  assert.equal(app.access.length, 2);
  assert.equal(h.access.length, 1);
  const rep = H.replaceAccess(app, 'e1', { accessId: 'e1', status: 'REVOKED' });
  assert.equal(rep.access.find((x) => x.status === 'REVOKED') !== undefined, true);
  assert.equal(H.replaceAccess(app, 'none', { accessId: 'x' }).access.some((x) => x.accessId === 'x'), false);
  const rem = H.removeAccess(app, 'e1');
  assert.equal(rem.access.length, 1);
  assert.equal(H.removeAccess(app, null).access.length, 2);
  assert.equal(H.findAccess(app, 'e2').accessId, 'e2');
  assert.equal(H.findAccess(app, 'nope'), null);
  assert.equal(H.findAccess(app, null), null);
});

test('E15-14. find latest / previous / next; key fallback; empty', () => {
  const h = H.createHistory({ access: [{ accessId: 'e1' }, { accessId: 'e2' }, { accessId: 'e3' }] });
  assert.equal(H.findLatest(h).accessId, 'e3');
  assert.equal(H.findLatest({ access: [] }), null);
  assert.equal(H.findPrevious(h, 'e2').accessId, 'e1');
  assert.equal(H.findPrevious(h, 'e1'), null);
  assert.equal(H.findPrevious(h, 'nope'), null);
  assert.equal(H.findNext(h, 'e2').accessId, 'e3');
  assert.equal(H.findNext(h, 'e3'), null);
  assert.equal(H.findNext(h, 'nope'), null);
  const noId = H.createHistory({ access: [{ status: 'GRANTED' }, { status: 'DENIED' }] });
  assert.equal(H.findAccess(noId, 'GRANTED').status, 'GRANTED');
});

test('E15-15. compareHistory / validateHistory: keys, duplicates, per-access, nested deepEqual', () => {
  const a = H.createHistory({ access: [{ accessId: 'e1' }, { accessId: 'e2' }] });
  const b = H.createHistory({ access: [{ accessId: 'e1', comments: 'edited' }, { accessId: 'e3' }] });
  const d = H.compareHistory(a, b);
  assert.deepEqual(d.added, ['e3']);
  assert.deepEqual(d.removed, ['e2']);
  assert.deepEqual(d.modified, ['e1']);
  const same = { accessId: 'k', metadata: { a: [1, 2] } };
  const A = H.createHistory({ access: [same, { accessId: 'x', metadata: { a: 1 } }, { accessId: 'y', permissions: ['p'] }, { accessId: 'z', permissions: ['p'] }, { accessId: 'w', metadata: { a: 1 } }] });
  const B = H.createHistory({ access: [same, { accessId: 'x', metadata: { b: 1 } }, { accessId: 'y', permissions: ['p', 'q'] }, { accessId: 'z', permissions: ['q'] }, { accessId: 'w', metadata: { a: 1, c: 2 } }] });
  const cmp = H.compareHistory(A, B);
  assert.deepEqual(cmp.unchanged, ['k']);
  assert.deepEqual(cmp.modified.sort(), ['w', 'x', 'y', 'z']);
  assert.equal(H.validateHistory({ access: [{ status: 'PENDING', accessId: 'e1' }] }).valid, true);
  const nonObj = H.validateHistory(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.errors[0].code, 'INVALID_HISTORY');
  assert.ok(H.validateHistory({ access: 'no' }).errors.some((e) => e.code === 'INVALID_ACCESS_LIST'));
  const dup = H.validateHistory({ access: [{ status: 'PENDING', accessId: 'e1' }, { status: 'PENDING', accessId: 'e1' }] });
  assert.deepEqual(dup.duplicateAccess, ['e1']);
  assert.ok(dup.errors.some((e) => e.code === 'DUPLICATE_ACCESS'));
  const bubble = H.validateHistory({ access: [{ status: 'FOO', accessId: 'e1', accessType: 'MADEUP' }] });
  assert.ok(bubble.errors.some((e) => e.code === 'INVALID_STATUS'));
  assert.ok(bubble.warnings.some((w) => w.code === 'UNKNOWN_ACCESS_TYPE'));
  assert.ok(H.validateHistory({ access: [{}] }).errors.some((e) => e.code === 'MISSING_STATUS'));
});

test('E15-16. normalizeHistory / clone / freeze: normalized, immutable, caller-safe', () => {
  const h = { accessId: 'A', accessType: 'REVIEWER', access: [{ status: 'PENDING', permissions: ['review', 'read'] }], metadata: { b: '  y  ', a: { n: 1 } }, futureReserved: ['z'] };
  const n = H.normalizeHistory(h);
  assert.deepEqual(Object.keys(n), ['accessId', 'accessType', 'access', 'metadata', 'futureReserved']);
  assert.deepEqual(n.access[0].permissions, ['read', 'review']);
  assert.equal(n.metadata.b, 'y');
  assert.deepEqual(n.metadata.a, { n: 1 });
  const frozen = H.freezeHistory(h);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.access) && Object.isFrozen(frozen.access[0]));
  assert.equal(Object.isFrozen(h), false);
  assert.deepEqual(H.cloneHistory(5), {});
  assert.notEqual(H.cloneHistory(h).access, h.access);
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E15-17. export surfaces are exact', () => {
  assert.deepEqual(Object.keys(M).sort(), ['cloneAccess', 'compareAccess', 'createAccess', 'denyPermission', 'evaluatePermissions', 'expireAccess', 'freezeAccess', 'generateAccessSnapshot', 'grantPermission', 'mergeAccess', 'normalizeAccess', 'revokePermission', 'validateAccess']);
  assert.deepEqual(Object.keys(H).sort(), ['appendAccess', 'cloneHistory', 'compareHistory', 'createHistory', 'findAccess', 'findLatest', 'findNext', 'findPrevious', 'freezeHistory', 'listAccess', 'normalizeHistory', 'removeAccess', 'replaceAccess', 'validateHistory']);
});

test('E15-18. never throws: every method tolerates hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { status: {} }, { metadata: 5 }, { access: 5 }, { permissions: 5 }];
  for (const a of hostile) {
    for (const fn of ['createAccess', 'evaluatePermissions', 'validateAccess', 'normalizeAccess', 'cloneAccess', 'freezeAccess', 'generateAccessSnapshot', 'expireAccess']) {
      noThrow(() => M[fn](a, a), `M.${fn}`);
    }
    for (const fn of ['grantPermission', 'denyPermission', 'revokePermission']) noThrow(() => M[fn](a, a, a), `M.${fn}`);
    noThrow(() => M.mergeAccess(a, a, a), 'M.mergeAccess');
    noThrow(() => M.compareAccess(a, a), 'M.compareAccess');
    for (const fn of ['createHistory', 'findLatest', 'validateHistory', 'normalizeHistory', 'cloneHistory', 'freezeHistory', 'listAccess']) {
      noThrow(() => H[fn](a), `H.${fn}`);
    }
    for (const fn of ['appendAccess', 'removeAccess', 'findAccess', 'findPrevious', 'findNext']) {
      noThrow(() => H[fn](a, a), `H.${fn}`);
    }
    noThrow(() => H.replaceAccess(a, a, a), 'H.replaceAccess');
    noThrow(() => H.compareHistory(a, a), 'H.compareHistory');
  }
});

test('E15-19. deterministic + immutable; frozen input not mutated; futureReserved fresh', () => {
  const input = Object.freeze({ accessType: 'REVIEWER', status: 'PENDING', permissions: Object.freeze(['read']), metadata: Object.freeze({ a: 1 }), futureReserved: Object.freeze(['r']) });
  const snap = JSON.parse(JSON.stringify(input));
  noThrow(() => M.createAccess(input), 'create frozen');
  noThrow(() => M.grantPermission(input, 'edit'), 'grant frozen');
  noThrow(() => M.normalizeAccess(input), 'normalize frozen');
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snap);
  assert.deepEqual(M.createAccess({ status: 'PENDING' }), M.createAccess({ status: 'PENDING' }));
  const a = M.createAccess({ status: 'PENDING' });
  const b = M.createAccess({ status: 'PENDING' });
  assert.notEqual(a.futureReserved, b.futureReserved);
});

// ---------------------------------------------------------------------------
// unwired requirement
// ---------------------------------------------------------------------------

test('E15-20. access modules import nothing from production', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/)/;
  for (const f of ['document-access-manager.js', 'document-access-history.js']) {
    const src = fs.readFileSync(path.join(EDIR, f), 'utf8');
    assert.ok(!FORBIDDEN.test(src), `${f} has no forbidden production import`);
    const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
    for (const r of requires) {
      assert.ok(/require\((['"])\.\.?\//.test(r), `${f} only uses relative foundation imports (found ${r})`);
    }
  }
});

test('E15-21. access engine is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
