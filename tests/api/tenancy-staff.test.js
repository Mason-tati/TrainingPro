// Full multi-tenant enforcement — staff module (reference pattern). Isolated in-process app.
const { test } = require('node:test');
const assert = require('node:assert');
const { startTestApp } = require('../helpers/app');

test('staff records are isolated per tenant (list/get/update)', async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());

  // Create a staff member in tenant 1 (admin default).
  const r1 = await app.request('POST', '/api/staff', { LastName: 'One', FirstName: 'Tenant', Status: 'Active', FileNum: 'T1-001' });
  assert.equal(r1.status, 200);
  const staffId = r1.json().StaffID;
  assert.ok(staffId);

  // Visible + fetchable in tenant 1.
  assert.ok((await app.request('GET', '/api/staff')).json().some((s) => s.StaffID === staffId));
  assert.equal((await app.request('GET', `/api/staff/${staffId}`)).status, 200);

  // Switch to a new tenant → the staff record is invisible and not fetchable.
  const t2 = (await app.request('POST', '/api/tenants', { name: 'Org Two' })).json().tenant;
  await app.request('POST', '/api/tenants/switch', { tenantId: t2.TenantID });

  assert.ok(!(await app.request('GET', '/api/staff')).json().some((s) => s.StaffID === staffId), 'staff hidden cross-tenant');
  assert.equal((await app.request('GET', `/api/staff/${staffId}`)).status, 404, 'cross-tenant get blocked');

  // Cross-tenant update does not affect the tenant-1 record.
  await app.request('PUT', `/api/staff/${staffId}`, { LastName: 'HACKED', FirstName: 'X', Status: 'Active' });
  await app.request('POST', '/api/tenants/switch', { tenantId: 1 });
  assert.equal((await app.request('GET', `/api/staff/${staffId}`)).json().LastName, 'One', 'cross-tenant update was blocked');

  // A staff member created in tenant 2 stays in tenant 2.
  await app.request('POST', '/api/tenants/switch', { tenantId: t2.TenantID });
  const r2 = await app.request('POST', '/api/staff', { LastName: 'Two', FirstName: 'Tenant', Status: 'Active', FileNum: 'T2-001' });
  const staff2 = r2.json().StaffID;
  await app.request('POST', '/api/tenants/switch', { tenantId: 1 });
  assert.ok(!(await app.request('GET', '/api/staff')).json().some((s) => s.StaffID === staff2), 'tenant-2 staff hidden from tenant 1');
});
