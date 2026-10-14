// One-time / on-demand regeneration of AI-generated .docx files from their stored
// StructuredData, using the CURRENT buildDocx. Fixes documents whose .docx on disk
// was written by an older code version (e.g. translation position, header/footer/cover).
//
// Usage:  node tools/regen-docx.js          (regenerate all AI docs)
//         node tools/regen-docx.js 48        (regenerate a single FileID)
//
// Safe: only touches tblFiles rows that HAVE StructuredData (AI-generated) and a .docx
// StoredName. Never touches manually-uploaded files. Reproducible from the database.

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { buildDocx } = require('../lib/content.js');

const DB_PATH = path.join(__dirname, '..', 'database', 'traintrack.db');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

const CAT_TO_TYPE = {
  'Exam':'exam','Assessment Form':'form','Training Request Form':'training-request',
  'Course':'course','Training Plan':'training-plan','Induction Pack':'induction',
  'Training Manual':'training-manual','Training Handout':'training-handout','Training Deck':'training-deck',
  'SOP':'sop','Safe Work Procedure':'swp','Job Safety Analysis':'jsa','Safety Alert':'safety-alert',
  'Transfer to Training':'transfer-to-training','Return to Operations':'return-to-ops',
  'Training Standards Document':'training-standards','Policy':'policy','Standard':'standard',
  'Plan':'plan','Record Form':'record-form','Checklist':'checklist'
};
const typeOf = (cat) => CAT_TO_TYPE[(cat||'').replace(/ \(AI draft\)$/i,'').trim()] || 'training-standards';

const db = new sqlite3.Database(DB_PATH);
const get = (sql, p=[]) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const all = (sql, p=[]) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const run = (sql, p=[]) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

(async () => {
  const onlyId = process.argv[2] ? parseInt(process.argv[2], 10) : null;
  const cfg = {};
  for (const row of await all(`SELECT ckey, cvalue FROM tblConfig WHERE ckey IN ('company_name','company_logo')`)) cfg[row.ckey] = row.cvalue;

  const where = onlyId ? 'FileID=?' : "StructuredData IS NOT NULL AND StoredName LIKE '%.docx'";
  const rows = await all(`SELECT FileID, FileName, StoredName, Category, StructuredData FROM tblFiles WHERE ${where}`, onlyId ? [onlyId] : []);

  let done = 0, skipped = 0;
  for (const r of rows) {
    if (!r.StructuredData || !/\.docx$/i.test(r.StoredName || '')) { skipped++; continue; }
    let data;
    try { data = JSON.parse(r.StructuredData); } catch { console.log(`  SKIP #${r.FileID} (bad JSON)`); skipped++; continue; }
    const buf = buildDocx(data.title || r.FileName, data.sections || [], {
      subtitle: data.subtitle || '', docNumber: data.docNumber || '', type: typeOf(r.Category),
      meta: data.meta || {}, transLayout: data.transLayout || 'below',
      companyName: (cfg.company_name || '').trim(), companyLogo: cfg.company_logo || ''
    });
    fs.writeFileSync(path.join(UPLOAD_DIR, r.StoredName), buf);
    await run(`UPDATE tblFiles SET FileSize=? WHERE FileID=?`, [buf.length, r.FileID]);
    console.log(`  regenerated #${r.FileID}  ${(data.transLayout||'below').padEnd(5)}  ${String(r.FileName).slice(0,50)}`);
    done++;
  }
  console.log(`\nDone. Regenerated ${done} file(s), skipped ${skipped}.`);
  db.close();
})().catch(e => { console.error(e); process.exit(1); });
