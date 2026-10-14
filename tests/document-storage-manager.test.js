// WP-18 · E16 — Enterprise Document Storage Engine Foundation tests.
// Exhaustively exercises the storage manager (create/archive/backup/retire/fail/evaluate/
// validate/normalize/clone/freeze/merge/compare/snapshot) and the storage history. Covers
// mode-field derivation, nullable numeric coercion, every state transition, hostile inputs,
// never-throw, determinism, immutability, copy-on-read, futureReserved, export surface, and
// unwired. Pure in-memory — no filesystem, no cloud, no uploads, no persistence.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const M = require(path.join(EDIR, 'document-storage-manager.js'));
const H = require(path.join(EDIR, 'document-storage-history.js'));
const DS = require(path.join(ROOT, 'lib', 'document', 'document-storage.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };
const ST_FIELDS = ['storageId', 'storageType', 'status', 'provider', 'storageClass', 'retentionDays', 'maxFileSizeMb', 'requiresEncryption', 'requiresChecksum', 'requiresVirusScan', 'supportsVersioning', 'supportsBackup', 'location', 'metadata', 'futureReserved'];
const LP = DS.getDocumentStorage('LOCAL_PRIVATE');

// ---------------------------------------------------------------------------
// manager: create + evaluate
// ---------------------------------------------------------------------------

test('E16-1. createStorage: structure, mode-derived defaults, nullable numeric coercion', () => {
  const a = M.createStorage();
  assert.deepEqual(Object.keys(a), ST_FIELDS);
  assert.equal(a.status, 'PENDING');
  assert.equal(a.storageType, 'NONE');
  assert.deepEqual(a.metadata, {});
  assert.deepEqual(a.futureReserved, []);
  // from LOCAL_PRIVATE mode (no explicit fields)
  const m = M.createStorage({ storageType: 'LOCAL_PRIVATE' });
  assert.equal(m.provider, LP.provider);
  assert.equal(m.storageClass, LP.storageClass);
  assert.equal(m.maxFileSizeMb, LP.maxFileSizeMb);
  assert.equal(m.requiresEncryption, LP.requiresEncryption);
  assert.equal(m.supportsBackup, LP.supportsBackup);
  // nullable numeric coercion
  assert.equal(M.createStorage({ retentionDays: null }).retentionDays, null);
  assert.equal(M.createStorage({ retentionDays: 5 }).retentionDays, 5);
  assert.equal(M.createStorage({ retentionDays: 5.9 }).retentionDays, 5); // truncated
  assert.equal(M.createStorage({ retentionDays: 'x' }).retentionDays, null); // non-number → null
  assert.equal(M.createStorage({}, { storageType: 'LOCAL_PRIVATE' }).storageType, 'LOCAL_PRIVATE');
  assert.equal(M.createStorage({}, { defaultStatus: 'ACTIVE' }).status, 'ACTIVE');
});

test('E16-2. createStorage explicit overrides + evaluateStorage re-derives from the mode', () => {
  const c = M.createStorage({ storageType: 'LOCAL_PRIVATE', provider: 'custom', storageClass: 'cold', retentionDays: 30, maxFileSizeMb: 50, requiresEncryption: false, requiresChecksum: false, requiresVirusScan: false, supportsVersioning: true, supportsBackup: false });
  assert.equal(c.provider, 'custom'); // explicit kept (not from mode)
  assert.equal(c.storageClass, 'cold');
  assert.equal(c.retentionDays, 30);
  assert.equal(c.maxFileSizeMb, 50);
  assert.equal(c.requiresEncryption, false);
  assert.equal(c.supportsBackup, false);
  // evaluateStorage forces every mode-controlled field back to the registry value
  const ev = M.evaluateStorage(c);
  assert.equal(ev.provider, LP.provider);
  assert.equal(ev.storageClass, LP.storageClass);
  assert.equal(ev.maxFileSizeMb, LP.maxFileSizeMb);
  assert.equal(ev.requiresEncryption, LP.requiresEncryption);
  assert.equal(ev.supportsBackup, LP.supportsBackup);
});

// ---------------------------------------------------------------------------
// manager: state transitions
// ---------------------------------------------------------------------------

test('E16-3. archiveStorage / failStorage + retired blocks them', () => {
  const s = M.createStorage({ storageType: 'LOCAL_PRIVATE' });
  const arch = M.archiveStorage(s, { location: '/archive' });
  assert.equal(arch.valid, true);
  assert.equal(arch.storage.status, 'ARCHIVED');
  assert.equal(arch.storage.location, '/archive'); // option applied
  assert.equal(M.failStorage(s).storage.status, 'FAILED');
  const retired = M.retireStorage(s).storage;
  assert.ok(M.archiveStorage(retired).errors.some((e) => e.code === 'NOT_TRANSITIONABLE'));
  assert.ok(M.failStorage(retired).errors.some((e) => e.code === 'NOT_TRANSITIONABLE'));
});

test('E16-4. backupStorage: supported vs unsupported vs retired', () => {
  const s = M.createStorage({ storageType: 'LOCAL_PRIVATE' }); // supportsBackup true
  assert.equal(M.backupStorage(s).storage.status, 'BACKUP');
  const noBackup = M.createStorage({ supportsBackup: false });
  assert.ok(M.backupStorage(noBackup).errors.some((e) => e.code === 'BACKUP_NOT_SUPPORTED'));
  const retired = M.retireStorage(s).storage;
  assert.ok(M.backupStorage(retired).errors.some((e) => e.code === 'NOT_TRANSITIONABLE'));
});

test('E16-5. retireStorage + already-retired', () => {
  const s = M.createStorage({ storageType: 'LOCAL_PRIVATE' });
  const retired = M.retireStorage(s, { location: '/cold' });
  assert.equal(retired.valid, true);
  assert.equal(retired.storage.status, 'RETIRED');
  assert.equal(retired.storage.location, '/cold');
  assert.equal(M.retireStorage(retired.storage).valid, false);
  assert.ok(M.retireStorage(retired.storage).errors.some((e) => e.code === 'ALREADY_RETIRED'));
});

// ---------------------------------------------------------------------------
// manager: validation
// ---------------------------------------------------------------------------

test('E16-6. validateStorage: shape, type, status, provider/class, retention, size, duplicates', () => {
  assert.equal(M.validateStorage({ storageType: 'LOCAL_PRIVATE', status: 'ACTIVE', provider: LP.provider, storageClass: LP.storageClass, retentionDays: null, maxFileSizeMb: 100 }).valid, true);
  const nonObj = M.validateStorage(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.errors[0].code, 'INVALID_STORAGE');
  const codes = (a) => M.validateStorage(a).errors.map((e) => e.code);
  const warns = (a) => M.validateStorage(a).warnings.map((w) => w.code);
  assert.ok(warns({ status: 'ACTIVE', storageType: 'MADEUP' }).includes('UNKNOWN_STORAGE_TYPE'));
  assert.ok(codes({}).includes('MISSING_STATUS'));
  assert.ok(codes({ status: 'FOO' }).includes('INVALID_STATUS'));
  assert.ok(warns({ status: 'ACTIVE', storageType: 'LOCAL_PRIVATE', provider: 'other' }).includes('PROVIDER_MISMATCH'));
  assert.equal(warns({ status: 'ACTIVE', storageType: 'LOCAL_PRIVATE', provider: LP.provider }).includes('PROVIDER_MISMATCH'), false); // matches
  assert.ok(warns({ status: 'ACTIVE', storageType: 'LOCAL_PRIVATE', storageClass: 'other' }).includes('CLASS_MISMATCH'));
  assert.equal(M.validateStorage({ status: 'ACTIVE', storageType: 'LOCAL_PRIVATE' }).warnings.some((w) => w.code === 'PROVIDER_MISMATCH'), false); // provider absent
  assert.ok(codes({ status: 'ACTIVE', retentionDays: -1 }).includes('INVALID_RETENTION'));
  assert.equal(M.validateStorage({ status: 'ACTIVE', retentionDays: 30 }).valid, true); // valid retention
  assert.ok(codes({ status: 'ACTIVE', maxFileSizeMb: 0 }).includes('INVALID_MAX_SIZE'));
  assert.equal(M.validateStorage({ status: 'ACTIVE', maxFileSizeMb: null }).valid, true); // null allowed
  assert.ok(warns({ status: 'ACTIVE', futureReserved: ['a', 'a'] }).includes('DUPLICATE_ENTRY'));
});

// ---------------------------------------------------------------------------
// manager: normalize / merge / compare / clone / freeze / snapshot
// ---------------------------------------------------------------------------

test('E16-7. normalizeStorage: trim strings, dedupe + sort arrays, normalize metadata', () => {
  const n = M.normalizeStorage({ status: 'PENDING', location: '  /vol  ', metadata: { b: '  y  ', a: 1, nested: { z: 2 }, arr: [3, 1, 2] }, futureReserved: [{ k: 1 }, { k: 1 }, 'x', 'x'] });
  assert.equal(n.location, '/vol');
  assert.deepEqual(n.metadata.nested, { z: 2 });
  assert.deepEqual(n.metadata.arr, [1, 2, 3]);
  assert.deepEqual(n.futureReserved, ['x', { k: 1 }]);
});

test('E16-8. mergeStorage: strategies, array + object modes, non-object base', () => {
  assert.deepEqual(M.mergeStorage({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
  assert.deepEqual(M.mergeStorage({ a: 1 }, { a: 2 }), { a: 2 });
  assert.deepEqual(M.mergeStorage({ a: 1 }, { a: 2 }, { strategy: 'keepExisting' }), { a: 1 });
  assert.deepEqual(M.mergeStorage({ t: [1] }, { t: [2] }).t, [2]);
  assert.deepEqual(M.mergeStorage({ t: [1] }, { t: [2] }, { strategy: 'keepExisting' }).t, [1]);
  assert.deepEqual(M.mergeStorage({ t: [1] }, { t: [2] }, { arrays: 'append' }).t, [1, 2]);
  assert.deepEqual(M.mergeStorage({ t: [1, 2] }, { t: [2, 3] }, { arrays: 'union' }).t, [1, 2, 3]);
  assert.deepEqual(M.mergeStorage({ o: { a: 1 } }, { o: { b: 2 } }, { objects: 'merge' }).o, { a: 1, b: 2 });
  assert.deepEqual(M.mergeStorage({ o: { a: 1 } }, { o: { b: 2 } }).o, { b: 2 });
  assert.deepEqual(M.mergeStorage({ o: { a: 1 } }, { o: { b: 2 } }, { strategy: 'keepExisting' }).o, { a: 1 });
  assert.deepEqual(M.mergeStorage(5, { a: 1 }), { a: 1 });
});

test('E16-9. compareStorage: added/removed/modified/unchanged + deepEqual matrix', () => {
  const d = M.compareStorage({ status: 'PENDING', location: 'x', metadata: { a: 1 }, same: 1 }, { status: 'ACTIVE', metadata: { a: 2 }, same: 1, extra: 9 });
  assert.deepEqual(d.added, ['extra']);
  assert.deepEqual(d.removed, ['location']);
  assert.deepEqual(d.modified.sort(), ['metadata', 'status']);
  assert.deepEqual(d.unchanged, ['same']);
  assert.deepEqual(M.compareStorage(5, 6), { added: [], removed: [], modified: [], unchanged: [] });
  const diff = (av, bv) => M.compareStorage({ F: av }, { F: bv }).modified.length === 1;
  assert.equal(diff([1], [1, 2]), true);
  assert.equal(diff([1], [2]), true);
  assert.equal(diff([1], { x: 1 }), true);
  assert.equal(diff({ x: 1 }, [1]), true);
  assert.equal(diff({ a: 1 }, { a: 1, b: 2 }), true);
  assert.equal(diff({ a: 1 }, { b: 1 }), true);
  assert.equal(diff({ a: 1 }, { a: 2 }), true);
  assert.equal(diff(1, '1'), true);
  assert.equal(M.compareStorage({ F: { a: [1] } }, { F: { a: [1] } }).unchanged.length, 1);
});

test('E16-10. clone / freeze / snapshot', () => {
  const src = { status: 'PENDING', metadata: { a: 1 }, futureReserved: ['x'] };
  const frozen = M.freezeStorage(src);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.metadata) && Object.isFrozen(frozen.futureReserved));
  assert.equal(Object.isFrozen(src), false);
  assert.notEqual(M.cloneStorage(src).metadata, src.metadata);
  assert.deepEqual(M.cloneStorage(5), {});
  assert.deepEqual(M.freezeStorage(5), {});
  const s1 = M.generateStorageSnapshot(src);
  assert.equal(s1.schema, 'enterprise-storage.v1');
  assert.equal(s1.digest.length, 8);
  assert.equal(s1.digest, M.generateStorageSnapshot(src).digest);
  assert.ok(Object.isFrozen(s1) && Object.isFrozen(s1.storage));
  assert.notEqual(s1.digest, M.generateStorageSnapshot({ status: 'ACTIVE' }).digest);
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

test('E16-11. createHistory + listStorage: structure, coercion, storageId variants', () => {
  const h = H.createHistory({ storageId: 'S1', storageType: 'LOCAL_PRIVATE', storage: [{ status: 'PENDING' }], metadata: { a: 1 }, futureReserved: ['r'] });
  assert.deepEqual(Object.keys(h), ['storageId', 'storageType', 'storage', 'metadata', 'futureReserved']);
  assert.equal(h.storageId, 'S1');
  assert.equal(H.listStorage(h).length, 1);
  assert.equal(H.createHistory({}).storageId, null);
  assert.equal(H.createHistory({ storageId: null }).storageId, null);
  assert.equal(H.createHistory({ storageId: 7 }).storageId, 7);
  assert.equal(H.createHistory({}).storageType, 'NONE');
  assert.deepEqual(H.createHistory({ storage: 'no', metadata: 5, futureReserved: 9 }).storage, []);
});

test('E16-12. append / replace / remove / find', () => {
  const h = H.createHistory({ storage: [{ storageId: 'e1', status: 'PENDING' }] });
  const app = H.appendStorage(h, { storageId: 'e2', status: 'ACTIVE' });
  assert.equal(app.storage.length, 2);
  assert.equal(h.storage.length, 1);
  const rep = H.replaceStorage(app, 'e1', { storageId: 'e1', status: 'RETIRED' });
  assert.equal(rep.storage.find((x) => x.status === 'RETIRED') !== undefined, true);
  assert.equal(H.replaceStorage(app, 'none', { storageId: 'x' }).storage.some((x) => x.storageId === 'x'), false);
  const rem = H.removeStorage(app, 'e1');
  assert.equal(rem.storage.length, 1);
  assert.equal(H.removeStorage(app, null).storage.length, 2);
  assert.equal(H.findStorage(app, 'e2').storageId, 'e2');
  assert.equal(H.findStorage(app, 'nope'), null);
  assert.equal(H.findStorage(app, null), null);
});

test('E16-13. find latest / previous / next; key fallback; empty', () => {
  const h = H.createHistory({ storage: [{ storageId: 'e1' }, { storageId: 'e2' }, { storageId: 'e3' }] });
  assert.equal(H.findLatest(h).storageId, 'e3');
  assert.equal(H.findLatest({ storage: [] }), null);
  assert.equal(H.findPrevious(h, 'e2').storageId, 'e1');
  assert.equal(H.findPrevious(h, 'e1'), null);
  assert.equal(H.findPrevious(h, 'nope'), null);
  assert.equal(H.findNext(h, 'e2').storageId, 'e3');
  assert.equal(H.findNext(h, 'e3'), null);
  assert.equal(H.findNext(h, 'nope'), null);
  const noId = H.createHistory({ storage: [{ status: 'ACTIVE' }, { status: 'RETIRED' }] });
  assert.equal(H.findStorage(noId, 'ACTIVE').status, 'ACTIVE');
});

test('E16-14. compareHistory / validateHistory: keys, duplicates, per-storage, nested deepEqual', () => {
  const a = H.createHistory({ storage: [{ storageId: 'e1' }, { storageId: 'e2' }] });
  const b = H.createHistory({ storage: [{ storageId: 'e1', location: 'edited' }, { storageId: 'e3' }] });
  const d = H.compareHistory(a, b);
  assert.deepEqual(d.added, ['e3']);
  assert.deepEqual(d.removed, ['e2']);
  assert.deepEqual(d.modified, ['e1']);
  const same = { storageId: 'k', metadata: { a: [1, 2] } };
  const A = H.createHistory({ storage: [same, { storageId: 'x', metadata: { a: 1 } }, { storageId: 'y', futureReserved: ['p'] }, { storageId: 'z', futureReserved: ['p'] }, { storageId: 'w', metadata: { a: 1 } }] });
  const B = H.createHistory({ storage: [same, { storageId: 'x', metadata: { b: 1 } }, { storageId: 'y', futureReserved: ['p', 'q'] }, { storageId: 'z', futureReserved: ['q'] }, { storageId: 'w', metadata: { a: 1, c: 2 } }] });
  const cmp = H.compareHistory(A, B);
  assert.deepEqual(cmp.unchanged, ['k']);
  assert.deepEqual(cmp.modified.sort(), ['w', 'x', 'y', 'z']);
  assert.equal(H.validateHistory({ storage: [{ status: 'ACTIVE', storageId: 'e1' }] }).valid, true);
  const nonObj = H.validateHistory(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.errors[0].code, 'INVALID_HISTORY');
  assert.ok(H.validateHistory({ storage: 'no' }).errors.some((e) => e.code === 'INVALID_STORAGE_LIST'));
  const dup = H.validateHistory({ storage: [{ status: 'ACTIVE', storageId: 'e1' }, { status: 'ACTIVE', storageId: 'e1' }] });
  assert.deepEqual(dup.duplicateStorage, ['e1']);
  assert.ok(dup.errors.some((e) => e.code === 'DUPLICATE_STORAGE'));
  const bubble = H.validateHistory({ storage: [{ status: 'FOO', storageId: 'e1', storageType: 'MADEUP' }] });
  assert.ok(bubble.errors.some((e) => e.code === 'INVALID_STATUS'));
  assert.ok(bubble.warnings.some((w) => w.code === 'UNKNOWN_STORAGE_TYPE'));
  assert.ok(H.validateHistory({ storage: [{}] }).errors.some((e) => e.code === 'MISSING_STATUS'));
});

test('E16-15. normalizeHistory / clone / freeze: normalized, immutable, caller-safe', () => {
  const h = { storageId: 'S', storageType: 'LOCAL_PRIVATE', storage: [{ status: 'PENDING', futureReserved: ['b', 'a'] }], metadata: { b: '  y  ', a: { n: 1 } }, futureReserved: ['z'] };
  const n = H.normalizeHistory(h);
  assert.deepEqual(Object.keys(n), ['storageId', 'storageType', 'storage', 'metadata', 'futureReserved']);
  assert.deepEqual(n.storage[0].futureReserved, ['a', 'b']);
  assert.equal(n.metadata.b, 'y');
  assert.deepEqual(n.metadata.a, { n: 1 });
  const frozen = H.freezeHistory(h);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.storage) && Object.isFrozen(frozen.storage[0]));
  assert.equal(Object.isFrozen(h), false);
  assert.deepEqual(H.cloneHistory(5), {});
  assert.notEqual(H.cloneHistory(h).storage, h.storage);
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E16-16. export surfaces are exact', () => {
  assert.deepEqual(Object.keys(M).sort(), ['archiveStorage', 'backupStorage', 'cloneStorage', 'compareStorage', 'createStorage', 'evaluateStorage', 'failStorage', 'freezeStorage', 'generateStorageSnapshot', 'mergeStorage', 'normalizeStorage', 'retireStorage', 'validateStorage']);
  assert.deepEqual(Object.keys(H).sort(), ['appendStorage', 'cloneHistory', 'compareHistory', 'createHistory', 'findLatest', 'findNext', 'findPrevious', 'findStorage', 'freezeHistory', 'listStorage', 'normalizeHistory', 'removeStorage', 'replaceStorage', 'validateHistory']);
});

test('E16-17. never throws: every method tolerates hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { status: {} }, { metadata: 5 }, { storage: 5 }, { retentionDays: 'x' }];
  for (const a of hostile) {
    for (const fn of ['createStorage', 'evaluateStorage', 'validateStorage', 'normalizeStorage', 'cloneStorage', 'freezeStorage', 'generateStorageSnapshot', 'archiveStorage', 'backupStorage', 'retireStorage', 'failStorage']) {
      noThrow(() => M[fn](a, a), `M.${fn}`);
    }
    noThrow(() => M.mergeStorage(a, a, a), 'M.mergeStorage');
    noThrow(() => M.compareStorage(a, a), 'M.compareStorage');
    for (const fn of ['createHistory', 'findLatest', 'validateHistory', 'normalizeHistory', 'cloneHistory', 'freezeHistory', 'listStorage']) {
      noThrow(() => H[fn](a), `H.${fn}`);
    }
    for (const fn of ['appendStorage', 'removeStorage', 'findStorage', 'findPrevious', 'findNext']) {
      noThrow(() => H[fn](a, a), `H.${fn}`);
    }
    noThrow(() => H.replaceStorage(a, a, a), 'H.replaceStorage');
    noThrow(() => H.compareHistory(a, a), 'H.compareHistory');
  }
});

test('E16-18. deterministic + immutable; frozen input not mutated; futureReserved fresh', () => {
  const input = Object.freeze({ storageType: 'LOCAL_PRIVATE', status: 'PENDING', metadata: Object.freeze({ a: 1 }), futureReserved: Object.freeze(['r']) });
  const snap = JSON.parse(JSON.stringify(input));
  noThrow(() => M.createStorage(input), 'create frozen');
  noThrow(() => M.archiveStorage(input), 'archive frozen');
  noThrow(() => M.normalizeStorage(input), 'normalize frozen');
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snap);
  assert.deepEqual(M.createStorage({ status: 'PENDING' }), M.createStorage({ status: 'PENDING' }));
  const a = M.createStorage({ status: 'PENDING' });
  const b = M.createStorage({ status: 'PENDING' });
  assert.notEqual(a.futureReserved, b.futureReserved);
});

// ---------------------------------------------------------------------------
// unwired requirement
// ---------------------------------------------------------------------------

test('E16-19. storage modules import nothing from production', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/)/;
  for (const f of ['document-storage-manager.js', 'document-storage-history.js']) {
    const src = fs.readFileSync(path.join(EDIR, f), 'utf8');
    assert.ok(!FORBIDDEN.test(src), `${f} has no forbidden production import`);
    const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
    for (const r of requires) {
      assert.ok(/require\((['"])\.\.?\//.test(r), `${f} only uses relative foundation imports (found ${r})`);
    }
  }
});

test('E16-20. storage engine is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
