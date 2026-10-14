const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, requireAdmin, requirePermission, tenantOf } = require('./auth');
const { recordLegacyAudit } = require('../lib/governance/audit-adapter'); // WP-16 M5 — sanitizing audit (medium-risk; AI content dropped, identifiers masked/capped)
const { CONTENT_TYPES, LEARNING_PROFILES, TECH_DEPTHS, TEMPLATE_SECTIONS, mapSourceToTemplate, buildRecordFormHtml, recordFormToDocx, buildExcelForm, detectForms, extractDocxText, extractDocxImages, parseDocxToSections, cloneDocxAsForm, extractDocxFormBody, renderDocxBodyHtml, buildFormDocHtml, aiSmartForm, buildSmartFormHtml, smartFormToDocx, debrandSections, generate, adaptDocument, saveExam, saveForm, buildDocx, translateSection, generateCoverImageSvg, generateCoverImagePhoto } = require('../lib/content');
const { LANGUAGES, langCodeFromName } = require('../lib/translate');

const uploadSrc = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.use(requireAuth);
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// One-shot download tokens: generated files are written to a temp path and streamed via a real GET URL
// (with Content-Disposition: attachment). This works in embedded/in-app browsers where a client-side
// blob download is blocked. Each token is single-use and auto-expires; the temp file is cleaned up after
// it is streamed or after the TTL, whichever comes first.
const _dlTokens = new Map(); // token -> { file, filename, mime, tenantId, expires }
const _DL_TTL_MS = 10 * 60 * 1000; // 10 minutes
function _makeDownloadToken(buffer, filename, mime, tenantId) {
  const token = crypto.randomBytes(24).toString('hex');
  const file = path.join(UPLOAD_DIR, 'dl_' + token + path.extname(filename || '') );
  fs.writeFileSync(file, buffer);
  const expires = Date.now() + _DL_TTL_MS;
  _dlTokens.set(token, { file, filename: filename || 'download', mime: mime || 'application/octet-stream', tenantId, expires });
  const t = setTimeout(() => { const e = _dlTokens.get(token); if (e) { _dlTokens.delete(token); try { if (fs.existsSync(e.file)) fs.unlinkSync(e.file); } catch {} } }, _DL_TTL_MS + 1000);
  if (t.unref) t.unref();
  return token;
}

// Pick a sensible title/filename for a copied form. Auto-detected titles sometimes grab the first body
// line, which on many forms is a long instruction sentence (e.g. "Use this MOC Form for any proposed
// Change…"). When the detected title looks like a sentence (too long, trailing full stop, or many words),
// fall back to the uploaded file's name — which the user chose and is concise.
function _cleanFormTitle(parsedTitle, fileName) {
  const fn = String(fileName || '').replace(/\.[a-z0-9]+$/i, '').trim();
  const t = String(parsedTitle || '').trim();
  const looksLikeSentence = t.length > 70 || /[.!?]\s*$/.test(t) || t.split(/\s+/).length > 12;
  if (t && !looksLikeSentence) return t;
  return fn || t || 'Form';
}

// If the form-doc draft was scoped to one selected form (data.formScope), reduce the source .docx buffer to
// just that form before cloning; otherwise return the buffer unchanged (copy the whole document).
function _scopeFormBuf(srcBuf, d) {
  const sc = d && d.formScope;
  return (sc && sc.title) ? extractDocxFormBody(srcBuf, sc.title, Array.isArray(sc.detectedTitles) ? sc.detectedTitles : []) : srcBuf;
}

// Site-configured find→replace pairs (tblConfig key 'doc_replacements', a JSON array of {find, replace}).
// Applied to exact-copy forms so a source document's third-party site/project names and foreign legal
// references are swapped for the organisation's own — e.g. "LGP-JV Mine Site" → "AKR Mine Site". Returned
// as {pattern, replace} for cloneDocxAsForm's run-level replacement (longest find first, so overlapping
// terms replace the most specific one). This complements the automatic company-name de-branding.
async function loadDocReplacements() {
  try {
    const row = await dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='doc_replacements'`, []);
    if (!row || !row.cvalue) return [];
    let pairs = JSON.parse(row.cvalue);
    if (!Array.isArray(pairs)) return [];
    pairs = pairs.filter(p => p && p.find).sort((a, b) => String(b.find).length - String(a.find).length);
    return pairs.map(p => ({
      pattern: new RegExp(String(p.find).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      replace: String(p.replace == null ? '' : p.replace)
    }));
  } catch { return []; }
}

router.get('/types', (req, res) => res.json(CONTENT_TYPES));

// Which document types support semantic source→template mapping (have a template catalog).
router.get('/mappable-types', (req, res) => res.json(Object.keys(TEMPLATE_SECTIONS)));

// Export a record form as a standalone HTML file. Body: { data, riskMatrix }. Returns the HTML
// (the client downloads it). riskMatrix (or data.includeRiskMatrix) appends the colour AKARA matrix.
router.post('/record-form-html', async (req, res) => {
  try {
    const { data } = req.body || {};
    if (!data || !Array.isArray(data.fields)) return res.status(400).json({ error: 'No record form to export.' });
    const riskMatrix = req.body.riskMatrix === true || data.includeRiskMatrix === true;
    const [cfg, logoCfg] = await Promise.all([
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, [])
    ]);
    const companyName = (cfg && cfg.cvalue) ? cfg.cvalue.trim() : '';
    const companyLogo = (logoCfg && logoCfg.cvalue) ? logoCfg.cvalue : '';
    const submitEmail = (typeof data.submitEmail === 'string' && /.+@.+\..+/.test(data.submitEmail.trim())) ? data.submitEmail.trim() : '';
    const orientation = data.orientation === 'landscape' ? 'landscape' : 'portrait';
    const html = buildRecordFormHtml(data, { riskMatrix, companyName, companyLogo, submitEmail, orientation });
    const base = (data.name || data.title || 'Record Form').replace(/[<>:"/\\|?*]+/g, '').trim() || 'Record Form';
    const filename = base + '.html';
    const token = _makeDownloadToken(Buffer.from(html, 'utf8'), filename, 'text/html; charset=utf-8', tenantOf(req));
    res.json({ success: true, html, filename, downloadUrl: '/api/content/dl/' + token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// AI assistant for a RECORD / FORM in the editor: the user gives some context and the AI builds (or
// completes) the fillable fields. Body: { name, context, fields }. Returns { name, fields }.
router.post('/assist-form', requirePermission('ai.use'), async (req, res) => {
  try {
    const aiGateway = require('../lib/ai-gateway');
    const name = String(req.body.name || '').trim();
    const context = String(req.body.context || '').trim();
    const existing = Array.isArray(req.body.fields) ? req.body.fields : [];
    if (!context && !existing.length) return res.status(400).json({ error: 'Describe what the form should capture.' });
    const sys = `You design fillable RECORD FORMS for a mining / industrial company. Return ONLY JSON: {"name":"[Form name]","fields":[{"type":"section|text|textarea|checkbox|yesno|competency|rating|signature|date|number|select","label":"...","options":["..."]}]}.
Rules: use "section" ONLY for a numbered group heading that has no answer ("1. …", "2. …"); "date" for dates; "number" for readings/values; "yesno" for Yes/No checks; "select" (with "options") for a fixed choice; "textarea" for comments/observations; "signature" for a sign-off line. Group the fields under numbered sections, include an identification section and a sign-off section, keep labels concise, and adapt everything to the context. No markdown fences.`;
    const user = `Form name: ${name || '(none yet — propose one)'}\n\nCONTEXT — what this form must capture:\n${context || '(expand and complete the existing fields below into a full form)'}\n\n${existing.length ? 'EXISTING FIELDS — keep these and build the rest around them:\n' + JSON.stringify(existing.slice(0, 60)) : 'Build the complete field list from the context.'}`;
    const msg = await aiGateway.complete({ provider: 'anthropic', agent: 'AI-DOC-001', operation: 'assist_form', model: 'claude-sonnet-4-6', max_tokens: 4000, system: sys, messages: [{ role: 'user', content: user }] });
    const raw = (msg.content.find(b => b.type === 'text') || {}).text || '';
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    let j; try { j = JSON.parse(cleaned); } catch { try { j = JSON.parse((cleaned.match(/\{[\s\S]*\}/) || [''])[0]); } catch { j = null; } }
    if (!j || !Array.isArray(j.fields)) return res.status(502).json({ error: 'The AI returned an unexpected format. Try again.' });
    const VALID = ['section', 'text', 'textarea', 'checkbox', 'competency', 'yesno', 'rating', 'signature', 'date', 'number', 'select', 'radio'];
    const fields = j.fields.filter(f => f && f.label).map(f => ({
      type: VALID.includes(f.type) ? f.type : 'text',
      label: String(f.label).slice(0, 160),
      options: (Array.isArray(f.options) && f.options.length) ? f.options.map(o => String(o)).slice(0, 12) : undefined
    })).slice(0, 80);
    res.json({ success: true, name: String(j.name || name || 'Record Form').slice(0, 120), fields });
  } catch (e) { res.status(500).json({ error: 'AI assist failed: ' + (e && e.message ? e.message : String(e)) }); }
});

// Export an Excel form as a downloadable .xlsx (base64 in JSON; the client turns it into a file).
router.post('/excel-form-xlsx', async (req, res) => {
  try {
    const { data } = req.body || {};
    if (!data || (!Array.isArray(data.fields) && !Array.isArray(data.columns))) return res.status(400).json({ error: 'No form to export.' });
    const [cfg, logoCfg] = await Promise.all([
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, [])
    ]);
    const companyName = (cfg && cfg.cvalue) ? cfg.cvalue.trim() : '';
    const companyLogo = (logoCfg && logoCfg.cvalue) ? logoCfg.cvalue : '';
    const dashboard = !!(req.body && (req.body.dashboard || (data && data.dashboard)));
    const buffer = buildExcelForm(data, { companyName, companyLogo, dashboard });
    const base = (data.name || data.title || 'Excel Form').replace(/[<>:"/\\|?*]+/g, '').trim() || 'Excel Form';
    const filename = base + '.xlsx';
    const token = _makeDownloadToken(buffer, filename, XLSX_MIME, tenantOf(req));
    res.json({ success: true, b64: buffer.toString('base64'), filename, downloadUrl: '/api/content/dl/' + token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Semantic mapping preview: map an uploaded source into the selected template's sections.
// R5 — uses AI, requires ai.use. Body: { type, sourceFileId } or { type, sourceText }.
router.post('/map-preview', requirePermission('ai.use'), async (req, res) => {
  try {
    const { type } = req.body || {};
    if (!TEMPLATE_SECTIONS[type]) return res.status(400).json({ error: 'This document type does not support mapping preview.' });
    let srcText = (typeof req.body.sourceText === 'string') ? req.body.sourceText : '';
    if (!srcText && req.body.sourceFileId) {
      const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [req.body.sourceFileId]);
      if (!f || (f.TenantID || 1) !== tenantOf(req)) return res.status(404).json({ error: 'Source document not found.' });
      const fp = path.join(UPLOAD_DIR, f.StoredName);
      if (fs.existsSync(fp)) {
        const buf = fs.readFileSync(fp);
        const name = (f.FileName || '').toLowerCase();
        const { extractPdfText, extractPptxText } = require('../lib/content');
        if (name.endsWith('.docx')) srcText = extractDocxText(buf);
        else if (name.endsWith('.pptx')) srcText = extractPptxText(buf);
        else if (name.endsWith('.pdf')) srcText = await extractPdfText(buf);
        else return res.status(400).json({ error: 'Mapping preview needs a DOCX, PDF or PPTX source (not an image).' });
      }
    }
    if (!srcText || !srcText.trim()) return res.status(400).json({ error: 'No readable source text to map. Upload a DOCX/PDF/PPTX source first.' });
    const result = await mapSourceToTemplate(srcText, type);
    if (!result) return res.status(400).json({ error: 'Mapping is not available for this type.' });
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: 'Mapping failed: ' + e.message }); }
});

// Audience-adaptation options for the Content Studio UI (Learning Profile × Technical Depth).
router.get('/learning-options', (req, res) => res.json({
  learningProfiles: Object.entries(LEARNING_PROFILES).map(([key, v]) => ({ key, label: v.label })),
  techDepths: Object.entries(TECH_DEPTHS).map(([key, v]) => ({ key, label: v.label })),
}));

// All published KB articles available for context injection
router.get('/kb-context', async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT a.ArticleID, a.Title, a.Tags, a.Body, a.UpdatedAt,
              k.Name AS categoryName, k.Icon AS catIcon, k.Color AS catColor
       FROM tblKBArticle a
       LEFT JOIN tblKBCategory k ON k.CategoryID = a.CategoryID
       WHERE a.Status = 'Published'
       ORDER BY k.SortOrder, k.Name, a.Title`, []);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload a source document for use in content generation (saved to uploads, not the public library)
router.post('/upload-source', uploadSrc.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const origName = req.file.originalname || 'source';
    const ext = (origName.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    const ALLOWED = ['docx', 'pdf', 'pptx', 'png', 'jpg', 'jpeg', 'webp'];
    if (!ALLOWED.includes(ext)) return res.status(400).json({ error: 'Unsupported file type. Use DOCX, PDF, or an image.' });
    const MIME = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
    const stored = crypto.randomBytes(16).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), req.file.buffer);
    const r = await dbRun(
      `INSERT INTO tblFiles (EntityType, EntityID, FileName, StoredName, MimeType, FileSize, Category, Description, UploadedBy, Approved, TenantID)
       VALUES ('content-source', 0, ?, ?, ?, ?, 'AI Content Studio Source', 'Source document uploaded for AI content generation', ?, 0, ?)`,
      [origName, stored, MIME[ext] || 'application/octet-stream', req.file.size, req.session.user.username, tenantOf(req)]);
    res.json({ fileId: r.lastID, name: origName });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Source documents the AI can base content on (.docx text, plus PDF/images read via vision)
router.get('/sources', async (req, res) => {
  try {
    res.json(await dbAll(
      `SELECT FileID, FileName FROM tblFiles
       WHERE TenantID=? AND (LOWER(FileName) LIKE '%.docx' OR LOWER(FileName) LIKE '%.pdf'
              OR LOWER(FileName) LIKE '%.png' OR LOWER(FileName) LIKE '%.jpg' OR LOWER(FileName) LIKE '%.jpeg' OR LOWER(FileName) LIKE '%.webp')
       ORDER BY UploadedDate DESC LIMIT 200`, [tenantOf(req)]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const IMG_MEDIA = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

// Step 1 — generate the content (no save). Returns the structured draft for preview.
// R5 — AI generation now requires the ai.use permission (admins bypass; read-only/exam users denied).
router.post('/generate', requirePermission('ai.use'), async (req, res) => {
  try {
    const { type, prompt, sourceFileId, sourceMode, contentFileId, refFileIds, kbArticleIds, learningProfile, techDepth, mapping, recordOpts, selection, selections, docControl, imageSuggest, imgStyle, imgRegion, imgGender, useSourceImages } = req.body;
    if (!CONTENT_TYPES.find(t => t.key === type)) return res.status(400).json({ error: 'Choose a content type.' });

    // Form (exact copy): reproduce the uploaded document's own structure and layout — headings, body
    // and tables — instead of AI-generating. No prompt needed; the source document IS the form.
    if (type === 'form-doc') {
      if (!sourceFileId) return res.status(400).json({ error: 'Choose the uploaded document to copy (Source document).' });
      const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [sourceFileId]);
      const fp = f && path.join(UPLOAD_DIR, f.StoredName);
      if (!f || !fp || !fs.existsSync(fp)) return res.status(404).json({ error: 'Source document not found.' });
      if (!/\.docx$/i.test(f.FileName || '')) return res.status(400).json({ error: 'Only Word .docx documents can be copied exactly. Convert PDFs/spreadsheets to .docx first.' });
      const fullBuf = fs.readFileSync(fp);
      // If the user analysed the document and picked ONE form to create first, scope the exact copy to just
      // that form (from its title to the next form's title), keeping the document letterhead.
      const selTitle = (selection && selection.title) ? String(selection.title) : '';
      const detectedTitles = Array.isArray(req.body.detectedTitles) ? req.body.detectedTitles.map(String) : [];
      const formScope = selTitle ? { title: selTitle, detectedTitles } : null;
      const srcBuf = selTitle ? extractDocxFormBody(fullBuf, selTitle, detectedTitles) : fullBuf;
      const parsed = parseDocxToSections(srcBuf);
      if (!parsed.sections.length) return res.status(400).json({ error: 'No content could be read from that document.' });
      // De-brand the preview the same way the saved clone is de-branded, so the Content Studio editor
      // shows the company's information (not the source's) while editing.
      const cCfg = await dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []);
      const cLogoCfg = await dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, []);
      const cName = (cCfg && cCfg.cvalue) ? cCfg.cvalue.trim() : '';
      const cLogo = (cLogoCfg && cLogoCfg.cvalue) ? cLogoCfg.cvalue : null;
      if (cName) debrandSections(parsed, srcBuf, cName);
      const title = _cleanFormTitle(parsed.title, f.FileName);
      // Render the ACTUAL exact clone (de-branded + brand-recoloured, same as the save/download) to
      // faithful HTML so the preview mirrors the real copy — every table, column, merge and shaded cell —
      // instead of the flattened section rebuild. This is what makes "copy exactly" visibly true.
      let exactHtml = '';
      try {
        const clone = cloneDocxAsForm(srcBuf, { companyName: cName, companyLogo: cLogo, autoDetectOrg: true, brandTables: true, replacements: await loadDocReplacements(), translations: [], editReplacements: [], transSideOrder: 'en-first' });
        // Editable fillable preview — the WYSIWYG layout editor; edits are captured on download.
        exactHtml = buildFormDocHtml(clone, { title, companyName: cName, companyLogo: cLogo, editable: true });
      } catch (e) { exactHtml = ''; }
      // sourceFileId is carried so Save can produce an EXACT clone of this document (see /save). formScope,
      // when present, scopes the clone to the single selected form on save/export too.
      const data = { title, fileName: title, sections: parsed.sections, isForm: true, sourceFileId: Number(sourceFileId), exactHtml };
      if (formScope) data.formScope = formScope;
      return res.json({ success: true, type, data });
    }

    if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Describe what you want the AI to build.' });

    const opts = { sourceMode: sourceMode || 'reference' };
    if (learningProfile) opts.learningProfile = learningProfile; // audience literacy dial
    if (techDepth) opts.techDepth = techDepth;                    // technical depth dial
    if (mapping && typeof mapping === 'object') opts.mapping = mapping; // user-confirmed section mapping
    if (type === 'record-form' && recordOpts && typeof recordOpts === 'object') opts.recordOpts = recordOpts; // copy-layout / remove-training
    // A specific form/procedure chosen from a multi-item uploaded document — build ONLY that one.
    if (selection && typeof selection === 'object' && selection.title) {
      opts.selection = { title: String(selection.title), description: String(selection.description || '') };
    }
    // Several forms chosen to COMBINE into one record form (each as its own section).
    if (Array.isArray(selections) && selections.length > 1) {
      opts.selections = selections.filter(s => s && s.title).slice(0, 12)
        .map(s => ({ title: String(s.title), description: String(s.description || '') }));
    }
    // Document control / version control (any build type): the chosen control functions.
    if (Array.isArray(docControl)) opts.docControl = docControl.filter(k => typeof k === 'string').slice(0, 12);
    else if (docControl === true) opts.docControl = true;
    // Training Manual: per-section image suggestions (default on; false turns them off).
    if (imageSuggest === false) opts.imageSuggest = false;
    // Image style for the suggested-image prompts (style / region / gender).
    if (typeof imgStyle === 'string' && imgStyle.trim()) opts.imgStyle = imgStyle.trim().slice(0, 120);
    if (typeof imgRegion === 'string' && imgRegion.trim()) opts.imgRegion = imgRegion.trim().slice(0, 60);
    if (typeof imgGender === 'string' && imgGender.trim()) opts.imgGender = imgGender.trim().slice(0, 20);

    if (Array.isArray(kbArticleIds) && kbArticleIds.length) {
      const ph = kbArticleIds.map(() => '?').join(',');
      const kbRows = await dbAll(
        `SELECT a.Title, a.Body, k.Name AS categoryName
         FROM tblKBArticle a
         LEFT JOIN tblKBCategory k ON k.CategoryID = a.CategoryID
         WHERE a.ArticleID IN (${ph}) AND a.Status = 'Published'`,
        kbArticleIds);
      if (kbRows.length) {
        opts.kbContext = kbRows
          .map(r => `[${r.categoryName || 'Knowledge Base'}] ${r.Title}\n${r.Body}`)
          .join('\n\n---\n\n');
      }
      // Observability: confirm the selected KB article(s) were received and resolved into prompt context.
      console.log(`[content/generate] KB requested=[${kbArticleIds.join(',')}] resolved=${kbRows.length} (${kbRows.map(r => r.Title).join(' | ')}) kbContextChars=${opts.kbContext ? opts.kbContext.length : 0} type=${type}`);
    } else {
      console.log(`[content/generate] KB requested=none type=${type}`);
    }

    // Approved terminology glossary — so generated (incl. bilingual) content uses the
    // organisation's exact approved terms where relevant to the topic.
    const allTerms = await dbAll('SELECT LangCode, SourceTerm, TargetTerm FROM tblTerminology ORDER BY LangCode, SourceTerm', []);
    if (allTerms.length) {
      const codeToName = {}; LANGUAGES.forEach(l => codeToName[l.code] = l.name);
      const byLang = {};
      for (const t of allTerms) (byLang[t.LangCode] = byLang[t.LangCode] || []).push(t);
      opts.glossary = Object.entries(byLang)
        .map(([code, terms]) => `[${codeToName[code] || code}]\n` + terms.slice(0, 80).map(t => `- "${t.SourceTerm}" => "${t.TargetTerm}"`).join('\n'))
        .join('\n\n');
    }

    // Two-document ("update") mode: Document 1 = layout, Document 2 = updated content. Two full
    // PDFs would exceed the model's per-request page/size limit, so in this mode PDFs are sent as
    // extracted TEXT (light) rather than the whole binary, and the vision images are capped.
    const twoDocs = !!(contentFileId && String(contentFileId) !== String(sourceFileId || ''));
    const visMax = twoDocs ? 4 : 6;
    const { extractPdfText } = require('../lib/content');
    // Any section-based document type (built by buildDocx) can embed the source's pictures at
    // [IMG:n] markers — not just training manuals. Exclude the builder/exact-copy types.
    // Gated by the end-user's "Use the uploaded document's images" choice (default on when omitted).
    const useSrcImgs = useSourceImages !== false;
    const wantsPlaceableImages = useSrcImgs && !['exam', 'form', 'training-request', 'record-form', 'excel-form', 'form-doc'].includes(type);

    if (sourceFileId) {
      const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [sourceFileId]);
      const fp = f && path.join(UPLOAD_DIR, f.StoredName);
      if (f && fs.existsSync(fp)) {
        const ext = (f.FileName.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
        const buf = fs.readFileSync(fp);
        if (ext === 'docx') {
          opts.sourceText = extractDocxText(buf);
          // Pass embedded diagrams/flowcharts (pasted as pictures) to the model's vision
          opts.sourceBlocks = extractDocxImages(buf, { max: visMax });
          // Make the source pictures placeable so [IMG:n] markers embed them (all section-based types).
          if (wantsPlaceableImages) {
            const { getImageDimensions } = require('../lib/content');
            opts.sourceImages = extractDocxImages(buf, { max: 40, minBytes: 8000 }).map(b => {
              const bytes = Buffer.from(b.source.data, 'base64');
              const d = getImageDimensions(bytes, b.source.media_type) || {};
              return { data: `data:${b.source.media_type};base64,${b.source.data}`, mimeType: b.source.media_type, width: d.width || 0, height: d.height || 0 };
            });
          }
        }
        else if (ext === 'pptx') {
          // Extract slide text + trainer notes so the AI can build new content from an existing deck
          const { extractPptxText } = require('../lib/content');
          opts.sourceText = extractPptxText(buf);
        }
        else if (ext === 'pdf') {
          // In update mode, send the layout PDF as text (structure) to keep the request small;
          // otherwise attach the whole PDF so the model reads it natively.
          if (twoDocs) opts.sourceText = await extractPdfText(buf);
          else opts.sourceBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } };
          // Extract the source's pictures so they can be copied into the document at the positions the
          // AI marks with [IMG:n] (all section-based types). Best-effort — embedded JPEG photos/figures.
          if (wantsPlaceableImages) {
            try { opts.sourceImages = require('../lib/content').extractPdfImages(buf); } catch { opts.sourceImages = []; }
          }
        }
        else if (IMG_MEDIA[ext]) opts.sourceBlock = { type: 'image', source: { type: 'base64', media_type: IMG_MEDIA[ext], data: buf.toString('base64') } };
      }
    }

    // ── Document 2 — updated-content source ──────────────────────────────────────
    // Keeps Document 1's layout, but its information is the authoritative update. Loaded
    // into update* opts; figures come from HERE (the new/OEM document) when present.
    if (contentFileId && String(contentFileId) !== String(sourceFileId || '')) {
      const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [contentFileId]);
      const fp = f && path.join(UPLOAD_DIR, f.StoredName);
      if (f && fs.existsSync(fp)) {
        const ext = (f.FileName.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
        const buf = fs.readFileSync(fp);
        let updImages = [];
        if (ext === 'docx') {
          opts.updateText = extractDocxText(buf);
          opts.updateBlocks = extractDocxImages(buf, { max: visMax });
          if (useSrcImgs && type === 'training-manual') {
            const { getImageDimensions } = require('../lib/content');
            updImages = extractDocxImages(buf, { max: 40, minBytes: 8000 }).map(b => {
              const bytes = Buffer.from(b.source.data, 'base64');
              const d = getImageDimensions(bytes, b.source.media_type) || {};
              return { data: `data:${b.source.media_type};base64,${b.source.data}`, mimeType: b.source.media_type, width: d.width || 0, height: d.height || 0 };
            });
          }
        } else if (ext === 'pptx') {
          opts.updateText = require('../lib/content').extractPptxText(buf);
        } else if (ext === 'pdf') {
          // Send Document 2 (the authoritative content) as TEXT so two full PDFs never exceed the limit.
          opts.updateText = await extractPdfText(buf);
          if (useSrcImgs && type === 'training-manual') {
            try { updImages = require('../lib/content').extractPdfImages(buf); } catch { updImages = []; }
          }
        } else if (IMG_MEDIA[ext]) {
          opts.updateBlock = { type: 'image', source: { type: 'base64', media_type: IMG_MEDIA[ext], data: buf.toString('base64') } };
        }
        // COMBINE mode: pictures from BOTH documents are placeable, so figures from Document 1 and
        // Document 2 can be embedded at [IMG:n] positions where they best fit the merged content.
        if (type === 'training-manual' && updImages.length) {
          opts.sourceImages = [...(opts.sourceImages || []), ...updImages].slice(0, 40);
        }
      }
    }

    // ── Additional REFERENCE documents (the user may upload several) ──────────────
    // Each is extracted to text and passed as reference material the AI builds the new document from.
    if (Array.isArray(refFileIds) && refFileIds.length) {
      const seen = new Set([String(sourceFileId || ''), String(contentFileId || '')]);
      const ids = refFileIds.map(x => parseInt(x, 10)).filter(n => Number.isInteger(n) && n > 0 && !seen.has(String(n))).slice(0, 10);
      const docs = [];
      for (const id of ids) {
        const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [id]);
        const fp = f && path.join(UPLOAD_DIR, f.StoredName);
        if (!f || !fp || !fs.existsSync(fp)) continue;
        const ext = (f.FileName.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
        const buf = fs.readFileSync(fp);
        let text = '';
        try {
          if (ext === 'docx') text = extractDocxText(buf);
          else if (ext === 'pdf') text = await extractPdfText(buf);
          else if (ext === 'pptx') text = require('../lib/content').extractPptxText(buf);
        } catch { text = ''; }
        if (text && text.trim()) docs.push({ name: f.FileName, text });
      }
      if (docs.length) opts.referenceDocs = docs;
    }

    const companyCfg = await dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []);
    if (companyCfg && companyCfg.cvalue && companyCfg.cvalue.trim()) opts.companyName = companyCfg.cvalue.trim();

    // Observability: confirm Document 1 (source) and Document 2 (update) were received and how much text
    // was extracted from each — so a "Document 2 not used" report can be diagnosed from the log.
    console.log(`[content/generate] type=${type} twoDocs=${twoDocs} doc1=${sourceFileId || 'none'}(${(opts.sourceText || '').length}ch,blocks=${(opts.sourceBlocks || opts.sourceBlock ? ((opts.sourceBlocks || []).length || 1) : 0)}) doc2=${contentFileId || 'none'}(${(opts.updateText || '').length}ch,blocks=${(opts.updateBlocks || opts.updateBlock ? ((opts.updateBlocks || []).length || 1) : 0)}) refDocs=${(opts.referenceDocs || []).length}[${(opts.referenceDocs || []).map(d => (d.name || '?') + ':' + d.text.length + 'ch').join(' | ')}]`);

    const data = await generate(type, prompt, opts);
    // Bump the AI-suggested docNumber to the next available in the existing folder's number series.
    // Example: AI returns "TS-TRN-001"; org already has TS-TRN-001..TS-TRN-006 stored → result becomes "TS-TRN-007".
    if (data && data.docNumber) {
      try { data.docNumber = await nextAvailableDocNumber(data.docNumber); } catch {}
    }
    // The document was so large it hit the output cap and was truncated; the completed sections were
    // salvaged. Tell the front-end so it can warn the user to generate the remaining sections separately.
    const truncated = !!(data && data._truncated);
    if (data) delete data._truncated;
    // Record-form: carry the "add risk matrix" choice on the data so the HTML export includes it.
    if (type === 'record-form' && data && recordOpts && recordOpts.addRiskMatrix) data.includeRiskMatrix = true;
    // Protected-value check: when generated from a source, flag any source numbers/units/limits/
    // model codes missing or changed in the output (heuristic; shown for review, never blocks).
    let valueCheck = null;
    try {
      const srcTextForCheck = [opts.sourceText, opts.updateText].filter(Boolean).join('\n'); // both docs combined
      if (srcTextForCheck && data) {
        const vg = require('../lib/value-guard');
        valueCheck = vg.compareValues(srcTextForCheck, vg.documentText(data));
      }
    } catch { /* value check is advisory — never break generation */ }
    res.json({ success: true, type, data, truncated, valueCheck, sectionCount: (data && Array.isArray(data.sections)) ? data.sections.length : 0 });
  } catch (e) {
    if (e.message && e.message.includes('API key')) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: 'Generation failed: ' + e.message });
  }
});

// Given a docNumber like "TS-TRN-001" / "POL-HSE-001" / "STD-OPS-001",
// scan every saved structured doc for the highest <same-prefix>NNN and return prefix + (max+1) zero-padded.
// If no existing docs match the prefix, returns the input unchanged (so the AI's "001" stays).
async function nextAvailableDocNumber(suggested) {
  const m = String(suggested || '').match(/^(.*?-)(\d+)$/);
  if (!m) return suggested; // not a "PREFIX-NNN" format → leave as-is
  const prefix = m[1];
  const padWidth = m[2].length;
  const startedAt = parseInt(m[2], 10);
  const likePrefix = '%' + prefix.replace(/[%_]/g, m => '\\' + m) + '%';
  const rows = await dbAll(
    `SELECT StructuredData FROM tblFiles WHERE StructuredData LIKE ? ESCAPE '\\' AND StructuredData IS NOT NULL`,
    [likePrefix]);
  const reEsc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('"docNumber"\\s*:\\s*"' + reEsc + '(\\d+)"', 'g');
  let maxN = 0;
  for (const r of rows) {
    const sd = r.StructuredData || '';
    let mm;
    while ((mm = re.exec(sd)) !== null) {
      const n = parseInt(mm[1], 10);
      if (n > maxN) maxN = n;
    }
  }
  if (maxN === 0) return suggested; // no existing doc with this prefix → keep AI's suggestion
  const next = Math.max(maxN + 1, startedAt); // never go BELOW what the AI suggested
  return prefix + String(next).padStart(padWidth, '0');
}

// ---- Template Forms ----
// Blank reusable form templates. Stored in tblFiles with Folder='template-forms'.
router.get('/template-forms', async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT FileID, FileName, MimeType, FileSize, Category, Description, UploadedBy, UploadedDate
       FROM tblFiles WHERE Folder='template-forms' ORDER BY UploadedDate DESC, FileName`, []);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/template-forms', uploadSrc.single('file'), async (req, res) => {
  try {
    if (!(req.session.user && req.session.user.admin)) return res.status(403).json({ error: 'Only an administrator can upload template forms.' });
    if (!req.file) return res.status(400).json({ error: 'No file selected.' });
    const origName = req.file.originalname || 'template';
    const ext = (origName.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    const ALLOWED = ['docx', 'doc', 'pdf', 'xlsx', 'xls', 'csv'];
    if (!ALLOWED.includes(ext)) return res.status(400).json({ error: 'Unsupported file type. Allowed: DOCX, DOC, PDF, XLSX, XLS, CSV.' });
    const MIME = {
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc:  'application/msword',
      pdf:  'application/pdf',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls:  'application/vnd.ms-excel',
      csv:  'text/csv',
    };
    const category = (req.body.category || 'General').trim().slice(0, 80) || 'General';
    const description = (req.body.description || '').trim().slice(0, 500) || null;
    const stored = crypto.randomBytes(16).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), req.file.buffer);
    const r = await dbRun(
      `INSERT INTO tblFiles (EntityType, EntityID, FileName, StoredName, MimeType, FileSize, Category, Description, UploadedBy, Approved, Folder)
       VALUES ('template-form', 0, ?, ?, ?, ?, ?, ?, ?, 1, 'template-forms')`,
      [origName, stored, MIME[ext] || 'application/octet-stream', req.file.size, category, description, req.session.user.username]);
    try { await recordLegacyAudit(req.session.user.username, 'tblFiles', 'TEMPLATE_FORM_UPLOAD', r.lastID, null, null, origName); } catch {}
    res.json({ success: true, fileId: r.lastID, fileName: origName, category });
  } catch (e) { res.status(500).json({ error: 'Upload failed: ' + e.message }); }
});

// Open a Template Form (.docx) in Content Studio: reproduce its LAYOUT (headings, body, tables) as
// editable sections — or reuse the stored structure if it was edited before. Returns
// { type, data:{title,sections}, tsFileId }; the front-end sets csDraft and navigates to Content Studio,
// gaining edit / AI / translation / branding, and "Update Document" saves the branded, layout-preserving
// .docx back to the same file.
router.get('/template-form-to-doc/:fileId', async (req, res) => {
  try {
    const f = await dbGet(`SELECT * FROM tblFiles WHERE FileID=? AND Folder='template-forms'`, [req.params.fileId]);
    if (!f) return res.status(404).json({ error: 'Template form not found.' });
    let data = null;
    let isFormDoc = false;
    if (f.StructuredData) {
      try {
        const d = JSON.parse(f.StructuredData);
        if (d && Array.isArray(d.sections)) { data = d; if (d.isForm) isFormDoc = true; } // created via the "Form (copy exactly)" flow
      } catch (e) { data = null; }
    }
    if (!data) {
      if (!/\.docx$/i.test(f.FileName || '')) {
        return res.status(400).json({ error: 'Only Word .docx template forms can be edited in Content Studio. Export PDFs/spreadsheets to .docx first.' });
      }
      const full = path.join(UPLOAD_DIR, f.StoredName);
      if (!fs.existsSync(full)) return res.status(404).json({ error: 'The stored file is missing.' });
      const parsed = parseDocxToSections(fs.readFileSync(full));
      if (!parsed.sections.length) return res.status(400).json({ error: 'No editable content could be read from that document.' });
      data = { title: parsed.title || (f.FileName || '').replace(/\.docx$/i, ''), sections: parsed.sections };
    }
    // Template forms created via the AI Content Studio "Form (copy an uploaded document exactly)" option
    // re-open in that same mode — no document-control metadata block, exact-layout clone on update.
    res.json({ type: isFormDoc ? 'form-doc' : 'training-standards', data, tsFileId: f.FileID });
  } catch (e) { res.status(500).json({ error: 'Could not open template form: ' + e.message }); }
});

router.delete('/template-forms/:id', async (req, res) => {
  try {
    if (!(req.session.user && req.session.user.admin)) return res.status(403).json({ error: 'Admin only.' });
    const f = await dbGet(`SELECT * FROM tblFiles WHERE FileID=? AND Folder='template-forms'`, [req.params.id]);
    if (!f) return res.status(404).json({ error: 'Template form not found.' });
    // Best-effort delete of the stored file; don't fail the API if it's already gone
    try { fs.unlinkSync(path.join(UPLOAD_DIR, f.StoredName)); } catch {}
    await dbRun('DELETE FROM tblFiles WHERE FileID=?', [req.params.id]);
    try { await recordLegacyAudit(req.session.user.username, 'tblFiles', 'TEMPLATE_FORM_DELETE', req.params.id, null, f.FileName, null); } catch {}
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Delete failed: ' + e.message }); }
});

// Public endpoint for the frontend to fetch the next number for a given prefix.
// E.g. GET /api/content/next-doc-number?prefix=TS-TRN-&width=3
router.get('/next-doc-number', async (req, res) => {
  try {
    const prefix = String(req.query.prefix || '').trim();
    const width = Math.max(1, Math.min(8, parseInt(req.query.width, 10) || 3));
    if (!prefix) return res.status(400).json({ error: 'prefix required' });
    const seed = prefix + String(1).padStart(width, '0');
    const next = await nextAvailableDocNumber(seed);
    res.json({ next });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Flatten a form's bilingual translation into { en, tr } text pairs (heading, each body line, and each
// table cell) so the exact-clone save can append each translation inline next to its English text.
function buildTranslationPairs(sections) {
  const pairs = [];
  const add = (en, tr) => { en = String(en == null ? '' : en).trim(); tr = String(tr == null ? '' : tr).trim(); if (en && tr && en !== tr) pairs.push({ en, tr }); };
  // Whole value AND — when a cell/body holds multiple lines (e.g. a lead-in + bullet list) and the
  // translation preserved the same line count — each line, so every bullet is matched and translated.
  const addMulti = (en, tr) => {
    add(en, tr);
    const el = String(en == null ? '' : en).split('\n'), tl = String(tr == null ? '' : tr).split('\n');
    if (el.length > 1 && el.length === tl.length) for (let i = 0; i < el.length; i++) add(el[i], tl[i]);
  };
  for (const s of (sections || [])) {
    const t = s && s.translation; if (!t) continue;
    if (s.heading) addMulti(s.heading, t.heading);
    if (s.body && t.body) addMulti(s.body, t.body);
    if (s.table && t.table) {
      (s.table.headers || []).forEach((h, j) => addMulti(h, (t.table.headers || [])[j]));
      (s.table.rows || []).forEach((row, i) => (row || []).forEach((c, j) => addMulti(c, (((t.table.rows || [])[i]) || [])[j])));
    }
  }
  return pairs;
}

// Diff the (de-branded) original document against the user's edited sections and return literal
// text replacements { pattern: /old/, replace: new } for anything that changed in place — so the
// exact-clone save/update reflects label/question/body edits without reflowing the layout. Aligned by
// index; structural additions/removals aren't diffable this way (those need the buildDocx rebuild).
function buildEditReplacements(srcBuf, editedData, companyName) {
  let orig;
  try { orig = parseDocxToSections(srcBuf); } catch (e) { return []; }
  if (companyName) { try { debrandSections(orig, srcBuf, companyName); } catch (e) {} }
  const os = orig.sections || [], es = (editedData && editedData.sections) || [];
  const reps = [], seen = new Set();
  const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const add = (oldT, newT) => {
    oldT = String(oldT == null ? '' : oldT).trim(); newT = String(newT == null ? '' : newT).trim();
    if (!oldT || oldT === newT || seen.has(oldT)) return;
    seen.add(oldT);
    const pat = esc(oldT).replace(/\s+/g, '\\s+'); // tolerate whitespace differences between parse and clone
    reps.push({ pattern: new RegExp(pat, 'g'), replace: newT.replace(/\$/g, '$$$$') });
  };
  const n = Math.min(os.length, es.length);
  for (let i = 0; i < n; i++) {
    const o = os[i] || {}, e = es[i] || {};
    add(o.heading, e.heading);
    if (o.body || e.body) {
      const ol = String(o.body || '').split('\n'), el = String(e.body || '').split('\n');
      for (let j = 0; j < Math.min(ol.length, el.length); j++) add(ol[j], el[j]);
    }
    if (o.table && e.table) {
      const oh = o.table.headers || [], eh = e.table.headers || [];
      for (let j = 0; j < Math.min(oh.length, eh.length); j++) add(oh[j], eh[j]);
      const orr = o.table.rows || [], err = e.table.rows || [];
      for (let r = 0; r < Math.min(orr.length, err.length); r++) {
        const orow = orr[r] || [], erow = err[r] || [];
        for (let j = 0; j < Math.min(orow.length, erow.length); j++) add(orow[j], erow[j]);
      }
    }
  }
  return reps;
}

// Refresh the exact-copy preview after the user edits text or runs Translate All — re-clones the source
// with the current edits/translations and returns faithful HTML so the WYSIWYG preview matches exactly
// what a save/download would produce.
router.post('/form-preview', async (req, res) => {
  try {
    const { sourceFileId, data } = req.body || {};
    if (!sourceFileId) return res.status(400).json({ error: 'sourceFileId required' });
    const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [sourceFileId]);
    const fp = f && path.join(UPLOAD_DIR, f.StoredName);
    if (!f || !fp || !fs.existsSync(fp) || !/\.docx$/i.test(f.FileName || '')) return res.status(404).json({ error: 'Source document not found.' });
    const srcBuf = fs.readFileSync(fp);
    const [nameCfg, logoCfg] = await Promise.all([
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, [])
    ]);
    const companyName = (nameCfg && nameCfg.cvalue) ? nameCfg.cvalue.trim() : '';
    const companyLogo = (logoCfg && logoCfg.cvalue) ? logoCfg.cvalue : null;
    const d = data || {};
    const scopedBuf = _scopeFormBuf(srcBuf, d);
    const clone = cloneDocxAsForm(scopedBuf, {
      companyName, companyLogo, autoDetectOrg: true, brandTables: true,
      replacements: await loadDocReplacements(),
      translations: buildTranslationPairs(d.sections || []),
      editReplacements: buildEditReplacements(scopedBuf, d, companyName),
      transSideOrder: d.transSideOrder
    });
    // Preview the SAME fillable HTML the download produces (not the read-only render), so every layout
    // fix — tick boxes in the left column, date pickers, de-branding, edits — shows in the preview.
    const title = _cleanFormTitle(d.fileName || d.title, f.FileName);
    const submitEmail = (typeof d.submitEmail === 'string' && /.+@.+\..+/.test(d.submitEmail.trim())) ? d.submitEmail.trim() : '';
    const orientation = d.orientation === 'landscape' ? 'landscape' : 'portrait';
    res.json({ html: buildFormDocHtml(clone, { title, companyName, companyLogo, submitEmail, orientation, editable: true }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Export a "Form (copy exactly)" draft as a standalone FILLABLE HTML file: the exact document layout with
// blank cells turned into inputs / expandable comment boxes, Word checkboxes into tick boxes, the company
// logo in the top-left letterhead cell, and a Print/Submit bar + page/created/name footer. The client
// downloads the returned HTML. Body: { sourceFileId, data }.
router.post('/form-doc-html', async (req, res) => {
  try {
    const { sourceFileId, data } = req.body || {};
    const d = data || {};
    const srcId = Number(sourceFileId || d.sourceFileId) || 0;
    if (!srcId) return res.status(400).json({ error: 'No source document for this form.' });
    const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [srcId]);
    const fp = f && path.join(UPLOAD_DIR, f.StoredName);
    if (!f || !fp || !fs.existsSync(fp) || !/\.docx$/i.test(f.FileName || '')) return res.status(404).json({ error: 'Source document not found.' });
    const srcBuf = fs.readFileSync(fp);
    const [nameCfg, logoCfg] = await Promise.all([
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, [])
    ]);
    const companyName = (nameCfg && nameCfg.cvalue) ? nameCfg.cvalue.trim() : '';
    const companyLogo = (logoCfg && logoCfg.cvalue) ? logoCfg.cvalue : '';
    const scopedBuf = _scopeFormBuf(srcBuf, d);
    const clone = cloneDocxAsForm(scopedBuf, {
      companyName, companyLogo, autoDetectOrg: true, brandTables: true,
      replacements: await loadDocReplacements(),
      translations: buildTranslationPairs(d.sections || []),
      editReplacements: buildEditReplacements(scopedBuf, d, companyName),
      transSideOrder: d.transSideOrder
    });
    const title = _cleanFormTitle(d.fileName || d.title, f.FileName);
    const submitEmail = (typeof d.submitEmail === 'string' && /.+@.+\..+/.test(d.submitEmail.trim())) ? d.submitEmail.trim() : '';
    const orientation = d.orientation === 'landscape' ? 'landscape' : 'portrait';
    const html = buildFormDocHtml(clone, { title, companyName, companyLogo, submitEmail, orientation });
    const base = title.replace(/[<>:"/\\|?*]+/g, '').trim() || 'Form';
    const filename = base + '.html';
    const token = _makeDownloadToken(Buffer.from(html, 'utf8'), filename, 'text/html; charset=utf-8', tenantOf(req));
    // Return a real GET URL (reliable in embedded browsers) PLUS the raw html as a client-side fallback.
    res.json({ success: true, html, filename, downloadUrl: '/api/content/dl/' + token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stream a one-shot generated file by token as an attachment (works where client-side blob downloads are
// blocked, e.g. in-app browsers). Single-use: the token and its temp file are removed after streaming.
router.get('/dl/:token', (req, res) => {
  const entry = _dlTokens.get(String(req.params.token || ''));
  if (!entry) return res.status(404).send('This download link has expired. Please export again.');
  if (entry.tenantId != null && entry.tenantId !== tenantOf(req)) return res.status(403).send('Not authorised.');
  const done = () => { _dlTokens.delete(req.params.token); try { if (fs.existsSync(entry.file)) fs.unlinkSync(entry.file); } catch {} };
  try {
    if (!fs.existsSync(entry.file)) { done(); return res.status(404).send('File no longer available. Please export again.'); }
    res.setHeader('Content-Type', entry.mime);
    // The quoted filename="…" part of a header value may only contain Latin-1 characters — an em-dash,
    // Thai text or any other non-Latin-1 glyph makes res.setHeader throw ERR_INVALID_CHAR (→ a 500 and no
    // download). Keep an ASCII-only fallback here; the filename*=UTF-8'' part carries the real name, which
    // every modern browser uses, so the downloaded file still keeps its proper (e.g. em-dash) title.
    const asciiName = String(entry.filename).replace(/"/g, '').replace(/[^\x20-\x7E]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(entry.filename)}`);
    const stream = fs.createReadStream(entry.file);
    stream.on('close', done);
    stream.on('error', () => { done(); if (!res.headersSent) res.status(500).end(); });
    stream.pipe(res);
  } catch (e) { done(); if (!res.headersSent) res.status(500).send('Download failed.'); }
});

// Export a "Form (copy exactly)" draft as a Word .docx (the exact, re-branded clone) WITHOUT saving it to
// the library — the client downloads it directly. Body: { sourceFileId, data }.
router.post('/form-doc-docx', async (req, res) => {
  try {
    const { sourceFileId, data } = req.body || {};
    const d = data || {};
    const srcId = Number(sourceFileId || d.sourceFileId) || 0;
    if (!srcId) return res.status(400).json({ error: 'No source document for this form.' });
    const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [srcId]);
    const fp = f && path.join(UPLOAD_DIR, f.StoredName);
    if (!f || !fp || !fs.existsSync(fp) || !/\.docx$/i.test(f.FileName || '')) return res.status(404).json({ error: 'Source document not found.' });
    const srcBuf = fs.readFileSync(fp);
    const [nameCfg, logoCfg] = await Promise.all([
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, [])
    ]);
    const companyName = (nameCfg && nameCfg.cvalue) ? nameCfg.cvalue.trim() : '';
    const companyLogo = (logoCfg && logoCfg.cvalue) ? logoCfg.cvalue : '';
    const scopedBuf = _scopeFormBuf(srcBuf, d);
    const buffer = cloneDocxAsForm(scopedBuf, {
      companyName, companyLogo, autoDetectOrg: true, brandTables: true,
      replacements: await loadDocReplacements(),
      translations: buildTranslationPairs(d.sections || []),
      editReplacements: buildEditReplacements(scopedBuf, d, companyName),
      transSideOrder: d.transSideOrder
    });
    const title = _cleanFormTitle(d.fileName || d.title, f.FileName);
    const base = title.replace(/[<>:"/\\|?*]+/g, '').trim() || 'Form';
    const filename = base + '.docx';
    const token = _makeDownloadToken(buffer, filename, DOCX_MIME, tenantOf(req));
    res.json({ success: true, b64: buffer.toString('base64'), filename, downloadUrl: '/api/content/dl/' + token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// AI SMART FORM — read an uploaded form and rebuild it CLEAN: AI understands the content and produces a
// correctly-structured model (one check box per logical item, wrapped lines merged, distinct items
// separated, labelled fields, no blank cells), then renders a tidy fillable HTML form or Word .docx.
// Body: { sourceFileId, data?, format:'html'|'docx' }. R5 — AI use.
async function _smartFormModel(req) {
  const { sourceFileId, data } = req.body || {};
  const d = data || {};
  const srcId = Number(sourceFileId || d.sourceFileId) || 0;
  if (!srcId) return { error: 'No source document for this form.' };
  const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [srcId]);
  const fp = f && path.join(UPLOAD_DIR, f.StoredName);
  if (!f || !fp || !fs.existsSync(fp)) return { error: 'Source document not found.' };
  const ext = (f.FileName.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  const buf = fs.readFileSync(fp);
  let text = '';
  if (ext === 'docx') { const scoped = _scopeFormBuf(buf, d); text = extractDocxText(scoped); }
  else if (ext === 'pdf') { const { extractPdfText } = require('../lib/content'); text = await extractPdfText(buf); }
  else return { error: 'AI Smart Form needs a Word .docx or PDF source.' };
  if (!text || !text.trim()) return { error: 'No readable text in that document.' };
  const [nameCfg, logoCfg] = await Promise.all([
    dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
    dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, [])
  ]);
  const companyName = (nameCfg && nameCfg.cvalue) ? nameCfg.cvalue.trim() : '';
  const companyLogo = (logoCfg && logoCfg.cvalue) ? logoCfg.cvalue : '';
  // Apply the organisation's find→replace (LGP-JV → AKR, legislation, …) to the text before the AI reads it.
  const reps = await loadDocReplacements();
  for (const r of reps) { try { text = text.replace(r.pattern, r.replace); } catch {} }
  const model = await aiSmartForm({ text });
  if (!model) return { error: 'The AI could not rebuild this form. Try again, or use the exact copy.' };
  const title = (model.title || d.fileName || d.title || (f.FileName || 'Form').replace(/\.[a-z0-9]+$/i, '')).toString();
  return { model, companyName, companyLogo, title };
}

router.post('/smart-form-html', requirePermission('ai.use'), async (req, res) => {
  try {
    const r = await _smartFormModel(req);
    if (r.error) return res.status(400).json({ error: r.error });
    const html = buildSmartFormHtml(r.model, { companyName: r.companyName, companyLogo: r.companyLogo, title: r.title });
    const base = r.title.replace(/[<>:"/\\|?*]+/g, '').trim() || 'Form';
    const filename = base + '.html';
    const token = _makeDownloadToken(Buffer.from(html, 'utf8'), filename, 'text/html; charset=utf-8', tenantOf(req));
    res.json({ success: true, html, model: r.model, filename, downloadUrl: '/api/content/dl/' + token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/smart-form-docx', requirePermission('ai.use'), async (req, res) => {
  try {
    const r = await _smartFormModel(req);
    if (r.error) return res.status(400).json({ error: r.error });
    const buffer = smartFormToDocx(r.model, { companyName: r.companyName, companyLogo: r.companyLogo, title: r.title });
    const base = r.title.replace(/[<>:"/\\|?*]+/g, '').trim() || 'Form';
    const filename = base + '.docx';
    const token = _makeDownloadToken(buffer, filename, DOCX_MIME, tenantOf(req));
    res.json({ success: true, b64: buffer.toString('base64'), filename, downloadUrl: '/api/content/dl/' + token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// For a translated Training Manual, translate the Safety Prompts legend into the document's language so the
// safety section is bilingual too. Returns { intro, rows:[{label,text}] } or null (untranslated / on error).
async function safetyPromptsTransFor(data) {
  const transLang = (data && Array.isArray(data.sections))
    ? data.sections.reduce((l, s) => l || (s && s.translation && s.translation.lang) || null, null) : null;
  if (!transLang) return null;
  try {
    const { translateSection, SAFETY_PROMPTS_CONTENT } = require('../lib/content');
    const code = langCodeFromName(transLang);
    let glossary = [];
    if (code) glossary = await dbAll('SELECT SourceTerm, TargetTerm FROM tblTerminology WHERE LangCode=?', [code]);
    const payload = { intro: SAFETY_PROMPTS_CONTENT.intro, rows: SAFETY_PROMPTS_CONTENT.rows.map(r => ({ label: r.label, text: r.text })) };
    const tr = await translateSection(payload, transLang, glossary);
    return (tr && (tr.intro || Array.isArray(tr.rows))) ? tr : null;
  } catch { return null; }
}

// Step 2 — save the (possibly user-edited) draft into the right module.
// R4 — saving authored content requires documents.write (admins bypass; read-only users denied).
router.post('/save', requirePermission('documents.write'), async (req, res) => {
  try {
    const { type, data, destination, materialCategory } = req.body;
    if (!CONTENT_TYPES.find(t => t.key === type)) return res.status(400).json({ error: 'Invalid content type.' });
    if (!data) return res.status(400).json({ error: 'Nothing to save.' });
    const user = req.session.user.username;
    const tenantId = tenantOf(req); // R3
    let result;

    const TYPE_LABELS = {
      exam: 'Exam', form: 'Assessment Form', 'training-request': 'Training Request Form',
      course: 'Course', 'training-plan': 'Training Plan', induction: 'Induction Pack',
      'training-manual': 'Training Manual', 'training-handout': 'Training Handout',
      'training-deck': 'Training Deck', sop: 'SOP', swp: 'Safe Work Procedure',
      jsa: 'Job Safety Analysis', 'safety-alert': 'Safety Alert', 'toolbox-talk': 'Toolbox Talk',
      'transfer-to-training': 'Transfer to Training', 'return-to-ops': 'Return to Operations',
      'training-standards': 'Training Standards Document', policy: 'Policy',
      standard: 'Standard', plan: 'Plan', 'management-plan': 'Management Plan', 'strategy-plan': 'Strategy Plan',
      'record-form': 'Record Form', checklist: 'Checklist',
      'akara-leadership': 'Leadership Expectations', process: 'Process Document',
      'trainer-assessor-guide': 'Trainer and Assessor Guide',
      'statutory-regulatory': 'Statutory and Regulatory Requirements',
      'operational-guidelines': 'Operational Guidelines'
    };
    if (type === 'exam') {
      result = await saveExam(data, user);
      result.message = `Exam "${result.name}" created with ${(data.questions || []).length} questions — open the Exam Builder to review and publish.`;
    } else if (type === 'record-form' && (data.includeRiskMatrix || data.removedTraining)) {
      // Record form with "Add risk matrix" and/or "Remove training information" selected → emit a proper
      // Word document (NOT the Form Builder, which hard-codes Trainee/Trainer scaffolding and omits the
      // matrix). The fill-in grid is laid out via recordFormToDocx; the colour AKARA matrix is appended
      // when requested. This keeps the final .docx free of training fields and includes the matrix.
      const [nameCfg, logoCfg] = await Promise.all([
        dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
        dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, [])
      ]);
      const companyName = (nameCfg && nameCfg.cvalue) ? nameCfg.cvalue.trim() : '';
      const companyLogo = (logoCfg && logoCfg.cvalue) ? logoCfg.cvalue : '';
      const rf = recordFormToDocx(data);
      const buffer = buildDocx(rf.title, rf.sections,
        { type: 'record-form', companyName, companyLogo, includeRiskMatrix: !!data.includeRiskMatrix });
      const stored = crypto.randomBytes(16).toString('hex') + '.docx';
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), buffer);
      const baseName = (data.fileName || data.name || data.title || 'Record Form').replace(/[<>:"/\\|?*]+/g, '').trim() || 'Record Form';
      const name = `${baseName}.docx`;
      const r = await dbRun(
        `INSERT INTO tblFiles (EntityType, EntityID, FileName, StoredName, MimeType, FileSize, Category, Description, UploadedBy, Approved, Status, StructuredData, Folder, TenantID)
         VALUES ('template-form', 0, ?, ?, ?, ?, 'Record Form', 'Created in AI Content Studio (record form)', ?, 1, 'Approved', ?, 'template-forms', ?)`,
        [name, stored, DOCX_MIME, buffer.length, user, JSON.stringify(data), tenantId]);
      result = { id: r.lastID, name, fileId: r.lastID, folder: 'template-forms', page: 'forms',
        message: `Record form "${baseName}" saved to Template Forms as a Word document${data.includeRiskMatrix ? ' (with the AKARA risk matrix)' : ''}.` };
    } else if (type === 'form' || type === 'training-request' || type === 'record-form') {
      // Record forms + training-request forms are general record/template forms (NOT competency
      // assessments) — categorise them so the Field Assessment view doesn't add Trainee/Trainer +
      // signature scaffolding. Only 'form' (assessment form) stays a competency assessment.
      const formCategory = (type === 'record-form' || type === 'training-request') ? 'template-form' : 'assessment';
      result = await saveForm(data, user, formCategory);
      result.message = `Form "${result.name}" created with ${(data.fields || []).length} fields — open it under ${formCategory === 'template-form' ? 'Template Forms' : 'the Form Builder'} to review.`;
    } else if (type === 'excel-form') {
      // Excel form → build a .xlsx spreadsheet and save it into Template Forms (downloadable).
      const [nameCfg, logoCfg] = await Promise.all([
        dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
        dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, [])
      ]);
      const companyName = (nameCfg && nameCfg.cvalue) ? nameCfg.cvalue.trim() : '';
      const companyLogo = (logoCfg && logoCfg.cvalue) ? logoCfg.cvalue : '';
      const dashboard = !!(req.body && (req.body.dashboard || (data && data.dashboard)));
      const buffer = buildExcelForm(data, { companyName, companyLogo, dashboard });
      const stored = crypto.randomBytes(16).toString('hex') + '.xlsx';
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), buffer);
      const baseName = (data.name || data.title || 'Excel Form').replace(/[<>:"/\\|?*]+/g, '').trim() || 'Excel Form';
      const name = `${baseName}.xlsx`;
      const r = await dbRun(
        `INSERT INTO tblFiles (EntityType, EntityID, FileName, StoredName, MimeType, FileSize, Category, Description, UploadedBy, Approved, Status, StructuredData, Folder, TenantID)
         VALUES ('template-form', 0, ?, ?, ?, ?, 'Excel Form', 'Created in AI Content Studio (Excel form)', ?, 1, 'Approved', ?, 'template-forms', ?)`,
        [name, stored, XLSX_MIME, buffer.length, user, JSON.stringify(data), tenantId]);
      result = { id: r.lastID, name, fileId: r.lastID, folder: 'template-forms', page: 'forms',
        message: `Excel form "${baseName}" saved to Template Forms — open it to download the .xlsx.` };
    } else if (type === 'form-doc') {
      // Form -> saved into Template Forms as an EXACT clone of the uploaded .docx (keeps every table,
      // merge, column width and fill-in cell — so Y/N stay in their narrow right columns, comment cells
      // stay writable, and there are no gaps), then rebranded: company letterhead logo, third-party org
      // names swapped for the company's (autoDetectOrg), and the source's shaded header cells recoloured
      // to the TrainingPro dark-blue scheme (brandTables). If the source is unavailable, fall back to the
      // buildDocx rebuild.
      const [nameCfg, logoCfg] = await Promise.all([
        dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
        dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, [])
      ]);
      const companyName = (nameCfg && nameCfg.cvalue) ? nameCfg.cvalue.trim() : '';
      const companyLogo = (logoCfg && logoCfg.cvalue) ? logoCfg.cvalue : '';
      let buffer = null;
      const srcId = Number(data.sourceFileId) || 0;
      if (srcId) {
        const src = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [srcId]);
        const srcPath = src && path.join(UPLOAD_DIR, src.StoredName);
        if (src && srcPath && /\.docx$/i.test(src.FileName || '') && fs.existsSync(srcPath)) {
          {
            const rawBuf = fs.readFileSync(srcPath);
            const srcBuf = _scopeFormBuf(rawBuf, data);
            buffer = cloneDocxAsForm(srcBuf, { companyName, companyLogo, autoDetectOrg: true, brandTables: true, replacements: await loadDocReplacements(), translations: buildTranslationPairs(data.sections), editReplacements: buildEditReplacements(srcBuf, data, companyName), transSideOrder: data.transSideOrder });
          }
        }
      }
      if (!buffer) {
        buffer = buildDocx(data.title || 'Form', data.sections || [],
          { type: 'form-doc', transLayout: data.transLayout || "below", transSideOrder: data.transSideOrder, companyName, companyLogo });
      }
      const stored = crypto.randomBytes(16).toString('hex') + '.docx';
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), buffer);
      const baseName = (data.fileName || data.title || 'Form').replace(/[<>:"/\\|?*]+/g, '').trim() || 'Form';
      const name = `${baseName}.docx`;
      const structuredJson = JSON.stringify(data);
      const r = await dbRun(
        `INSERT INTO tblFiles (EntityType, EntityID, FileName, StoredName, MimeType, FileSize, Category, Description, UploadedBy, Approved, Status, StructuredData, Folder, TenantID)
         VALUES ('template-form', 0, ?, ?, ?, ?, 'General', 'Created in AI Content Studio (Form — exact copy)', ?, 1, 'Approved', ?, 'template-forms', ?)`,
        [name, stored, DOCX_MIME, buffer.length, user, structuredJson, tenantId]);
      result = { id: r.lastID, name, fileId: r.lastID, folder: 'template-forms', page: 'forms',
        message: `Form "${baseName}" saved to Template Forms.` };
    } else { // all doc types -> .docx in the Document Library
      const [nameCfg, logoCfg] = await Promise.all([
        dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
        dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, [])
      ]);
      const wantSafety = type === 'training-manual' && data.includeSafetyPrompts !== false;
      const safetyPromptsTrans = wantSafety ? await safetyPromptsTransFor(data) : null;
      const buffer = buildDocx(data.title || 'AI-generated content', data.sections || [],
        { subtitle: data.subtitle || '', docNumber: data.docNumber || '', type, meta: data.meta || {},
          transLayout: data.transLayout || 'below', transSideOrder: data.transSideOrder,
          // Contents page + Safety Prompts legend after the document-control page — ONLY for Training Manuals.
          includeToc: ['training-manual','management-plan','strategy-plan','operational-guidelines'].includes(type) && data.includeToc !== false,
          includeSafetyPrompts: wantSafety, safetyPromptsTrans,
          companyName: (nameCfg && nameCfg.cvalue) ? nameCfg.cvalue.trim() : '',
          companyLogo: (logoCfg && logoCfg.cvalue) ? logoCfg.cvalue : '' });
      const stored = crypto.randomBytes(16).toString('hex') + '.docx';
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), buffer);
      const typeLabel = TYPE_LABELS[type] || 'Document';
      const baseName = (data.fileName || data.title || typeLabel).replace(/[<>:"/\\|?*]+/g, '').trim() || typeLabel;
      const name = `${baseName} (AI draft).docx`;
      const isTS = ['training-standards','policy','standard','plan','management-plan','strategy-plan','checklist'].includes(type);
      // Destination folder: explicit dropdown choice, else default by type
      let folder = destination || (isTS ? 'training-standards' : 'library');
      if (!['library', 'training-standards', 'training-material'].includes(folder)) folder = 'library';
      let category = typeLabel;
      if (folder === 'training-material') {
        const cat = (materialCategory || '').trim();
        if (!cat) return res.status(400).json({ error: 'Choose (or add) a Training Material category.' });
        await dbRun('INSERT OR IGNORE INTO tblTrainMatCat (Name) VALUES (?)', [cat]); // create on first use
        category = cat;
      }
      // Store structured data for ALL document types so every doc stays previewable / re-editable.
      const structuredJson = JSON.stringify(data);
      const r = await dbRun(
        `INSERT INTO tblFiles (EntityType, EntityID, FileName, StoredName, MimeType, FileSize, Category, Description, UploadedBy, Approved, Status, StructuredData, Folder, TenantID)
         VALUES ('document', 0, ?, ?, ?, ?, ?, 'AI Content Studio draft — pending review', ?, 0, 'Draft', ?, ?, ?)`,
        [name, stored, DOCX_MIME, buffer.length, category, user, structuredJson, folder, tenantId]);
      const destLabel = folder === 'training-standards' ? 'Training Standards'
        : folder === 'training-material' ? `Training Material → ${category}` : 'Document Library';
      result = { id: r.lastID, name, fileId: r.lastID, folder, message: `${typeLabel} draft saved to ${destLabel}.` };
    }

    await recordLegacyAudit(user, 'AIContent', 'SAVE', result.id, type, null, result.name);
    res.json({ success: true, type, ...result });
  } catch (e) { res.status(500).json({ error: 'Save failed: ' + e.message }); }
});

// Bilingual translation — translate one section's content to a target language
router.post('/translate', requirePermission('documents.translate'), async (req, res) => {
  try {
    const { section, targetLang, kbArticleIds } = req.body;
    if (!section || !targetLang) return res.status(400).json({ error: 'section and targetLang required' });
    // Look up the approved terminology glossary for this language and enforce it in the translation
    const code = langCodeFromName(targetLang);
    let glossary = [];
    if (code) glossary = await dbAll('SELECT SourceTerm, TargetTerm FROM tblTerminology WHERE LangCode=?', [code]);
    // Knowledge Base context (selected articles) — site facts/names the translation should respect
    let kbContext = '';
    if (Array.isArray(kbArticleIds) && kbArticleIds.length) {
      const ph = kbArticleIds.map(() => '?').join(',');
      const kbRows = await dbAll(
        `SELECT Title, Body FROM tblKBArticle WHERE ArticleID IN (${ph}) AND Status='Published'`, kbArticleIds);
      if (kbRows.length) kbContext = kbRows.map(r => `[${r.Title}]\n${r.Body}`).join('\n\n---\n\n');
    }
    const translated = await translateSection(section, targetLang, glossary, kbContext);
    res.json({ translated, glossaryTerms: glossary.length, kbArticles: (Array.isArray(kbArticleIds) ? kbArticleIds.length : 0) });
  } catch (e) { res.status(500).json({ error: 'Translation failed: ' + e.message }); }
});

// AI assist for one page/section — fill blank table cells and add missing content.
// R5 — requires ai.use (admins bypass).
router.post('/assist', requirePermission('ai.use'), async (req, res) => {
  try {
    const { heading, body, table, docTitle, kbArticleIds, prompt, imageFileId, refFileId, updateMode, targetRows } = req.body || {};
    // Site facts (selected KB articles) so filled values respect organisation data.
    let kbContext = '';
    if (Array.isArray(kbArticleIds) && kbArticleIds.length) {
      const ph = kbArticleIds.map(() => '?').join(',');
      const kbRows = await dbAll(
        `SELECT Title, Body FROM tblKBArticle WHERE ArticleID IN (${ph}) AND Status='Published'`, kbArticleIds);
      if (kbRows.length) kbContext = kbRows.map(r => `[${r.Title}]\n${r.Body}`).join('\n\n---\n\n');
    }

    // Load an uploaded file (image to analyse / reference file) by its FileID.
    const { extractPdfText } = require('../lib/content');
    const loadUpload = async (fileId) => {
      if (!fileId) return null;
      const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [fileId]);
      const fp = f && path.join(UPLOAD_DIR, f.StoredName);
      if (!f || !fs.existsSync(fp)) return null;
      const ext = (f.FileName.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
      const buf = fs.readFileSync(fp);
      if (IMG_MEDIA[ext]) return { kind: 'image', block: { type: 'image', source: { type: 'base64', media_type: IMG_MEDIA[ext], data: buf.toString('base64') } } };
      if (ext === 'pdf') return { kind: 'text', text: await extractPdfText(buf) };
      if (ext === 'docx') return { kind: 'text', text: extractDocxText(buf) };
      if (ext === 'pptx') return { kind: 'text', text: require('../lib/content').extractPptxText(buf) };
      return null;
    };
    const img = await loadUpload(imageFileId);
    const ref = await loadUpload(refFileId);
    const opts = { docTitle, kbContext, userPrompt: prompt || '',
      updateMode: updateMode === 'update' ? 'update' : 'fill',
      targetRows: Array.isArray(targetRows) ? targetRows : [] };
    if (img && img.block) opts.imageBlock = img.block;
    if (ref) { if (ref.block) opts.refBlock = ref.block; else if (ref.text) opts.refText = ref.text; }

    const { assistSection } = require('../lib/content');
    const result = await assistSection({ heading, body, table }, opts);
    // Count how many blanks were actually filled (for user feedback).
    let filled = 0;
    if (table && Array.isArray(table.rows) && result.table && Array.isArray(result.table.rows)) {
      table.rows.forEach((row, ri) => (row || []).forEach((c, ci) => {
        if (!String(c || '').trim()) {
          const nv = ((result.table.rows[ri] || [])[ci] || '');
          if (String(nv).trim()) filled++;
        }
      }));
    }
    res.json({ table: result.table || null, bodyAddition: result.bodyAddition || '', bodyReplace: (typeof result.bodyReplace === 'string' ? result.bodyReplace : null), filled });
  } catch (e) { res.status(500).json({ error: 'AI assist failed: ' + e.message }); }
});

// Update an existing TS document in-place.
// R4 — requires documents.write (admins bypass). R3 — tenant-scoped. R1 — snapshots the
// current version before overwriting. R2 — an edit reverts an approved doc to Draft.
router.put('/ts-doc/:id', requirePermission('documents.write'), async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    const { type, data, changeNote } = req.body;
    if (!data) return res.status(400).json({ error: 'data required' });
    const existing = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [fileId]);
    if (!existing) return res.status(404).json({ error: 'Document not found' });
    // R3 — cannot edit another tenant's document.
    if ((existing.TenantID || 1) !== tenantOf(req)) return res.status(403).json({ error: 'Not found in this tenant' });
    const [nameCfg, logoCfg] = await Promise.all([
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, [])
    ]);
    const companyName = (nameCfg && nameCfg.cvalue) ? nameCfg.cvalue.trim() : '';
    const companyLogo = (logoCfg && logoCfg.cvalue) ? logoCfg.cvalue : '';
    let buffer = null;
    // Form (exact copy): re-clone the original source (exact tables/columns/fill cells, no metadata) and
    // inject the current translations — same output as the first save, so editing/translating keeps layout.
    if (type === 'form-doc') {
      const srcId = Number(data.sourceFileId) || 0;
      if (srcId) {
        const src = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [srcId]);
        const srcPath = src && path.join(UPLOAD_DIR, src.StoredName);
        if (src && srcPath && /\.docx$/i.test(src.FileName || '') && fs.existsSync(srcPath)) {
          {
            const rawBuf = fs.readFileSync(srcPath);
            const srcBuf = _scopeFormBuf(rawBuf, data);
            buffer = cloneDocxAsForm(srcBuf, { companyName, companyLogo, autoDetectOrg: true, brandTables: true, replacements: await loadDocReplacements(), translations: buildTranslationPairs(data.sections), editReplacements: buildEditReplacements(srcBuf, data, companyName), transSideOrder: data.transSideOrder });
          }
        }
      }
    }
    if (!buffer) {
      const wantSafety = type === 'training-manual' && data.includeSafetyPrompts !== false;
      const safetyPromptsTrans = wantSafety ? await safetyPromptsTransFor(data) : null;
      buffer = buildDocx(data.title || 'Document', data.sections || [],
        { subtitle: data.subtitle || '', docNumber: data.docNumber || '', type, meta: data.meta || {},
          transLayout: data.transLayout || "below", transSideOrder: data.transSideOrder,
          includeToc: ['training-manual','management-plan','strategy-plan','operational-guidelines'].includes(type) && data.includeToc !== false,
          includeSafetyPrompts: wantSafety, safetyPromptsTrans,
          companyName, companyLogo });
    }
    const storedPath = path.join(UPLOAD_DIR, existing.StoredName);
    // R1 — snapshot the CURRENT version before overwriting so nothing is ever lost.
    // Copy the existing bytes to a version-stored file and record the row (best-effort; a
    // snapshot failure must not block the save, but is logged to the audit trail).
    const prevVersion = existing.Version || 1;
    try {
      let snapStored = null;
      if (existing.StoredName && fs.existsSync(storedPath)) {
        snapStored = 'ver_' + crypto.randomBytes(12).toString('hex') + '.docx';
        fs.copyFileSync(storedPath, path.join(UPLOAD_DIR, snapStored));
      }
      await dbRun(
        `INSERT INTO tblFileVersion (FileID, TenantID, Version, FileName, StoredName, MimeType, FileSize, StructuredData, ChangeNote, ChangedBy)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [fileId, existing.TenantID || 1, prevVersion, existing.FileName, snapStored, existing.MimeType,
         existing.FileSize, existing.StructuredData, (changeNote || '').toString().slice(0, 500) || null, req.session.user.username]);
    } catch (snapErr) {
      try { await recordLegacyAudit(req.session.user.username, 'AIContent', 'VERSION_SNAPSHOT_FAILED', fileId, type, null, String(snapErr.message || snapErr)); } catch {}
    }
    fs.writeFileSync(storedPath, buffer);
    // R2 — editing invalidates any prior approval: revert to Draft and clear approval/publish stamps.
    await dbRun(
      `UPDATE tblFiles SET FileSize=?, StructuredData=?, Version=?, Status='Draft', Approved=0,
              ApprovedBy=NULL, ApprovedDate=NULL, ReviewedBy=NULL, ReviewedDate=NULL, PublishedBy=NULL, PublishedDate=NULL,
              UploadedDate=datetime('now'), UploadedBy=? WHERE FileID=?`,
      [buffer.length, JSON.stringify(data), prevVersion + 1, req.session.user.username, fileId]);
    // Master/derived: editing a master invalidates its derivatives → flag them for review.
    let staleFlagged = 0;
    try {
      const r = await dbRun("UPDATE tblFiles SET MasterStale=1 WHERE MasterFileID=? AND TenantID=?", [fileId, tenantOf(req)]);
      staleFlagged = r.changes || 0;
    } catch { /* non-fatal */ }
    await recordLegacyAudit(req.session.user.username, 'AIContent', 'UPDATE', fileId, type, 'v' + prevVersion, 'v' + (prevVersion + 1) + ' · ' + existing.FileName);
    res.json({ success: true, fileId, version: prevVersion + 1, derivativesFlagged: staleFlagged,
      message: 'Document updated (v' + (prevVersion + 1) + '). Previous version saved to history; status reset to Draft for re-approval.' + (staleFlagged ? ` ${staleFlagged} derived version(s) flagged for review.` : '') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Training Standards library — all docs generated with TS-related types
router.get('/ts-docs', async (req, res) => {
  try {
    const cats = [
      'Training Standards Document', 'Policy', 'Standard', 'Plan', 'Checklist',
      'Training Standards Document (AI draft)', 'Policy (AI draft)',
      'Standard (AI draft)', 'Plan (AI draft)', 'Checklist (AI draft)'
    ];
    const ph = cats.map(() => '?').join(',');
    const rows = await dbAll(
      `SELECT FileID, FileName, Category, UploadedDate, UploadedBy, FileSize, StructuredData,
              Status, Version, Approved
       FROM tblFiles WHERE TenantID=? AND (Folder='training-standards' OR (Folder IS NULL AND Category IN (${ph})))
       ORDER BY UploadedDate DESC`, [tenantOf(req), ...cats]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// R1 VERSION HISTORY + R2 APPROVAL / PUBLISH WORKFLOW (on the live tblFiles model)
// ══════════════════════════════════════════════════════════════════════════════

// Governance state for one document (status, version, who approved/published, history count).
router.get('/doc/:id/governance', async (req, res) => {
  try {
    const fileId = parseInt(req.params.id, 10);
    const f = await dbGet(
      `SELECT FileID, FileName, Status, Version, Approved, ApprovedBy, ApprovedDate,
              ReviewedBy, ReviewedDate, PublishedBy, PublishedDate, TenantID,
              MasterFileID, DerivedProfile, DerivedDepth, DerivedLang, MasterStale, MasterVersion
       FROM tblFiles WHERE FileID=?`, [fileId]);
    if (!f || (f.TenantID || 1) !== tenantOf(req)) return res.status(404).json({ error: 'Document not found' });
    const versions = await dbAll(
      `SELECT VersionID, Version, FileName, FileSize, ChangeNote, ChangedBy, ChangedDate
       FROM tblFileVersion WHERE FileID=? ORDER BY Version DESC`, [fileId]);
    // Derivatives of this document (empty for a pure derivative/standalone).
    const derivs = await dbAll(
      `SELECT FileID, FileName, DerivedProfile, DerivedDepth, DerivedLang, Status, Version, MasterStale
       FROM tblFiles WHERE MasterFileID=? AND TenantID=? ORDER BY FileID`, [fileId, tenantOf(req)]);
    res.json({ ...f, versions, derivatives: derivs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// R2 — advance a document through its lifecycle. actions:
//   submit  -> 'Under Review'   (documents.write)
//   approve -> 'Approved'       (documents.publish)
//   publish -> 'Published'      (documents.publish)  [must already be Approved]
//   reject/return -> 'Draft'    (documents.publish)
const _statusPermission = { submit: 'documents.write', approve: 'documents.publish', publish: 'documents.publish', reject: 'documents.publish' };
router.post('/doc-status/:id', async (req, res) => {
  try {
    const action = String((req.body && req.body.action) || '').toLowerCase();
    const perm = _statusPermission[action];
    if (!perm) return res.status(400).json({ error: 'Invalid action. Use submit | approve | publish | reject.' });
    // Inline permission check (admins bypass) so one route can gate per-action.
    const u = req.session.user;
    if (!u.admin && !(Array.isArray(u.permissions) && u.permissions.includes(perm)))
      return res.status(403).json({ error: 'Permission required: ' + perm });
    const fileId = parseInt(req.params.id, 10);
    const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [fileId]);
    if (!f || (f.TenantID || 1) !== tenantOf(req)) return res.status(404).json({ error: 'Document not found' });
    const who = u.username;
    let sql, params, newStatus;
    if (action === 'submit') {
      newStatus = 'Under Review';
      sql = "UPDATE tblFiles SET Status='Under Review' WHERE FileID=?"; params = [fileId];
    } else if (action === 'approve') {
      newStatus = 'Approved';
      sql = "UPDATE tblFiles SET Status='Approved', Approved=1, ApprovedBy=?, ApprovedDate=datetime('now'), ReviewedBy=?, ReviewedDate=datetime('now') WHERE FileID=?";
      params = [who, who, fileId];
    } else if (action === 'publish') {
      if (f.Status !== 'Approved' && f.Approved !== 1) return res.status(400).json({ error: 'Document must be Approved before publishing.' });
      newStatus = 'Published';
      sql = "UPDATE tblFiles SET Status='Published', Approved=1, PublishedBy=?, PublishedDate=datetime('now') WHERE FileID=?";
      params = [who, fileId];
    } else { // reject / return to draft
      newStatus = 'Draft';
      sql = "UPDATE tblFiles SET Status='Draft', Approved=0, ApprovedBy=NULL, ApprovedDate=NULL, PublishedBy=NULL, PublishedDate=NULL WHERE FileID=?";
      params = [fileId];
    }
    await dbRun(sql, params);
    await recordLegacyAudit(who, 'AIContent', 'STATUS_' + action.toUpperCase(), fileId, f.Status || '', null, newStatus);
    res.json({ success: true, fileId, status: newStatus });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// R1 — download a historical version's file bytes.
router.get('/doc-version/:versionId/download', async (req, res) => {
  try {
    const vId = parseInt(req.params.versionId, 10);
    const v = await dbGet('SELECT * FROM tblFileVersion WHERE VersionID=?', [vId]);
    if (!v || (v.TenantID || 1) !== tenantOf(req)) return res.status(404).json({ error: 'Version not found' });
    if (!v.StoredName) return res.status(404).json({ error: 'This version has no stored file.' });
    const p = path.join(UPLOAD_DIR, v.StoredName);
    if (!fs.existsSync(p)) return res.status(404).json({ error: 'Version file missing on disk.' });
    res.setHeader('Content-Type', v.MimeType || DOCX_MIME);
    // ASCII-safe quoted filename (non-Latin-1 chars throw ERR_INVALID_CHAR); filename* carries the real name.
    const vFull = `v${v.Version} ${v.FileName || 'document.docx'}`;
    const vAscii = vFull.replace(/"/g, '').replace(/[^\x20-\x7E]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${vAscii}"; filename*=UTF-8''${encodeURIComponent(vFull)}`);
    fs.createReadStream(p).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// R1 — restore a historical version as the current document (snapshots current first, via the same path).
router.post('/doc-version/:versionId/restore', requirePermission('documents.write'), async (req, res) => {
  try {
    const vId = parseInt(req.params.versionId, 10);
    const v = await dbGet('SELECT * FROM tblFileVersion WHERE VersionID=?', [vId]);
    if (!v || (v.TenantID || 1) !== tenantOf(req)) return res.status(404).json({ error: 'Version not found' });
    const existing = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [v.FileID]);
    if (!existing || (existing.TenantID || 1) !== tenantOf(req)) return res.status(404).json({ error: 'Document not found' });
    const storedPath = path.join(UPLOAD_DIR, existing.StoredName);
    const prevVersion = existing.Version || 1;
    // Snapshot the current bytes before restoring, so restore is itself reversible.
    try {
      let snapStored = null;
      if (existing.StoredName && fs.existsSync(storedPath)) {
        snapStored = 'ver_' + crypto.randomBytes(12).toString('hex') + '.docx';
        fs.copyFileSync(storedPath, path.join(UPLOAD_DIR, snapStored));
      }
      await dbRun(
        `INSERT INTO tblFileVersion (FileID, TenantID, Version, FileName, StoredName, MimeType, FileSize, StructuredData, ChangeNote, ChangedBy)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [existing.FileID, existing.TenantID || 1, prevVersion, existing.FileName, snapStored, existing.MimeType,
         existing.FileSize, existing.StructuredData, 'Auto-snapshot before restoring v' + v.Version, req.session.user.username]);
    } catch { /* non-fatal */ }
    // Restore the historical bytes + structured data into the live row.
    if (v.StoredName && fs.existsSync(path.join(UPLOAD_DIR, v.StoredName))) {
      fs.copyFileSync(path.join(UPLOAD_DIR, v.StoredName), storedPath);
    }
    await dbRun(
      `UPDATE tblFiles SET StructuredData=?, FileSize=?, Version=?, Status='Draft', Approved=0,
              ApprovedBy=NULL, ApprovedDate=NULL, ReviewedBy=NULL, ReviewedDate=NULL, PublishedBy=NULL, PublishedDate=NULL,
              UploadedDate=datetime('now'), UploadedBy=? WHERE FileID=?`,
      [v.StructuredData, v.FileSize, prevVersion + 1, req.session.user.username, existing.FileID]);
    await recordLegacyAudit(req.session.user.username, 'AIContent', 'VERSION_RESTORE', existing.FileID, 'v' + v.Version, null, 'v' + (prevVersion + 1));
    let restoredData = null;
    try { restoredData = JSON.parse(v.StructuredData || '{}'); } catch {}
    res.json({ success: true, fileId: existing.FileID, restoredFrom: v.Version, version: prevVersion + 1, data: restoredData });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// MASTER / DERIVED versions — generate an audience-adapted derivative of a master doc
// ══════════════════════════════════════════════════════════════════════════════

// Load any editable document's structured data by FileID (tenant-scoped) — used to open
// derivatives / linked docs in the editor without depending on a client-side cache.
router.get('/doc-data/:id', async (req, res) => {
  try {
    const f = await dbGet('SELECT FileID, StructuredData, Category, Folder, TenantID FROM tblFiles WHERE FileID=?', [parseInt(req.params.id, 10)]);
    if (!f || (f.TenantID || 1) !== tenantOf(req)) return res.status(404).json({ error: 'Document not found' });
    if (!f.StructuredData) return res.status(400).json({ error: 'This document has no editable data.' });
    let data; try { data = JSON.parse(f.StructuredData); } catch { return res.status(400).json({ error: 'Could not read document data.' }); }
    res.json({ fileId: f.FileID, data, category: f.Category, folder: f.Folder });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List a master document's derivatives.
router.get('/derivatives/:masterId', async (req, res) => {
  try {
    const masterId = parseInt(req.params.masterId, 10);
    const rows = await dbAll(
      `SELECT FileID, FileName, Category, Folder, DerivedProfile, DerivedDepth, DerivedLang,
              Status, Version, MasterStale, UploadedBy, UploadedDate
       FROM tblFiles WHERE MasterFileID=? AND TenantID=? ORDER BY FileID`, [masterId, tenantOf(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create an audience-adapted DERIVED version of a master document.
// R5 — uses AI (adaptDocument) so requires ai.use. Body: { learningProfile, techDepth, type }.
// Core: create ONE audience-adapted derived version of a master doc. Returns the new row info.
async function deriveVariant(master, learningProfile, techDepth, type, companyName, companyLogo, username, tenantId) {
  const rootMasterId = master.MasterFileID || master.FileID;
  const data = JSON.parse(master.StructuredData);
  const adapted = await adaptDocument(data, LEARNING_PROFILES[learningProfile] ? learningProfile : null, TECH_DEPTHS[techDepth] ? techDepth : null);
  const wantSafety = type === 'training-manual' && adapted.includeSafetyPrompts !== false;
  const safetyPromptsTrans = wantSafety ? await safetyPromptsTransFor(adapted) : null;
  const buffer = buildDocx(adapted.title || 'Derived document', adapted.sections || [],
    { subtitle: adapted.subtitle || '', docNumber: adapted.docNumber || '', type, meta: adapted.meta || {},
      transLayout: adapted.transLayout || 'below', transSideOrder: adapted.transSideOrder,
      includeToc: ['training-manual','management-plan','strategy-plan','operational-guidelines'].includes(type) && adapted.includeToc !== false,
      includeSafetyPrompts: wantSafety, safetyPromptsTrans, companyName, companyLogo });
  const stored = crypto.randomBytes(16).toString('hex') + '.docx';
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buffer);
  const variantParts = [];
  if (LEARNING_PROFILES[learningProfile]) variantParts.push(LEARNING_PROFILES[learningProfile].label.replace(/ —.*$/, '').replace(/^Level /, 'L'));
  if (TECH_DEPTHS[techDepth]) variantParts.push(TECH_DEPTHS[techDepth].label);
  const variantLabel = variantParts.join(' · ') || 'Variant';
  const baseName = (master.FileName || 'Document').replace(/ \(AI draft\)\.docx$/i, '').replace(/\.docx$/i, '');
  const name = `${baseName} — ${variantLabel} (derived).docx`;
  const r = await dbRun(
    `INSERT INTO tblFiles (EntityType, EntityID, FileName, StoredName, MimeType, FileSize, Category, Description, UploadedBy, Approved, Status, StructuredData, Folder, TenantID, MasterFileID, DerivedProfile, DerivedDepth, MasterVersion)
     VALUES ('document', 0, ?, ?, ?, ?, ?, ?, ?, 0, 'Draft', ?, ?, ?, ?, ?, ?, ?)`,
    [name, stored, DOCX_MIME, buffer.length, master.Category || 'Document',
     `Derived version (${variantLabel}) of master #${rootMasterId} — pending review`,
     username, JSON.stringify(adapted), master.Folder || 'library', tenantId,
     rootMasterId, LEARNING_PROFILES[learningProfile] ? learningProfile : null, TECH_DEPTHS[techDepth] ? techDepth : null, master.Version || 1]);
  let valueCheck = null;
  try { const vg = require('../lib/value-guard'); valueCheck = vg.compareValues(vg.documentText(data), vg.documentText(adapted)); } catch {}
  await recordLegacyAudit(username, 'AIContent', 'DERIVE', r.lastID, variantLabel, 'master#' + rootMasterId, name);
  return { fileId: r.lastID, name, variant: variantLabel, valueCheck };
}

router.post('/derive/:masterId', requirePermission('ai.use'), async (req, res) => {
  try {
    const masterId = parseInt(req.params.masterId, 10);
    const { learningProfile, techDepth } = req.body || {};
    if (!LEARNING_PROFILES[learningProfile] && !TECH_DEPTHS[techDepth])
      return res.status(400).json({ error: 'Choose a reading level and/or technical depth for the derived version.' });
    const master = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [masterId]);
    if (!master || (master.TenantID || 1) !== tenantOf(req)) return res.status(404).json({ error: 'Master document not found' });
    if (!master.StructuredData) return res.status(400).json({ error: 'This document has no editable data to derive from.' });
    const type = req.body.type || 'sop';
    const [nameCfg, logoCfg] = await Promise.all([
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, [])
    ]);
    const out = await deriveVariant(master, learningProfile, techDepth, type,
      (nameCfg && nameCfg.cvalue) ? nameCfg.cvalue.trim() : '', (logoCfg && logoCfg.cvalue) ? logoCfg.cvalue : '',
      req.session.user.username, tenantOf(req));
    res.json({ success: true, ...out });
  } catch (e) { res.status(500).json({ error: 'Derive failed: ' + e.message }); }
});

// §9 — BATCH derive: create several audience variants of a master in one action.
// Body: { variants: [{learningProfile, techDepth}, ...], type }.
router.post('/derive-batch/:masterId', requirePermission('ai.use'), async (req, res) => {
  try {
    const masterId = parseInt(req.params.masterId, 10);
    const variants = Array.isArray(req.body.variants) ? req.body.variants : [];
    const valid = variants.filter(v => v && (LEARNING_PROFILES[v.learningProfile] || TECH_DEPTHS[v.techDepth]));
    if (!valid.length) return res.status(400).json({ error: 'Choose at least one variant (a reading level and/or technical depth).' });
    if (valid.length > 8) return res.status(400).json({ error: 'Too many variants at once (max 8).' });
    const master = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [masterId]);
    if (!master || (master.TenantID || 1) !== tenantOf(req)) return res.status(404).json({ error: 'Master document not found' });
    if (!master.StructuredData) return res.status(400).json({ error: 'This document has no editable data to derive from.' });
    const type = req.body.type || 'sop';
    const [nameCfg, logoCfg] = await Promise.all([
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, [])
    ]);
    const companyName = (nameCfg && nameCfg.cvalue) ? nameCfg.cvalue.trim() : '';
    const companyLogo = (logoCfg && logoCfg.cvalue) ? logoCfg.cvalue : '';
    const created = [], errors = [];
    for (const v of valid) {
      try {
        created.push(await deriveVariant(master, v.learningProfile, v.techDepth, type, companyName, companyLogo, req.session.user.username, tenantOf(req)));
      } catch (e) { errors.push({ variant: [v.learningProfile, v.techDepth].filter(Boolean).join(' · '), error: e.message }); }
    }
    res.json({ success: true, created, errors });
  } catch (e) { res.status(500).json({ error: 'Batch derive failed: ' + e.message }); }
});

// §21 — return the plain text of a source document (for the change-review diff). Tenant-scoped.
router.post('/source-text', async (req, res) => {
  try {
    const { sourceFileId } = req.body || {};
    if (!sourceFileId) return res.status(400).json({ error: 'sourceFileId required' });
    const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [sourceFileId]);
    if (!f || (f.TenantID || 1) !== tenantOf(req)) return res.status(404).json({ error: 'Source not found' });
    const fp = path.join(UPLOAD_DIR, f.StoredName);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Source file missing' });
    const buf = fs.readFileSync(fp);
    const name = (f.FileName || '').toLowerCase();
    const { extractPdfText, extractPptxText } = require('../lib/content');
    let text = '';
    if (name.endsWith('.docx')) text = extractDocxText(buf);
    else if (name.endsWith('.pptx')) text = extractPptxText(buf);
    else if (name.endsWith('.pdf')) text = await extractPdfText(buf);
    else return res.status(400).json({ error: 'Source is not a readable text document.' });
    res.json({ success: true, text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Analyse an uploaded document for the distinct FORMS or PROCEDURES it contains, so the user can
// pick which one to build. Body: { sourceFileId, kind }. kind = 'form' (record-form) or 'procedure'
// (SOP / Safe Work Procedure). Returns { items: [{title, description}] }.
router.post('/detect-forms', async (req, res) => {
  try {
    const { sourceFileId } = req.body || {};
    const kind = req.body && req.body.kind === 'procedure' ? 'procedure' : 'form';
    if (!sourceFileId) return res.status(400).json({ error: 'Choose or upload a source document first.' });
    const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [sourceFileId]);
    if (!f || (f.TenantID || 1) !== tenantOf(req)) return res.status(404).json({ error: 'Source not found' });
    const fp = path.join(UPLOAD_DIR, f.StoredName);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Source file missing' });
    const buf = fs.readFileSync(fp);
    const ext = (f.FileName.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    const { extractPdfText, extractPptxText } = require('../lib/content');
    let text = '', blocks = [];
    if (ext === 'docx') text = extractDocxText(buf);
    else if (ext === 'pptx') text = extractPptxText(buf);
    else if (ext === 'pdf') {
      text = await extractPdfText(buf);
      // Thin text (scanned/flattened PDF) → let the model SEE it.
      if (!text || text.trim().length < 200) blocks = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }];
    } else if (IMG_MEDIA[ext]) {
      blocks = [{ type: 'image', source: { type: 'base64', media_type: IMG_MEDIA[ext], data: buf.toString('base64') } }];
    } else return res.status(400).json({ error: 'Source is not a readable document.' });
    const items = await detectForms({ text, blocks, kind });
    res.json({ success: true, items, forms: items }); // `forms` kept for backward-compat
  } catch (e) { res.status(500).json({ error: 'Analysis failed: ' + e.message }); }
});

// On-demand protected-value check: compare the current draft against a source document (or raw
// source text). Body: { data, sourceFileId } or { data, sourceText }. Returns the value diff.
router.post('/validate-values', async (req, res) => {
  try {
    const { data, sourceFileId, sourceText } = req.body || {};
    if (!data) return res.status(400).json({ error: 'No document data to check.' });
    let srcText = (typeof sourceText === 'string') ? sourceText : '';
    if (!srcText && sourceFileId) {
      const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [sourceFileId]);
      if (f && (f.TenantID || 1) === tenantOf(req)) {
        const fp = path.join(UPLOAD_DIR, f.StoredName);
        if (fs.existsSync(fp)) {
          const buf = fs.readFileSync(fp);
          const name = (f.FileName || '').toLowerCase();
          const { extractPdfText, extractPptxText } = require('../lib/content');
          if (name.endsWith('.docx')) srcText = extractDocxText(buf);
          else if (name.endsWith('.pptx')) srcText = extractPptxText(buf);
          else if (name.endsWith('.pdf')) srcText = await extractPdfText(buf);
        }
      }
    }
    if (!srcText) return res.status(400).json({ error: 'No source text available to compare against. Choose the original source document.' });
    const vg = require('../lib/value-guard');
    res.json({ success: true, valueCheck: vg.compareValues(srcText, vg.documentText(data)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Training Material folders/categories ──────────────────────────────────────
router.get('/trainmat-cats', async (req, res) => {
  try {
    res.json(await dbAll('SELECT CatID, Name FROM tblTrainMatCat ORDER BY SortOrder, Name', []));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/trainmat-cats', async (req, res) => {
  try {
    if (!req.session.user.admin) return res.status(403).json({ error: 'Admin only' });
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Category name required.' });
    await dbRun('INSERT OR IGNORE INTO tblTrainMatCat (Name, CreatedBy) VALUES (?,?)', [name, req.session.user.username]);
    res.json({ success: true, cats: await dbAll('SELECT CatID, Name FROM tblTrainMatCat ORDER BY SortOrder, Name', []) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Training Material documents, grouped client-side by Category (the folder)
router.get('/trainmat-docs', async (req, res) => {
  try {
    const forCovers = req.query.forCovers === '1' || req.query.forCovers === 'true';
    if (forCovers) {
      // Covers page: offer documents to build a cover for from the Training Material folder AND the Document
      // Library (where Content Studio saves generated training documents by default), excluding existing
      // covers — so the user's training manuals show up even if they were saved to the library.
      return res.json(await dbAll(
        `SELECT FileID, FileName, Category, Folder, UploadedDate, UploadedBy, FileSize, StructuredData
         FROM tblFiles
         WHERE EntityType='document'
           AND (Folder IN ('training-material','library') OR Folder IS NULL OR Folder='')
           AND FileName NOT LIKE '% — Cover.docx'
         ORDER BY Category, UploadedDate DESC`, []));
    }
    // Default (Training Material page): the training-material folder exactly as filed, covers included.
    res.json(await dbAll(
      `SELECT FileID, FileName, Category, UploadedDate, UploadedBy, FileSize, StructuredData
       FROM tblFiles WHERE Folder='training-material' ORDER BY Category, UploadedDate DESC`, []));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// AI cover illustration (admin) — Claude-drawn SVG, returned as a data URL
router.post('/cover-image', async (req, res) => {
  try {
    if (!req.session.user.admin) return res.status(403).json({ error: 'Admin only' });
    const prompt = (req.body.prompt || '').trim();
    const mode = req.body.mode === 'photo' ? 'photo' : 'svg';
    if (!prompt) return res.status(400).json({ error: 'Describe the equipment/image.' });
    if (mode === 'photo') {
      const key = process.env.OPENAI_API_KEY || (await require('../lib/secret-config').readSecretConfig(dbGet, 'openai_api_key')) || '';
      const image = await generateCoverImagePhoto(prompt, key);
      return res.json({ success: true, image, raster: true });
    }
    const svg = await generateCoverImageSvg(prompt);
    res.json({ success: true, image: 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64'), raster: false });
  } catch (e) {
    if ((e.message && e.message.includes('API key')) || e.userError) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: 'Image generation failed: ' + e.message });
  }
});

// Build a Training Material COVER (the trainee-facing first page) for a selected material
router.post('/cover', async (req, res) => {
  try {
    if (!req.session.user.admin) return res.status(403).json({ error: 'Admin only' });
    const { materialFileId, title, subtitle, docNumber, version, date, audience, overview, heroImage } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: 'Cover title is required.' });
    // The cover is filed in the same Training Material folder as the selected material
    let category = 'Training Material';
    if (materialFileId) {
      const mat = await dbGet('SELECT Category, Folder FROM tblFiles WHERE FileID=?', [materialFileId]);
      if (mat && mat.Folder === 'training-material' && mat.Category) category = mat.Category;
    }
    const [nameCfg, logoCfg] = await Promise.all([
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, [])
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const infoRows = [
      ['Training Material', title.trim()],
      ['Folder', category],
      ['Version', version || '1.0'],
      ['Date', date || today]
    ];
    if (audience && audience.trim()) infoRows.push(['Audience', audience.trim()]);
    // Raster hero image embeds in the .docx; SVG (AI illustration) is print/preview only
    const heroOk = heroImage && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(heroImage);
    const heroSection = heroOk ? { heading: '', level: 1, images: [{ base64: heroImage, mimeType: (heroImage.match(/^data:([^;]+);/) || [])[1], layout: { docWidth: 6 } }] } : null;
    const sections = [
      ...(heroSection ? [heroSection] : []),
      {
        heading: 'About This Training Material', level: 1,
        body: (overview || '').trim() || 'This cover introduces the training material that follows.',
        table: { headers: ['Field', 'Detail'], rows: infoRows }
      }
    ];
    const data = { title: title.trim(), subtitle: subtitle || '', docNumber: docNumber || '', meta: { status: 'Draft', version: version || '1.0' }, sections, isCover: true };
    const buffer = buildDocx(title.trim(), sections, {
      subtitle: subtitle || '', docNumber: docNumber || '', type: 'cover', cover: true,
      meta: { status: 'Draft', version: version || '1.0' },
      companyName: (nameCfg && nameCfg.cvalue) ? nameCfg.cvalue.trim() : '',
      companyLogo: (logoCfg && logoCfg.cvalue) ? logoCfg.cvalue : ''
    });
    const stored = crypto.randomBytes(16).toString('hex') + '.docx';
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), buffer);
    const baseName = title.trim().replace(/[<>:"/\\|?*]+/g, '').trim() || 'Training Material';
    const name = `${baseName} — Cover.docx`;
    const r = await dbRun(
      `INSERT INTO tblFiles (EntityType, EntityID, FileName, StoredName, MimeType, FileSize, Category, Description, UploadedBy, Approved, StructuredData, Folder)
       VALUES ('document', 0, ?, ?, ?, ?, ?, 'Training material cover', ?, 1, ?, 'training-material')`,
      [name, stored, DOCX_MIME, buffer.length, category, req.session.user.username, JSON.stringify(data)]);
    await recordLegacyAudit(req.session.user.username, 'AIContent', 'COVER', r.lastID, 'cover', null, name);
    res.json({ success: true, fileId: r.lastID, name, category, message: `Cover saved to Training Material → ${category}.` });
  } catch (e) { res.status(500).json({ error: 'Cover build failed: ' + e.message }); }
});

// Build a print-ready Certificate of Competency (.docx, landscape) — admin only
router.post('/certificate', async (req, res) => {
  try {
    if (!req.session.user.admin) return res.status(403).json({ error: 'Admin only' });
    const b = req.body || {};
    const title = (b.title || 'CERTIFICATE OF COMPETENCY').trim();
    const toList = (v) => Array.isArray(v) ? v.filter(Boolean) : String(v || '').split('\n').map(s => s.replace(/^[-•\s]+/, '').trim()).filter(Boolean);
    const scope = toList(b.scope);
    const restrictions = toList(b.restrictions);
    const [nameCfg, logoCfg] = await Promise.all([
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, [])
    ]);
    const companyName = (b.companyName || (nameCfg && nameCfg.cvalue) || '').trim();
    const certId = (b.certId || b.certNumber || ('CERT-' + Date.now())).trim();
    const sections = [
      { heading: 'Certification Statement', level: 1, body: (b.statement || '').trim() ||
        `This is to certify that the trainee named below has successfully completed the required training and assessment and is deemed COMPETENT to operate a Caterpillar 777 Rigid Haul Truck in accordance with site competency and safety management requirements.` },
      { heading: 'Trainee Details', level: 1, table: { headers: ['Field', 'Detail'], rows: [
        ['Trainee Full Name', b.traineeName || '________________________'],
        ['Operator ID', b.operatorId || '________________________']
      ] } },
      { heading: 'Competency Outcome', level: 1, callout: `OUTCOME:  ${(b.outcome || 'COMPETENT').toUpperCase()}` },
      { heading: 'Competency Scope', level: 1, checklist: scope.length ? scope : ['Pre-start inspections and defect reporting', 'Safe start-up and shutdown procedures', 'Haul road operation and traffic compliance', 'Loading and dumping procedures', 'Retarder, braking, and speed control', 'Hazard identification and risk management', 'Communication protocols', 'Emergency response procedures'] },
      { heading: 'Training and Equipment Details', level: 1, table: { headers: ['Field', 'Detail'], rows: [
        ['Equipment Model', b.equipModel || 'CAT 777 Rigid Haul Truck'],
        ['Truck Class', b.truckClass || '90–100 Ton Class'],
        ['Total Training Hours', b.hours || '40 Hours (Supervised Operation)'],
        ['Assessment Standard', b.standard || 'Site Haul Truck Competency Management System'],
        ['Location', b.location || '[Mine Site Name]']
      ] } },
      { heading: 'Conditions / Restrictions', level: 1, checklist: restrictions.length ? restrictions : ['Day shift operation only until reassessment', 'Supervised operation for first 2 shifts', 'No night or wet condition operation until signed off'] },
      { heading: 'Certification Details', level: 1, table: { headers: ['Field', 'Detail'], rows: [
        ['Issue Date', b.issueDate || '____________'],
        ['Review / Expiry Date', b.expiryDate || '____________'],
        ['Certificate Number', b.certNumber || certId]
      ] } },
      { heading: 'Authorisation', level: 1, table: { headers: ['Role', 'Name', 'Signature', 'Date'], rows: [
        ['Assessor', b.assessor || '', '______________', '__________'],
        ['Supervisor', b.supervisor || '', '______________', '__________'],
        ['Training Superintendent', b.superintendent || '', '______________', '__________']
      ] } },
      { heading: 'Verification', level: 1, body: `Unique Certificate ID: ${certId}\n[ QR CODE PLACEHOLDER — Scan for verification ]`,
        callout: 'Scan for verification' },
      { heading: 'Issued By', level: 1, body: `${companyName || '[Company Name]'}\nThis certification is issued in accordance with site competency and safety management requirements.` }
    ];
    const buffer = buildDocx(title, sections, {
      subtitle: b.subtitle || 'Competency Certificate', docNumber: b.certNumber || certId,
      type: 'certificate', cover: true, docOrient: 'landscape',
      meta: { status: 'Approved', version: '1.0' },
      companyName, companyLogo: (logoCfg && logoCfg.cvalue) ? logoCfg.cvalue : ''
    });
    const stored = crypto.randomBytes(16).toString('hex') + '.docx';
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), buffer);
    // Certificate Library: file under Folder='certificates', categorised by course/competency, with a
    // per-course running sequence number (Haul Truck 777 → 1, 2, 3 … independently of other courses).
    const course = (b.course || 'Certificate').trim();
    const seq = await nextCertSeq(course);
    const certNumber = (b.certNumber && String(b.certNumber).trim()) || certFormatNo(course, seq);
    const baseName = (b.traineeName ? `${b.traineeName} — ` : '') + course + ' Certificate';
    const name = baseName.replace(/[<>:"/\\|?*]+/g, '').trim() + '.docx';
    const data = { title, subtitle: b.subtitleLocal || b.subtitle || 'Certificate of Achievement', docNumber: certNumber,
      course, seq, traineeName: b.traineeName || '', traineeLocal: b.traineeLocal || '', statementLocal: b.statementLocal || '',
      issueDate: b.issueDate || '', meta: { status: 'Approved', version: '1.0' }, sections, isCertificate: true };
    const r = await dbRun(
      `INSERT INTO tblFiles (EntityType, EntityID, FileName, StoredName, MimeType, FileSize, Category, Description, UploadedBy, Approved, StructuredData, Folder)
       VALUES ('document', 0, ?, ?, ?, ?, ?, 'Competency Certificate', ?, 1, ?, 'certificates')`,
      [name, stored, DOCX_MIME, buffer.length, course, req.session.user.username, JSON.stringify(data)]);
    await recordLegacyAudit(req.session.user.username, 'AIContent', 'CERTIFICATE', r.lastID, 'certificate', null, name);
    res.json({ success: true, fileId: r.lastID, name, certNumber, seq, course, message: `Certificate #${seq} for “${course}” saved to the Certificate Library.` });
  } catch (e) { res.status(500).json({ error: 'Certificate build failed: ' + e.message }); }
});

// History: last 30 AI content generations from the audit log
router.get('/history', async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT AuditDate, AuditUser, AuditField AS contentType, NewValue AS itemName, AuditRecord AS itemId
       FROM tblAudit WHERE AuditTable='AIContent' AND AuditAction='SAVE'
       ORDER BY AuditDate DESC LIMIT 30`, []);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Certificate Library — per-course auto-numbering + listing ──────────────────────────────────────────
// A compact certificate number from the course name + zero-padded sequence, e.g. "CAT777DUMPTR-0001".
function certFormatNo(course, seq) {
  const code = String(course || 'CERT').replace(/[^A-Za-z0-9]+/g, '').toUpperCase().slice(0, 14) || 'CERT';
  return `${code}-${String(seq).padStart(4, '0')}`;
}
// Next sequence for a course = highest stored seq for that course + 1 (independent per course).
async function nextCertSeq(course) {
  const rows = await dbAll("SELECT StructuredData FROM tblFiles WHERE Folder='certificates' AND Category=?", [course]);
  let max = 0;
  for (const r of rows) { try { const d = JSON.parse(r.StructuredData || '{}'); if (typeof d.seq === 'number' && d.seq > max) max = d.seq; } catch {} }
  return max + 1;
}
// Peek the next number for a course without consuming it (drives the auto-filled field in the UI).
router.get('/cert-next-number', async (req, res) => {
  try {
    const course = String(req.query.course || 'Certificate').trim();
    const seq = await nextCertSeq(course);
    res.json({ course, seq, number: certFormatNo(course, seq) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// List saved certificates (Certificate Library).
router.get('/certificates', async (req, res) => {
  try {
    res.json(await dbAll(
      `SELECT FileID, FileName, Category, UploadedDate, UploadedBy, FileSize, StructuredData
       FROM tblFiles WHERE Folder='certificates' ORDER BY UploadedDate DESC`, []));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
