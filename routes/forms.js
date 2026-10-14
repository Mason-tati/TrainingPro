const express = require('express');
const router = express.Router();
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');
const { recordLegacyAudit } = require('../lib/governance/audit-adapter'); // WP-16 M5 — sanitizing audit (medium-risk; AI content dropped, identifiers masked/capped)
// WP-10 A6.4 — AI calls go through the central AI Gateway (byte-identical passthrough).
const aiGateway = require('../lib/ai-gateway');
const mailer = require('../lib/mailer');
const { fireWorkflow } = require('../lib/workflow');
const { translateSection } = require('../lib/content');
const { formTemplateToDocx } = require('../lib/form-export');

router.use(requireAuth);

// Company branding (name + logo) for generated documents, mirroring the Content Studio save path.
async function companyBranding() {
  const [nameCfg, logoCfg] = await Promise.all([
    dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
    dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, []),
  ]);
  return {
    companyName: (nameCfg && nameCfg.cvalue) ? nameCfg.cvalue.trim() : '',
    companyLogo: (logoCfg && logoCfg.cvalue) ? logoCfg.cvalue : '',
  };
}
function sendDocx(res, buffer, filename) {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${String(filename).replace(/"/g, '')}"`);
  res.send(buffer);
}

// File a generated form .docx into a chosen destination folder (reusing the shared tblFiles.Folder store,
// same as the Content Studio save). Returns { fileId, folder, message } on success, or { error } on a bad
// destination / missing category. Saving to 'template-forms' makes it a reusable Template Form.
const SAVE_FOLDERS = ['library', 'training-standards', 'training-material', 'template-forms'];
const FOLDER_LABEL = {
  library: 'Document Library', 'training-standards': 'Training Standards',
  'training-material': 'Training Material', 'template-forms': 'Template Forms',
};
async function saveFormDocToFolder(buffer, baseName, opts, user) {
  const folder = (opts && opts.folder) || 'library';
  if (!SAVE_FOLDERS.includes(folder)) return { error: 'Invalid destination.' };
  let category = null;
  if (folder === 'training-material') {
    category = String((opts && opts.materialCategory) || '').trim();
    if (!category) return { error: 'Choose (or add) a Training Material category.' };
    await dbRun('INSERT OR IGNORE INTO tblTrainMatCat (Name) VALUES (?)', [category]);
  }
  const clean = String(baseName || 'Form').replace(/[<>:"/\\|?*]+/g, '').trim() || 'Form';
  const stored = crypto.randomBytes(16).toString('hex') + '.docx';
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buffer);
  const entityType = folder === 'template-forms' ? 'template-form' : 'document';
  const r = await dbRun(
    `INSERT INTO tblFiles (EntityType, EntityID, FileName, StoredName, MimeType, FileSize, Category, Description, UploadedBy, Approved, Folder)
     VALUES (?, 0, ?, ?, ?, ?, ?, 'Saved from Form Builder', ?, 1, ?)`,
    [entityType, clean + '.docx', stored, DOCX_MIME, buffer.length, category, user, folder]);
  const label = category ? `${FOLDER_LABEL[folder]} → ${category}` : FOLDER_LABEL[folder];
  return { fileId: r.lastID, folder, category, fileName: clean + '.docx', message: `Form saved to ${label}.` };
}

// Resolve the candidate's area supervisor (SupID -> tblEmpSup -> Supervisor text), with an email if available.
async function findAreaSupervisor(empId) {
  const staff = await dbGet('SELECT SupID, Supervisor FROM tblStaff WHERE StaffID=?', [empId]);
  if (!staff) return null;
  if (staff.SupID) {
    const s = await dbGet('SELECT FirstName, LastName, Email FROM tblStaff WHERE StaffID=?', [staff.SupID]);
    if (s) return { name: `${s.FirstName} ${s.LastName}`.trim(), email: s.Email };
  }
  const es = await dbGet(`SELECT s.FirstName, s.LastName, s.Email FROM tblEmpSup e JOIN tblStaff s ON e.SupID=s.StaffID
    WHERE e.EmpID=? ORDER BY e.EmpSupID DESC LIMIT 1`, [empId]);
  if (es) return { name: `${es.FirstName} ${es.LastName}`.trim(), email: es.Email };
  if (staff.Supervisor) {
    // Try to match the free-text supervisor name to a staff email
    const byName = await dbGet(`SELECT FirstName, LastName, Email FROM tblStaff
      WHERE (FirstName||' '||LastName)=? OR (LastName||', '||FirstName)=? COLLATE NOCASE`, [staff.Supervisor, staff.Supervisor]);
    if (byName) return { name: staff.Supervisor, email: byName.Email };
    return { name: staff.Supervisor, email: null };
  }
  return null;
}

function supervisorEmailHtml(o) {
  const sig = (label, src) => `<div style="margin-top:10px"><div style="font-size:11px;color:#777">${label}</div>
    <img src="${src}" style="border:1px solid #ccc;border-radius:6px;height:90px;background:#fff"></div>`;
  return `<div style="font-family:Arial,sans-serif;max-width:640px;color:#1a1d28">
    <h2 style="color:#F58220">Competency Assessment — Area Supervisor Sign-off Required</h2>
    <p>Dear ${o.supName || 'Supervisor'},</p>
    <p>A field competency assessment has been completed and the candidate assessed <strong>COMPETENT</strong>.
    As the candidate's area supervisor, your signature is required to confirm you take responsibility for the candidate operating this equipment.</p>
    <table style="border-collapse:collapse;font-size:13px;margin:12px 0">
      <tr><td style="padding:4px 10px;color:#777">Assessment</td><td style="padding:4px 10px"><strong>${o.tmpl.Name}</strong></td></tr>
      <tr><td style="padding:4px 10px;color:#777">Candidate</td><td style="padding:4px 10px"><strong>${o.cand ? o.cand.FirstName + ' ' + o.cand.LastName : ''}</strong> ${o.cand && o.cand.FileNum ? '(' + o.cand.FileNum + ')' : ''}</td></tr>
      <tr><td style="padding:4px 10px;color:#777">Assessor</td><td style="padding:4px 10px">${o.trainerName || ''}</td></tr>
      <tr><td style="padding:4px 10px;color:#777">Date</td><td style="padding:4px 10px">${o.assessDate || ''}</td></tr>
      <tr><td style="padding:4px 10px;color:#777">Location</td><td style="padding:4px 10px">${o.location || ''}</td></tr>
      <tr><td style="padding:4px 10px;color:#777">Result</td><td style="padding:4px 10px"><strong style="color:#10b981">${o.scorePct}% — COMPETENT</strong></td></tr>
    </table>
    ${sig('Candidate signature', o.traineeSig)}
    ${sig('Assessor signature', o.trainerSig)}
    <p style="margin-top:16px">Please open <strong>TrainingPro</strong> and add your Area Manager signature to assessment record <strong>#${o.submissionId}</strong> to complete the sign-off.</p>
    <p style="color:#777;font-size:12px">This is an automated message from TrainingPro.</p>
  </div>`;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// ---- Parse an uploaded .docx into editable form fields (faithful reproduction) ----
// Wingdings / symbol-font checkbox glyphs commonly used for tick boxes in Word forms.
const WINGDINGS_CHECKED = new Set(['F0FE','F0FD','F0FC','F0FB','F0FA','F052','F0A4']); // ticked / crossed boxes
const WINGDINGS_EMPTY   = new Set(['F0A8','F06F','F071','F072','F0A1','F0A2']);          // empty squares/boxes

// Extract readable text from any chunk: <w:t> runs, <w:sym> checkbox glyphs, tabs and line breaks — in document order.
function xmlText(s) {
  if (!s) return '';
  var out = '';
  var re = /<w:t[ >][\s\S]*?<\/w:t>|<w:sym\b[^>]*\/>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>|<w:cr\b[^>]*\/?>/g;
  var m;
  var BOX = String.fromCharCode(0x2610), BOXC = String.fromCharCode(0x2611);
  while ((m = re.exec(s))) {
    var tok = m[0];
    if (tok.indexOf('<w:sym') === 0) {
      var ch = (tok.match(/w:char="([0-9A-Fa-f]+)"/) || ['', ''])[1].toUpperCase();
      if (WINGDINGS_CHECKED.has(ch)) out += BOXC;
      else if (WINGDINGS_EMPTY.has(ch)) out += BOX;
    } else if (tok.indexOf('<w:tab') === 0) out += ' ';
    else if (tok.indexOf('<w:br') === 0 || tok.indexOf('<w:cr') === 0) out += '\n';
    else out += tok.replace(/<[^>]+>/g, '');
  }
  // Convert / strip symbol-font Private-Use glyphs (Wingdings checkboxes stored as literal F0xx text chars)
  var cleaned = '';
  for (var i = 0; i < out.length; i++) {
    var cp = out.charCodeAt(i);
    if (cp >= 0xE000 && cp <= 0xF8FF) {
      if (cp === 0xF0FE || cp === 0xF0FD || cp === 0xF0FC || cp === 0xF0FB || cp === 0xF052 || cp === 0xF0A4) cleaned += BOXC;
      else if (cp === 0xF0A8 || cp === 0xF06F || cp === 0xF071 || cp === 0xF072 || cp === 0xF0A1 || cp === 0xF0A2 || cp === 0xF06E) cleaned += BOX;
      // otherwise drop the decorative glyph (spaces, bullets, arrows)
    } else if (cp === 0xFFFD) {
      // drop replacement character
    } else cleaned += out[i];
  }
  return cleaned
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}
function paraText(p) { return xmlText(p); }

// ---- Word list numbering (numbering.xml) ----
let _numFmt = {}; // numId -> { ilvl -> format }
function loadNumbering(zip) {
  _numFmt = {};
  let xml; try { xml = zip.readAsText('word/numbering.xml'); } catch (e) { return; }
  if (!xml) return;
  const num2abs = {};
  (xml.match(/<w:num\s+w:numId="(\d+)"[\s\S]*?<\/w:num>/g) || []).forEach(b => {
    const id = (b.match(/w:numId="(\d+)"/) || [])[1];
    const abs = (b.match(/<w:abstractNumId\s+w:val="(\d+)"/) || [])[1];
    if (id && abs) num2abs[id] = abs;
  });
  const absFmt = {};
  (xml.match(/<w:abstractNum\s+w:abstractNumId="(\d+)"[\s\S]*?<\/w:abstractNum>/g) || []).forEach(b => {
    const abs = (b.match(/w:abstractNumId="(\d+)"/) || [])[1];
    const lvls = {};
    (b.match(/<w:lvl\s+w:ilvl="(\d+)"[\s\S]*?<\/w:lvl>/g) || []).forEach(l => {
      const il = (l.match(/w:ilvl="(\d+)"/) || [])[1];
      const fmt = (l.match(/<w:numFmt\s+w:val="(\w+)"/) || [])[1] || 'bullet';
      lvls[il] = fmt;
    });
    absFmt[abs] = lvls;
  });
  Object.keys(num2abs).forEach(id => { _numFmt[id] = absFmt[num2abs[id]] || {}; });
}
function listFmt(numId, ilvl) { const m = _numFmt[numId]; return m ? (m[ilvl] || m['0'] || 'bullet') : 'bullet'; }

// Extract a table cell preserving paragraph breaks and list markers (real numbers / bullets),
// so each numbered or bulleted item lands on its own line.
function cellText(tc) {
  const paras = tc && tc.match(/<w:p\b[\s\S]*?<\/w:p>/g);
  if (!paras || paras.length <= 1) return xmlText(tc);
  const lines = [];
  const counters = {};
  for (const p of paras) {
    const t = xmlText(p);
    if (!t) continue;
    const np = p.match(/<w:numPr>[\s\S]*?<\/w:numPr>/);
    let prefix = '';
    if (np && !/^[☐☑•]/.test(t) && !/^\d+\.\s/.test(t)) {
      const numId = (np[0].match(/<w:numId\s+w:val="(\d+)"/) || [])[1];
      const ilvl = (np[0].match(/<w:ilvl\s+w:val="(\d+)"/) || ['', '0'])[1] || '0';
      const fmt = listFmt(numId, ilvl);
      if (/decimal|ordinal|number|Letter|Roman/i.test(fmt)) {
        const k = numId + ':' + ilvl; counters[k] = (counters[k] || 0) + 1;
        prefix = counters[k] + '. ';
      } else prefix = '• ';
    } else if (!np) {
      // a non-list paragraph (e.g. a sub-heading) restarts the numbering for the next list
      Object.keys(counters).forEach(k => delete counters[k]);
    }
    lines.push(prefix + t);
  }
  return lines.join('\n');
}

function headingLevel(p) {
  const m = p.match(/<w:pStyle\s+w:val="(Heading(\d)|Title|Subtitle)"/);
  if (!m) return 0;
  if (m[1] === 'Title') return 1;
  if (m[1] === 'Subtitle') return 2;
  return m[2] ? parseInt(m[2]) : 0;
}
const FILLISH = /(initial|date|sign|signature|comment|result|outcome|score|mark|grade|tick|✓|complete|covered|verified|yes\s*\/\s*no|n\/a)/i;
const CHECKISH = /(tick|✓|☑|☐|covered|verified|complete|yes\s*\/\s*no|competent|y\/n)/i;

// Parse one <w:tbl> into a normalized matrix honouring the true column count, gridSpan (colspan) and vMerge.
function parseTable(tbl) {
  const colCount = (tbl.match(/<w:gridCol\b/g) || []).length || 1;
  const trBlocks = tbl.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [];
  const matrix = [];                 // matrix[r][c] = { text, span } or null (covered by a span/merge)
  const vmergeCarry = {};            // colIndex -> text being carried down by a vertical merge
  trBlocks.forEach((tr, r) => {
    const tcs = tr.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || [];
    const rowArr = new Array(colCount).fill(undefined);
    let c = 0;
    for (const tc of tcs) {
      while (c < colCount && rowArr[c] === null) c++;   // skip columns already covered
      const span = parseInt((tc.match(/<w:gridSpan\s+w:val="(\d+)"/) || [, '1'])[1], 10) || 1;
      const vMergeContinue = /<w:vMerge\s*\/>|<w:vMerge\s+w:val="continue"/.test(tc);
      const vMergeRestart  = /<w:vMerge\s+w:val="restart"/.test(tc);
      let text = cellText(tc);
      if (vMergeContinue) { text = vmergeCarry[c] != null ? '' : ''; }   // continuation cells render empty
      if (vMergeRestart) vmergeCarry[c] = text;
      rowArr[c] = { text, span };
      for (let k = 1; k < span && c + k < colCount; k++) rowArr[c + k] = null; // mark spanned columns
      c += span;
    }
    matrix.push(rowArr);
  });
  return { colCount, matrix };
}

function countTextCells(rowArr) { return (rowArr || []).filter(c => c && (c.text || '').trim()).length; }
function stripBoxes(s) { return (s || '').replace(/[☐☑]/g, '').replace(/^[\s·•‐-―-]+/, '').replace(/\s+/g, ' ').trim(); }
function hasWords(s) { return /[A-Za-z]{2,}/.test(stripBoxes(s)); }

// A genuine data table (multi-column header, repeating rows) -> keep as an editable grid.
function buildGridField(colCount, matrix) {
  const headerRow = matrix[0] || [];
  const columns = [];
  for (let i = 0; i < colCount; i++) {
    const cell = headerRow[i];
    const label = (cell && cell.text ? cell.text : '').replace(/\n/g, ' ').trim() || ('Column ' + (i + 1));
    columns.push({ key: 'c' + i, label });
  }
  const bodyRows = matrix.slice(1);
  columns.forEach((col, i) => {
    const bodyCells = bodyRows.map(r => (r[i] && r[i].text != null ? r[i].text : '')).filter(t => t !== null);
    const filled = bodyCells.filter(t => (t || '').trim()).length;
    const hasBox = bodyCells.some(t => /[☐☑]/.test(t || ''));
    // A "checklist" column holds a list of tickable items per cell (e.g. Observations).
    // Detected by header name, or by cells that hold ☐-prefixed multi-line lists.
    const isChecklist = /observ|checklist|tick all|competenc/i.test(col.label)
      || (hasBox && bodyCells.some(t => (t.match(/[☐☑]/g) || []).length >= 1 && (t.length > 22 || /\n/.test(t))));
    col.checklist = isChecklist;
    col.check = !isChecklist && (CHECKISH.test(col.label) || hasBox);
    col.fill = !col.check && !col.checklist && (FILLISH.test(col.label) || filled === 0);
  });
  const rows = [];
  bodyRows.forEach(rowArr => {
    const present = rowArr.map((cell, i) => ({ i, cell })).filter(x => x.cell);
    const nonEmpty = present.filter(x => (x.cell.text || '').trim());
    const spansAll = present.length === 1 && present[0].cell.span >= colCount;
    if (spansAll || (nonEmpty.length === 1 && (rowArr[0] && (rowArr[0].text || '').trim()) && colCount > 2)) {
      rows.push({ heading: (nonEmpty[0] ? nonEmpty[0].cell.text : '').trim() });
      return;
    }
    const cells = {};
    columns.forEach((col, i) => {
      const cell = rowArr[i];
      const t = cell && cell.text != null ? cell.text.trim() : '';
      if (col.check) { if (/☑/.test(t)) cells[col.key] = '✓'; }
      else if (!col.fill && t) cells[col.key] = t;
    });
    rows.push({ cells });
  });
  const title = columns.map(c => c.label).filter(l => !/^Column \d+$/.test(l)).join(' / ').slice(0, 90) || 'Table';
  return { FieldType: 'grid', Label: title, Options: { columns, rows } };
}

// A layout/form table (label column + merged value area) -> decompose row-by-row into real fields:
//   • full-width paragraph  -> instructions block (grouped text)
//   • label + empty value   -> text field (a box to type into)
//   • label + option cells   -> checkboxes (tick options)
//   • label + single value   -> section showing the fixed text
function decomposeLayoutTable(colCount, matrix, isFirstTable) {
  const out = [];
  matrix.forEach((rowArr, ri) => {
    const cells = rowArr.filter(Boolean);
    if (!cells.length) return;
    const firstIdx = rowArr.findIndex(c => c);
    const first = rowArr[firstIdx];
    const fullSpan = cells.length === 1 && (first.span >= colCount || colCount === 1);
    if (fullSpan) {
      const txt = (first.text || '').trim();
      if (!txt) return;
      if (isFirstTable && ri === 0) return;                       // table title -> used as the form name
      // A short "Comments / Suggestions / Feedback:" banner names a free-text area to be filled in.
      if (txt.length <= 80 && /comment|suggestion|feedback|recommendation|\bnotes?\b|\bremarks?\b/i.test(txt)) {
        out.push({ FieldType: 'textarea', Label: txt.replace(/[:：]\s*$/, '') }); return;
      }
      if (hasWords(txt) && txt.length > 80) out.push({ FieldType: 'instructions', Label: txt.split(/[.\n]/)[0].slice(0, 60), HelpText: txt });
      else out.push({ FieldType: 'section', Label: txt });
      return;
    }
    const label = stripBoxes(first.text);
    if (!label || !/[A-Za-z0-9]/.test(label)) return;            // skip junk / lone symbols
    const valueCells = cells.slice(1);
    // A "Question | Y | N" row (the value columns are just Yes/No labels) -> a Yes/No answer field.
    const ynTexts = valueCells.map(c => stripBoxes(c.text).toUpperCase().trim()).filter(Boolean);
    if (ynTexts.length && ynTexts.length <= 3 && ynTexts.every(v => /^(Y|N|YES|NO|N\/A|NA)$/.test(v))) {
      out.push({ FieldType: 'yesno', Label: label }); return;
    }
    // A single cell can hold several ☐-prefixed options (e.g. the Evidence list) — split them out.
    const rawVals = [];
    valueCells.forEach(c => {
      const t = (c.text || '').trim();
      if ((t.match(/[☐☑]/g) || []).length >= 2) t.split(/(?=[☐☑])/).forEach(part => { if (part.trim()) rawVals.push(part.trim()); });
      else rawVals.push(t);
    });
    const boxOpts = rawVals.filter(t => /[☐☑□]/.test(t)).map(stripBoxes).filter(t => hasWords(t));
    const wordOpts = rawVals.filter(t => !/[☐☑□]/.test(t) && hasWords(t) && !/^date\b/i.test(stripBoxes(t)));
    const allOpts = [...new Set([...boxOpts, ...wordOpts])];
    const hasDate = rawVals.some(t => /date/i.test(t) || /[_…]{3,}/.test(t));

    // Signature rows -> a signature field AND a matching date field
    if (/signature/i.test(label)) {
      out.push({ FieldType: 'signature', Label: label });
      out.push({ FieldType: 'date', Label: label.replace(/signature/i, '').replace(/\s+/g, ' ').trim() + ' Date' });
      return;
    }
    // Tick-box / multi-option rows -> checkbox (keep ALL options), plus a date if the row carries one
    if (boxOpts.length || allOpts.length >= 2) {
      out.push({ FieldType: 'checkbox', Label: label, Options: allOpts });
      if (hasDate) out.push({ FieldType: 'date', Label: label + ' — Date' });
      return;
    }
    // Single fixed value -> show as static text (e.g. "Unit(s) Covered: MPR0003 …")
    if (allOpts.length === 1) { out.push({ FieldType: 'section', Label: label + ': ' + allOpts[0] }); return; }
    // A date-only field
    if (/\bdate/i.test(label)) { out.push({ FieldType: 'date', Label: label }); return; }
    // Free-text comment/feedback/declaration areas -> textarea
    if (/comment|feedback|note|declaration|adjustment|observation|description|reason/i.test(label)) { out.push({ FieldType: 'textarea', Label: label }); return; }
    // Default -> a text box; add a date box too if the row had a date blank
    out.push({ FieldType: 'text', Label: label });
    if (hasDate) out.push({ FieldType: 'date', Label: label + ' Date' });
  });
  return out;
}

// A Y/N observation/answer form table — a question column plus narrow Y/N answer columns, with
// full-width "Comments/Suggestions:" banner rows between the questions — must decompose row-by-row into
// yes/no + comment fields (exactly like the Questions table), NOT collapse into a data grid with blank
// "Column 2/3/5" headers and mashed-together rows. Detect it by the tell-tale combination of interleaved
// comment banner rows and repeated Y/N answer rows; genuine data grids (Learning Criteria, registers)
// have neither.
function looksLikeAnswerForm(matrix, colCount) {
  let banners = 0, ynRows = 0;
  for (const row of (matrix || [])) {
    const present = (row || []).filter(Boolean);
    if (!present.length) continue;
    if (present.length === 1 && (present[0].span >= colCount || colCount === 1)) {
      const t = stripBoxes(present[0].text);
      if (t && t.length <= 80 && /comment|suggestion|feedback|recommendation|\bnotes?\b|\bremarks?\b/i.test(t)) banners++;
      continue;
    }
    const vals = present.slice(1).map(c => stripBoxes(c.text).toUpperCase().trim()).filter(Boolean);
    if (vals.length && vals.every(v => /^(Y|N|YES|NO|N\/A|NA)$/.test(v))) ynRows++;
  }
  return banners >= 1 && ynRows >= 2;
}

// Returns an ARRAY of fields for a table (a layout table yields several; a data table yields one grid).
function tableToFields(tbl, isFirstTable) {
  const { colCount, matrix } = parseTable(tbl);
  if (!matrix.length) return [];
  // Multi-column data table (e.g. the 7-column Learning Criteria tables) — but NOT a Y/N answer form,
  // which only looks grid-like because its first row is "question | Y | N".
  if (countTextCells(matrix[0]) >= 3 && !looksLikeAnswerForm(matrix, colCount)) return [buildGridField(colCount, matrix)];
  // 2-column data register (e.g. Supporting Evidence "Type / Description", Overall Performance) —
  // find a row that names the two columns, treat earlier rows as section titles.
  if (colCount === 2) {
    const hi = matrix.findIndex(r => countTextCells(r) === 2 && r.filter(Boolean).every(c => (c.text || '').length <= 45));
    if (hi !== -1 && matrix.length - hi >= 2) {
      const out = [];
      for (let i = 0; i < hi; i++) { const c = matrix[i].find(x => x && (x.text || '').trim()); if (c) out.push({ FieldType: 'section', Label: c.text.trim() }); }
      out.push(buildGridField(colCount, matrix.slice(hi)));
      return out;
    }
  }
  return decomposeLayoutTable(colCount, matrix, isFirstTable);
}

function parseDocxToFields(buf) {
  const zip = new AdmZip(buf);
  loadNumbering(zip);
  const xml = zip.readAsText('word/document.xml');
  const body = (xml.match(/<w:body>([\s\S]*)<\/w:body>/) || [, xml])[1];
  const blocks = [];
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(body))) blocks.push(m[0]);

  const fields = [];
  let formName = '';
  let firstTextSeen = '';
  let tableIndex = 0;
  for (const b of blocks) {
    if (b.startsWith('<w:tbl')) {
      const isFirstTable = tableIndex === 0;
      // The document title is usually the first cell of the very first (cover) table. On a bilingual
      // clone the cell holds "English   ·   translation" (or the translation on a second line) — take
      // just the English/first portion so the form name stays the real title, not title+translation.
      if (isFirstTable && !formName) {
        const { matrix } = parseTable(b);
        const t = matrix[0] && matrix[0].find(c => c && (c.text || '').trim());
        if (t) {
          const tt = t.text.split(/\n|\s+[·•]\s+/)[0].replace(/\s+/g, ' ').trim();
          if (tt.length >= 3 && tt.length <= 90) formName = tt;
        }
      }
      tableToFields(b, isFirstTable).forEach(f => fields.push(f));
      tableIndex++;
    } else {
      const txt = paraText(b);
      if (!txt) continue;
      // Skip page header/footer boilerplate that repeats on every page
      if (/^©|Pertrain Pty Ltd|^J\/N\s|Page \d+ of \d+|^Thank you\.?$|^Ambatovy Training Department$/i.test(txt)) continue;
      if (!firstTextSeen) firstTextSeen = txt;
      const lvl = headingLevel(b);
      if ((!formName || formName.length < 5) && lvl === 1) formName = txt.slice(0, 120);
      // A standalone signature line -> signature + date pair
      if (/signature/i.test(txt) && txt.length <= 60) {
        fields.push({ FieldType: 'signature', Label: txt.replace(/\s*date.*$/i, '').trim() });
        fields.push({ FieldType: 'date', Label: txt.replace(/signature/i, '').replace(/\s+/g, ' ').trim() + ' Date' });
      } else if (lvl > 0 || (txt.length <= 90 && !/[.;]$/.test(txt))) {
        // Headings and short lines -> section headings
        fields.push({ FieldType: 'section', Label: txt.length > 140 ? txt.slice(0, 140) : txt, HelpText: txt.length > 140 ? txt : undefined });
      } else {
        // Longer instructional prose -> static text block, full wording preserved
        fields.push({ FieldType: 'instructions', Label: txt.split(/[.\n]/)[0].slice(0, 60), HelpText: txt });
      }
    }
  }
  // Fall back to the first line of text only if it reads like a title (short, not a sentence) — a long
  // instructions sentence (e.g. "The purpose of the … review is for …") must NOT become the form name;
  // the caller then falls back to the document's file name instead.
  const titleish = firstTextSeen && firstTextSeen.length <= 80 && !/[.;:]\s*$/.test(firstTextSeen) ? firstTextSeen : '';
  return { name: formName || titleish, fields };
}

// ── Generate from document using MASTER TEMPLATE (MPR0003 layout) ──────────────
// Approach: clone the master template (default = MPR0003 Haul Truck TAR) field-for-field,
// then ask Claude to populate ONLY the variable content (unit-code section labels, the four
// grids: Training Office check, Supporting Evidence, Cert III Qualification, Training and
// Assessment Record grids, Overall Performance). Field types, order, options, signatures,
// instructions, and registers stay byte-identical so every saved form behaves the same.
router.post('/from-master', upload.single('file'), async (req, res) => {
  try {
    if (!(req.session.user && req.session.user.admin)) return res.status(403).json({ error: 'Admin only.' });
    if (!req.file) return res.status(400).json({ error: 'Upload a Word .docx (or PDF) so the AI can extract the unit-of-competency content.' });

    const masterId = parseInt(req.body.masterId, 10) || 5; // default: MPR0003
    const master = await dbGet('SELECT * FROM tblFormTemplate WHERE TemplateID=? AND (TenantID=? OR TenantID IS NULL)', [masterId, tenantOf(req)]);
    if (!master) return res.status(404).json({ error: 'Master template not found.' });
    const masterFields = await dbAll('SELECT * FROM tblFormField WHERE TemplateID=? ORDER BY OrderNum, FieldID', [masterId]);
    if (!masterFields.length) return res.status(500).json({ error: 'Master template has no fields.' });

    // Extract text from the uploaded document so the AI knows what unit/criteria to populate
    const { extractDocxText, extractPptxText } = require('../lib/content');
    const origName = req.file.originalname || 'source.docx';
    const ext = (origName.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    let sourceText = '';
    const sourceBlocks = [];
    if (ext === 'docx') sourceText = extractDocxText(req.file.buffer);
    else if (ext === 'pptx') sourceText = extractPptxText(req.file.buffer);
    else if (ext === 'pdf') sourceBlocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: req.file.buffer.toString('base64') } });
    else if (['png','jpg','jpeg','webp','gif'].includes(ext)) {
      const MIME = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif' };
      sourceBlocks.push({ type: 'image', source: { type: 'base64', media_type: MIME[ext] || 'image/png', data: req.file.buffer.toString('base64') } });
    } else if (ext === 'txt') sourceText = req.file.buffer.toString('utf8');
    else return res.status(400).json({ error: 'Supported file types: DOCX, PDF, TXT, image.' });

    // Build the variability map — only certain fields get AI-filled content; the rest pass through unchanged.
    // We index by OrderNum so the AI references stable positions, not DB IDs that change between clones.
    const variable = []; // { idx, kind, label, options? }
    const passThrough = []; // every other field
    masterFields.forEach((f, idx) => {
      const o = idx + 1;
      const ftype = f.FieldType;
      let opts = null;
      if (f.Options) { try { opts = JSON.parse(f.Options); } catch {} }
      const isUnitSection = ftype === 'section' && /Unit\(s\) Covered/i.test(f.Label || '');
      const isMainTitle   = ftype === 'section' && /Training and Assessment Record$/i.test(f.Label || '');
      const isCertIIIGrid = ftype === 'grid' && /Certificate III/i.test(f.Label || '');
      const isTARGrid     = ftype === 'grid' && opts && opts.columns && opts.columns.some(c => /Learning Criteria/i.test(c.label || ''));
      const isOverallGrid = ftype === 'grid' && opts && opts.columns && opts.columns.some(c => /Overall Performance/i.test(c.label || ''));
      if (isUnitSection)       variable.push({ o, kind: 'unit-section', label: f.Label });
      else if (isMainTitle)    variable.push({ o, kind: 'tar-title',    label: f.Label });
      else if (isCertIIIGrid)  variable.push({ o, kind: 'cert3-grid',   options: opts });
      else if (isTARGrid)      variable.push({ o, kind: 'tar-grid',     options: opts });
      else if (isOverallGrid)  variable.push({ o, kind: 'overall-grid', options: opts });
      else passThrough.push({ o });
    });

    // Build the AI request: give Claude the variable slots only, plus the source. Ask for one JSON blob
    // back keyed by slot index. We then merge the AI's content into the master structure.
    const sys = `You populate a fixed competency-assessment form template (the MPR0003 Haul Truck Competency Assessment Record / TAR — Pertrain layout) with content extracted from a NEW source document for a DIFFERENT unit of competency. The form's structure, field count, order, columns, signatures, instructions, and registers MUST remain identical — you ONLY supply the variable content listed below.\n\nReturn ONLY valid JSON of this shape:\n{ "unitCode": "[Unit code e.g. RIIMPO301B]",\n  "unitTitle": "[Unit title e.g. Conduct Hydraulic Excavator Operations]",\n  "slots": {\n    "<o>": { ...content for that slot... }\n  }\n}\n\nSlot kinds:\n• "unit-section"  → return { "label": "Unit(s) Covered: <unitCode> <unitTitle>" }\n• "tar-title"     → return { "label": "Training and Assessment Record" }  (keep as-is, present for completeness)\n• "cert3-grid"    → return { "rows": [ { "cells": { "c0": "Summary", "c1": "[Description for the level]" }, ... ] }  // 4 rows: Summary / Knowledge / Skills / Application of knowledge and skills\n• "tar-grid"      → return { "heading": "[Element name e.g. 'Plan and Prepare for Operations']", "rows": [ { "cells": { "c0":"[Learning Criteria]", "c1":"[Learning Content bullet list]", "c4":"[Task letter and prompt]", "c5":"[Observation bullets]" } }, ... ] }   // c2 and c3 (Candidate/Trainer initials) are ALWAYS blank — the assessor fills these on the day\n• "overall-grid"  → return { "rows": [ { "cells": { "c0": "[Overall performance criterion]" }, ... ] }   // 4 rows mirroring the master's Overall Performance criteria\n\nRules:\n1. Identify the unit code (RIIxxx, MPRxxx, etc.) and full title from the source document.\n2. For tar-grid slots, build ONE grid per Element of the Unit of Competency. There are typically 3 Elements (Plan and Prepare / Operate / Post-operational). Populate rows so EACH Performance Criterion of that Element becomes one row. Use bullets in cells when listing sub-content (separate items with \\n).\n3. Tasks: use letter codes consistent with Pertrain mapping (A=Plan/Prepare, B=Operate, C=Emergency, D=Post-op). Each Task cell starts with the letter and a brief prompt.\n4. Observations cells list 4-8 specific observable behaviours that demonstrate the criterion. Use one bullet per line ("\\u2610 ..." prefix).\n5. Never invent regulatory content not present in the source. Leave a cell blank ("") rather than fabricate.\n6. Output JSON only — no markdown, no commentary.`;

    const slotInstructions = variable.map(v => {
      if (v.kind === 'cert3-grid') {
        const rowCount = (v.options.rows || []).length || 4;
        return `Slot ${v.o} [cert3-grid] — provide ${rowCount} rows with cells c0 (heading) and c1 (description).`;
      }
      if (v.kind === 'tar-grid') {
        const colCount = (v.options.columns || []).length;
        return `Slot ${v.o} [tar-grid, ${colCount} cols] — heading + rows. Each row's cells.c0=Learning Criteria, cells.c1=Learning Content, cells.c4=Task, cells.c5=Observations.`;
      }
      if (v.kind === 'overall-grid') {
        const rowCount = (v.options.rows || []).length || 4;
        return `Slot ${v.o} [overall-grid, ${rowCount} rows] — cells.c0 = an Overall Performance criterion.`;
      }
      if (v.kind === 'unit-section') return `Slot ${v.o} [unit-section] — section label "Unit(s) Covered: <unitCode> <unitTitle>".`;
      if (v.kind === 'tar-title')    return `Slot ${v.o} [tar-title] — section label "Training and Assessment Record".`;
      return '';
    }).filter(Boolean).join('\n');
    const userText = `Master template: MPR0003 Haul Truck — Competency Assessment Record (TAR) — Pertrain layout.\nNew unit document: ${origName}.\n\nFill these variable slots:\n${slotInstructions}\n\n${sourceText ? 'SOURCE TEXT:\n"""' + sourceText.slice(0, 32000) + '"""' : 'See attached file.'}`;
    const content = sourceBlocks.length ? [...sourceBlocks, { type: 'text', text: userText }] : userText;

    const msg = await aiGateway.complete({
      provider: 'anthropic',
      agent: 'AI-FRM-001',
      operation: 'form_fields',
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      system: sys,
      messages: [{ role: 'user', content }]
    });
    const raw = ((msg.content.find(b => b.type === 'text') || {}).text || '').trim()
      .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      const m = raw.match(/\{[\s\S]*\}/); if (m) try { parsed = JSON.parse(m[0]); } catch {}
      if (!parsed) return res.status(502).json({ error: 'The AI returned an unexpected format. Try a different source document.' });
    }
    const slots = parsed.slots || {};
    const unitCode  = (parsed.unitCode  || 'NEW001').trim();
    const unitTitle = (parsed.unitTitle || 'New Competency').trim();

    // Build the cloned fields by walking the master and applying slot content where applicable
    const cloned = masterFields.map((f, idx) => {
      const o = idx + 1;
      const slot = slots[String(o)] || slots[o];
      const v = variable.find(x => x.o === o);
      let Label = f.Label;
      let Options = f.Options;
      if (v && slot) {
        if (v.kind === 'unit-section') {
          Label = (slot.label || `Unit(s) Covered: ${unitCode} ${unitTitle}`);
        } else if (v.kind === 'tar-title') {
          Label = slot.label || f.Label;
        } else if (v.kind === 'cert3-grid' || v.kind === 'tar-grid' || v.kind === 'overall-grid') {
          // Keep the EXACT same columns; only replace rows + the grid's heading-row text if provided
          const cols = (v.options.columns || []);
          const newRows = [];
          if (v.kind === 'tar-grid' && slot.heading) newRows.push({ heading: slot.heading });
          (slot.rows || []).forEach(r => {
            if (r && r.heading != null) newRows.push({ heading: String(r.heading || '') });
            else if (r && r.cells) {
              const cells = {};
              cols.forEach(c => { if (r.cells[c.key] != null) cells[c.key] = String(r.cells[c.key]); });
              newRows.push({ cells });
            }
          });
          Options = JSON.stringify({ columns: cols, rows: newRows.length ? newRows : (v.options.rows || []) });
        }
      }
      return { OrderNum: f.OrderNum, FieldType: f.FieldType, Label, Options, Required: f.Required, Points: f.Points || 0, HelpText: f.HelpText, Translation: null };
    });

    // Insert the new template — name reflects the new unit, locked=0, copies master's pass mark / cert
    const newName = `${unitCode} ${unitTitle} — Competency Assessment Record (TAR)`;
    const r = await dbRun(
      `INSERT INTO tblFormTemplate (Name,Description,CertID,PassMark,MaterialLink,Status,CreatedBy,Locked,TenantID)
       VALUES (?,?,?,?,?,?,?,0,?)`,
      [newName, null, master.CertID, master.PassMark || 80, master.MaterialLink, 'Active', req.session.user.username, tenantOf(req)]);
    for (const f of cloned) {
      // Re-parse Options to plain JSON string (already stringified above for grids; leave others as-is)
      await dbRun(
        `INSERT INTO tblFormField (TemplateID,OrderNum,FieldType,Label,Options,Required,Points,HelpText,Translation,TenantID) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [r.lastID, f.OrderNum, f.FieldType, f.Label, f.Options, f.Required, f.Points, f.HelpText, f.Translation, tenantOf(req)]);
    }
    try { await recordLegacyAudit(req.session.user.username, 'tblFormTemplate', 'FROM_MASTER', r.lastID, 'master:'+masterId, origName, newName); } catch {}
    res.json({ success: true, TemplateID: r.lastID, Name: newName, unitCode, unitTitle, fieldCount: cloned.length, slotsFilled: Object.keys(slots).length });
  } catch (e) {
    res.status(500).json({ error: 'Generation failed: ' + (e && e.message ? e.message : String(e)) });
  }
});

router.post('/import-doc', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const name = (req.file.originalname || '').toLowerCase();
    if (!name.endsWith('.docx')) return res.status(400).json({ error: 'Please upload a Word .docx file (export PDFs to .docx first).' });
    const parsed = parseDocxToFields(req.file.buffer);
    if (!parsed.fields.length) return res.status(400).json({ error: 'No content could be read from that document.' });
    res.json(parsed);
  } catch (e) { res.status(500).json({ error: 'Could not parse document: ' + e.message }); }
});

// Convert a stored Template Form (blank .docx in the Template Forms library) into editable online-form
// fields. Does NOT save — it returns the parsed { name, fields } so the builder opens pre-populated for
// the user to review, tweak and save as a form template. This is the bridge between the Template Forms
// file library and the online Form Builder.
router.post('/import-template-form/:fileId', async (req, res) => {
  try {
    const f = await dbGet(`SELECT * FROM tblFiles WHERE FileID=? AND Folder='template-forms'`, [req.params.fileId]);
    if (!f) return res.status(404).json({ error: 'Template form not found.' });
    if (!/\.docx$/i.test(f.FileName || '')) {
      return res.status(400).json({ error: 'Only Word .docx template forms can be turned into an online form. Export PDFs/spreadsheets to .docx first.' });
    }
    const full = path.join(UPLOAD_DIR, f.StoredName);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'The stored file is missing.' });
    const parsed = parseDocxToFields(fs.readFileSync(full));
    if (!parsed.fields.length) return res.status(400).json({ error: 'No content could be read from that document.' });
    parsed.name = parsed.name || (f.FileName || '').replace(/\.docx$/i, '');
    res.json(parsed);
  } catch (e) { res.status(500).json({ error: 'Could not convert template form: ' + e.message }); }
});

const SCORED = new Set(['competency', 'yesno', 'rating']);

// ---- Templates ----
router.get('/templates', async (req, res) => {
  try {
    // category=hr returns HR-builder forms; category=template-form returns online forms published from the
    // Template Forms library (kept OUT of the Field Assessment picker — they open from the Template Forms
    // page). Default=assessment keeps backward compat (legacy rows have FormCategory=NULL → 'assessment').
    const category = String(req.query.category || 'assessment').toLowerCase();
    const where = category === 'hr'
      ? `WHERE LOWER(IFNULL(t.FormCategory,'assessment'))='hr'`
      : category === 'template-form'
      ? `WHERE LOWER(IFNULL(t.FormCategory,'assessment'))='template-form'`
      : `WHERE LOWER(IFNULL(t.FormCategory,'assessment'))='assessment'`;
    res.json(await dbAll(`SELECT t.*, c.CertName,
      (SELECT COUNT(*) FROM tblFormField f WHERE f.TemplateID=t.TemplateID) as FieldCount,
      (SELECT COUNT(*) FROM tblFormSubmission s WHERE s.TemplateID=t.TemplateID) as SubmissionCount
      FROM tblFormTemplate t LEFT JOIN tblCerts c ON t.CertID=c.CertID ${where} AND (t.TenantID=? OR t.TenantID IS NULL) ORDER BY t.Name`, [tenantOf(req)]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/templates/:id', async (req, res) => {
  try {
    const t = await dbGet('SELECT * FROM tblFormTemplate WHERE TemplateID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    t.fields = await dbAll('SELECT * FROM tblFormField WHERE TemplateID=? ORDER BY OrderNum, FieldID', [req.params.id]);
    t.fields.forEach(f => {
      try { f.Options = f.Options ? JSON.parse(f.Options) : []; } catch { f.Options = []; }
      try { f.Translation = f.Translation ? JSON.parse(f.Translation) : null; } catch { f.Translation = null; }
    });
    res.json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Export a BLANK form template as a Word .docx (tables/grids + section structure preserved).
router.get('/templates/:id/export', async (req, res) => {
  try {
    const t = await dbGet('SELECT * FROM tblFormTemplate WHERE TemplateID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    const fields = await dbAll('SELECT * FROM tblFormField WHERE TemplateID=? ORDER BY OrderNum, FieldID', [req.params.id]);
    fields.forEach(f => { try { f.Options = f.Options ? JSON.parse(f.Options) : null; } catch { f.Options = null; } });
    const { buffer, filename } = formTemplateToDocx(t, fields, null, await companyBranding());
    sendDocx(res, buffer, filename);
  } catch (e) { res.status(500).json({ error: 'Export failed: ' + e.message }); }
});

// Export a COMPLETED submission as a Word .docx (the entered answers rendered into the form).
router.get('/submissions/:id/export', async (req, res) => {
  try {
    const s = await dbGet(`SELECT s.*, t.Name AS Name, t.Description AS Description, emp.FirstName, emp.LastName
      FROM tblFormSubmission s LEFT JOIN tblFormTemplate t ON s.TemplateID=t.TemplateID
      LEFT JOIN tblStaff emp ON s.EmpID=emp.StaffID WHERE s.SubmissionID=? AND (s.TenantID=? OR s.TenantID IS NULL)`, [req.params.id, tenantOf(req)]);
    if (!s) return res.status(404).json({ error: 'Not found' });
    const fields = await dbAll('SELECT * FROM tblFormField WHERE TemplateID=? ORDER BY OrderNum, FieldID', [s.TemplateID]);
    fields.forEach(f => { try { f.Options = f.Options ? JSON.parse(f.Options) : null; } catch { f.Options = null; } });
    const answers = await dbAll('SELECT FieldID, Value FROM tblFormAnswer WHERE SubmissionID=?', [req.params.id]);
    const submission = { answers,
      empName: [s.FirstName, s.LastName].filter(Boolean).join(' '),
      trainerName: s.TrainerName || '', assessDate: s.AssessDate || '', location: s.Location || '' };
    const { buffer, filename } = formTemplateToDocx({ Name: s.Name, Description: s.Description }, fields, submission, await companyBranding());
    sendDocx(res, buffer, filename);
  } catch (e) { res.status(500).json({ error: 'Export failed: ' + e.message }); }
});

// Save a BLANK form template as a Word document into a chosen destination folder.
router.post('/templates/:id/save-doc', async (req, res) => {
  try {
    const t = await dbGet('SELECT * FROM tblFormTemplate WHERE TemplateID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    const fields = await dbAll('SELECT * FROM tblFormField WHERE TemplateID=? ORDER BY OrderNum, FieldID', [req.params.id]);
    fields.forEach(f => { try { f.Options = f.Options ? JSON.parse(f.Options) : null; } catch { f.Options = null; } });
    const { buffer } = formTemplateToDocx(t, fields, null, await companyBranding());
    const saved = await saveFormDocToFolder(buffer, t.Name, req.body, req.session.user.username);
    if (saved.error) return res.status(400).json({ error: saved.error });
    try { await recordLegacyAudit(req.session.user.username, 'tblFiles', 'FORM_DOC_SAVE', saved.fileId, null, saved.fileName, null); } catch (e) { /* audit best-effort */ }
    res.json({ success: true, ...saved });
  } catch (e) { res.status(500).json({ error: 'Save failed: ' + e.message }); }
});

// Save a COMPLETED submission as a Word document into a chosen destination folder.
router.post('/submissions/:id/save-doc', async (req, res) => {
  try {
    const s = await dbGet(`SELECT s.*, t.Name AS Name, t.Description AS Description, emp.FirstName, emp.LastName
      FROM tblFormSubmission s LEFT JOIN tblFormTemplate t ON s.TemplateID=t.TemplateID
      LEFT JOIN tblStaff emp ON s.EmpID=emp.StaffID WHERE s.SubmissionID=? AND (s.TenantID=? OR s.TenantID IS NULL)`, [req.params.id, tenantOf(req)]);
    if (!s) return res.status(404).json({ error: 'Not found' });
    const fields = await dbAll('SELECT * FROM tblFormField WHERE TemplateID=? ORDER BY OrderNum, FieldID', [s.TemplateID]);
    fields.forEach(f => { try { f.Options = f.Options ? JSON.parse(f.Options) : null; } catch { f.Options = null; } });
    const answers = await dbAll('SELECT FieldID, Value FROM tblFormAnswer WHERE SubmissionID=?', [req.params.id]);
    const submission = { answers, empName: [s.FirstName, s.LastName].filter(Boolean).join(' '), trainerName: s.TrainerName || '', assessDate: s.AssessDate || '', location: s.Location || '' };
    const { buffer } = formTemplateToDocx({ Name: s.Name, Description: s.Description }, fields, submission, await companyBranding());
    const base = (s.Name || 'Form') + (submission.empName ? ' - ' + submission.empName : '');
    const saved = await saveFormDocToFolder(buffer, base, req.body, req.session.user.username);
    if (saved.error) return res.status(400).json({ error: saved.error });
    try { await recordLegacyAudit(req.session.user.username, 'tblFiles', 'FORM_DOC_SAVE', saved.fileId, null, saved.fileName, null); } catch (e) { /* audit best-effort */ }
    res.json({ success: true, ...saved });
  } catch (e) { res.status(500).json({ error: 'Save failed: ' + e.message }); }
});

router.post('/templates', async (req, res) => {
  try {
    const d = req.body;
    const fc = String(d.FormCategory || 'assessment').toLowerCase();
    const formCategory = (fc === 'hr' || fc === 'template-form') ? fc : 'assessment';
    const r = await dbRun(`INSERT INTO tblFormTemplate (Name,Description,CertID,PassMark,MaterialLink,Status,CreatedBy,TransLang,TransLayout,TransSideOrder,TransName,TransDescription,FormCategory,TenantID)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.Name, d.Description, d.CertID || null, d.PassMark || 80, d.MaterialLink, d.Status || 'Active', req.session.user.username,
       d.TransLang || null, d.TransLayout || null, d.TransSideOrder || null, d.TransName || null, d.TransDescription || null, formCategory, tenantOf(req)]);
    await saveFields(r.lastID, d.fields);
    res.json({ TemplateID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/templates/:id', async (req, res) => {
  try {
    const d = req.body;
    const cur = await dbGet('SELECT Locked, FormCategory FROM tblFormTemplate WHERE TemplateID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (cur && cur.Locked && !req.session.user.admin)
      return res.status(403).json({ error: 'This form is locked. Only a master admin can unlock it before editing.' });
    // FormCategory is optional on update — used to reclassify legacy template-form online forms so they drop
    // out of the Field Assessment picker. When omitted, keep the row's existing category.
    const fcIn = d.FormCategory != null ? String(d.FormCategory).toLowerCase() : null;
    const formCategory = (fcIn === 'hr' || fcIn === 'template-form' || fcIn === 'assessment') ? fcIn : (cur && cur.FormCategory) || 'assessment';
    await dbRun(`UPDATE tblFormTemplate SET Name=?,Description=?,CertID=?,PassMark=?,MaterialLink=?,Status=?,TransLang=?,TransLayout=?,TransSideOrder=?,TransName=?,TransDescription=?,FormCategory=? WHERE TemplateID=? AND (TenantID=? OR TenantID IS NULL)`,
      [d.Name, d.Description, d.CertID || null, d.PassMark || 80, d.MaterialLink, d.Status || 'Active',
       d.TransLang || null, d.TransLayout || null, d.TransSideOrder || null, d.TransName || null, d.TransDescription || null, formCategory, req.params.id, tenantOf(req)]);
    if (d.fields) { await dbRun('DELETE FROM tblFormField WHERE TemplateID=?', [req.params.id]); await saveFields(req.params.id, d.fields); }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    const t = await dbGet('SELECT Locked FROM tblFormTemplate WHERE TemplateID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (t && t.Locked && !req.session.user.admin) return res.status(403).json({ error: 'This form is locked. Only a master admin can delete it.' });
    await dbRun('DELETE FROM tblFormField WHERE TemplateID=?', [req.params.id]);
    await dbRun('DELETE FROM tblFormTemplate WHERE TemplateID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Duplicate a template (e.g. use an existing assessment record as the basis for a new one)
router.post('/templates/:id/duplicate', async (req, res) => {
  try {
    const t = await dbGet('SELECT * FROM tblFormTemplate WHERE TemplateID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!t) return res.status(404).json({ error: 'Template not found' });
    const name = (req.body.Name || (t.Name + ' (Copy)')).trim();
    const r = await dbRun(`INSERT INTO tblFormTemplate (Name,Description,CertID,PassMark,MaterialLink,Status,Locked,CreatedBy,TransLang,TransLayout,TenantID)
      VALUES (?,?,?,?,?,?,0,?,?,?,?)`,
      [name, t.Description, req.body.CertID !== undefined ? (req.body.CertID || null) : t.CertID,
       t.PassMark, t.MaterialLink, 'Active', req.session.user.username, t.TransLang || null, t.TransLayout || null, tenantOf(req)]);
    const fields = await dbAll('SELECT * FROM tblFormField WHERE TemplateID=? ORDER BY OrderNum, FieldID', [req.params.id]);
    for (const f of fields) {
      await dbRun(`INSERT INTO tblFormField (TemplateID,OrderNum,FieldType,Label,Options,Required,Points,HelpText,Translation,TenantID)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [r.lastID, f.OrderNum, f.FieldType, f.Label, f.Options, f.Required, f.Points, f.HelpText, f.Translation, tenantOf(req)]);
    }
    await recordLegacyAudit(req.session.user.username, 'tblFormTemplate', 'DUPLICATE', r.lastID, null, t.Name, name);
    res.json({ TemplateID: r.lastID, Name: name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lock / unlock a template. Unlocking requires master admin.
router.put('/templates/:id/lock', async (req, res) => {
  try {
    const locked = req.body.locked ? 1 : 0;
    if (locked === 0 && !req.session.user.admin)
      return res.status(403).json({ error: 'Only a master admin can unlock a saved form for editing.' });
    await dbRun('UPDATE tblFormTemplate SET Locked=? WHERE TemplateID=? AND (TenantID=? OR TenantID IS NULL)', [locked, req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'tblFormTemplate', locked ? 'LOCK' : 'UNLOCK', req.params.id, null, null, null);
    res.json({ success: true, locked: !!locked });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function saveFields(templateId, fields) {
  for (let i = 0; i < (fields || []).length; i++) {
    const f = fields[i];
    const transJson = (f.Translation && (f.Translation.label || f.Translation.helpText || (f.Translation.options && f.Translation.options.length)))
      ? JSON.stringify(f.Translation) : null;
    await dbRun(`INSERT INTO tblFormField (TemplateID,OrderNum,FieldType,Label,Options,Required,Points,HelpText,Translation)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [templateId, i, f.FieldType, f.Label, f.Options ? JSON.stringify(f.Options) : null,
       f.Required ? 1 : 0, f.Points || 0, f.HelpText, transJson]);
  }
}

// Translate every translatable text on a form into a target language:
//   • form Name + Description
//   • each field's Label, HelpText
//   • select/radio/checkbox Options
//   • grid column labels + row cell text + row headings
// Applies the approved terminology glossary just like Content Studio.
router.post('/translate-fields', async (req, res) => {
  try {
    if (!req.session.user.admin) return res.status(403).json({ error: 'Admin only' });
    const { fields, targetLang, name, description } = req.body;
    if (!Array.isArray(fields) || !targetLang) return res.status(400).json({ error: 'fields and targetLang required' });

    // Resolve glossary via shared resolver
    const { langCodeFromName } = require('../lib/translate');
    const code = langCodeFromName(targetLang);
    let glossary = [];
    if (code) glossary = await dbAll('SELECT SourceTerm, TargetTerm FROM tblTerminology WHERE LangCode=?', [code]);

    // Build the payload — grid columns + rows are first-class so the AI translates every visible cell
    const payload = {
      name: name || '',
      description: description || '',
      items: fields.map(f => {
        const it = {
          label: f.Label || '',
          helpText: f.HelpText || '',
          options: (['select','radio','checkbox'].includes(f.FieldType) && Array.isArray(f.Options)) ? f.Options : []
        };
        if (f.FieldType === 'grid' && f.Options && (f.Options.columns || f.Options.rows)) {
          it.grid = {
            columns: (f.Options.columns || []).map(c => c.label || ''),
            rows: (f.Options.rows || []).map(r => {
              if (r.heading != null) return { heading: r.heading || '' };
              const cells = r.cells || {};
              const cellTexts = {};
              Object.keys(cells).forEach(k => { cellTexts[k] = String(cells[k] == null ? '' : cells[k]); });
              return { cellTexts };
            })
          };
        }
        return it;
      })
    };

    const out = await translateSection(payload, targetLang, glossary);
    const items = (out && Array.isArray(out.items)) ? out.items : [];

    // Rebuild grid translations alongside the original column keys so the frontend can re-render reliably
    items.forEach((it, idx) => {
      const src = fields[idx];
      if (it && it.grid && src && src.FieldType === 'grid' && src.Options) {
        const srcCols = src.Options.columns || [];
        const srcRows = src.Options.rows || [];
        const tCols = (it.grid.columns || []).map((label, i) => ({ key: (srcCols[i] && srcCols[i].key) || ('c' + i), label: label || '' }));
        const tRows = (it.grid.rows || []).map((r, i) => {
          const srcRow = srcRows[i] || {};
          if (srcRow.heading != null) return { heading: (r && r.heading) || '' };
          const cells = {};
          const tCells = (r && r.cellTexts) || {};
          // Preserve every original key, fall back to the original text if AI dropped a cell
          Object.keys(srcRow.cells || {}).forEach(k => {
            cells[k] = tCells[k] != null && tCells[k] !== '' ? tCells[k] : (srcRow.cells[k] || '');
          });
          return { cells };
        });
        it.grid = { columns: tCols, rows: tRows };
      }
    });

    res.json({
      name: out && out.name ? String(out.name) : '',
      description: out && out.description ? String(out.description) : '',
      items,
      glossaryTerms: glossary.length
    });
  } catch (e) { res.status(500).json({ error: 'Translation failed: ' + e.message }); }
});

// ---- Submissions ----
// Create a completed assessment (from the tablet). Auto-scores & awards qualification on pass.
router.post('/submit', async (req, res) => {
  try {
    const d = req.body; // { templateId, empId, trainerId, trainerName, assessDate, location, answers:[{fieldId,value}], traineeSignature, trainerSignature, notes }
    const tmpl = await dbGet('SELECT * FROM tblFormTemplate WHERE TemplateID=? AND (TenantID=? OR TenantID IS NULL)', [d.templateId, tenantOf(req)]);
    if (!tmpl) return res.status(404).json({ error: 'Template not found' });
    if (!d.traineeSignature || !d.trainerSignature) return res.status(400).json({ error: 'Both trainee and trainer signatures are required.' });
    const fields = await dbAll('SELECT * FROM tblFormField WHERE TemplateID=?', [d.templateId]);
    const fieldMap = {}; fields.forEach(f => fieldMap[f.FieldID] = f);

    // Score the scored fields
    let earned = 0, possible = 0;
    const answerRows = [];
    for (const a of (d.answers || [])) {
      const f = fieldMap[a.fieldId];
      if (!f) continue;
      let pts = 0;
      if (SCORED.has(f.FieldType) && f.Points) {
        possible += f.Points;
        const v = String(a.value || '').toLowerCase();
        if (f.FieldType === 'rating') {
          const n = parseInt(a.value) || 0; pts = Math.round(f.Points * (n / 5));
        } else if (['yes', 'competent', 'pass', 'true', '1'].includes(v)) {
          pts = f.Points;
        }
        earned += pts;
      }
      answerRows.push({ fieldId: a.fieldId, value: a.value, points: pts });
    }
    const scorePct = possible ? Math.round(earned / possible * 100) : 100;
    const passed = scorePct >= (tmpl.PassMark || 80) ? 1 : 0;

    const now = new Date().toISOString();
    const sub = await dbRun(`INSERT INTO tblFormSubmission
      (TemplateID,EmpID,TrainerID,TrainerName,AssessDate,Location,Score,PossiblePoints,Passed,
       TraineeSignature,TrainerSignature,TraineeSignedAt,TrainerSignedAt,Notes,SubmittedBy,TenantID)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.templateId, d.empId || null, d.trainerId || null, d.trainerName, d.assessDate || now.split('T')[0], d.location,
       scorePct, possible, passed, d.traineeSignature, d.trainerSignature, now, now, d.notes, req.session.user.username, tenantOf(req)]);

    for (const a of answerRows)
      await dbRun('INSERT INTO tblFormAnswer (SubmissionID,FieldID,Value,Points,TenantID) VALUES (?,?,?,?,?)',
        [sub.lastID, a.fieldId, a.value, a.points, tenantOf(req)]);

    // Award qualification on pass
    let registerId = null;
    if (passed && tmpl.CertID && d.empId) {
      const cert = await dbGet('SELECT Months FROM tblCerts WHERE CertID=?', [tmpl.CertID]);
      let exp = null;
      if (cert && cert.Months) { const dd = new Date(); dd.setMonth(dd.getMonth() + cert.Months); exp = dd.toISOString().split('T')[0]; }
      const reg = await dbRun(`INSERT INTO tblRegister (StaffID,CertID,Complete,Exp,Score,Pass,State,SignBy,SignDate,SignMean,LastUpdateBy)
        VALUES (?,?,date('now'),?,?,1,'Completed',?,datetime('now'),'Field Assessment',?)`,
        [d.empId, tmpl.CertID, exp, scorePct, d.trainerName || req.session.user.username, req.session.user.username]);
      registerId = reg.lastID;
      await dbRun('UPDATE tblFormSubmission SET RegisterID=? WHERE SubmissionID=? AND (TenantID=? OR TenantID IS NULL)', [registerId, sub.lastID, tenantOf(req)]);
      // Workflow: qualification awarded via field assessment
      try {
        const aw = await dbGet(`SELECT s.FirstName,s.LastName,s.Email,sup.Email AS SupEmail,c.CertName
          FROM tblStaff s LEFT JOIN tblStaff sup ON sup.StaffID=s.SupID, tblCerts c
          WHERE s.StaffID=? AND c.CertID=?`, [d.empId, tmpl.CertID]);
        if (aw) await fireWorkflow('cert_awarded', {
          employeeEmail: aw.Email, supervisorEmail: aw.SupEmail,
          vars: { Employee: `${aw.FirstName||''} ${aw.LastName||''}`.trim(), Qualification: aw.CertName||'', Score: scorePct + '%', Expires: exp||'—', Date: new Date().toISOString().slice(0,10) }
        });
      } catch (_) {}
    }
    // ---- Route to the candidate's area supervisor for sign-off ----
    // Only when COMPETENT, both candidate + trainer signatures present, AND the form
    // includes a REQUIRED area-manager/supervisor signature field. Otherwise skip (no email).
    let emailResult = { sent: false };
    const supSigRequired = fields.some(f => f.FieldType === 'signature' && f.Required &&
      /supervisor|area\s*manager|\bmanager\b/i.test(f.Label || ''));
    if (!supSigRequired) {
      emailResult = { sent: false, skipped: true };
    } else if (passed && d.empId && d.traineeSignature && d.trainerSignature) {
      try {
        const sup = await findAreaSupervisor(d.empId);
        if (!sup || !sup.email) {
          emailResult = { sent: false, reason: sup ? `Supervisor ${sup.name} has no email on file.` : 'No area supervisor linked to this employee.' };
        } else {
          const cand = await dbGet('SELECT FirstName,LastName,FileNum FROM tblStaff WHERE StaffID=?', [d.empId]);
          const html = supervisorEmailHtml({ tmpl, cand, trainerName: d.trainerName, assessDate: d.assessDate, location: d.location,
            scorePct, submissionId: sub.lastID, supName: sup.name,
            traineeSig: d.traineeSignature, trainerSig: d.trainerSignature });
          await mailer.sendMail({ to: sup.email,
            subject: `Sign-off required: ${cand ? cand.FirstName + ' ' + cand.LastName : 'Candidate'} — ${tmpl.Name} (COMPETENT)`,
            html });
          emailResult = { sent: true, to: sup.email, supervisor: sup.name };
          await recordLegacyAudit(req.session.user.username, 'tblFormSubmission', 'EMAIL', sub.lastID, 'SupervisorSignoff', null, sup.email);
          // Workflow: assessment awaiting supervisor sign-off
          try {
            await fireWorkflow('form_signoff', {
              supervisorEmail: sup.email,
              vars: { Employee: cand ? `${cand.FirstName} ${cand.LastName}` : '', Assessment: tmpl.Name, Supervisor: sup.name, Score: scorePct + '%', Date: d.assessDate || new Date().toISOString().slice(0,10) }
            });
          } catch (_) {}
        }
      } catch (mailErr) { emailResult = { sent: false, reason: mailErr.message }; }
    }

    await recordLegacyAudit(req.session.user.username, 'tblFormSubmission', 'ASSESS', sub.lastID, 'Result', null, `${scorePct}% (${passed ? 'PASS' : 'FAIL'})`);
    res.json({ SubmissionID: sub.lastID, score: scorePct, passed: !!passed, registerId, qualificationAwarded: !!registerId, email: emailResult });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/submissions', async (req, res) => {
  try {
    const { empId, templateId } = req.query;
    let sql = `SELECT s.*, t.Name as TemplateName, c.CertName, emp.FirstName, emp.LastName, emp.FileNum
      FROM tblFormSubmission s
      LEFT JOIN tblFormTemplate t ON s.TemplateID=t.TemplateID
      LEFT JOIN tblCerts c ON t.CertID=c.CertID
      LEFT JOIN tblStaff emp ON s.EmpID=emp.StaffID WHERE 1=1 AND (s.TenantID=? OR s.TenantID IS NULL)`;
    const p = [tenantOf(req)];
    if (empId) { sql += ' AND s.EmpID=?'; p.push(empId); }
    if (templateId) { sql += ' AND s.TemplateID=?'; p.push(templateId); }
    sql += ' ORDER BY s.SubmittedAt DESC';
    res.json(await dbAll(sql, p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/submissions/:id', async (req, res) => {
  try {
    const s = await dbGet(`SELECT s.*, t.Name as TemplateName, t.MaterialLink, c.CertName,
      emp.FirstName, emp.LastName, emp.FileNum
      FROM tblFormSubmission s LEFT JOIN tblFormTemplate t ON s.TemplateID=t.TemplateID
      LEFT JOIN tblCerts c ON t.CertID=c.CertID LEFT JOIN tblStaff emp ON s.EmpID=emp.StaffID
      WHERE s.SubmissionID=? AND (s.TenantID=? OR s.TenantID IS NULL)`, [req.params.id, tenantOf(req)]);
    if (!s) return res.status(404).json({ error: 'Not found' });
    s.answers = await dbAll(`SELECT a.*, f.Label, f.FieldType, f.OrderNum FROM tblFormAnswer a
      JOIN tblFormField f ON a.FieldID=f.FieldID WHERE a.SubmissionID=? ORDER BY f.OrderNum`, [req.params.id]);
    s.templateFields = await dbAll('SELECT FieldID, FieldType, Label, Options FROM tblFormField WHERE TemplateID=?', [s.TemplateID]);
    s.templateFields.forEach(f => { try { f.Options = f.Options ? JSON.parse(f.Options) : null; } catch { f.Options = null; } });
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Area supervisor adds their counter-signature to a completed assessment
router.post('/submissions/:id/supervisor-sign', async (req, res) => {
  try {
    const { signature, name } = req.body;
    if (!signature) return res.status(400).json({ error: 'Signature is required.' });
    await dbRun("UPDATE tblFormSubmission SET SupervisorSignature=?, SupervisorSignedAt=datetime('now'), SupervisorName=? WHERE SubmissionID=? AND (TenantID=? OR TenantID IS NULL)",
      [signature, name || req.session.user.username, req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'tblFormSubmission', 'SUPERVISOR_SIGN', req.params.id, 'AreaManager', null, name || req.session.user.username);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
// Exposed for maintenance/migration scripts that need to derive an online form's name from a .docx.
module.exports.parseDocxToFields = parseDocxToFields;
