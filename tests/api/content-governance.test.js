// Governance workflow on the live tblFiles model (R1 versioning, R2 approvals, R4/R5 RBAC,
// protected-value check). Runs against an isolated in-process app + throwaway DB. No AI calls.
const { test } = require('node:test');
const assert = require('node:assert');
const { startTestApp } = require('../helpers/app');

// Minimal doc payload (no AI needed — /save builds a DOCX from the structured data).
const docPayload = (body = 'v1 body') => ({
  type: 'sop',
  destination: 'library',
  data: { title: '__TEST_DOC__', docNumber: 'T-1', sections: [{ heading: 'Purpose', body, level: 1 }] },
});

async function loginAs(t, username, password) {
  const r = await t.rawRequest(t.baseUrl, 'POST', '/api/auth/login', { username, password });
  assert.equal(r.status, 200, 'login should succeed');
  return (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
}

test('version snapshot on edit + status lifecycle + download gate + restore', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  // Create a document (admin).
  let r = await app.request('POST', '/api/content/save', docPayload('v1 body'));
  assert.equal(r.status, 200, 'save ok');
  const fileId = r.json().fileId;
  assert.ok(fileId, 'returns fileId');

  // Fresh doc: Draft, v1, no versions.
  r = await app.request('GET', `/api/content/doc/${fileId}/governance`);
  assert.equal(r.json().Status, 'Draft');
  assert.equal(r.json().Version, 1);
  assert.equal(r.json().versions.length, 0);

  // Edit → v2, previous snapshotted, status still Draft.
  r = await app.request('PUT', `/api/content/ts-doc/${fileId}`, {
    type: 'sop', changeNote: 'edit', data: { title: '__TEST_DOC__', sections: [{ heading: 'Purpose', body: 'v2 body', level: 1 }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json().version, 2);
  r = await app.request('GET', `/api/content/doc/${fileId}/governance`);
  assert.equal(r.json().Version, 2);
  assert.equal(r.json().versions.length, 1, 'v1 snapshot recorded');

  // Lifecycle: submit → approve → publish.
  assert.equal((await app.request('POST', `/api/content/doc-status/${fileId}`, { action: 'submit' })).json().status, 'Under Review');
  assert.equal((await app.request('POST', `/api/content/doc-status/${fileId}`, { action: 'approve' })).json().status, 'Approved');
  assert.equal((await app.request('POST', `/api/content/doc-status/${fileId}`, { action: 'publish' })).json().status, 'Published');

  // Restore v1 → new version, back to Draft.
  const versId = (await app.request('GET', `/api/content/doc/${fileId}/governance`)).json().versions[0].VersionID;
  r = await app.request('POST', `/api/content/doc-version/${versId}/restore`, {});
  assert.equal(r.status, 200);
  assert.equal(r.json().restoredFrom, 1);
  assert.equal((await app.request('GET', `/api/content/doc/${fileId}/governance`)).json().Status, 'Draft');
});

test('download gate: viewer blocked on Draft, allowed on Published; admin always allowed', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  // Seed a read-only viewer user (Restricted → VIEWER role, no documents.write).
  await app.db.dbRun("INSERT INTO tblPswd (UserName, HashPass, Password, Admin, Restricted, UserStatus) VALUES ('viewer', '$2a$10$placeholder', 'view123', 0, 1, 'Active')");
  const viewer = await loginAs(app, 'viewer', 'view123');

  // Admin creates a draft doc.
  const fileId = (await app.request('POST', '/api/content/save', docPayload())).json().fileId;

  // Viewer cannot generate/save (R5/R4).
  assert.equal((await app.request('POST', '/api/content/save', docPayload(), viewer)).status, 403);

  // Viewer cannot download an unapproved draft (R2); admin can.
  assert.equal((await app.request('GET', `/api/files/download/${fileId}`, null, viewer)).status, 403);
  assert.equal((await app.request('GET', `/api/files/download/${fileId}`)).status, 200);

  // Approve → publish, viewer can now download.
  await app.request('POST', `/api/content/doc-status/${fileId}`, { action: 'approve' });
  await app.request('POST', `/api/content/doc-status/${fileId}`, { action: 'publish' });
  assert.equal((await app.request('GET', `/api/files/download/${fileId}`, null, viewer)).status, 200);
});

test('protected-value check flags dropped source values (no AI)', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const r = await app.request('POST', '/api/content/validate-values', {
    sourceText: 'Isolate at 0 kPa. Max belt speed 4.5 m/s. Pass 80%.',
    data: { title: 'x', sections: [{ heading: 'Steps', body: 'Isolate. Max belt speed 5 m/s. Pass 80%.' }] },
  });
  assert.equal(r.status, 200);
  const vc = r.json().valueCheck;
  assert.equal(vc.ok, false);
  assert.ok(vc.critical.some((x) => /0\s?kPa/i.test(x.value)));
});
