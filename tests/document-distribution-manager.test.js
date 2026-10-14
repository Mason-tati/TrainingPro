// WP-18 · E13 — Enterprise Document Distribution Engine Foundation tests.
// Exhaustively exercises the distribution manager (create/completeRecipient/failRecipient/
// acknowledgeRecipient/retryRecipient/cancelDistribution/validate/normalize/clone/freeze/
// merge/compare/snapshot) and the distribution history. Covers single + multi recipients,
// partial completion, failure, retry, acknowledgement, cancel, every derived state, hostile
// inputs, never-throw, determinism, immutability, copy-on-read, futureReserved, export
// surface, and unwired. Pure in-memory.
require('./helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const EDIR = path.join(ROOT, 'lib', 'document-engine');
const M = require(path.join(EDIR, 'document-distribution-manager.js'));
const H = require(path.join(EDIR, 'document-distribution-history.js'));
const DD = require(path.join(ROOT, 'lib', 'document', 'document-distribution.js'));

const noThrow = (fn, label) => { try { fn(); } catch (e) { assert.fail(`${label} threw: ${e && e.message}`); } };
const DT_FIELDS = ['distributionId', 'mode', 'status', 'channel', 'recipients', 'completedRecipients', 'failedRecipients', 'pendingRecipients', 'requiresAcknowledgement', 'acknowledgedRecipients', 'deliveryAttempts', 'comments', 'metadata', 'futureReserved'];
// a known mode with a non-empty allowedChannels (for channel validation) and (if any) one with empty
const CHANNELLED = DD.DOCUMENT_DISTRIBUTION_IDS.find((id) => DD.getDocumentDistribution(id).allowedChannels.length > 0);
const EMPTY_CHANNEL_MODE = DD.DOCUMENT_DISTRIBUTION_IDS.find((id) => DD.getDocumentDistribution(id).allowedChannels.length === 0);
const CHANNELLED_ALLOWED = DD.getDocumentDistribution(CHANNELLED).allowedChannels[0];

// ---------------------------------------------------------------------------
// manager: create
// ---------------------------------------------------------------------------

test('E13-1. createDistribution: full structure, coercion, mode/channel/ack defaults', () => {
  const d = M.createDistribution();
  assert.deepEqual(Object.keys(d), DT_FIELDS);
  assert.equal(d.status, 'PENDING');
  assert.equal(d.mode, 'NONE');
  assert.equal(d.deliveryAttempts, 0);
  assert.equal(d.requiresAcknowledgement, DD.getDocumentDistribution('NONE').requiresReadAcknowledgement); // from mode
  assert.deepEqual(d.pendingRecipients, []);
  const c = M.createDistribution({ mode: 'ALL_EMPLOYEES', status: 'IN_PROGRESS', channel: 'email', deliveryAttempts: 2.9, comments: 5, requiresAcknowledgement: false, metadata: [1], futureReserved: 'no', recipients: ['a', 'b'], completedRecipients: ['a'] });
  assert.equal(c.channel, 'email');
  assert.equal(c.deliveryAttempts, 2); // truncated
  assert.equal(c.comments, '5');
  assert.equal(c.requiresAcknowledgement, false); // explicit override
  assert.deepEqual(c.metadata, {});
  assert.deepEqual(c.pendingRecipients, ['b']); // recipients minus completed
  assert.equal(M.createDistribution({ mode: 'ALL_EMPLOYEES' }).channel, DD.getDocumentDistribution('ALL_EMPLOYEES').defaultChannel); // mode default channel
  assert.equal(M.createDistribution({}, { mode: 'SITE_BASED' }).mode, 'SITE_BASED');
  assert.equal(M.createDistribution({}, { defaultStatus: 'CANCELLED' }).status, 'CANCELLED');
});

// ---------------------------------------------------------------------------
// manager: recipient actions + derived states
// ---------------------------------------------------------------------------

test('E13-2. completeRecipient: single completes; partial; multi completes; invalid', () => {
  const single = M.completeRecipient(M.createDistribution({ mode: 'ALL_EMPLOYEES' }), 'alice', { comments: 'sent' });
  assert.equal(single.valid, true);
  assert.equal(single.distribution.status, 'COMPLETED'); // auto-registered single recipient, all done
  assert.deepEqual(single.distribution.completedRecipients, ['alice']);
  assert.equal(single.distribution.deliveryAttempts, 1);
  assert.equal(single.distribution.comments, 'sent');
  // partial then complete
  const d = M.createDistribution({ recipients: ['a', 'b'] });
  const p = M.completeRecipient(d, 'a');
  assert.equal(p.distribution.status, 'PARTIALLY_COMPLETED');
  assert.deepEqual(p.distribution.pendingRecipients, ['b']);
  assert.equal(M.completeRecipient(p.distribution, 'b').distribution.status, 'COMPLETED');
  // invalid: cancelled, invalid recipient, duplicate
  assert.ok(M.completeRecipient(single.distribution, 'alice').errors.some((e) => e.code === 'DUPLICATE_RECIPIENT'));
  assert.ok(M.completeRecipient(d, '  ').errors.some((e) => e.code === 'INVALID_RECIPIENT'));
});

test('E13-3. failRecipient / retryRecipient: derived FAILED / IN_PROGRESS / PENDING states', () => {
  // all fail → FAILED
  const one = M.createDistribution({ recipients: ['x'] });
  const f = M.failRecipient(one, 'x');
  assert.equal(f.distribution.status, 'FAILED');
  assert.equal(f.distribution.deliveryAttempts, 1);
  assert.ok(M.failRecipient(f.distribution, 'x').errors.some((e) => e.code === 'DUPLICATE_RECIPIENT')); // already failed
  // some fail, none done, some pending → IN_PROGRESS
  const two = M.createDistribution({ recipients: ['a', 'b'] });
  assert.equal(M.failRecipient(two, 'a').distribution.status, 'IN_PROGRESS');
  // retry the only failed → back to all-pending → PENDING
  const retried = M.retryRecipient(f.distribution, 'x');
  assert.equal(retried.distribution.status, 'PENDING');
  assert.equal(retried.distribution.deliveryAttempts, 2);
  assert.ok(M.retryRecipient(one, 'x').errors.some((e) => e.code === 'NOT_FAILED')); // not a failed recipient
  // failing a completed recipient moves them to failed
  const done = M.completeRecipient(two, 'a').distribution;
  assert.deepEqual(M.failRecipient(done, 'a').distribution.completedRecipients, []);
});

test('E13-4. acknowledgeRecipient', () => {
  const d = M.completeRecipient(M.createDistribution({ recipients: ['a', 'b'] }), 'a').distribution;
  const ack = M.acknowledgeRecipient(d, 'a', { comments: 'read' });
  assert.equal(ack.valid, true);
  assert.deepEqual(ack.distribution.acknowledgedRecipients, ['a']);
  assert.ok(M.acknowledgeRecipient(d, 'b').errors.some((e) => e.code === 'NOT_DELIVERED')); // b not completed
  assert.ok(M.acknowledgeRecipient(ack.distribution, 'a').errors.some((e) => e.code === 'DUPLICATE_ACKNOWLEDGEMENT'));
  assert.ok(M.acknowledgeRecipient(d, '  ').errors.some((e) => e.code === 'INVALID_RECIPIENT'));
});

test('E13-5. cancelDistribution + cancelled blocks all actions', () => {
  const partial = M.completeRecipient(M.createDistribution({ recipients: ['a', 'b'] }), 'a').distribution;
  const cancelled = M.cancelDistribution(partial, { comments: 'stop' });
  assert.equal(cancelled.valid, true);
  assert.equal(cancelled.distribution.status, 'CANCELLED');
  // cannot cancel a terminal distribution (COMPLETED / FAILED / CANCELLED)
  assert.equal(M.cancelDistribution(M.completeRecipient(M.createDistribution({ recipients: ['a'] }), 'a').distribution).valid, false);
  assert.equal(M.cancelDistribution(M.failRecipient(M.createDistribution({ recipients: ['a'] }), 'a').distribution).valid, false);
  assert.equal(M.cancelDistribution(cancelled.distribution).valid, false);
  // cancelled blocks every recipient action
  assert.ok(M.completeRecipient(cancelled.distribution, 'q').errors.some((e) => e.code === 'NOT_DISTRIBUTABLE'));
  assert.ok(M.failRecipient(cancelled.distribution, 'q').errors.some((e) => e.code === 'NOT_DISTRIBUTABLE'));
  assert.ok(M.retryRecipient(cancelled.distribution, 'q').errors.some((e) => e.code === 'NOT_DISTRIBUTABLE'));
  assert.ok(M.acknowledgeRecipient(cancelled.distribution, 'q').errors.some((e) => e.code === 'NOT_DISTRIBUTABLE'));
});

// ---------------------------------------------------------------------------
// manager: validation
// ---------------------------------------------------------------------------

test('E13-6. validateDistribution: shape, mode, status, channel, recipient + ack consistency', () => {
  assert.equal(M.validateDistribution({ mode: CHANNELLED, status: 'PENDING', channel: CHANNELLED_ALLOWED, recipients: ['a', 'b'] }).valid, true);
  const nonObj = M.validateDistribution(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.errors[0].code, 'INVALID_DISTRIBUTION');
  const codes = (a) => M.validateDistribution(a).errors.map((e) => e.code);
  const warns = (a) => M.validateDistribution(a).warnings.map((w) => w.code);
  assert.ok(warns({ status: 'PENDING', mode: 'MADEUP' }).includes('UNKNOWN_MODE'));
  assert.ok(codes({}).includes('MISSING_STATUS'));
  assert.ok(codes({ status: 'FOO' }).includes('INVALID_STATUS'));
  assert.ok(warns({ status: 'PENDING', mode: CHANNELLED, channel: 'carrier-pigeon' }).includes('INVALID_CHANNEL'));
  assert.ok(codes({ status: 'PENDING', recipients: ['x', 'x'] }).includes('DUPLICATE_RECIPIENT'));
  assert.ok(warns({ status: 'PENDING', recipients: ['a'], completedRecipients: ['ghost'] }).includes('INCONSISTENT_RECIPIENT'));
  assert.ok(warns({ status: 'PENDING', recipients: ['a'], failedRecipients: ['ghost'] }).includes('INCONSISTENT_RECIPIENT'));
  assert.ok(warns({ status: 'PENDING', completedRecipients: ['a'], acknowledgedRecipients: ['b'] }).includes('INCONSISTENT_ACKNOWLEDGEMENT'));
  // channel check skipped when mode has empty allowedChannels or channel absent
  if (EMPTY_CHANNEL_MODE) assert.equal(M.validateDistribution({ status: 'PENDING', mode: EMPTY_CHANNEL_MODE, channel: 'anything' }).warnings.some((w) => w.code === 'INVALID_CHANNEL'), false);
  assert.equal(M.validateDistribution({ status: 'PENDING', mode: CHANNELLED }).warnings.some((w) => w.code === 'INVALID_CHANNEL'), false); // channel absent
});

// ---------------------------------------------------------------------------
// manager: normalize / merge / compare / clone / freeze / snapshot
// ---------------------------------------------------------------------------

test('E13-7. normalizeDistribution: trim strings, dedupe + sort arrays, normalize metadata', () => {
  const n = M.normalizeDistribution({ status: 'PENDING', comments: '  c  ', recipients: [' b ', 'a', 'a', ''], metadata: { b: '  y  ', a: 1, nested: { z: 2 }, arr: [3, 1, 2] }, futureReserved: [{ k: 1 }, { k: 1 }, 'x', 'x'] });
  assert.equal(n.comments, 'c');
  assert.deepEqual(n.recipients, ['a', 'b']);
  assert.deepEqual(n.metadata.nested, { z: 2 });
  assert.deepEqual(n.metadata.arr, [1, 2, 3]);
  assert.deepEqual(n.futureReserved, ['x', { k: 1 }]);
});

test('E13-8. mergeDistribution: strategies, array + object modes, non-object base', () => {
  assert.deepEqual(M.mergeDistribution({ a: 1 }, { b: 2 }), { a: 1, b: 2 });
  assert.deepEqual(M.mergeDistribution({ a: 1 }, { a: 2 }), { a: 2 });
  assert.deepEqual(M.mergeDistribution({ a: 1 }, { a: 2 }, { strategy: 'keepExisting' }), { a: 1 });
  assert.deepEqual(M.mergeDistribution({ t: [1] }, { t: [2] }).t, [2]);
  assert.deepEqual(M.mergeDistribution({ t: [1] }, { t: [2] }, { strategy: 'keepExisting' }).t, [1]);
  assert.deepEqual(M.mergeDistribution({ t: [1] }, { t: [2] }, { arrays: 'append' }).t, [1, 2]);
  assert.deepEqual(M.mergeDistribution({ t: [1, 2] }, { t: [2, 3] }, { arrays: 'union' }).t, [1, 2, 3]);
  assert.deepEqual(M.mergeDistribution({ o: { a: 1 } }, { o: { b: 2 } }, { objects: 'merge' }).o, { a: 1, b: 2 });
  assert.deepEqual(M.mergeDistribution({ o: { a: 1 } }, { o: { b: 2 } }).o, { b: 2 });
  assert.deepEqual(M.mergeDistribution({ o: { a: 1 } }, { o: { b: 2 } }, { strategy: 'keepExisting' }).o, { a: 1 });
  assert.deepEqual(M.mergeDistribution(5, { a: 1 }), { a: 1 });
});

test('E13-9. compareDistribution: added/removed/modified/unchanged + deepEqual matrix', () => {
  const d = M.compareDistribution({ status: 'PENDING', comments: 'x', metadata: { a: 1 }, same: 1 }, { status: 'COMPLETED', metadata: { a: 2 }, same: 1, extra: 9 });
  assert.deepEqual(d.added, ['extra']);
  assert.deepEqual(d.removed, ['comments']);
  assert.deepEqual(d.modified.sort(), ['metadata', 'status']);
  assert.deepEqual(d.unchanged, ['same']);
  assert.deepEqual(M.compareDistribution(5, 6), { added: [], removed: [], modified: [], unchanged: [] });
  const diff = (av, bv) => M.compareDistribution({ F: av }, { F: bv }).modified.length === 1;
  assert.equal(diff([1], [1, 2]), true);
  assert.equal(diff([1], [2]), true);
  assert.equal(diff([1], { x: 1 }), true);
  assert.equal(diff({ x: 1 }, [1]), true);
  assert.equal(diff({ a: 1 }, { a: 1, b: 2 }), true);
  assert.equal(diff({ a: 1 }, { b: 1 }), true);
  assert.equal(diff({ a: 1 }, { a: 2 }), true);
  assert.equal(diff(1, '1'), true);
  assert.equal(M.compareDistribution({ F: { a: [1] } }, { F: { a: [1] } }).unchanged.length, 1);
});

test('E13-10. clone / freeze / snapshot', () => {
  const src = { status: 'PENDING', metadata: { a: 1 }, recipients: ['x'] };
  const frozen = M.freezeDistribution(src);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.metadata) && Object.isFrozen(frozen.recipients));
  assert.equal(Object.isFrozen(src), false);
  assert.notEqual(M.cloneDistribution(src).metadata, src.metadata);
  assert.deepEqual(M.cloneDistribution(5), {});
  assert.deepEqual(M.freezeDistribution(5), {});
  const s1 = M.generateDistributionSnapshot(src);
  assert.equal(s1.schema, 'enterprise-distribution.v1');
  assert.equal(s1.digest.length, 8);
  assert.equal(s1.digest, M.generateDistributionSnapshot(src).digest);
  assert.ok(Object.isFrozen(s1) && Object.isFrozen(s1.distribution));
  assert.notEqual(s1.digest, M.generateDistributionSnapshot({ status: 'COMPLETED' }).digest);
});

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

test('E13-11. createHistory + listDistributions: structure, coercion, distributionId variants', () => {
  const h = H.createHistory({ distributionId: 'D1', mode: 'ALL_EMPLOYEES', distributions: [{ status: 'PENDING' }], metadata: { a: 1 }, futureReserved: ['r'] });
  assert.deepEqual(Object.keys(h), ['distributionId', 'mode', 'distributions', 'metadata', 'futureReserved']);
  assert.equal(h.distributionId, 'D1');
  assert.equal(H.listDistributions(h).length, 1);
  assert.equal(H.createHistory({}).distributionId, null);
  assert.equal(H.createHistory({ distributionId: null }).distributionId, null);
  assert.equal(H.createHistory({ distributionId: 7 }).distributionId, 7);
  assert.equal(H.createHistory({}).mode, 'NONE');
  assert.deepEqual(H.createHistory({ distributions: 'no', metadata: 5, futureReserved: 9 }).distributions, []);
});

test('E13-12. append / replace / remove / find', () => {
  const h = H.createHistory({ distributions: [{ distributionId: 'e1', status: 'PENDING' }] });
  const app = H.appendDistribution(h, { distributionId: 'e2', status: 'COMPLETED' });
  assert.equal(app.distributions.length, 2);
  assert.equal(h.distributions.length, 1);
  const rep = H.replaceDistribution(app, 'e1', { distributionId: 'e1', status: 'CANCELLED' });
  assert.equal(rep.distributions.find((d) => d.status === 'CANCELLED') !== undefined, true);
  assert.equal(H.replaceDistribution(app, 'none', { distributionId: 'x' }).distributions.some((d) => d.distributionId === 'x'), false);
  const rem = H.removeDistribution(app, 'e1');
  assert.equal(rem.distributions.length, 1);
  assert.equal(H.removeDistribution(app, null).distributions.length, 2);
  assert.equal(H.findDistribution(app, 'e2').distributionId, 'e2');
  assert.equal(H.findDistribution(app, 'nope'), null);
  assert.equal(H.findDistribution(app, null), null);
});

test('E13-13. find latest / previous / next; key fallback; empty', () => {
  const h = H.createHistory({ distributions: [{ distributionId: 'e1' }, { distributionId: 'e2' }, { distributionId: 'e3' }] });
  assert.equal(H.findLatest(h).distributionId, 'e3');
  assert.equal(H.findLatest({ distributions: [] }), null);
  assert.equal(H.findPrevious(h, 'e2').distributionId, 'e1');
  assert.equal(H.findPrevious(h, 'e1'), null);
  assert.equal(H.findPrevious(h, 'nope'), null);
  assert.equal(H.findNext(h, 'e2').distributionId, 'e3');
  assert.equal(H.findNext(h, 'e3'), null);
  assert.equal(H.findNext(h, 'nope'), null);
  // key fallback: no distributionId → status/mode
  const noId = H.createHistory({ distributions: [{ status: 'COMPLETED' }, { status: 'FAILED' }] });
  assert.equal(H.findDistribution(noId, 'COMPLETED').status, 'COMPLETED');
});

test('E13-14. compareHistory / validateHistory: keys, duplicates, per-distribution, nested deepEqual', () => {
  const a = H.createHistory({ distributions: [{ distributionId: 'e1' }, { distributionId: 'e2' }] });
  const b = H.createHistory({ distributions: [{ distributionId: 'e1', comments: 'edited' }, { distributionId: 'e3' }] });
  const d = H.compareHistory(a, b);
  assert.deepEqual(d.added, ['e3']);
  assert.deepEqual(d.removed, ['e2']);
  assert.deepEqual(d.modified, ['e1']);
  const same = { distributionId: 'k', metadata: { a: [1, 2] } };
  const A = H.createHistory({ distributions: [same, { distributionId: 'x', metadata: { a: 1 } }, { distributionId: 'y', recipients: ['p'] }, { distributionId: 'z', recipients: ['p'] }, { distributionId: 'w', metadata: { a: 1 } }] });
  const B = H.createHistory({ distributions: [same, { distributionId: 'x', metadata: { b: 1 } }, { distributionId: 'y', recipients: ['p', 'q'] }, { distributionId: 'z', recipients: ['q'] }, { distributionId: 'w', metadata: { a: 1, c: 2 } }] });
  const cmp = H.compareHistory(A, B);
  assert.deepEqual(cmp.unchanged, ['k']);
  assert.deepEqual(cmp.modified.sort(), ['w', 'x', 'y', 'z']);
  // validation
  assert.equal(H.validateHistory({ distributions: [{ status: 'PENDING', distributionId: 'e1' }] }).valid, true);
  const nonObj = H.validateHistory(5);
  assert.equal(nonObj.valid, false);
  assert.equal(nonObj.errors[0].code, 'INVALID_HISTORY');
  assert.ok(H.validateHistory({ distributions: 'no' }).errors.some((e) => e.code === 'INVALID_DISTRIBUTIONS'));
  const dup = H.validateHistory({ distributions: [{ status: 'PENDING', distributionId: 'e1' }, { status: 'PENDING', distributionId: 'e1' }] });
  assert.deepEqual(dup.duplicateDistributions, ['e1']);
  assert.ok(dup.errors.some((e) => e.code === 'DUPLICATE_DISTRIBUTION'));
  const bubble = H.validateHistory({ distributions: [{ status: 'FOO', distributionId: 'e1', mode: 'MADEUP' }] });
  assert.ok(bubble.errors.some((e) => e.code === 'INVALID_STATUS'));
  assert.ok(bubble.warnings.some((w) => w.code === 'UNKNOWN_MODE'));
  // a keyless raw distribution → distributionKey '' (pickString exhausts all fields)
  assert.ok(H.validateHistory({ distributions: [{}] }).errors.some((e) => e.code === 'MISSING_STATUS'));
});

test('E13-15. normalizeHistory / clone / freeze: normalized, immutable, caller-safe', () => {
  const h = { distributionId: 'D', mode: 'ALL_EMPLOYEES', distributions: [{ status: 'PENDING', recipients: ['b', 'a'] }], metadata: { b: '  y  ', a: { n: 1 } }, futureReserved: ['z'] };
  const n = H.normalizeHistory(h);
  assert.deepEqual(Object.keys(n), ['distributionId', 'mode', 'distributions', 'metadata', 'futureReserved']);
  assert.deepEqual(n.distributions[0].recipients, ['a', 'b']); // per-distribution normalized
  assert.equal(n.metadata.b, 'y');
  assert.deepEqual(n.metadata.a, { n: 1 });
  const frozen = H.freezeHistory(h);
  assert.ok(Object.isFrozen(frozen) && Object.isFrozen(frozen.distributions) && Object.isFrozen(frozen.distributions[0]));
  assert.equal(Object.isFrozen(h), false);
  assert.deepEqual(H.cloneHistory(5), {});
  assert.notEqual(H.cloneHistory(h).distributions, h.distributions);
});

// ---------------------------------------------------------------------------
// cross-cutting guarantees
// ---------------------------------------------------------------------------

test('E13-16. export surfaces are exact', () => {
  assert.deepEqual(Object.keys(M).sort(), ['acknowledgeRecipient', 'cancelDistribution', 'cloneDistribution', 'compareDistribution', 'completeRecipient', 'createDistribution', 'failRecipient', 'freezeDistribution', 'generateDistributionSnapshot', 'mergeDistribution', 'normalizeDistribution', 'retryRecipient', 'validateDistribution']);
  assert.deepEqual(Object.keys(H).sort(), ['appendDistribution', 'cloneHistory', 'compareHistory', 'createHistory', 'findDistribution', 'findLatest', 'findNext', 'findPrevious', 'freezeHistory', 'listDistributions', 'normalizeHistory', 'removeDistribution', 'replaceDistribution', 'validateHistory']);
});

test('E13-17. never throws: every method tolerates hostile inputs', () => {
  const hostile = [undefined, null, 5, 'x', true, {}, [], { status: {} }, { metadata: 5 }, { distributions: 5 }, { deliveryAttempts: 'x' }];
  for (const a of hostile) {
    for (const fn of ['createDistribution', 'validateDistribution', 'normalizeDistribution', 'cloneDistribution', 'freezeDistribution', 'generateDistributionSnapshot', 'cancelDistribution']) {
      noThrow(() => M[fn](a, a), `M.${fn}`);
    }
    for (const fn of ['completeRecipient', 'failRecipient', 'acknowledgeRecipient', 'retryRecipient']) noThrow(() => M[fn](a, a, a), `M.${fn}`);
    noThrow(() => M.mergeDistribution(a, a, a), 'M.mergeDistribution');
    noThrow(() => M.compareDistribution(a, a), 'M.compareDistribution');
    for (const fn of ['createHistory', 'findLatest', 'validateHistory', 'normalizeHistory', 'cloneHistory', 'freezeHistory', 'listDistributions']) {
      noThrow(() => H[fn](a), `H.${fn}`);
    }
    for (const fn of ['appendDistribution', 'removeDistribution', 'findDistribution', 'findPrevious', 'findNext']) {
      noThrow(() => H[fn](a, a), `H.${fn}`);
    }
    noThrow(() => H.replaceDistribution(a, a, a), 'H.replaceDistribution');
    noThrow(() => H.compareHistory(a, a), 'H.compareHistory');
  }
});

test('E13-18. deterministic + immutable; frozen input not mutated; futureReserved fresh', () => {
  const input = Object.freeze({ mode: 'ALL_EMPLOYEES', status: 'PENDING', recipients: Object.freeze(['a']), metadata: Object.freeze({ a: 1 }), futureReserved: Object.freeze(['r']) });
  const snap = JSON.parse(JSON.stringify(input));
  noThrow(() => M.createDistribution(input), 'create frozen');
  noThrow(() => M.completeRecipient(input, 'b'), 'complete frozen');
  noThrow(() => M.normalizeDistribution(input), 'normalize frozen');
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snap);
  assert.deepEqual(M.createDistribution({ status: 'PENDING' }), M.createDistribution({ status: 'PENDING' }));
  const a = M.createDistribution({ status: 'PENDING' });
  const b = M.createDistribution({ status: 'PENDING' });
  assert.notEqual(a.futureReserved, b.futureReserved);
});

// ---------------------------------------------------------------------------
// unwired requirement
// ---------------------------------------------------------------------------

test('E13-19. distribution modules import nothing from production', () => {
  const FORBIDDEN = /require\(['"][^'"]*(database\/db|express|request-context|\/logger|\/routes\/|\/server|\/services\/|\/repositories\/)/;
  for (const f of ['document-distribution-manager.js', 'document-distribution-history.js']) {
    const src = fs.readFileSync(path.join(EDIR, f), 'utf8');
    assert.ok(!FORBIDDEN.test(src), `${f} has no forbidden production import`);
    const requires = (src.match(/require\((['"])(.*?)\1\)/g) || []);
    for (const r of requires) {
      assert.ok(/require\((['"])\.\.?\//.test(r), `${f} only uses relative foundation imports (found ${r})`);
    }
  }
});

test('E13-20. distribution engine is UNWIRED: no production consumer imports lib/document-engine', () => {
  const files = [path.join(ROOT, 'server.js')];
  for (const f of fs.readdirSync(path.join(ROOT, 'routes'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'routes', f));
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) if (f.endsWith('.js')) files.push(path.join(ROOT, 'lib', f));
  for (const f of files) {
    assert.ok(!fs.readFileSync(f, 'utf8').replace(/[^\n]*server-mount-integration[^\n]*/g, '').includes('document-engine'), `${path.relative(ROOT, f)} must not import lib/document-engine`);
  }
});
