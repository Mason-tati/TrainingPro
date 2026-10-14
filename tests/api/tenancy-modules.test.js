// Cross-tenant isolation for enforced CRUD modules (competency, equipment, leave). Exercises
// each INSERT (catches param-alignment bugs) and read filtering after a tenant switch.
const { test } = require('node:test');
const assert = require('node:assert');
const { startTestApp } = require('../helpers/app');

async function newTenant(app, name) {
  const r = await app.request('POST', '/api/tenants', { name });
  return r.json().tenant.TenantID;
}
async function switchTo(app, id) { return app.request('POST', '/api/tenants/switch', { tenantId: id }); }

test('competency frameworks are tenant-isolated', async (t) => {
  const app = await startTestApp(); t.after(() => app.close());
  const created = await app.request('POST', '/api/competency/frameworks', { name: 'FW-T1', description: 'x' });
  assert.equal(created.status, 200, 'framework created (insert params aligned)');
  assert.ok((await app.request('GET', '/api/competency/frameworks')).json().some((f) => f.Name === 'FW-T1'), 'visible in tenant 1');
  await switchTo(app, await newTenant(app, 'Org B'));
  assert.ok(!(await app.request('GET', '/api/competency/frameworks')).json().some((f) => f.Name === 'FW-T1'), 'hidden in tenant 2');
});

test('equipment types are tenant-isolated', async (t) => {
  const app = await startTestApp(); t.after(() => app.close());
  const created = await app.request('POST', '/api/equipment/types', { Name: 'EQ-T1', Category: 'Haul Truck' });
  assert.equal(created.status, 200, 'equipment type created (insert params aligned)');
  assert.ok((await app.request('GET', '/api/equipment/types')).json().some((e) => e.Name === 'EQ-T1'), 'visible in tenant 1');
  await switchTo(app, await newTenant(app, 'Org B'));
  assert.ok(!(await app.request('GET', '/api/equipment/types')).json().some((e) => e.Name === 'EQ-T1'), 'hidden in tenant 2');
});

test('leave types are tenant-isolated', async (t) => {
  const app = await startTestApp(); t.after(() => app.close());
  const created = await app.request('POST', '/api/leave/types', { Name: 'LV-T1', Paid: true, DefaultDays: 5 });
  assert.equal(created.status, 200, 'leave type created (insert params aligned)');
  assert.ok((await app.request('GET', '/api/leave/types')).json().some((l) => l.Name === 'LV-T1'), 'visible in tenant 1');
  await switchTo(app, await newTenant(app, 'Org B'));
  assert.ok(!(await app.request('GET', '/api/leave/types')).json().some((l) => l.Name === 'LV-T1'), 'hidden in tenant 2');
});
