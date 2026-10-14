// Tenant administration + isolation (scoped slice). Isolated in-process app + throwaway DB.
const { test } = require('node:test');
const assert = require('node:assert');
const { startTestApp } = require('../helpers/app');

const docPayload = { type: 'sop', destination: 'library', data: { title: '__T__', sections: [{ heading: 'Purpose', body: 'x', level: 1 }] } };

async function loginAs(app, username, password) {
  const r = await app.rawRequest(app.baseUrl, 'POST', '/api/auth/login', { username, password });
  return r.status === 200 ? (r.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ') : null;
}

test('current tenant is the seeded org and admin can switch', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const r = await app.request('GET', '/api/tenants/current');
  assert.equal(r.status, 200);
  assert.equal(r.json().current.TenantID, 1);
  assert.equal(r.json().canSwitch, true);
});

test('create org, switch, and documents are isolated per tenant', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  // A doc in tenant 1.
  const fileId = (await app.request('POST', '/api/content/save', docPayload)).json().fileId;
  assert.ok(fileId);
  assert.ok((await app.request('GET', '/api/content/ts-docs')).json().length >= 0);
  const t1Files = (await app.request('GET', '/api/files?entityType=document')).json();
  assert.ok(t1Files.some((f) => f.FileID === fileId), 'doc visible in tenant 1');

  // Create tenant 2 and switch to it.
  const t2 = (await app.request('POST', '/api/tenants', { name: 'Second Org' })).json().tenant;
  assert.ok(t2 && t2.TenantID > 1);
  assert.equal((await app.request('POST', '/api/tenants/switch', { tenantId: t2.TenantID })).status, 200);

  // Tenant 2 sees none of tenant 1's documents.
  const t2Files = (await app.request('GET', '/api/files?entityType=document')).json();
  assert.ok(!t2Files.some((f) => f.FileID === fileId), 'tenant 1 doc hidden from tenant 2');
  assert.equal((await app.request('GET', `/api/files/download/${fileId}`)).status, 404, 'cross-tenant download blocked');

  // Switch back → doc visible again.
  await app.request('POST', '/api/tenants/switch', { tenantId: 1 });
  const back = (await app.request('GET', '/api/files?entityType=document')).json();
  assert.ok(back.some((f) => f.FileID === fileId), 'doc visible again in tenant 1');
});

test('non-admin cannot manage tenants', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  await app.db.dbRun("INSERT INTO tblPswd (UserName, HashPass, Password, Admin, Standard, UserStatus) VALUES ('worker', '$2a$10$placeholder', 'work123', 0, 1, 'Active')");
  const worker = await loginAs(app, 'worker', 'work123');
  assert.ok(worker, 'worker logged in');
  assert.equal((await app.request('POST', '/api/tenants', { name: 'X' }, worker)).status, 403);
  assert.equal((await app.request('POST', '/api/tenants/switch', { tenantId: 1 }, worker)).status, 403);
  assert.equal((await app.request('GET', '/api/tenants', null, worker)).status, 403);
});
