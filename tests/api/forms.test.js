// WP-07 · C9 — Form template API tests (CRUD + field persistence).
// Isolated harness; temporary DB + session storage; synthetic data only.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('../helpers/app');

let app;
before(async () => { app = await startTestApp(); });
after(async () => { if (app) await app.close(); });

// 11. Unauthenticated access → 401.
test('11. unauthenticated /api/forms/templates returns 401', async () => {
  assert.equal((await app.request('GET', '/api/forms/templates', null, null)).status, 401);
});

// 6/7. Create a template with fields; fields persist and are retrievable.
test('6/7. form template CRUD and field persistence', async () => {
  const created = await app.request('POST', '/api/forms/templates', {
    Name: 'C9 Form', PassMark: 80,
    fields: [
      { FieldType: 'section', Label: 'Section A' },
      { FieldType: 'text', Label: 'Operator Name' },
      { FieldType: 'grid', Label: 'Checklist', Options: { columns: [{ key: 'c0', label: 'Item' }, { key: 'c1', label: 'OK', check: true }], rows: [{ cells: { c0: 'Row 1' } }] } },
    ],
  });
  assert.equal(created.status, 200);
  const id = created.json().TemplateID;
  assert.ok(id > 0, 'returns TemplateID');

  const got = await app.request('GET', `/api/forms/templates/${id}`);
  assert.equal(got.status, 200);
  const fields = got.json().fields;
  assert.ok(Array.isArray(fields) && fields.length === 3, 'three fields persisted');
  assert.ok(fields.some((f) => f.Label === 'Operator Name' && f.FieldType === 'text'), 'text field persisted');
  assert.ok(fields.some((f) => f.FieldType === 'grid'), 'grid field persisted');
});

// CRUD delete completes the lifecycle.
test('form template delete works', async () => {
  const created = await app.request('POST', '/api/forms/templates', { Name: 'C9 Delete Me', PassMark: 80, fields: [{ FieldType: 'text', Label: 'X' }] });
  const id = created.json().TemplateID;
  const del = await app.request('DELETE', `/api/forms/templates/${id}`);
  assert.equal(del.status, 200);
  const list = await app.request('GET', '/api/forms/templates');
  assert.ok(!list.json().some((t) => t.TemplateID === id), 'deleted template no longer listed');
});
