// WP-18 · E7 — Enterprise Metadata Policy Engine Foundation tests.
// Exhaustively exercises the immutable policy registry (copy-on-read, frozen, safe default)
// and the policy engine (validate / applyDefaults / inherit / merge / compare / normalize /
// freeze / clone / list). Covers hostile inputs, never-throw, determinism, immutability, and
// the unwired requirement. Pure in-memory — no DB, no network, no production imports.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MDIR = path.join(ROOT, 'lib', 'document-engine', 'metadata');
const P = require(path.join(MDIR, 'metadata-policy.js'));
const E = require(path.join(MDIR, 'metadata-policy-engine.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };
const REQUIRED_POLICIES = ['NONE', 'CONTROLLED_DOCUMENT', 'WORK_INSTRUCTION', 'STANDARD_OPERATING_PROCEDURE', 'POLICY', 'PROCEDURE', 'FORM', 'CHECKLIST', 'RISK_ASSESSMENT', 'TRAINING', 'PRESENTATION', 'ASSESSMENT', 'REFERENCE', 'TRANSLATION', 'AI_GENERATED', 'TEMPLATE', 'ARCHIVE', 'CUSTOM'];

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

test('E7-1. registry: contains all required policies; ids frozen; export surface exact', () => {
  for (const id of REQUIRED_POLICIES) assert.ok(P.METADATA_POLICY_IDS.includes(id), `${id} present`);
  assert.equal(P.METADATA_POLICY_IDS.length >= 18, true);
  assert.ok(Object.isFrozen(P.METADATA_POLICY_IDS));
  assert.deepEqual(Object.keys(P).sort(), ['METADATA_POLICIES', 'METADATA_POLICY_IDS', 'getMetadataPolicy', 'isKnownMetadataPolicy', 'listMetadataPolicies']);
});

test('E7-2. registry: deep frozen, complete policy shape', () => {
  assert.ok(Object.isFrozen(P.METADATA_POLICIES));
  assert.ok(Object.isFrozen(P.METADATA_POLICIES.CONTROLLED_DOCUMENT));
  assert.ok(Object.isFrozen(P.METADATA_POLICIES.CONTROLLED_DOCUMENT.requiredFields));
  const shape = ['id', 'displayName', 'description', 'requiredFields', 'optionalFields', 'readOnlyFields', 'inheritFields', 'allowedCustomFields', 'allowUnknownFields', 'allowReservedFields', 'requireOwner', 'requireAuthor', 'requireDepartment', 'requireSite', 'requireReviewDate', 'requireEffectiveDate', 'requireClassification', 'requireCompliance', 'requireLanguage', 'requireVersion', 'futureReserved'];
  for (const id of P.METADATA_POLICY_IDS) {
    const pol = P.METADATA_POLICIES[id];
    for (const k of shape) assert.ok(Object.prototype.hasOwnProperty.call(pol, k), `${id}.${k}`);
    assert.equal(pol.id, id);
  }
});

test('E7-3. lookup: known / unknown / non-string; safe default is most restrictive', () => {
  assert.equal(P.getMetadataPolicy('FORM').id, 'FORM');
  const unk = P.getMetadataPolicy('does-not-exist');
  assert.equal(unk.id, 'UNKNOWN');
  assert.equal(unk.allowUnknownFields, false);
  assert.equal(unk.allowReservedFields, false);
  assert.ok(unk.requiredFields.length >= 10, 'all critical metadata required');
  assert.equal(P.getMetadataPolicy(5).id, 'UNKNOWN'); // non-string
  assert.equal(P.getMetadataPolicy().id, 'UNKNOWN'); // undefined
});

test('E7-4. isKnownMetadataPolicy: members true; UNKNOWN + non-string false', () => {
  assert.equal(P.isKnownMetadataPolicy('FORM'), true);
  assert.equal(P.isKnownMetadataPolicy('UNKNOWN'), false); // safe default is NOT a member
  assert.equal(P.isKnownMetadataPolicy('nope'), false);
  assert.equal(P.isKnownMetadataPolicy(5), false);
  assert.equal(P.isKnownMetadataPolicy(null), false);
});

test('E7-5. copy-on-read: fresh objects, fresh arrays, futureReserved; mutation does not leak', () => {
  const a = P.getMetadataPolicy('AI_GENERATED');
  const b = P.getMetadataPolicy('AI_GENERATED');
  assert.notEqual(a, b);
  assert.notEqual(a.requiredFields, b.requiredFields);
  assert.notEqual(a.futureReserved, b.futureReserved);
  assert.ok(a.futureReserved.length > 0, 'AI_GENERATED has futureReserved');
  a.requiredFields.push('HACK');
  a.futureReserved.push('HACK');
  a.id = 'MUTATED';
  assert.equal(P.getMetadataPolicy('AI_GENERATED').requiredFields.includes('HACK'), false);
  assert.equal(P.getMetadataPolicy('AI_GENERATED').futureReserved.includes('HACK'), false);
  assert.equal(P.getMetadataPolicy('AI_GENERATED').id, 'AI_GENERATED');
  // list also returns fresh clones
  const list = P.listMetadataPolicies();
  assert.equal(list.length, P.METADATA_POLICY_IDS.length);
  list[0].requiredFields.push('X');
  assert.equal(P.listMetadataPolicies()[0].requiredFields.includes('X'), false);
});

// ---------------------------------------------------------------------------
// engine: passthrough + validation
// ---------------------------------------------------------------------------

test('E7-6. engine: getPolicy / listPolicies passthrough + export surface exact', () => {
  assert.equal(E.getPolicy('FORM').id, 'FORM');
  assert.equal(E.listPolicies().length, P.METADATA_POLICY_IDS.length);
  assert.deepEqual(Object.keys(E).sort(), ['applyDefaults', 'clonePolicy', 'comparePolicies', 'freezePolicy', 'getPolicy', 'inheritPolicy', 'listPolicies', 'mergePolicies', 'normalizePolicy', 'validateAgainstPolicy']);
});

test('E7-7. validate: shape, non-object metadata, missing required (required + require flags)', () => {
  const bad = E.validateAgainstPolicy(5, 'FORM');
  assert.equal(bad.valid, false);
  assert.deepEqual(Object.keys(bad).sort(), ['errors', 'missingFields', 'unknownFields', 'valid', 'warnings']);
  assert.equal(bad.errors[0].code, 'INVALID_METADATA');
  // CONTROLLED_DOCUMENT requires many fields (via requiredFields + require flags)
  const r = E.validateAgainstPolicy({ Title: 'X' }, 'CONTROLLED_DOCUMENT');
  assert.equal(r.valid, false);
  assert.ok(r.missingFields.includes('Owner') && r.missingFields.includes('Version'));
  // empty-ish values count as missing
  const empty = E.validateAgainstPolicy({ Title: '   ', Owner: null, Department: '', Version: [] }, 'CONTROLLED_DOCUMENT');
  assert.ok(empty.missingFields.includes('Title') && empty.missingFields.includes('Owner') && empty.missingFields.includes('Version'));
  // a non-empty array value satisfies a required field (not missing)
  assert.equal(E.validateAgainstPolicy({ Title: ['x'], Owner: 'o' }, 'FORM').missingFields.includes('Title'), false);
});

test('E7-8. validate: reserved (allowed→warn / not→error), read-only warn, unknown (allow→warn / not→error)', () => {
  // CONTROLLED_DOCUMENT: reserved not allowed → error; unknown not allowed → error
  const strict = E.validateAgainstPolicy({ Title: 'X', Owner: 'o', Department: 'd', Classification: 'c', EffectiveDate: '2026-01-01', ReviewDate: '2026-06-01', Version: '1', CreatedBy: 'sys', Weird: 1 }, 'CONTROLLED_DOCUMENT');
  assert.ok(strict.errors.some((e) => e.code === 'RESERVED_NOT_ALLOWED'));
  assert.ok(strict.errors.some((e) => e.code === 'UNKNOWN_FIELD'));
  assert.ok(strict.unknownFields.includes('Weird'));
  // ARCHIVE: reserved allowed → warning; non-reserved read-only field → READ_ONLY warning
  const arch = E.validateAgainstPolicy({ Title: 'X', Owner: 'o', CreatedBy: 'sys' }, 'ARCHIVE');
  assert.ok(arch.warnings.some((w) => w.code === 'RESERVED_FIELD'));
  assert.ok(arch.warnings.some((w) => w.code === 'READ_ONLY'));
  // FORM: unknown allowed → warning (not error)
  const loose = E.validateAgainstPolicy({ Title: 'X', Owner: 'o', Weird: 1 }, 'FORM');
  assert.ok(loose.warnings.some((w) => w.code === 'UNKNOWN_FIELD'));
  assert.equal(loose.errors.some((e) => e.code === 'UNKNOWN_FIELD'), false);
});

test('E7-9. validate: custom-field whitelist (wildcard vs restricted; allow-unknown warn vs error)', () => {
  // FORM: allowedCustomFields ['*'] → any custom key OK
  assert.equal(E.validateAgainstPolicy({ Title: 'X', Owner: 'o', CustomFields: { anything: 1 } }, 'FORM').errors.some((e) => e.code === 'CUSTOM_NOT_ALLOWED'), false);
  // CONTROLLED_DOCUMENT: allowedCustomFields [] + allowUnknown false → not allowed → error
  assert.ok(E.validateAgainstPolicy({ Title: 'X', CustomFields: { x: 1 } }, 'CONTROLLED_DOCUMENT').errors.some((e) => e.code === 'CUSTOM_NOT_ALLOWED'));
  // policy object: allowedCustomFields [] + allowUnknown true → not allowed → warning
  const warnPolicy = { requiredFields: ['Title'], allowedCustomFields: [], allowUnknownFields: true };
  assert.ok(E.validateAgainstPolicy({ Title: 'X', CustomFields: { z: 1 } }, warnPolicy).warnings.some((w) => w.code === 'CUSTOM_NOT_ALLOWED'));
  // policy object: a specific (non-wildcard) whitelist admits listed keys, flags the rest
  const whitelist = E.validateAgainstPolicy({ Title: 'X', CustomFields: { approved: 1, other: 2 } }, { requiredFields: ['Title'], allowedCustomFields: ['approved'], allowUnknownFields: false });
  assert.equal(whitelist.unknownFields.includes('CustomFields.approved'), false); // whitelisted → allowed
  assert.equal(whitelist.unknownFields.includes('CustomFields.other'), true); // not listed → flagged
  // non-object CustomFields is ignored by the custom-field check
  noThrow(() => E.validateAgainstPolicy({ Title: 'X', CustomFields: [1] }, 'FORM'), 'array CustomFields');
});

test('E7-10. validate: resolvePolicy accepts id / policy-object / other; non-array policy fields tolerated', () => {
  assert.equal(E.validateAgainstPolicy({ Title: 'X' }, 'FORM').valid !== undefined, true); // id
  assert.equal(typeof E.validateAgainstPolicy({ Title: 'X' }, { requiredFields: ['Title'], allowUnknownFields: true }).valid, 'boolean'); // object
  assert.equal(typeof E.validateAgainstPolicy({ Title: 'X' }, 5).valid, 'boolean'); // other → UNKNOWN default
  // non-array policy list fields must not crash (they resolve to empty)
  const weird = { requiredFields: 'x', optionalFields: 'x', readOnlyFields: 'x', inheritFields: 'x', allowedCustomFields: 'x', allowUnknownFields: true, allowReservedFields: true };
  noThrow(() => E.validateAgainstPolicy({ Title: 'X', CustomFields: { k: 1 } }, weird), 'non-array fields');
});

// ---------------------------------------------------------------------------
// engine: applyDefaults
// ---------------------------------------------------------------------------

test('E7-11. applyDefaults: strips reserved / read-only / unknown per policy; toggles honoured; no mutation', () => {
  const input = { Title: 'T', CreatedBy: 'x', Weird: 1 };
  assert.deepEqual(E.applyDefaults(input, 'CONTROLLED_DOCUMENT'), { Title: 'T' }); // reserved + unknown stripped
  assert.deepEqual(input, { Title: 'T', CreatedBy: 'x', Weird: 1 }); // caller not mutated
  // ARCHIVE: non-reserved read-only 'Owner' stripped by default; kept when stripReadOnly:false
  assert.equal('Owner' in E.applyDefaults({ Title: 'T', Owner: 'o' }, 'ARCHIVE'), false);
  assert.equal('Owner' in E.applyDefaults({ Title: 'T', Owner: 'o' }, 'ARCHIVE', { stripReadOnly: false }), true);
  // permitted, non-reserved, non-readonly field is kept
  assert.deepEqual(E.applyDefaults({ Title: 'keep' }, 'NONE'), { Title: 'keep' });
  // CUSTOM allows reserved + unknown fields → both kept (exercises the "keep" branches)
  assert.deepEqual(E.applyDefaults({ Title: 'T', CreatedBy: 'sys', Weird: 1 }, 'CUSTOM'), { Title: 'T', CreatedBy: 'sys', Weird: 1 });
  // policy object with a non-array readOnlyFields must not crash (resolves to no read-only fields)
  noThrow(() => E.applyDefaults({ Title: 'T' }, { readOnlyFields: 'x', allowUnknownFields: true, allowReservedFields: true }), 'non-array readOnlyFields');
});

// ---------------------------------------------------------------------------
// engine: inheritance
// ---------------------------------------------------------------------------

test('E7-12. inherit: default + custom precedence, blocking, source shapes, deep clone', () => {
  const r = E.inheritPolicy([
    { source: 'site', policy: { requireSite: true, inheritFields: ['Site'] } },
    { source: 'parent', policy: { requireSite: false } },
  ]);
  assert.equal(r.policy.requireSite, false); // parent (highest) wins
  assert.equal(r.resolution.requireSite, 'parent');
  assert.equal(r.resolution.inheritFields, 'site'); // only site provides it
  // custom precedence
  const c = E.inheritPolicy([{ source: 'template', policy: { requireVersion: true } }, { source: 'site', policy: { requireVersion: false } }], { precedence: ['template', 'site'] });
  assert.equal(c.policy.requireVersion, false); // site now highest
  // blocking (non-string block entries ignored)
  const b = E.inheritPolicy([{ source: 'department', policy: { requireDepartment: true, requireSite: true } }], { blocked: ['requireDepartment', 42] });
  assert.equal('requireDepartment' in b.policy, false); // blocked
  assert.equal(b.policy.requireSite, true);
  // sources as a map
  const m = E.inheritPolicy({ site: { requireSite: true }, department: { requireDepartment: true } });
  assert.deepEqual(m.policy, { requireSite: true, requireDepartment: true });
  // junk + null sources tolerated
  assert.deepEqual(E.inheritPolicy([{ nope: 1 }, 'str', null, { source: 'site', policy: { requireSite: true } }]).policy, { requireSite: true });
  assert.deepEqual(E.inheritPolicy(null).policy, {});
  // deep clone of inherited arrays
  const arr = ['Site'];
  const inh = E.inheritPolicy([{ source: 'site', policy: { inheritFields: arr } }]);
  assert.notEqual(inh.policy.inheritFields, arr);
  // an empty precedence array falls back to the default precedence
  assert.equal(E.inheritPolicy([{ source: 'site', policy: { requireSite: true } }], { precedence: [] }).resolution.requireSite, 'site');
});

// ---------------------------------------------------------------------------
// engine: merge / compare / normalize / freeze / clone
// ---------------------------------------------------------------------------

test('E7-13. merge: overwrite / keepExisting / union arrays / replace arrays; non-object base', () => {
  assert.deepEqual(E.mergePolicies({ a: 1 }, { b: 2 }), { a: 1, b: 2 }); // new key
  assert.deepEqual(E.mergePolicies({ a: 1 }, { a: 2 }), { a: 2 }); // scalar overwrite
  assert.deepEqual(E.mergePolicies({ a: 1 }, { a: 2 }, { strategy: 'keepExisting' }), { a: 1 });
  assert.deepEqual(E.mergePolicies({ r: ['Title'] }, { r: ['Owner'] }).r, ['Owner']); // array replace overwrite
  assert.deepEqual(E.mergePolicies({ r: ['Title'] }, { r: ['Owner'] }, { strategy: 'keepExisting' }).r, ['Title']); // array replace keep
  assert.deepEqual(E.mergePolicies({ r: ['Title', 'Owner'] }, { r: ['Owner', 'Version'] }, { arrays: 'union' }).r, ['Title', 'Owner', 'Version']);
  assert.deepEqual(E.mergePolicies(5, { a: 1 }), { a: 1 }); // non-object base
  assert.deepEqual(E.mergePolicies({ r: ['a'] }, { r: 5 }), { r: 5 }); // array base + scalar incoming → overwrite
  // uniq keyOf: object + null elements
  assert.deepEqual(E.mergePolicies({ r: [{ a: 1 }, null] }, { r: [{ a: 1 }, { a: 2 }, null] }, { arrays: 'union' }).r, [{ a: 1 }, null, { a: 2 }]);
});

test('E7-14. compare: added / removed / modified / unchanged; deepEqual across types; non-objects', () => {
  const d = E.comparePolicies({ a: 1, b: [1], c: { x: 1 }, same: 1 }, { a: 2, b: [1], c: { x: 2 }, extra: 9 });
  assert.deepEqual(d.added, ['extra']);
  assert.deepEqual(d.removed, ['same'].sort()); // 'same' only in A
  assert.deepEqual(d.modified.sort(), ['a', 'c']);
  assert.deepEqual(d.unchanged, ['b']);
  assert.deepEqual(E.comparePolicies(5, 6), { added: [], removed: [], modified: [], unchanged: [] }); // non-objects
  const diff = (av, bv) => E.comparePolicies({ F: av }, { F: bv }).modified.length === 1;
  assert.equal(diff([1], [1, 2]), true);
  assert.equal(diff([1], [2]), true);
  assert.equal(diff([1], { x: 1 }), true);
  assert.equal(diff({ x: 1 }, [1]), true);
  assert.equal(diff({ a: 1 }, { a: 1, b: 2 }), true);
  assert.equal(diff({ a: 1 }, { b: 1 }), true);
  assert.equal(diff({ a: 1 }, { a: 2 }), true);
  assert.equal(diff(1, '1'), true);
  assert.equal(E.comparePolicies({ F: { a: [1] } }, { F: { a: [1] } }).unchanged.length, 1);
});

test('E7-15. normalize: stable ordering, trim, dedupe, sort arrays; scalars cloned; extras sorted after', () => {
  const out = E.normalizePolicy({
    zExtra: true, id: 'X', displayName: '  Name  ',
    requiredFields: [' b ', 'a', 'a', ''], futureReserved: [2, 1, 1], allowUnknownFields: true,
  });
  assert.deepEqual(Object.keys(out), ['id', 'displayName', 'requiredFields', 'allowUnknownFields', 'futureReserved', 'zExtra']); // canonical then extras
  assert.equal(out.displayName, 'Name');
  assert.deepEqual(out.requiredFields, ['a', 'b']); // trimmed, deduped, sorted, empty dropped
  assert.deepEqual(out.futureReserved, [1, 2]); // non-string elements deduped + sorted
  assert.equal(out.allowUnknownFields, true); // boolean cloned through
  // dedupe of object/null array elements (keyOf branches)
  assert.deepEqual(E.normalizePolicy({ optionalFields: [null, null] }).optionalFields, [null]);
});

test('E7-16. freeze + clone: deep, never freeze/mutate caller; non-object coerced', () => {
  const src = { requiredFields: ['Title'], nested: { a: 1 } };
  const frozen = E.freezePolicy(src);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.requiredFields) && Object.isFrozen(frozen.nested));
  assert.equal(Object.isFrozen(src), false); // caller not frozen
  const clone = E.clonePolicy(src);
  assert.notEqual(clone, src);
  assert.notEqual(clone.requiredFields, src.requiredFields);
  assert.deepEqual(clone, src);
  assert.deepEqual(E.clonePolicy(5), {});
  assert.deepEqual(E.freezePolicy(5), {});
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E7-17. never throws: every engine + registry method tolerates hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { requiredFields: 7 }, { CustomFields: 5 }];
  for (const a of hostile) {
    noThrow(() => P.getMetadataPolicy(a), 'getMetadataPolicy');
    noThrow(() => P.isKnownMetadataPolicy(a), 'isKnownMetadataPolicy');
    noThrow(() => E.getPolicy(a), 'getPolicy');
    noThrow(() => E.validateAgainstPolicy(a, a), 'validateAgainstPolicy');
    noThrow(() => E.applyDefaults(a, a, a), 'applyDefaults');
    noThrow(() => E.inheritPolicy(a, a), 'inheritPolicy');
    noThrow(() => E.mergePolicies(a, a, a), 'mergePolicies');
    noThrow(() => E.comparePolicies(a, a), 'comparePolicies');
    noThrow(() => E.normalizePolicy(a), 'normalizePolicy');
    noThrow(() => E.freezePolicy(a), 'freezePolicy');
    noThrow(() => E.clonePolicy(a), 'clonePolicy');
  }
});

test('E7-18. deterministic: identical inputs produce identical output', () => {
  const meta = { Title: 'X', Owner: 'o', CustomFields: { k: 1 } };
  assert.deepEqual(E.validateAgainstPolicy(meta, 'CONTROLLED_DOCUMENT'), E.validateAgainstPolicy(meta, 'CONTROLLED_DOCUMENT'));
  const srcs = [{ source: 'site', policy: { requireSite: true } }, { source: 'parent', policy: { requireSite: false } }];
  assert.deepEqual(E.inheritPolicy(srcs), E.inheritPolicy(srcs));
  assert.deepEqual(E.normalizePolicy(P.getMetadataPolicy('STANDARD_OPERATING_PROCEDURE')), E.normalizePolicy(P.getMetadataPolicy('STANDARD_OPERATING_PROCEDURE')));
});

// ---------------------------------------------------------------------------
// unwired requirement
// ---------------------------------------------------------------------------

test('E7-19. policy modules import nothing from production', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/|\/numbering\/)/;
  const files = ['metadata-policy.js', 'metadata-policy-engine.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(MDIR, f), 'utf8');
    assert.ok(!FORBIDDEN.test(src), `${f} has no forbidden production import`);
    const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
    for (const r of requires) {
      assert.ok(/require\((['"])\.\/metadata-policy\1\)/.test(r), `${f} only requires the sibling policy registry (found ${r})`);
    }
  }
});

test('E7-20. policy engine is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
