const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');
const { recordLegacyAudit } = require('../lib/governance/audit-adapter'); // WP-16 M5 — sanitizing audit (medium-risk; AI content dropped, identifiers masked/capped)
const logger = require('../lib/logger');
// WP-10 A6.4 — AI calls go through the central AI Gateway (byte-identical passthrough).
const aiGateway = require('../lib/ai-gateway');
const { LANGUAGES, translateDocument, buildDocxFromSegments, SUPPORTED_EXTS, MIME_BY_EXT, IMAGE_EXTS } = require('../lib/translate');

router.use(requireAuth);
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const extOf = name => (name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();

// Available target languages
router.get('/languages', (req, res) => res.json(LANGUAGES));

// Source documents available to translate (DOCX files already in the Document Library)
router.get('/sources', async (req, res) => {
  try {
    res.json(await dbAll(
      `SELECT FileID, FileName, Category, UploadedDate FROM tblFiles
       WHERE (LOWER(FileName) LIKE '%.docx' OR LOWER(FileName) LIKE '%.pptx' OR LOWER(FileName) LIKE '%.xlsx' OR LOWER(FileName) LIKE '%.pdf'
              OR LOWER(FileName) LIKE '%.png' OR LOWER(FileName) LIKE '%.jpg' OR LOWER(FileName) LIKE '%.jpeg' OR LOWER(FileName) LIKE '%.webp')
       AND (TargetLang IS NULL OR TargetLang='')
       ORDER BY UploadedDate DESC LIMIT 200`, []));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Past translation jobs
router.get('/jobs', async (req, res) => {
  try {
    res.json(await dbAll(
      `SELECT FileID, FileName, TargetLang, Category, Approved, ApprovedBy, ApprovedDate, UploadedBy, UploadedDate, SourceFileID
       FROM tblFiles WHERE TargetLang IS NOT NULL AND TargetLang!='' ORDER BY UploadedDate DESC LIMIT 200`, []));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Translate an uploaded file OR an existing Document Library file
router.post('/translate', upload.single('file'), async (req, res) => {
  try {
    const lang = LANGUAGES.find(l => l.code === req.body.langCode);
    if (!lang) return res.status(400).json({ error: 'Choose a target language.' });
    const mode = req.body.mode === 'bilingual' ? 'bilingual' : 'target';

    let buf, origName, sourceFileId = null;
    if (req.file) { buf = req.file.buffer; origName = req.file.originalname; }
    else if (req.body.fileId) {
      const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [req.body.fileId]);
      if (!f) return res.status(404).json({ error: 'Source file not found.' });
      const fp = path.join(UPLOAD_DIR, f.StoredName);
      if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Source file missing on disk.' });
      buf = fs.readFileSync(fp); origName = f.FileName; sourceFileId = f.FileID;
    } else return res.status(400).json({ error: 'Select a document or upload one to translate.' });

    const ext = extOf(origName);
    if (!SUPPORTED_EXTS.includes(ext))
      return res.status(400).json({ error: 'Supported formats: .docx, .pptx, .xlsx. (PDF / OCR are on the roadmap.)' });

    // If the source was uploaded (not from the library), store it so the job can be re-generated during review.
    if (!sourceFileId) {
      const srcStored = crypto.randomBytes(16).toString('hex') + '.' + ext;
      fs.writeFileSync(path.join(UPLOAD_DIR, srcStored), buf);
      const sr = await dbRun(
        `INSERT INTO tblFiles (EntityType, EntityID, FileName, StoredName, MimeType, FileSize, Category, Description, UploadedBy, Approved)
         VALUES ('document', 0, ?, ?, ?, ?, 'Source document', 'Uploaded for translation', ?, 1)`,
        [origName, srcStored, MIME_BY_EXT[ext], buf.length, req.session.user.username]);
      sourceFileId = sr.lastID;
    }

    // Reuse approved Translation Memory + enforce approved Terminology for this language
    const tmRows = await dbAll('SELECT SourceText, TargetText FROM tblTransMemory WHERE LangCode=? AND Approved=1 AND (TenantID=? OR TenantID IS NULL)', [lang.code, tenantOf(req)]);
    const tmMap = {}; tmRows.forEach(r => { tmMap[r.SourceText] = r.TargetText; });
    const glossary = await dbAll('SELECT SourceTerm, TargetTerm FROM tblTerminology WHERE LangCode=?', [lang.code]);

    const { buffer, segments, replaced, tmHits, pairs, outExt } = await translateDocument(buf, ext, lang.name, mode, { tmMap, glossary });

    // Save the result back to the Document Library (pending approval, audit-logged).
    // Images OCR to a .docx, so the output extension can differ from the input.
    const oExt = outExt || ext;
    const stored = crypto.randomBytes(16).toString('hex') + '.' + oExt;
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), buffer);
    const base = origName.replace(new RegExp('\\.' + ext + '$', 'i'), '');
    const biLabel = mode === 'bilingual' ? ' bilingual' : '';
    const newName = `${base} [${lang.name}${biLabel}].${oExt}`;
    const r = await dbRun(
      `INSERT INTO tblFiles
        (EntityType, EntityID, FileName, StoredName, MimeType, FileSize, Category, Description, UploadedBy, Approved, SourceFileID, TargetLang)
       VALUES ('document', 0, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [newName, stored, MIME_BY_EXT[oExt], buffer.length, `Translation (${lang.name})`,
       `Auto-translated from "${origName}" — pending approval`, req.session.user.username, sourceFileId, lang.name]);
    await recordLegacyAudit(req.session.user.username, 'tblFiles', 'TRANSLATE', r.lastID, lang.name, origName, newName);

    // Capture every segment pair into Translation Memory (pending) and this job's ordered segment list (for review)
    let tmAdded = 0, order = 0;
    for (const [src, tgt] of Object.entries(pairs || {})) {
      if (!src || !tgt) continue;
      await dbRun('INSERT INTO tblTransSegment (JobFileID, OrderNum, SourceText, TargetText, TenantID) VALUES (?,?,?,?,?)',
        [r.lastID, order++, src, tgt, tenantOf(req)]);
      const ins = await dbRun(
        `INSERT OR IGNORE INTO tblTransMemory (LangCode, SourceText, TargetText, Approved, JobFileID, CreatedBy, TenantID)
         VALUES (?,?,?,0,?,?,?)`, [lang.code, src, tgt, r.lastID, req.session.user.username, tenantOf(req)]);
      if (ins.changes) tmAdded++;
    }

    res.json({ success: true, fileId: r.lastID, fileName: newName, segments, replaced, tmHits: tmHits || 0, tmAdded, language: lang.name, mode });
  } catch (e) {
    if (e.message && e.message.includes('API key')) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: 'Translation failed: ' + e.message });
  }
});

// Approve a translation (approval gate before it is considered published)
router.post('/approve/:fileId', async (req, res) => {
  try {
    if (!req.session.user.admin) return res.status(403).json({ error: 'Only an administrator can approve translations.' });
    await dbRun("UPDATE tblFiles SET Approved=1, ApprovedBy=?, ApprovedDate=datetime('now') WHERE FileID=?",
      [req.session.user.username, req.params.fileId]);
    // Promote this job's Translation Memory entries to approved so they are reused going forward
    await dbRun('UPDATE tblTransMemory SET Approved=1 WHERE JobFileID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.fileId, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'tblFiles', 'APPROVE_TRANSLATION', req.params.fileId, null, null, null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Dashboard metrics ----
router.get('/metrics', async (req, res) => {
  try {
    const jobs = await dbGet("SELECT COUNT(*) total, COALESCE(SUM(Approved),0) approved FROM tblFiles WHERE TargetLang IS NOT NULL AND TargetLang!=''");
    const segs = await dbGet('SELECT COUNT(*) c FROM tblTransSegment WHERE (TenantID=? OR TenantID IS NULL)', [tenantOf(req)]);
    const tm = await dbGet('SELECT COUNT(*) total, COALESCE(SUM(Approved),0) approved FROM tblTransMemory WHERE (TenantID=? OR TenantID IS NULL)', [tenantOf(req)]);
    const terms = await dbGet('SELECT COUNT(*) c FROM tblTerminology');
    const jobsByName = await dbAll("SELECT TargetLang lang, COUNT(*) jobs, COALESCE(SUM(Approved),0) approved FROM tblFiles WHERE TargetLang IS NOT NULL AND TargetLang!='' GROUP BY TargetLang");
    const tmByCode = await dbAll('SELECT LangCode, COUNT(*) total, COALESCE(SUM(Approved),0) approved FROM tblTransMemory WHERE (TenantID=? OR TenantID IS NULL) GROUP BY LangCode', [tenantOf(req)]);
    const termsByCode = await dbAll('SELECT LangCode, COUNT(*) c FROM tblTerminology GROUP BY LangCode');
    const tmMap = {}; tmByCode.forEach(r => tmMap[r.LangCode] = r);
    const termMap = {}; termsByCode.forEach(r => termMap[r.LangCode] = r.c);
    const nameToCode = {}; LANGUAGES.forEach(l => nameToCode[l.name] = l.code);
    const byLang = jobsByName.map(j => {
      const code = nameToCode[j.lang] || '';
      return { language: j.lang, jobs: j.jobs, jobsApproved: j.approved,
        tmTotal: (tmMap[code] || {}).total || 0, tmApproved: (tmMap[code] || {}).approved || 0, terms: termMap[code] || 0 };
    }).sort((a, b) => b.jobs - a.jobs);
    res.json({
      jobs: jobs.total, jobsApproved: jobs.approved, jobsPending: jobs.total - jobs.approved,
      segments: segs.c, tmTotal: tm.total, tmApproved: tm.approved, terms: terms.c, byLang
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Translation Memory stats ----
router.get('/tm-stats', async (req, res) => {
  try {
    res.json(await dbAll(
      `SELECT LangCode, COUNT(*) AS total, SUM(Approved) AS approved FROM tblTransMemory WHERE (TenantID=? OR TenantID IS NULL) GROUP BY LangCode ORDER BY total DESC`, [tenantOf(req)]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Terminology (glossary) management ----
router.get('/terms', async (req, res) => {
  try {
    const { lang } = req.query;
    let sql = 'SELECT * FROM tblTerminology'; const p = [];
    if (lang) { sql += ' WHERE LangCode=?'; p.push(lang); }
    sql += ' ORDER BY LangCode, SourceTerm';
    res.json(await dbAll(sql, p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/terms', async (req, res) => {
  try {
    const d = req.body;
    if (!d.LangCode || !d.SourceTerm || !d.TargetTerm) return res.status(400).json({ error: 'Language, source term and target term are required.' });
    await dbRun(
      `INSERT INTO tblTerminology (LangCode, SourceTerm, TargetTerm, Note, CreatedBy) VALUES (?,?,?,?,?)
       ON CONFLICT(LangCode, SourceTerm) DO UPDATE SET TargetTerm=excluded.TargetTerm, Note=excluded.Note`,
      [d.LangCode, d.SourceTerm.trim(), d.TargetTerm.trim(), d.Note || null, req.session.user.username]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/terms/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM tblTerminology WHERE TermID=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Terminology bulk import ─────────────────────────────────────────────────
// Download a CSV template the user fills in offline.
router.get('/terms/template', (req, res) => {
  const examples = [
    ['es','haul truck','camión de acarreo',''],
    ['th','haul truck','รถบรรทุก',''],
    ['fr','confined space','espace clos','For safety procedures and permit-to-work documentation'],
    ['es','lockout/tagout','bloqueo y etiquetado',''],
    ['th','PPE','อุปกรณ์ป้องกันส่วนบุคคล',''],
  ];
  const csvEscape = v => {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['LangCode','SourceTerm (English)','TargetTerm','Note (optional — AI fills blanks)'];
  const lines = [header.map(csvEscape).join(',')].concat(examples.map(r => r.map(csvEscape).join(',')));
  const body = '﻿' + lines.join('\r\n') + '\r\n'; // BOM so Excel opens as UTF-8
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="terminology_template.csv"');
  res.send(body);
});

// Export the live terminology glossary as a CSV the user can edit offline and re-upload.
// Same column shape as the template (LangCode, SourceTerm, TargetTerm, Note) so a round-trip works.
// Optional ?lang=xx filter narrows the export to a single target language.
router.get('/terms/export', async (req, res) => {
  try {
    const { lang } = req.query;
    let sql = 'SELECT LangCode, SourceTerm, TargetTerm, Note FROM tblTerminology';
    const p = [];
    if (lang) { sql += ' WHERE LangCode=?'; p.push(String(lang).toLowerCase()); }
    sql += ' ORDER BY LangCode, SourceTerm COLLATE NOCASE';
    const rows = await dbAll(sql, p);

    const csvEscape = v => {
      const s = String(v == null ? '' : v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = ['LangCode', 'SourceTerm (English)', 'TargetTerm', 'Note'];
    const lines = [header.map(csvEscape).join(',')]
      .concat(rows.map(r => [r.LangCode || '', r.SourceTerm || '', r.TargetTerm || '', r.Note || ''].map(csvEscape).join(',')));
    const body = '﻿' + lines.join('\r\n') + '\r\n'; // UTF-8 BOM so Excel opens it correctly (preserves Thai / Mandarin / Arabic)

    const today = new Date().toISOString().slice(0, 10);
    const fileName = lang
      ? `terminology_glossary_${String(lang).toLowerCase()}_${today}.csv`
      : `terminology_glossary_${today}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(body);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Minimal RFC-4180 CSV parser (handles quoted fields, escaped quotes, CRLF, BOM, and a custom delimiter)
function parseCsv(text, delim) {
  if (!text) return [];
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const D = delim || ',';
  const rows = [];
  let row = [], cell = '', inQ = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i+1] === '"') { cell += '"'; i += 2; continue; } inQ = false; i++; continue; }
      cell += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === D) { row.push(cell); cell = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += c; i++;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.length && r.some(v => String(v || '').trim()));
}

// Upload + import terminology CSV. AI fills any blank Note from the English SourceTerm.
router.post('/terms/import', upload.single('file'), async (req, res) => {
  // Wrap the response so we log any 4xx error to the server console for diagnosis.
  const origStatus = res.status.bind(res);
  // WP-08 L4 — structured error record, metadata only (response body never logged).
  res.status = function(code) { if (code >= 400 && code < 500) { const origJson = res.json.bind(res); res.json = function(b) { try { logger.error('TRANSLATION_ERROR', { message: 'Terminology import failed', statusCode: code, method: req.method, path: req.path, operation: 'terms-import' }); } catch {} return origJson(b); }; } return origStatus(code); };
  try {
    if (!(req.session.user && req.session.user.admin)) return res.status(403).json({ error: 'Admin only.' });
    if (!req.file) return res.status(400).json({ error: 'Upload the filled-in CSV (use the Download Template button first).' });
    // Diagnostic line — captures filename + size for every import attempt so we can trace failures
    console.log('[import] file:', req.file.originalname, '| size:', req.file.size, 'bytes | mimetype:', req.file.mimetype);

    // Reject Excel files explicitly — we only parse CSV. .xlsx starts with the ZIP "PK" magic bytes.
    const buf = req.file.buffer;
    const origName = (req.file.originalname || '').toLowerCase();
    const isZip = buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4B;
    if (isZip || origName.endsWith('.xlsx') || origName.endsWith('.xls') || origName.endsWith('.xlsm')) {
      return res.status(400).json({ error: 'This is an Excel file, not a CSV. In Excel use File → Save As → CSV UTF-8 (.csv), then upload that. Or click ⬇ Template and edit in place.' });
    }
    const text = buf.toString('utf8');
    // Auto-detect delimiter: comma vs semicolon (European Excel) — count occurrences on first non-empty line
    const firstLine = (text.split(/\r?\n/).find(l => l.trim()) || '');
    const semiColons = (firstLine.match(/;/g) || []).length;
    const commas = (firstLine.match(/,/g) || []).length;
    const delim = (semiColons > commas) ? ';' : ',';
    const rows = parseCsv(text, delim);
    if (rows.length < 2) return res.status(400).json({ error: 'CSV is empty or has only a header row. (' + (text.length ? text.length + ' bytes received' : 'empty file') + ')' });

    // Map header positions defensively — accept any casing/whitespace/alias for the four columns
    const header = rows[0].map(h => String(h || '').trim().toLowerCase());
    const findCol = (...names) => header.findIndex(h => names.some(n => h === n.toLowerCase() || h.startsWith(n.toLowerCase())));
    const iLang = findCol('langcode', 'lang', 'language');
    const iSrc  = findCol('sourceterm', 'source', 'english');
    const iTgt  = findCol('targetterm', 'target', 'translation');
    const iNote = findCol('note', 'context');
    if (iLang < 0 || iSrc < 0 || iTgt < 0) return res.status(400).json({
      error: 'Missing required columns. The first row must include "LangCode", "SourceTerm" and "TargetTerm" (Note is optional). Found headers: [' + header.join(', ') + ']'
    });

    // Build the parsed candidates with row-level validation
    const valid = []; const errors = []; const warnings = [];
    const VALID_CODES = new Set(LANGUAGES.map(l => l.code));
    // Accept language NAMES too (e.g. "Spanish", "Thai") and aliases. Map them to the canonical code.
    const NAME_TO_CODE = {};
    LANGUAGES.forEach(l => { NAME_TO_CODE[l.name.toLowerCase()] = l.code; });
    const NAME_ALIASES = {
      'mandarin chinese': 'zh', 'chinese': 'zh', 'chinese (simplified)': 'zh',
      'bahasa indonesia': 'id', 'indonesian': 'id',
      'bahasa melayu': 'ms', 'malay': 'ms',
      'filipino': 'tl', 'filipino (tagalog)': 'tl', 'tagalog': 'tl',
    };
    function resolveLang(raw) {
      const v = String(raw || '').trim().toLowerCase();
      if (!v) return '';
      if (VALID_CODES.has(v)) return v;
      if (NAME_TO_CODE[v]) return NAME_TO_CODE[v];
      if (NAME_ALIASES[v]) return NAME_ALIASES[v];
      // Try partial match on language name (e.g. "spani" → "spanish" → "es")
      for (const name in NAME_TO_CODE) {
        if (name.startsWith(v) || v.startsWith(name.split(' ')[0])) return NAME_TO_CODE[name];
      }
      return v; // unrecognised — error path below will report
    }
    // Detect the target language from the TARGET text when LangCode column is blank.
    // Non-Latin scripts are uniquely identifiable; Latin-script text remains ambiguous (es/fr/pt/it/de).
    function detectLangFromTarget(text) {
      const t = String(text || '');
      if (!t) return '';
      if (/[฀-๿]/.test(t)) return VALID_CODES.has('th') ? 'th' : '';        // Thai
      if (/[一-鿿㐀-䶿]/.test(t)) return VALID_CODES.has('zh') ? 'zh' : ''; // Chinese
      if (/[぀-ゟ゠-ヿ]/.test(t)) return VALID_CODES.has('ja') ? 'ja' : ''; // Japanese kana
      if (/[가-힯ᄀ-ᇿ]/.test(t)) return VALID_CODES.has('ko') ? 'ko' : ''; // Korean Hangul
      if (/[؀-ۿݐ-ݿ]/.test(t)) return VALID_CODES.has('ar') ? 'ar' : ''; // Arabic
      if (/[Ѐ-ӿ]/.test(t)) return VALID_CODES.has('ru') ? 'ru' : '';         // Cyrillic (Russian)
      if (/[ऀ-ॿ]/.test(t)) return VALID_CODES.has('hi') ? 'hi' : '';         // Devanagari (Hindi)
      if (/[֐-׿]/.test(t)) return VALID_CODES.has('he') ? 'he' : '';         // Hebrew
      return ''; // Latin script — can't reliably auto-detect; user must specify LangCode
    }
    // Track within-file duplicates: same LangCode + SourceTerm (case-insensitive)
    const seen = new Map(); // key "lang|src(lower)" → first row number
    const fileDupes = []; // {row, lang, src, firstRow}

    // DIAGNOSTIC: log header + first 3 data rows + col positions so we can see EXACTLY what was parsed
    console.log('[import] header:', JSON.stringify(rows[0]));
    console.log('[import] col positions: iLang=' + iLang + ' iSrc=' + iSrc + ' iTgt=' + iTgt + ' iNote=' + iNote);
    for (let r = 1; r <= Math.min(3, rows.length - 1); r++) console.log('[import] row ' + (r+1) + ':', JSON.stringify(rows[r]));

    let autoDetected = 0;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const rawLang = String(row[iLang] || '').trim();
      let lang = resolveLang(rawLang);
      const src  = String(row[iSrc] || '').trim();
      const tgt  = String(row[iTgt] || '').trim();
      const note = iNote >= 0 ? String(row[iNote] || '').trim() : '';
      if (!rawLang && !src && !tgt) continue; // skip blank lines
      // If LangCode is blank but the target text is in a non-Latin script, auto-detect it
      if (!rawLang && tgt) {
        const detected = detectLangFromTarget(tgt);
        if (detected) { lang = detected; autoDetected++; }
      }
      if (!lang) {
        errors.push(`Row ${r+1}: LangCode is empty and the target text "${tgt.slice(0,40)}" is in Latin script — can't auto-detect (could be es/fr/pt/de/it). Add a LangCode (es, fr, th, …) to this row.`);
        continue;
      }
      // Terminology direction is English → target language. 'en' as the target makes no sense.
      if (lang === 'en' || rawLang.toLowerCase() === 'english') { errors.push(`Row ${r+1}: LangCode "${rawLang}" is invalid — terminology translates FROM English INTO the chosen language. Use the target language code (es, th, fr, …) or name (Spanish, Thai, French, …).`); continue; }
      if (!VALID_CODES.has(lang)) { errors.push(`Row ${r+1}: unsupported LangCode/name "${rawLang}" — use a code (${[...VALID_CODES].slice(0,8).join(', ')}, …) or full name (Spanish, Thai, French, …).`); continue; }
      if (!src) { errors.push(`Row ${r+1}: missing SourceTerm`); continue; }
      if (!tgt) { errors.push(`Row ${r+1}: missing TargetTerm`); continue; }
      // Within-file duplicate check (case-insensitive on the source term)
      const key = lang + '|' + src.toLowerCase();
      if (seen.has(key)) {
        const firstRow = seen.get(key);
        fileDupes.push({ row: r+1, lang, src, firstRow });
        errors.push(`Row ${r+1}: duplicate of row ${firstRow} (${lang.toUpperCase()} · "${src}") — only the first occurrence will be imported.`);
        continue;
      }
      seen.set(key, r+1);
      valid.push({ lang, src, tgt, note, row: r+1 });
    }
    if (!valid.length) return res.status(400).json({ error: 'No valid rows to import.', errors, duplicatesInFile: fileDupes.length });

    // DB-duplicate check (overwrite vs new) — done in one query for performance
    const existingMap = new Map(); // key "lang|src(lower)" → existing row
    const langGroups = {};
    valid.forEach(v => { (langGroups[v.lang] = langGroups[v.lang] || []).push(v.src); });
    for (const lang of Object.keys(langGroups)) {
      const ph = langGroups[lang].map(() => '?').join(',');
      const rows2 = await dbAll(
        `SELECT LangCode, SourceTerm, TargetTerm, Note FROM tblTerminology WHERE LangCode=? AND SourceTerm IN (${ph}) COLLATE NOCASE`,
        [lang, ...langGroups[lang]]);
      rows2.forEach(r2 => existingMap.set(r2.LangCode + '|' + r2.SourceTerm.toLowerCase(), r2));
    }
    const dbDupes = []; // {row, lang, src, oldTarget, newTarget}
    valid.forEach(v => {
      const ex = existingMap.get(v.lang + '|' + v.src.toLowerCase());
      if (ex) {
        v._existing = true;
        if (ex.TargetTerm !== v.tgt) dbDupes.push({ row: v.row, lang: v.lang, src: v.src, oldTarget: ex.TargetTerm, newTarget: v.tgt });
      }
    });
    if (dbDupes.length) {
      warnings.push(...dbDupes.slice(0, 20).map(d =>
        `Row ${d.row}: "${d.src}" (${d.lang.toUpperCase()}) already exists with translation "${d.oldTarget}" — will be overwritten by "${d.newTarget}".`));
      if (dbDupes.length > 20) warnings.push(`…and ${dbDupes.length - 20} more existing-translation overwrites.`);
    }

    // Ask Claude to fill any blank Note based on the English SourceTerm.
    // Batch all blank-note rows into a single prompt to keep latency low.
    let aiFilled = 0;
    const needNote = valid.filter(v => !v.note);
    if (needNote.length) {
      try {
        const sys = `You write concise glossary notes for an industrial / mining training company's translation memory. For each English term, return ONE short sentence (under 18 words) describing its operational context and where it appears in training documents (e.g. "Heavy earthmoving vehicle used in surface mining for ore and waste haulage"). Avoid the dictionary form ("a … is …"); make it usage-focused and unambiguous.`;
        const list = needNote.map((v, i) => `${i+1}. ${v.src}`).join('\n');
        const usr = `Return ONLY valid JSON: { "notes": ["note for term 1", "note for term 2", ...] } — one note per term, in the same order. Terms:\n${list}`;
        const msg = await aiGateway.complete({
          provider: 'anthropic', agent: 'AI-DOC-002', operation: 'glossary_notes',
          model: 'claude-sonnet-4-6', max_tokens: 2000, system: sys,
          messages: [{ role: 'user', content: usr }]
        });
        const raw = ((msg.content.find(b => b.type === 'text') || {}).text || '').trim()
          .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        let parsed; try { parsed = JSON.parse(raw); } catch { const m = raw.match(/\{[\s\S]*\}/); if (m) try { parsed = JSON.parse(m[0]); } catch {} }
        const notes = (parsed && Array.isArray(parsed.notes)) ? parsed.notes : [];
        for (let i = 0; i < needNote.length; i++) {
          const n = String(notes[i] || '').trim();
          if (n) { needNote[i].note = n; aiFilled++; }
        }
      } catch (e) { /* If AI fails, save anyway — notes just stay blank */ }
    }

    // Upsert into tblTerminology (same conflict rule as POST /terms)
    let inserted = 0, updated = 0;
    for (const v of valid) {
      const existed = await dbGet('SELECT TermID FROM tblTerminology WHERE LangCode=? AND SourceTerm=?', [v.lang, v.src]);
      await dbRun(
        `INSERT INTO tblTerminology (LangCode, SourceTerm, TargetTerm, Note, CreatedBy) VALUES (?,?,?,?,?)
         ON CONFLICT(LangCode, SourceTerm) DO UPDATE SET TargetTerm=excluded.TargetTerm, Note=excluded.Note`,
        [v.lang, v.src, v.tgt, v.note || null, req.session.user.username]);
      if (existed) updated++; else inserted++;
    }

    res.json({
      success: true,
      inserted, updated,
      aiNotesFilled: aiFilled,
      autoDetectedLang: autoDetected,
      total: valid.length,
      duplicatesInFile: fileDupes.length,
      duplicatesInDb: dbDupes.length,
      errors,
      warnings
    });
  } catch (e) {
    res.status(500).json({ error: 'Import failed: ' + e.message });
  }
});

// ---- Automated QA / Safety Review checks ----
const SAFETY_RE = /\b(danger|warning|caution|hazard|emergency|lockout|tag\s?out|isolat|fatal(?:ity)?|death|explos|toxic|flammable|high voltage|confined space|crush|asphyxiat|evacuat|PPE)\b/i;
function qaSegment(s) {
  const src = (s.SourceText || ''), tgt = (s.TargetText || '');
  const issues = [];
  if (!tgt.trim()) {
    issues.push({ sev: 'error', type: 'empty', msg: 'Not translated (empty)' });
  } else {
    if (tgt.trim() === src.trim() && /[A-Za-z]{3,}/.test(src)) issues.push({ sev: 'warn', type: 'unchanged', msg: 'Unchanged from source' });
    const nums = src.match(/\d+(?:[.,]\d+)?/g) || [];
    const missing = nums.filter(n => !tgt.includes(n));
    if (missing.length) issues.push({ sev: 'warn', type: 'number', msg: 'Missing number(s): ' + missing.join(', ') });
    if (/[A-Za-z]/.test(src) && src.length > 15 && tgt.length / src.length < 0.25) issues.push({ sev: 'warn', type: 'short', msg: 'Much shorter than source — possible truncation' });
  }
  if (SAFETY_RE.test(src)) issues.push({ sev: 'info', type: 'safety', msg: 'Safety-critical content — verify carefully' });
  return issues;
}

router.get('/qa/:fileId', async (req, res) => {
  try {
    const segs = await dbAll('SELECT SegID, SourceText, TargetText FROM tblTransSegment WHERE JobFileID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY OrderNum', [req.params.fileId, tenantOf(req)]);
    const flagged = {}; let errors = 0, warns = 0, infos = 0, safety = 0;
    for (const s of segs) {
      const iss = qaSegment(s);
      if (!iss.length) continue;
      flagged[s.SegID] = iss;
      iss.forEach(i => { if (i.sev === 'error') errors++; else if (i.sev === 'warn') warns++; else infos++; if (i.type === 'safety') safety++; });
    }
    res.json({ total: segs.length, errors, warns, infos, safety, flagged });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Human Review / QA ----
// Load a job's source→translation segments for review
router.get('/review/:fileId', async (req, res) => {
  try {
    const job = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [req.params.fileId]);
    if (!job) return res.status(404).json({ error: 'Translation not found.' });
    const segments = await dbAll('SELECT SegID, OrderNum, SourceText, TargetText FROM tblTransSegment WHERE JobFileID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY OrderNum', [req.params.fileId, tenantOf(req)]);
    res.json({ fileId: job.FileID, fileName: job.FileName, language: job.TargetLang, approved: job.Approved, segments });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save corrections — updates segments + memory, regenerates the document, optionally approves
router.post('/review/:fileId', async (req, res) => {
  try {
    const fileId = req.params.fileId;
    const corrections = req.body.corrections || {}; // { SegID: newTargetText }
    const job = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [fileId]);
    if (!job) return res.status(404).json({ error: 'Translation not found.' });
    const lang = LANGUAGES.find(l => l.name === job.TargetLang) || { code: '', name: job.TargetLang };

    // Apply corrections to the segment list + translation memory
    const segs = await dbAll('SELECT * FROM tblTransSegment WHERE JobFileID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY OrderNum', [fileId, tenantOf(req)]);
    const map = {}; let changed = 0;
    for (const s of segs) {
      let tgt = s.TargetText;
      if (corrections[s.SegID] != null && corrections[s.SegID] !== s.TargetText) {
        tgt = String(corrections[s.SegID]);
        await dbRun('UPDATE tblTransSegment SET TargetText=? WHERE SegID=? AND (TenantID=? OR TenantID IS NULL)', [tgt, s.SegID, tenantOf(req)]);
        if (lang.code) await dbRun(
          `INSERT INTO tblTransMemory (LangCode, SourceText, TargetText, Approved, JobFileID, CreatedBy, TenantID)
           VALUES (?,?,?,1,?,?,?) ON CONFLICT(LangCode, SourceText) DO UPDATE SET TargetText=excluded.TargetText`,
          [lang.code, s.SourceText, tgt, fileId, req.session.user.username, tenantOf(req)]);
        changed++;
      }
      map[s.SourceText] = tgt;
    }

    // Regenerate the document using the corrected map (no AI calls — all segments supplied)
    const mode = /bilingual\]/i.test(job.FileName) ? 'bilingual' : 'target';
    let buffer = null;
    const srcExt = job.SourceFileID ? extOf((await dbGet('SELECT FileName FROM tblFiles WHERE FileID=?', [job.SourceFileID]) || {}).FileName || '') : '';
    if (IMAGE_EXTS.includes(srcExt)) {
      // Image source: rebuild the .docx straight from the corrected segments (no re-OCR)
      buffer = buildDocxFromSegments(segs.map(s => ({ source: s.SourceText, target: map[s.SourceText] })), mode === 'bilingual');
    } else if (job.SourceFileID) {
      const src = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [job.SourceFileID]);
      const sp = src && path.join(UPLOAD_DIR, src.StoredName);
      if (src && fs.existsSync(sp)) {
        const out = await translateDocument(fs.readFileSync(sp), extOf(src.FileName), lang.name, mode, { tmMap: map, glossary: [] });
        buffer = out.buffer;
      }
    }
    if (buffer) {
      fs.writeFileSync(path.join(UPLOAD_DIR, job.StoredName), buffer);
      await dbRun('UPDATE tblFiles SET FileSize=? WHERE FileID=?', [buffer.length, fileId]);
    }

    if (req.body.approve) {
      if (!req.session.user.admin) return res.status(403).json({ error: 'Only an administrator can approve.' });
      await dbRun("UPDATE tblFiles SET Approved=1, ApprovedBy=?, ApprovedDate=datetime('now') WHERE FileID=?", [req.session.user.username, fileId]);
      await dbRun('UPDATE tblTransMemory SET Approved=1 WHERE JobFileID=? AND (TenantID=? OR TenantID IS NULL)', [fileId, tenantOf(req)]);
    }
    await recordLegacyAudit(req.session.user.username, 'tblFiles', req.body.approve ? 'REVIEW_APPROVE' : 'REVIEW_SAVE', fileId, lang.name, null, changed + ' corrected');
    res.json({ success: true, changed, approved: !!req.body.approve });
  } catch (e) { res.status(500).json({ error: 'Review save failed: ' + e.message }); }
});

module.exports = router;
