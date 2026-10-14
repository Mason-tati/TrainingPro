// Test the /translate-fields route end-to-end using the exact serialization the browser uses (JSON.stringify).
const http = require('http');
function req(opts, body) {
  return new Promise((res, rej) => {
    const r = http.request(opts, response => {
      let chunks = [];
      response.on('data', c => chunks.push(c));
      response.on('end', () => res({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', rej);
    if (body) r.write(body);
    r.end();
  });
}
(async () => {
  // 1) Log in to get a session cookie
  const loginBody = JSON.stringify({ username: 'admin', password: 'admin123' });
  const login = await req({ host: 'localhost', port: 3000, path: '/api/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginBody) } }, loginBody);
  const cookie = (login.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
  console.log('login HTTP', login.status, '| cookie:', cookie ? 'yes' : 'no');

  // 2) Fetch template #11
  const tplResp = await req({ host: 'localhost', port: 3000, path: '/api/forms/templates/11', method: 'GET', headers: { Cookie: cookie } });
  if (tplResp.status !== 200) { console.error('Template fetch failed:', tplResp.body); process.exit(1); }
  const t = JSON.parse(tplResp.body);
  console.log('Template:', t.Name, '| fields:', t.fields.length);

  // 3) Send the translate-fields request the way the frontend does
  const payload = JSON.stringify({
    targetLang: 'Thai',
    name: t.Name,
    description: t.Description || '',
    fields: t.fields.map(f => ({ FieldType: f.FieldType, Label: f.Label, HelpText: f.HelpText, Options: f.Options }))
  });
  console.log('Sending translate request (payload', payload.length, 'bytes)...');
  const t0 = Date.now();
  const r = await req({ host: 'localhost', port: 3000, path: '/api/forms/translate-fields', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Cookie: cookie } }, payload);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('HTTP', r.status, 'in', elapsed + 's');
  if (r.status !== 200) { console.error('Body:', r.body.slice(0, 800)); process.exit(1); }
  const j = JSON.parse(r.body);
  let labeled = 0, grids = 0;
  (j.items || []).forEach(it => { if (it.label) labeled++; if (it.grid && (it.grid.columns || it.grid.rows)) grids++; });
  console.log('items:', (j.items || []).length, '| labeled:', labeled, '| grids translated:', grids, '| glossary terms:', j.glossaryTerms);
  console.log('Form name  ->', j.name);
  console.log('Description->', (j.description || '').slice(0, 80));
  // Pick a translated grid + sample a cell
  const g = (j.items || []).find(it => it.grid && it.grid.columns);
  if (g) {
    console.log('Sample headers ->', g.grid.columns.slice(0, 3).map(c => "'" + c.label + "'").join(' / '));
    const row = (g.grid.rows || []).find(r => r.cells);
    if (row) {
      const k = Object.keys(row.cells)[0];
      console.log('Sample cell    ->', "'" + (row.cells[k] || '').slice(0, 120) + "'");
    }
  }
  process.exit(0);
})().catch(e => { console.error('ERROR name:', e && e.name, '| message:', e && e.message, '| stack:', e && e.stack); process.exit(1); });
