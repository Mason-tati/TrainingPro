// Seed a few TEST Training Material documents (one per folder) so the Training Material
// page and the Training Material Covers page have real items to work with.
//   node tools/seed-test-trainmat.js
// Safe/idempotent: skips a material if one with the same FileName already exists.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const { buildDocx } = require('../lib/content.js');

const DB = path.join(__dirname, '..', 'database', 'traintrack.db');
const UP = path.join(__dirname, '..', 'uploads');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const db = new sqlite3.Database(DB);
const get = (s, p = []) => new Promise((res, rej) => db.get(s, p, (e, r) => e ? rej(e) : res(r)));
const run = (s, p = []) => new Promise((res, rej) => db.run(s, p, function (e) { e ? rej(e) : res(this); }));

const MATERIALS = [
  {
    folder: 'Haul Truck Training Material',
    title: 'Haul Truck Operation — Module 1: Fundamentals',
    docNumber: 'TM-HT-001',
    subtitle: 'Haul Truck Training Material · Surface Operations',
    sections: [
      { heading: '1. Purpose', level: 1, body: 'This module introduces new operators to safe haul truck operation at Akara Resources surface mining operations.' },
      { heading: '2. Pre-Start Checks', level: 1, checklist: ['Walk-around inspection completed', 'Fluid levels checked', 'Tyres and rims inspected', 'Lights, horn and reversing alarm tested', 'Cab controls and seatbelt checked'] },
      { heading: '3. Safe Operating Practices', level: 1, body: 'Maintain safe following distances.\nObey all site speed limits.\nUse correct radio call-ups at intersections.\nNever operate fatigued.' },
      { heading: '4. Loading and Dumping', level: 1, table: { headers: ['Stage', 'Key Action', 'Hazard'], rows: [['Loading', 'Spot under excavator as directed', 'Blind spots'], ['Hauling', 'Maintain ramp discipline', 'Loss of control'], ['Dumping', 'Confirm edge protection / spotter', 'Edge failure']] } }
    ]
  },
  {
    folder: 'CAT777',
    title: 'CAT 777 Pre-Start Inspection Procedure',
    docNumber: 'TM-777-001',
    subtitle: 'CAT777 Training Material · Daily Inspection',
    sections: [
      { heading: '1. Scope', level: 1, body: 'Applies to all operators of the Caterpillar 777 rigid dump truck.' },
      { heading: '2. Daily Inspection Checklist', level: 1, checklist: ['Engine oil and coolant levels', 'Hydraulic and brake fluid', 'Tyres, rims and lock rings', 'Steering and suspension', 'Body, tray and tailgate condition', 'Lights, mirrors, camera and alarms'] },
      { heading: '3. Defect Reporting', level: 1, body: 'Record all defects on the pre-start sheet and report immediately to the supervisor. Do not operate equipment with a critical defect.' }
    ]
  },
  {
    folder: 'CAT745',
    title: 'CAT 745 Articulated Truck — Operation Basics',
    docNumber: 'TM-745-001',
    subtitle: 'CAT745 Training Material · Operation Basics',
    sections: [
      { heading: '1. Purpose', level: 1, body: 'Covers the safe operation of the Caterpillar 745 articulated dump truck in soft and uneven ground conditions.' },
      { heading: '2. Articulation and Stability', level: 1, body: 'Understand articulation steering behaviour.\nAvoid sharp turns on grades.\nKeep the load even and within rated capacity.' },
      { heading: '3. Competency Assessment', level: 1, checklist: ['Theory assessment — satisfactory', 'Practical operation observed', 'Loading/dumping demonstrated', 'Supervisor sign-off'] }
    ]
  }
];

(async () => {
  const nameCfg = await get(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`);
  const logoCfg = await get(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`);
  const companyName = nameCfg && nameCfg.cvalue ? nameCfg.cvalue.trim() : '';
  const companyLogo = logoCfg && logoCfg.cvalue ? logoCfg.cvalue : '';
  let made = 0, skipped = 0;
  for (const m of MATERIALS) {
    const fileName = `${m.title} (AI draft).docx`;
    const exists = await get('SELECT FileID FROM tblFiles WHERE FileName=? AND Folder=?', [fileName, 'training-material']);
    if (exists) { console.log('  skip (exists):', m.title); skipped++; continue; }
    const data = { title: m.title, subtitle: m.subtitle, docNumber: m.docNumber, meta: { status: 'Draft', version: '1.0' }, sections: m.sections };
    const buf = buildDocx(m.title, m.sections, { subtitle: m.subtitle, docNumber: m.docNumber, type: 'training-manual', meta: data.meta, companyName, companyLogo });
    const stored = crypto.randomBytes(16).toString('hex') + '.docx';
    fs.writeFileSync(path.join(UP, stored), buf);
    // ensure the folder/category exists
    await run('INSERT OR IGNORE INTO tblTrainMatCat (Name) VALUES (?)', [m.folder]);
    const r = await run(
      `INSERT INTO tblFiles (EntityType, EntityID, FileName, StoredName, MimeType, FileSize, Category, Description, UploadedBy, Approved, StructuredData, Folder)
       VALUES ('document', 0, ?, ?, ?, ?, ?, 'Test training material', 'seed', 1, ?, 'training-material')`,
      [fileName, stored, DOCX, buf.length, m.folder, JSON.stringify(data)]);
    console.log(`  created #${r.lastID}  [${m.folder}]  ${m.title}`);
    made++;
  }
  console.log(`\nDone. Created ${made}, skipped ${skipped}.`);
  db.close();
})().catch(e => { console.error(e); process.exit(1); });
