// WP-07 · C13 — Data-hygiene invariants (migrated from tests/regression.js).
// Verifies initDb's self-healing sweeps leave no orphaned rows. Temporary DB only.
require('../helpers/network-guard');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, initReady, cleanupAll } = require('../helpers/db');

after(async () => { await cleanupAll(); });

test('no orphaned translation segments after initDb', async () => {
  const { mod } = freshDb();
  await initReady(mod);
  const orphans = await mod.dbGet(
    'SELECT COUNT(*) AS c FROM tblTransSegment WHERE JobFileID NOT IN (SELECT FileID FROM tblFiles)'
  );
  assert.equal(orphans.c, 0, 'translation segments have no dangling JobFileID');
});

test('no unapproved orphaned translation memory after initDb', async () => {
  const { mod } = freshDb();
  await initReady(mod);
  const orphans = await mod.dbGet(
    "SELECT COUNT(*) AS c FROM tblTransMemory WHERE Approved=0 AND JobFileID IS NOT NULL AND JobFileID NOT IN (SELECT FileID FROM tblFiles)"
  );
  assert.equal(orphans.c, 0, 'unapproved TM rows have no dangling JobFileID');
});
