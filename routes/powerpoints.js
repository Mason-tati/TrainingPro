// Training PowerPoint Presentations — upload existing decks, AI-develop new ones,
// and build .pptx files from edited slide JSON.
const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const multer  = require('multer');
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth } = require('./auth');
const { recordLegacyAudit } = require('../lib/governance/audit-adapter'); // WP-16 M5 — sanitizing audit (medium-risk; AI content dropped, identifiers masked/capped)
const logger          = require('../lib/logger');
// WP-10 A6.4 — AI calls go through the central AI Gateway (byte-identical passthrough,
// including streaming — the returned stream object behaves exactly as before).
const aiGateway       = require('../lib/ai-gateway');

router.use(requireAuth);

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const PPT_MIME  = 'application/vnd.ms-powerpoint';

// ── PPTX slide-count helper ────────────────────────────────────────────────
// Count slides by inspecting the .pptx (a ZIP) for ppt/slides/slideN.xml entries.
// Draw image callouts: a rounded label box + a line + a filled dot at the marker point on the image.
// `callouts[i]` = { label, dotXf, dotYf } where dotXf/dotYf are 0..1 fractions of the image's box.
// Text boxes are auto-placed in the quadrant matching the dot's position, stacked so they don't collide.
function drawCallouts(pres, slide, callouts, img, theme) {
  if (!callouts || !callouts.length) return;
  const NAVY = (theme && theme.navy) || '1E3A5F';
  const YELLOW = (theme && theme.orange) || 'FBC02D';
  const DOT = 'CC0000'; // red — matches the reference image
  const LABEL_BG = 'FFFFFF';
  const LABEL_BORDER = NAVY;
  // Bucket callouts into quadrants so we can stack labels above/below/left/right of the image
  const Q = { TL: [], TR: [], BL: [], BR: [] };
  callouts.forEach(c => {
    const k = (c.dotXf < 0.5 ? 'L' : 'R') + (c.dotYf < 0.5 ? '' : '');
    const q = (c.dotYf < 0.5 ? 'T' : 'B') + (c.dotXf < 0.5 ? 'L' : 'R');
    Q[q].push(c);
  });
  // Label dimensions (inches)
  const LW = 1.45, LH = 0.42, GAP = 0.08;
  // Slide bounds (LAYOUT_WIDE = 13.33 x 7.5)
  const SW = 13.33, SH = 7.5;
  // Quadrant base origins outside the image: TL = top-left of slide, TR = top-right, etc.
  const placeQuadrant = (qKey, list) => {
    if (!list.length) return;
    list.forEach((c, idx) => {
      // Dot in slide coordinates
      const dotX = img.x + img.w * Math.max(0, Math.min(1, c.dotXf));
      const dotY = img.y + img.h * Math.max(0, Math.min(1, c.dotYf));
      let lx, ly;
      if (qKey === 'TL') { lx = Math.max(0.2, img.x - LW - 0.3); ly = Math.max(0.2, img.y + idx * (LH + GAP)); }
      else if (qKey === 'TR') { lx = Math.min(SW - LW - 0.2, img.x + img.w + 0.3); ly = Math.max(0.2, img.y + idx * (LH + GAP)); }
      else if (qKey === 'BL') { lx = Math.max(0.2, img.x - LW - 0.3); ly = Math.min(SH - LH - 0.2, img.y + img.h - LH - idx * (LH + GAP)); }
      else                    { lx = Math.min(SW - LW - 0.2, img.x + img.w + 0.3); ly = Math.min(SH - LH - 0.2, img.y + img.h - LH - idx * (LH + GAP)); }
      // 1) Connecting line from label to dot — start at the label edge closest to the dot
      const labelCenterX = lx + LW / 2;
      const labelCenterY = ly + LH / 2;
      // Compute a line start near the label's edge facing the dot
      const dx = dotX - labelCenterX, dy = dotY - labelCenterY;
      const startX = labelCenterX + (dx < 0 ? -LW / 2 : LW / 2);
      const startY = labelCenterY + (Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? -LH / 2 : LH / 2) : 0);
      try {
        slide.addShape(pres.ShapeType.line, {
          x: Math.min(startX, dotX), y: Math.min(startY, dotY),
          w: Math.abs(dotX - startX), h: Math.abs(dotY - startY),
          line: { color: DOT, width: 1.5, beginArrowType: 'none', endArrowType: 'none' },
          // The shape's bounding box is x..x+w, y..y+h — but pptxgenjs draws a line from corner to corner.
          // To force the right diagonal, we pass flipH/flipV when start point is to the right/below.
          flipH: startX > dotX, flipV: startY > dotY,
        });
      } catch {}
      // 2) Filled red dot at the marker point on the image
      try {
        slide.addShape(pres.ShapeType.ellipse, {
          x: dotX - 0.05, y: dotY - 0.05, w: 0.1, h: 0.1,
          fill: { color: DOT }, line: { color: DOT, width: 0 }
        });
      } catch {}
      // 3) Rounded label box with thin navy border and dark text
      try {
        slide.addShape(pres.ShapeType.roundRect, {
          x: lx, y: ly, w: LW, h: LH,
          fill: { color: LABEL_BG }, line: { color: LABEL_BORDER, width: 0.75 },
          rectRadius: 0.06,
        });
      } catch {}
      slide.addText(String(c.label || '').slice(0, 60), {
        x: lx, y: ly, w: LW, h: LH,
        fontSize: 9, color: '1F2937', fontFace: 'Segoe UI', align: 'center', valign: 'middle', bold: true,
      });
    });
  };
  placeQuadrant('TL', Q.TL);
  placeQuadrant('TR', Q.TR);
  placeQuadrant('BL', Q.BL);
  placeQuadrant('BR', Q.BR);
}

function pptxSlideCount(buf) {
  try {
    const AdmZip = require('adm-zip');
    const z = new AdmZip(buf);
    return z.getEntries().filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName)).length || 0;
  } catch { return 0; }
}

// PPTX text extractor — shared via lib/content.js so every AI-generation route can use it.
const { extractPptxText, getImageDimensions } = require('../lib/content');

// Build an "image style" directive from the user's choices (region/ethnicity, gender mix, visual
// style) that is baked into EVERY suggested image prompt so generated pictures match the workforce.
// The Akara Resources work uniform + branding, described so generated images are on-brand.
const PP_COMPANY_UNIFORM = `the workers MUST wear the company uniform: a high-visibility YELLOW long-sleeve work shirt with navy-blue lower sleeves and collar and silver-grey reflective stripes, navy-blue work trousers, a white hard hat, clear safety glasses and work gloves — with the "AKARA RESOURCES" company logo (a blue stylised letter "X" with a yellow triangle) on the left chest of the shirt and on the front of the white hard hat`;
function ppImageStyleDirective(body) {
  body = body || {};
  const region = String(body.imgRegion || '').trim();
  const gender = String(body.imgGender || '').trim();
  const style  = String(body.imgStyle || '').trim();
  const parts = [];
  if (region) parts.push(`the people depicted must look like workers from ${region} (correct ethnicity, clothing and work setting)`);
  if (/both/i.test(gender)) parts.push('include BOTH male and female workers');
  else if (gender) parts.push(`depict ${gender.toLowerCase()} workers`);
  if (style) parts.push(`render in a ${style}`);
  // Company uniform + logo — ALWAYS applied so people in the images are on-brand.
  parts.push(PP_COMPANY_UNIFORM);
  return `\n\n━━━ IMAGE STYLE (apply to EVERY image prompt) ━━━\nEvery "imagePrompt" you write MUST specify: ${parts.join('; ')}. Bake these requirements into each image prompt so the created picture matches.\n━━━ END IMAGE STYLE ━━━`;
}

// Compute aspect-preserving w/h + top-left x/y to letterbox an image inside a box.
// Accepts a data URI like "data:image/png;base64,...". Returns null if dims can't be read.
function fitDataUriInBox(dataUri, boxX, boxY, boxW, boxH) {
  try {
    const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(String(dataUri || ''));
    if (!m) return null;
    const buf = Buffer.from(m[2], 'base64');
    const dims = getImageDimensions(buf, m[1].toLowerCase());
    if (!dims || !dims.width || !dims.height) return null;
    const boxAspect = boxW / boxH;
    const imgAspect = dims.width / dims.height;
    let w, h;
    if (imgAspect >= boxAspect) { w = boxW; h = boxW / imgAspect; }
    else                         { h = boxH; w = boxH * imgAspect; }
    return { x: boxX + (boxW - w) / 2, y: boxY + (boxH - h) / 2, w, h };
  } catch { return null; }
}

// ── Built-in TRAINING TEMPLATES ────────────────────────────────────────────
// Each entry is a starter slide blueprint the AI will adapt to the user's topic.
const TEMPLATES = {
  'safety-training': {
    label: 'Safety Training',
    description: 'Hazards · Controls · PPE · Emergency · Knowledge check',
    structure: [
      'Title slide — course name, presenter, site, date',
      'Learning Outcomes — what the trainee will be able to do',
      'Hazards Overview — relevant site/equipment hazards (with examples)',
      'Risk Assessment — likelihood × consequence matrix',
      'Hierarchy of Controls — elimination → substitution → engineering → admin → PPE',
      'PPE Requirements — what to wear, when, AS/NZS standards',
      'Safe Work Procedure — step-by-step SOP for the task',
      'Emergency Procedures — alarms, evacuation, first aid, reporting',
      'Real Incident Case Study — what happened, root cause, lessons learned',
      'Knowledge Check — 4–6 multiple-choice questions',
      'Summary & Sign-off — recap and acknowledgement',
    ],
  },
  'equipment-operator': {
    label: 'Equipment Operator Course',
    description: 'Pre-start · Controls · Operating · Shutdown · Competency',
    structure: [
      'Title slide — equipment make/model, unit of competency',
      'Learning Outcomes — by the end of this course you will…',
      'Equipment Overview — purpose, components, capability',
      'Pre-start Inspection — walk-around checklist',
      'Cab Familiarisation — controls, instruments, alarms',
      'Start-up Procedure — sequence, idle warm-up, system checks',
      'Operating Techniques — efficient, safe operating practice',
      'Common Hazards — what to watch for during operation',
      'Shutdown Procedure — park-up, isolation, recording',
      'Post-operational Tasks — refuelling, housekeeping, faults log',
      'Practical Assessment — what the assessor will look for',
      'Knowledge Check — 4–6 questions',
    ],
  },
  'induction': {
    label: 'Site Induction',
    description: 'Welcome · Site rules · HSE · Emergency · Sign-off',
    structure: [
      'Title slide — site name, induction date, presenter',
      'Welcome & Agenda',
      'Company Overview — mission, values, operations',
      'Site Layout — gates, offices, work areas, restricted zones',
      'Site Rules — speed limits, PPE, smoking, mobile phones',
      'HSE Policy — commitments and your responsibilities',
      'Reporting Lines — supervisor, HSE rep, manager',
      'Hazards on Site — biggest risks and controls',
      'Emergency Procedures — alarms, assembly points, first aid',
      'Drug & Alcohol Policy',
      'Fitness for Work',
      'Incident Reporting — what, when, how',
      'Sign-off — acknowledgement and induction record',
    ],
  },
  'tool-box-talk': {
    label: 'Toolbox Talk',
    description: 'Short shift-start brief — 1 topic · 5–8 slides',
    structure: [
      'Title — topic, date, supervisor',
      'Why this matters — recent incident, near-miss, or trend',
      'Key hazards (1–3 max)',
      'Required controls / safe procedure',
      'PPE / equipment required',
      'Questions / discussion',
      'Sign-off — attendance and acknowledgement',
    ],
  },
  'refresher': {
    label: 'Refresher Training',
    description: 'Recap of an existing competency — key changes since last training',
    structure: [
      'Title slide',
      'Why this refresher? — regulatory / incident / scope change',
      'What has changed since the last training',
      'Recap of the core competency',
      'Updated procedures / standards',
      'Common errors observed in the field',
      'Knowledge check — 3–5 questions',
      'Sign-off',
    ],
  },
  'blank': {
    label: 'Blank — Custom',
    description: 'No structure — AI designs the whole deck from your prompt',
    structure: null,
  },
};

router.get('/templates', (req, res) => {
  const list = Object.entries(TEMPLATES).map(([key, t]) => ({ key, label: t.label, description: t.description, slides: t.structure ? t.structure.length : null }));
  res.json(list);
});

// ── Themes for the build pipeline — listed so the UI can show a picker ────
router.get('/themes', (req, res) => {
  res.json([
    { key: 'modern-navy',         label: 'Navy & Yellow',       description: 'White slides · navy accent · yellow highlights (brand default)' },
    { key: 'industrial-charcoal', label: 'Industrial Charcoal', description: 'Dark slate slides · orange highlights · industrial feel' },
    { key: 'clean-white',         label: 'Clean White',         description: 'Minimal white slides · blue accents · corporate look' },
    { key: 'bold-orange',         label: 'Bold Orange',         description: 'Warm cream slides · orange title slides · high energy' },
    { key: 'fresh-teal',          label: 'Fresh Teal',          description: 'Cool teal title slides · amber highlights · modern training feel' },
  ]);
});

// ── List uploaded decks ────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    // HasDeckJson flag tells the UI whether this row can be opened in the editor (✏️) or visual preview (👁).
    // Only AI-built decks saved AFTER we added StructuredData persistence have the JSON snapshot.
    const rows = await dbAll(
      `SELECT FileID, FileName, MimeType, FileSize, Category, Description, UploadedBy, UploadedDate, StoredName,
              CASE WHEN StructuredData IS NULL OR StructuredData='' THEN 0 ELSE 1 END AS HasDeckJson
       FROM tblFiles WHERE Folder='powerpoints' ORDER BY UploadedDate DESC, FileName`, []);
    for (const r of rows) {
      try {
        const fp = path.join(UPLOAD_DIR, r.StoredName);
        const buf = fs.existsSync(fp) ? fs.readFileSync(fp) : null;
        r.SlideCount = buf ? pptxSlideCount(buf) : 0;
      } catch { r.SlideCount = 0; }
      delete r.StoredName; // don't leak filesystem names to the client
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Upload an existing .pptx ───────────────────────────────────────────────
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!(req.session.user && req.session.user.admin)) return res.status(403).json({ error: 'Only an administrator can upload PowerPoint files.' });
    if (!req.file) return res.status(400).json({ error: 'No file selected.' });
    const origName = req.file.originalname || 'presentation.pptx';
    const ext = (origName.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    if (!['pptx', 'ppt'].includes(ext)) return res.status(400).json({ error: 'Only .pptx or .ppt files are supported.' });
    const category = (req.body.category || 'General').trim().slice(0, 80) || 'General';
    const description = (req.body.description || '').trim().slice(0, 500) || null;
    const stored = crypto.randomBytes(16).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, stored), req.file.buffer);
    const r = await dbRun(
      `INSERT INTO tblFiles (EntityType, EntityID, FileName, StoredName, MimeType, FileSize, Category, Description, UploadedBy, Approved, Folder)
       VALUES ('powerpoint', 0, ?, ?, ?, ?, ?, ?, ?, 1, 'powerpoints')`,
      [origName, stored, ext === 'pptx' ? PPTX_MIME : PPT_MIME, req.file.size, category, description, req.session.user.username]);
    try { await recordLegacyAudit(req.session.user.username, 'tblFiles', 'PPTX_UPLOAD', r.lastID, null, null, origName); } catch {}
    res.json({ success: true, fileId: r.lastID, fileName: origName, category });
  } catch (e) { res.status(500).json({ error: 'Upload failed: ' + e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!(req.session.user && req.session.user.admin)) return res.status(403).json({ error: 'Admin only.' });
    const f = await dbGet(`SELECT * FROM tblFiles WHERE FileID=? AND Folder='powerpoints'`, [req.params.id]);
    if (!f) return res.status(404).json({ error: 'PowerPoint not found.' });
    try { fs.unlinkSync(path.join(UPLOAD_DIR, f.StoredName)); } catch {}
    await dbRun('DELETE FROM tblFiles WHERE FileID=?', [req.params.id]);
    try { await recordLegacyAudit(req.session.user.username, 'tblFiles', 'PPTX_DELETE', req.params.id, null, f.FileName, null); } catch {}
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: 'Delete failed: ' + e.message }); }
});

// ── AI: develop a slide outline from a topic + optional template + source document ────────────
router.post('/develop', (req, res, next) => {
  // multer with detailed error handling — anything multer rejects (size, malformed multipart, etc.) gets logged + JSON-replied
  upload.single('file')(req, res, (err) => {
    if (err) {
      try { logger.error('VALIDATION_ERROR', { message: 'Upload validation failed', operation: 'powerpoint-develop-upload', errorName: err.code || err.name || 'MulterError', maskedErrorMessage: err.message, statusCode: 400 }); } catch {}
      return res.status(400).json({ error: 'Upload failed: ' + err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!(req.session.user && req.session.user.admin)) return res.status(403).json({ error: 'Admin only.' });
    console.log('[POWERPOINTS /develop] body keys:', Object.keys(req.body || {}).join(','), '| file:', req.file ? (req.file.originalname + ' ' + req.file.size + 'b') : 'none');
    const topic    = String(req.body.topic || '').trim();
    const audience = String(req.body.audience || '').trim();
    const slides   = Math.max(3, Math.min(200, parseInt(req.body.slides, 10) || 12));
    // When true (and a source is attached), the AI decides the slide count from its analysis of the document.
    const autoSlides = req.body.autoSlides === true || String(req.body.autoSlides) === 'true';
    const tplKey   = String(req.body.template || 'safety-training');
    const theme    = String(req.body.theme || 'modern-navy');
    // Audience dials (same as the Content Studio): reading/literacy level + technical depth.
    const learningProfile = ['L1','L2','L3','L4'].includes(String(req.body.learningProfile || '')) ? String(req.body.learningProfile) : '';
    const techDepth = ['basic','standard','advanced','expert'].includes(String(req.body.techDepth || '')) ? String(req.body.techDepth) : '';
    const kbArticleIds = (() => {
      const raw = req.body.kbArticleIds;
      if (Array.isArray(raw)) return raw.map(n => parseInt(n, 10)).filter(Boolean);
      if (typeof raw === 'string') { try { const a = JSON.parse(raw); return Array.isArray(a) ? a.map(n => parseInt(n, 10)).filter(Boolean) : []; } catch { return []; } }
      return [];
    })();
    if (!topic) { try { logger.error('VALIDATION_ERROR', { message: 'Request validation failed', operation: 'powerpoint-develop', reason: 'missing topic', bodyKeys: Object.keys(req.body || {}), statusCode: 400 }); } catch {} return res.status(400).json({ error: 'Describe the topic for the deck. (Got body keys: ' + (Object.keys(req.body || {}).join(',') || 'none') + ')' }); }

    // Optional source document — extracted to text (DOCX/TXT/PPTX) or passed as vision block (PDF/image)
    const sourceBlocks = [];
    let sourceText = '';
    let sourceName = '';
    // Pictures extracted from the uploaded training document — COPIED into the generated deck.
    let srcImages = []; // [{ data: 'data:<mime>;base64,<...>' }]
    if (req.file) {
      const { extractDocxText, extractDocxImages, extractPdfImages } = require('../lib/content');
      sourceName = req.file.originalname || 'source';
      const ext = (sourceName.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
      const ALLOWED = ['docx','pdf','txt','pptx','png','jpg','jpeg','webp','gif'];
      if (!ALLOWED.includes(ext)) return res.status(400).json({ error: 'Unsupported source file (.' + ext + '). Use DOCX, PDF, TXT, PPTX or image.' });
      const toDataUri = (b) => `data:${b.source.media_type};base64,${b.source.data}`;
      if (ext === 'docx') {
        sourceText = extractDocxText(req.file.buffer);
        const imgs = extractDocxImages(req.file.buffer, { max: 40, minBytes: 8000 });
        sourceBlocks.push(...imgs.slice(0, 4));                 // first few for the model to SEE
        srcImages = imgs.map(toDataUri).map(data => ({ data }));// ALL images, to copy into the deck
      }
      else if (ext === 'txt') { sourceText = req.file.buffer.toString('utf8'); }
      else if (ext === 'pptx') { sourceText = extractPptxText(req.file.buffer); }
      else if (ext === 'pdf') {
        sourceBlocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: req.file.buffer.toString('base64') } });
        try { srcImages = (extractPdfImages(req.file.buffer) || []).map(im => ({ data: `data:${im.mimeType};base64,${im.data}` })); } catch { srcImages = []; }
      }
      else {
        const MIME = { png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', gif:'image/gif' };
        const mime = MIME[ext] || 'image/png';
        sourceBlocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: req.file.buffer.toString('base64') } });
        srcImages = [{ data: `data:${mime};base64,${req.file.buffer.toString('base64')}` }];
      }
      console.log('[POWERPOINTS /develop] source:', sourceName, '|', ext.toUpperCase(), '|', sourceText.length, 'text chars |', sourceBlocks.length, 'vision blocks |', srcImages.length, 'images to copy');
    }

    const tpl = TEMPLATES[tplKey] || TEMPLATES['safety-training'];

    // KB context (same pattern as other AI features)
    let kbContext = '';
    if (kbArticleIds.length) {
      const ph = kbArticleIds.map(() => '?').join(',');
      const kbRows = await dbAll(
        `SELECT a.Title, a.Body, k.Name AS categoryName
         FROM tblKBArticle a LEFT JOIN tblKBCategory k ON k.CategoryID = a.CategoryID
         WHERE a.ArticleID IN (${ph}) AND a.Status='Published'`, kbArticleIds);
      if (kbRows.length) kbContext = '\n\n━━━ SITE REFERENCE (Knowledge Base) ━━━\n' +
        kbRows.map(r => `[${r.categoryName || 'KB'}] ${r.Title}\n${r.Body}`).join('\n\n---\n\n') +
        '\n━━━ END SITE REFERENCE ━━━';
    }

    const companyCfg = await dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []);
    const companyName = (companyCfg && companyCfg.cvalue) ? companyCfg.cvalue.trim() : '';

    const sys = `You are a senior training designer for a mining / industrial company. You design clean, audit-ready PowerPoint training decks. Return ONLY valid JSON in this exact shape:
{ "title": "Deck title",
  "subtitle": "Course code / unit · audience · version",
  "presenter": "[Default placeholder if not supplied]",
  "slides": [
    { "type": "title|content|two-column|bullets|image|quote|section|qa",
      "heading": "Slide heading",
      "subheading": "(optional)",
      "bullets": ["bullet 1", "bullet 2", "..."],
      "body": "(optional paragraph, plain text)",
      "leftBullets": ["..."], "rightBullets": ["..."],   // only for two-column
      "imagePrompt": "(optional — a COMPLETE, ready-to-paste image-generation prompt for ChatGPT / DALL·E that creates a helpful visual for this slide: describe the scene and key elements/labels, and specify a clean professional training ILLUSTRATION style, 16:9, no text baked into the image. Leave empty if the slide needs no image or already has a source picture.)",
      "srcImages": [1],   // optional — numbers of the source pictures (from SOURCE PICTURES) to place on this slide
      "notes": "Trainer / facilitator speaker notes for this slide"
    }
  ]
}

RULES:
1. Each slide is concise: heading ≤ 8 words, bullets ≤ 12 words each, 3–6 bullets per slide.
2. Every slide MUST include trainer "notes" (3–6 sentences of facilitator guidance: key points, demonstration prompts, common mistakes, time hint).
3. Open with a "title" slide, close with a "qa" or "section" sign-off slide.
4. Mix slide types — body content alternates between "bullets", "content", "two-column" for variety.
5. Use specific, operational language — no fluff. Reference real PPE standards (AS/NZS), Acts, or company procedures when relevant.
6. Never fabricate site-specific data (speeds, heights, distances) — leave a clear placeholder like "[site-specific value]" if the source doesn't supply it.
7. IMAGE SUGGESTIONS: for content/bullets/two-column slides that would be clearer with a diagram or illustration AND that have NO source picture placed on them, write a complete, ready-to-paste "imagePrompt" (an image-generation prompt for ChatGPT / DALL·E) specific to that slide's content. Do NOT add an imagePrompt to title / section / qa slides, or to any slide that already shows a source picture.
8. No markdown fences, no commentary, JSON only.`;

    const tplBlock = tpl.structure
      ? `Template (${tpl.label}): build approximately one slide per item below, but adapt to the topic:\n` + tpl.structure.map((s, i) => `  ${i+1}. ${s}`).join('\n')
      : `No template — design the deck from scratch in a logical training order for the topic.`;

    // Audience adaptation (reading/literacy level + technical depth) — reuse the Content Studio cap,
    // which also carries the Level-1-Operator + Basic "write abbreviations in full" rule.
    const LEARNING_CAP = require('../lib/content').buildLearningCap(learningProfile, techDepth);

    // DETAILED IMAGE ANALYSIS — the model LOOKS at each source picture and says what it shows, so the
    // main generation can place every picture on the slide whose CONTENT matches it.
    let imgDescriptions = []; // index-aligned with srcImages
    if (srcImages.length) {
      try {
        const blocks = srcImages.slice(0, 24).map(im => {
          const m = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(im.data || '');
          return m ? { type: 'image', source: { type: 'base64', media_type: m[1].toLowerCase(), data: m[2] } } : null;
        }).filter(Boolean);
        if (blocks.length) {
          const instr = `You are analysing pictures extracted from a training document, numbered 1..${blocks.length} in order. For EACH picture write ONE short sentence describing exactly what it shows (equipment, diagram, step, hazard, PPE, control, sign, screenshot, etc.) — specific enough to match it to the right slide. Return ONLY JSON: {"descriptions":[{"n":1,"desc":"..."}]}`;
          const amsg = await aiGateway.complete({ provider: 'anthropic', agent: 'AI-DOC-003', operation: 'analyze_deck_images', model: 'claude-sonnet-4-6', max_tokens: 2500, messages: [{ role: 'user', content: [...blocks, { type: 'text', text: instr }] }] });
          const araw = (amsg.content.find(b => b.type === 'text') || {}).text || '';
          const acln = araw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
          let aj; try { aj = JSON.parse(acln); } catch { try { aj = JSON.parse((acln.match(/\{[\s\S]*\}/) || [''])[0]); } catch { aj = null; } }
          if (aj && Array.isArray(aj.descriptions)) for (const d of aj.descriptions) if (d && d.n) imgDescriptions[d.n - 1] = String(d.desc || '').trim();
          console.log('[POWERPOINTS /develop] analysed', blocks.length, 'source images ·', imgDescriptions.filter(Boolean).length, 'described');
        }
      } catch (e) { console.warn('[POWERPOINTS /develop] image analysis failed: ' + e.message); }
    }

    // Source pictures must be COPIED into the deck — give the model what each shows so it can place
    // them on the matching slide (by number).
    const imgInstr = srcImages.length
      ? `SOURCE PICTURES — ${srcImages.length} picture(s) were extracted from the uploaded training document, numbered 1..${srcImages.length} in order of appearance. These MUST be copied into the deck. Here is what each picture shows:\n`
        + srcImages.map((im, i) => `  Picture ${i + 1}: ${imgDescriptions[i] || '(content not analysed — place by order / surrounding context)'}`).join('\n')
        + `\nOn the slide whose CONTENT MATCHES each picture, add a field "srcImages": [n] listing the picture number(s) for that slide (match each picture to the exact topic/step it illustrates; use each number at most once; a slide may list more than one). Do NOT describe the picture in words in the slide text. Any picture you do not place will be added as its own slide at the end.`
      : '';
    const hasSource = !!(sourceText || sourceBlocks.length);
    // When a source document is provided, build the deck FROM it — capture its headings and all the
    // important information, then adapt the language/depth to the audience.
    const sourceDrivenCap = hasSource
      ? `━━━ BUILD THE DECK FROM THE UPLOADED DOCUMENT ━━━\nThe attached document is the MASTER SOURCE for this deck. Build the deck by faithfully capturing it:\n`
        + `1. STRUCTURE: Identify the document's MAIN HEADINGS / sections and use them as the backbone of the deck — create section and content slides that follow the source's headings and their order. Every main heading in the source should appear as a slide heading (or a section-divider slide). Do not impose an unrelated structure over the source.\n`
        + `2. FULL COVERAGE: Extract ALL the important information from the document — key points, definitions, steps/procedures (in order), specifications, values/limits/numbers, PPE and safety requirements, warnings, roles/responsibilities, and any decision points. Do NOT omit important content; split it across MORE slides rather than dropping detail or over-packing a slide. Do NOT invent anything that is not in the source — if a figure is missing leave a clear "[site-specific value]" placeholder.\n`
        + `3. SUIT THE AUDIENCE: Rewrite the captured content to suit the people doing THIS training course at the selected Reading / Literacy Level and Technical Depth (see AUDIENCE ADAPTATION above). Simplify the LANGUAGE for a lower literacy level, but keep every safety-critical fact, step and number EXACTLY as in the source. Change the wording to get the correct information across clearly to that audience — never change the meaning.\n`
        + `4. Put the core teaching points on the slide bullets; put extra explanation, context and facilitator guidance in the slide "notes".\n━━━ END ━━━`
      : '';
    const userMsg = [
      `Topic: ${topic}`,
      audience ? `Target audience: ${audience}` : '',
      (hasSource && autoSlides)
        ? `SLIDE COUNT — DECIDE IT YOURSELF: after analysing the document, choose exactly how many slides are REQUIRED to cover every main heading and all the important information clearly for this audience. Use roughly one slide per main sub-topic/heading, plus supporting slides for steps, specifications and safety — do NOT pad with filler and do NOT drop important content. State nothing about the count; just produce that many slides (a thorough deck for a substantial document is typically 20–60 slides).`
        : hasSource
          ? `Target slide count: about ${slides} slides — but COMPLETENESS of the source's key information comes first: add more slides if needed to cover every main heading and important fact (split content rather than drop it or over-pack a slide).`
          : `Total slides: ${slides} (the deck should contain exactly this many slides — split content into more slides rather than over-packing any one slide).`,
      `Ensure the content is CLEAR and easy to follow for the audience.`,
      companyName ? `Company: ${companyName} (use this name in the title and footer if appropriate).` : '',
      tplBlock,
      LEARNING_CAP,
      ppImageStyleDirective(req.body),
      sourceDrivenCap,
      kbContext,
      sourceText ? `SOURCE DOCUMENT (${sourceName || 'attached'}) — capture its main headings and all important information; do not invent facts not in the source:\n"""${sourceText.slice(0, 120000)}"""` : '',
      (sourceBlocks.length && !sourceText) ? `An attached source document/image is provided — READ IT IN FULL, capture its main headings and all important information, and base the slide content on what it shows. Do not invent facts not in the source.` : '',
      imgInstr,
    ].filter(Boolean).join('\n\n');

    const content = sourceBlocks.length ? [...sourceBlocks, { type: 'text', text: userMsg }] : userMsg;
    // Larger decks need more output tokens — scale with slide count, capped at 32K (Claude Sonnet 4.6 limit).
    // Give extra headroom when building from a source (full coverage can add slides), and the full budget
    // when the AI is deciding the slide count itself.
    const maxTok = (hasSource && autoSlides) ? 32000 : Math.min(32000, Math.max(hasSource ? 20000 : 14000, slides * (hasSource ? 750 : 600)));

    // Use STREAMING so Anthropic doesn't hit its 10-minute non-streaming ceiling.
    // Big decks (max_tokens >= 16K) routinely take >10 min to produce — streaming keeps the connection
    // open while tokens arrive, so we never see "Request timed out" on legitimate long generations.
    let rawAccumulated = '';
    let lastErr;
    const t0 = Date.now();
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log('[POWERPOINTS /develop] Anthropic STREAM call attempt ' + attempt + ' — maxTok=' + maxTok + ' sourceBlocks=' + sourceBlocks.length + ' sourceTextLen=' + (sourceText || '').length);
        const stream = await aiGateway.stream({
          provider: 'anthropic',
          agent: 'AI-DOC-003',
          operation: 'develop_deck',
          model: 'claude-sonnet-4-6',
          max_tokens: maxTok,
          system: sys,
          messages: [{ role: 'user', content }]
        });
        rawAccumulated = '';
        let firstTokenAt = null;
        let tokenCount = 0;
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta && typeof event.delta.text === 'string') {
            if (firstTokenAt === null) {
              firstTokenAt = Date.now();
              console.log('[POWERPOINTS /develop] first token at ' + ((firstTokenAt - t0)/1000).toFixed(1) + 's');
            }
            rawAccumulated += event.delta.text;
            tokenCount++;
            // Progress beacon every 2000 deltas so we can see it's still moving on big decks
            if (tokenCount % 2000 === 0) console.log('[POWERPOINTS /develop]   …' + tokenCount + ' deltas, ' + rawAccumulated.length + ' chars, ' + ((Date.now()-t0)/1000).toFixed(0) + 's elapsed');
          }
        }
        const final = await stream.finalMessage();
        if (final && Array.isArray(final.content)) {
          const tb = final.content.find(b => b.type === 'text');
          if (tb && tb.text && !rawAccumulated) rawAccumulated = tb.text;
        }
        console.log('[POWERPOINTS /develop] stream complete in ' + ((Date.now() - t0)/1000).toFixed(1) + 's — ' + rawAccumulated.length + ' chars');
        break;
      } catch (apiErr) {
        lastErr = apiErr;
        // WP-08 L4 — one structured record per failed attempt (name + masked message
        // + cause names/codes; never the stack). Retry behaviour is unchanged.
        try {
          const causeChain = [];
          let cause = apiErr && apiErr.cause; let depth = 0;
          while (cause && depth++ < 4) { causeChain.push({ name: cause.name || 'Error', code: cause.code || null }); cause = cause.cause; }
          logger.error('AI_PROVIDER_ERROR', {
            message: 'AI provider request failed',
            operation: 'powerpoint-develop',
            attempt,
            errorName: apiErr && apiErr.name ? String(apiErr.name) : 'Error',
            maskedErrorMessage: apiErr && apiErr.message ? String(apiErr.message) : 'unknown',
            providerStatus: (apiErr && (apiErr.status || apiErr.statusCode)) || null,
            causeChain: causeChain.length ? causeChain : undefined,
          });
        } catch {}
        const status = apiErr && (apiErr.status || apiErr.statusCode);
        if (status && status >= 400 && status < 500) throw apiErr;
        if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 2000));
      }
    }
    if (!rawAccumulated) {
      const m = lastErr && lastErr.message ? lastErr.message : String(lastErr || 'unknown');
      return res.status(500).json({ error: 'AI service unavailable after 3 attempts: ' + m + '. For very large decks, try fewer slides (50–80 is a good starting point).' });
    }
    const raw = rawAccumulated.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    console.log('[POWERPOINTS /develop] parsing ' + raw.length + ' chars of JSON …');
    let data;
    try { data = JSON.parse(raw); console.log('[POWERPOINTS /develop] parsed cleanly — ' + (data.slides||[]).length + ' slides'); }
    catch (parseErr) {
      console.warn('[POWERPOINTS /develop] direct parse failed: ' + parseErr.message + ' — attempting repair…');
      // Strategy 1: pull the outermost JSON object literal
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) { try { data = JSON.parse(m[0]); console.log('[POWERPOINTS /develop] repaired by outer-object extraction'); } catch {} }
      // Strategy 2: TRUNCATED stream — find the last complete slide in the partial "slides":[...] array
      // and close the JSON envelope cleanly. Works when Claude hit max_tokens mid-slide.
      if (!data) {
        try {
          const startIdx = raw.indexOf('"slides"');
          if (startIdx >= 0) {
            const arrStart = raw.indexOf('[', startIdx);
            if (arrStart >= 0) {
              // Walk the array, tracking brace depth; capture the index just after the last fully-balanced top-level slide
              let depth = 0, inStr = false, prev = '', lastGoodEnd = -1;
              for (let p = arrStart; p < raw.length; p++) {
                const ch = raw[p];
                if (inStr) { if (ch === '"' && prev !== '\\') inStr = false; prev = ch; continue; }
                if (ch === '"') { inStr = true; prev = ch; continue; }
                if (ch === '{') depth++;
                else if (ch === '}') { depth--; if (depth === 1) lastGoodEnd = p + 1; }
                else if (ch === ']' && depth === 1) { lastGoodEnd = p; break; }
                prev = ch;
              }
              if (lastGoodEnd > arrStart) {
                // Construct: take everything up through the last complete slide, then close the array + the title block
                const head = raw.slice(0, lastGoodEnd);
                const candidate = head + ']}'; // close the slides array + the root object
                try {
                  data = JSON.parse(candidate);
                  console.log('[POWERPOINTS /develop] RECOVERED from truncated stream — kept ' + (data.slides||[]).length + ' complete slides (dropped the in-progress one)');
                } catch (rep2) {
                  console.warn('[POWERPOINTS /develop] truncation repair failed: ' + rep2.message);
                }
              }
            }
          }
        } catch (repErr) { console.warn('[POWERPOINTS /develop] repair exception: ' + repErr.message); }
      }
      if (!data) {
        // WP-08 L4 — structured, metadata-only (AI output content is never logged).
        try { logger.error('AI_PROVIDER_ERROR', { message: 'AI response parsing failed', operation: 'powerpoint-develop', responseLength: raw.length, statusCode: 502 }); } catch {}
        return res.status(502).json({ error: 'The AI returned a malformed / truncated response (' + raw.length + ' chars, no valid JSON object found). Try a smaller slide count (50–80 is the sweet spot).' });
      }
    }
    if (!Array.isArray(data.slides) || !data.slides.length) return res.status(422).json({ error: 'The AI did not return any slides.' });

    // Copy the uploaded training document's pictures INTO the deck: attach each to the slide the AI
    // chose (via "srcImages"), then append any it did not place as dedicated image slides at the end,
    // so every source picture ends up in the PowerPoint.
    if (srcImages.length) {
      const used = new Set();
      for (const s of data.slides) {
        if (!s || !Array.isArray(s.srcImages)) { if (s) delete s.srcImages; continue; }
        const imgs = [];
        for (const n of s.srcImages) {
          const idx = parseInt(n, 10) - 1;
          if (idx >= 0 && idx < srcImages.length && !used.has(idx)) { used.add(idx); imgs.push({ data: srcImages[idx].data, placement: 'right', size: 'medium' }); }
        }
        delete s.srcImages;
        if (imgs.length) {
          s.images = (Array.isArray(s.images) ? s.images : []).concat(imgs);
          // These slide types don't render a body image — switch to a content slide so the picture shows.
          if (['title', 'qa', 'section', 'quote'].includes(s.type)) s.type = 'content';
        }
      }
      // Any pictures the AI did not place → add as image slides (up to 2 per slide) before the sign-off.
      const leftover = srcImages.map((im, i) => ({ im, i })).filter(x => !used.has(x.i));
      if (leftover.length) {
        const chunks = [];
        for (let i = 0; i < leftover.length; i += 2) chunks.push(leftover.slice(i, i + 2));
        const newSlides = chunks.map(ch => ({
          type: 'image', heading: 'Reference Image' + (ch.length > 1 ? 's' : '') + ' from Source Document',
          images: ch.map(x => ({ data: x.im.data, size: ch.length > 1 ? 'medium' : 'large' })),
          notes: 'Picture(s) copied from the uploaded training document for reference.'
        }));
        const insertAt = Math.max(1, data.slides.length - 1);
        data.slides.splice(insertAt, 0, ...newSlides);
      }
      console.log('[POWERPOINTS /develop] copied source images → placed:', used.size, '| leftover slides for:', srcImages.length - used.size);
    }

    try { await recordLegacyAudit(req.session.user.username, 'PPTX', 'DEVELOP', null, tplKey, topic.slice(0, 200), `${data.slides.length} slides`); } catch {}
    res.json({ success: true, template: tplKey, deck: data });
  } catch (e) { res.status(500).json({ error: 'Develop failed: ' + (e && e.message ? e.message : String(e)) }); }
});

// ── Suggest AI image prompts (for ChatGPT / DALL·E) for slides that have NO image ──
// Works for a deck made with Develop-with-AI OR an uploaded PPTX. Body: { deck }.
// Returns { deck } with imagePrompt filled on content slides that lack a picture.
router.post('/suggest-images', async (req, res) => {
  try {
    if (!(req.session.user && req.session.user.admin)) return res.status(403).json({ error: 'Admin only.' });
    const deck = req.body.deck || {};
    if (!Array.isArray(deck.slides) || !deck.slides.length) return res.status(400).json({ error: 'No slides to suggest images for.' });
    // Only content-type slides with no image already placed.
    const targets = deck.slides.map((s, i) => ({ s, i })).filter(x => x.s
      && !['title', 'section', 'qa', 'quote'].includes(x.s.type)
      && !x.s.hasImage   // lite payload flag: slide already has a picture (image data not sent)
      && !(Array.isArray(x.s.images) && x.s.images.some(im => im && im.data)));
    if (!targets.length) return res.json({ success: true, deck, suggested: 0 });
    // Number the slides to illustrate SEQUENTIALLY (1..N) so the model can echo the numbers reliably.
    const list = targets.map((x, k) => ({
      n: k + 1, heading: x.s.heading || '',
      bullets: Array.isArray(x.s.bullets) ? x.s.bullets.slice(0, 6) : [],
      body: String(x.s.body || '').slice(0, 300)
    }));
    const sys = `You write ready-to-paste image-generation prompts for ChatGPT / DALL·E to illustrate training slides. For EACH of the ${list.length} slide(s) below, write ONE complete prompt that would create a helpful, professional training ILLUSTRATION for that slide's content: describe the scene and key elements/labels, specify a clean modern illustration style, 16:9 aspect ratio, and NO text baked into the image. Return a prompt for EVERY slide, in the same order, keeping the slide number. Return ONLY JSON: {"prompts":[{"n":<slide number>,"imagePrompt":"..."}]}` + ppImageStyleDirective(req.body);
    const user = `Deck title: ${deck.title || ''}\n\nSlides needing an image (write a prompt for each):\n\n` +
      list.map(l => `#${l.n} — ${l.heading}\n${(l.bullets || []).map(b => '• ' + b).join('\n')}${l.body ? '\n' + l.body : ''}`).join('\n\n');
    const msg = await aiGateway.complete({ provider: 'anthropic', agent: 'AI-DOC-003', operation: 'suggest_slide_images', model: 'claude-sonnet-4-6', max_tokens: 8000, system: sys, messages: [{ role: 'user', content: user }] });
    const raw = (msg.content.find(b => b.type === 'text') || {}).text || '';
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    let j; try { j = JSON.parse(cleaned); } catch { try { j = JSON.parse((cleaned.match(/\{[\s\S]*\}/) || [''])[0]); } catch { j = null; } }
    let suggested = 0;
    if (j && Array.isArray(j.prompts)) {
      const prompts = j.prompts;
      // Map each target by its sequential number (n = k+1); fall back to positional order if n is off.
      targets.forEach((x, k) => {
        let pr = '';
        const byN = prompts.find(p => p && Number(p.n) === k + 1);
        if (byN && byN.imagePrompt) pr = String(byN.imagePrompt).trim();
        else if (prompts[k] && prompts[k].imagePrompt) pr = String(prompts[k].imagePrompt).trim();
        if (pr) { deck.slides[x.i].imagePrompt = pr; suggested++; }
      });
    }
    res.json({ success: true, deck, suggested });
  } catch (e) { res.status(500).json({ error: 'Suggest images failed: ' + (e && e.message ? e.message : String(e)) }); }
});

// ── AI assistant for ONE slide — write / improve / expand its content ──
// Body: { slide, instruction, deckTitle }. Returns { slide:{heading,subheading,bullets,body,notes} }.
router.post('/assist-slide', async (req, res) => {
  try {
    if (!(req.session.user && req.session.user.admin)) return res.status(403).json({ error: 'Admin only.' });
    const slide = req.body.slide || {};
    const instruction = String(req.body.instruction || '').trim();
    const deckTitle = String(req.body.deckTitle || '').trim();
    const sys = `You improve ONE slide of a training deck for a mining / industrial company. Return ONLY JSON: {"heading":"...","subheading":"","bullets":["...","..."],"body":"","notes":"..."}. RULES: heading ≤ 8 words; 3–6 bullets each ≤ 12 words; ALWAYS include trainer "notes" (3–6 sentences of facilitator guidance). Keep it concise and operational; do NOT invent site-specific values (speeds/heights/distances) — use "[site-specific value]". No markdown fences.`;
    const user = `Deck: ${deckTitle || '(untitled)'}\n\nCURRENT SLIDE:\n${JSON.stringify({ heading: slide.heading || '', subheading: slide.subheading || '', bullets: Array.isArray(slide.bullets) ? slide.bullets : [], body: slide.body || '', notes: slide.notes || '' })}\n\nINSTRUCTION: ${instruction || 'Write and complete the content for this slide — fill the heading, 3–6 bullets, and trainer notes.'}`;
    const msg = await aiGateway.complete({ provider: 'anthropic', agent: 'AI-DOC-003', operation: 'assist_slide', model: 'claude-sonnet-4-6', max_tokens: 2000, system: sys, messages: [{ role: 'user', content: user }] });
    const raw = (msg.content.find(b => b.type === 'text') || {}).text || '';
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    let j; try { j = JSON.parse(cleaned); } catch { try { j = JSON.parse((cleaned.match(/\{[\s\S]*\}/) || [''])[0]); } catch { j = null; } }
    if (!j) return res.status(502).json({ error: 'The AI returned an unexpected format. Try again.' });
    const out = {
      heading: String(j.heading || slide.heading || '').slice(0, 120),
      subheading: String(j.subheading || '').slice(0, 160),
      bullets: Array.isArray(j.bullets) ? j.bullets.map(b => String(b)).filter(Boolean).slice(0, 10) : (Array.isArray(slide.bullets) ? slide.bullets : []),
      body: String(j.body || '').slice(0, 1500),
      notes: String(j.notes || '').slice(0, 3000),
    };
    res.json({ success: true, slide: out });
  } catch (e) { res.status(500).json({ error: 'Assist failed: ' + (e && e.message ? e.message : String(e)) }); }
});

// ── Translate the whole slide deck (or a single slide) into a target language ──
// Same pattern as Content Studio: applies the approved terminology glossary + optional KB context.
// Stores the result on each slide as { translation: { lang, heading, subheading, bullets[], body, notes, presenter?, title?, subtitle? } }.
router.post('/translate-deck', async (req, res) => {
  try {
    if (!(req.session.user && req.session.user.admin)) return res.status(403).json({ error: 'Admin only.' });
    const deck = req.body.deck || {};
    if (!Array.isArray(deck.slides) || !deck.slides.length) return res.status(400).json({ error: 'No slides in deck.' });
    const targetLang = String(req.body.targetLang || '').trim();
    if (!targetLang) return res.status(400).json({ error: 'Pick a target language.' });
    const onlySlideIdx = (req.body.slideIndex == null) ? null : parseInt(req.body.slideIndex, 10);
    const kbArticleIds = Array.isArray(req.body.kbArticleIds) ? req.body.kbArticleIds.map(n => parseInt(n, 10)).filter(Boolean) : [];

    // Resolve glossary code from language name via shared resolver
    const { langCodeFromName } = require('../lib/translate');
    const code = langCodeFromName(targetLang);
    let glossary = [];
    if (code) glossary = await dbAll('SELECT SourceTerm, TargetTerm FROM tblTerminology WHERE LangCode=?', [code]);

    // KB context
    let kbContext = '';
    if (kbArticleIds.length) {
      const ph = kbArticleIds.map(() => '?').join(',');
      const kbRows = await dbAll(
        `SELECT Title, Body FROM tblKBArticle WHERE ArticleID IN (${ph}) AND Status='Published'`, kbArticleIds);
      if (kbRows.length) kbContext = kbRows.map(r => `[${r.Title}]\n${r.Body}`).join('\n\n---\n\n');
    }

    const { translateSection } = require('../lib/content');

    // Build a compact payload Claude can faithfully translate without losing structure
    const slidesToDo = (onlySlideIdx == null)
      ? deck.slides
      : [deck.slides[onlySlideIdx]];
    const payload = {
      // Translating deck-level metadata too, but only when doing the full deck (per-slide skips these)
      ...(onlySlideIdx == null ? {
        title: deck.title || '',
        subtitle: deck.subtitle || '',
        presenter: deck.presenter || ''
      } : {}),
      slides: slidesToDo.map(s => ({
        heading: s.heading || '',
        subheading: s.subheading || '',
        bullets: Array.isArray(s.bullets) ? s.bullets : [],
        body: s.body || '',
        notes: s.notes || ''
      }))
    };

    // Retries request the full token budget so a big slide can't truncate to invalid JSON.
    const maxTokens = req.body.fullTokens ? 64000 : 32000;
    const tr = await translateSection(payload, targetLang, glossary, kbContext, { maxTokens });
    const trSlides = (tr && Array.isArray(tr.slides)) ? tr.slides : [];

    // Merge translations onto the original deck without mutating non-translated slides
    const out = JSON.parse(JSON.stringify(deck));
    out.translation = out.translation || {};
    if (onlySlideIdx == null) {
      out.translation.lang     = targetLang;
      out.translation.title    = tr.title || '';
      out.translation.subtitle = tr.subtitle || '';
      out.translation.presenter= tr.presenter || '';
    }
    slidesToDo.forEach((s, i) => {
      const real = (onlySlideIdx == null) ? i : onlySlideIdx;
      const t = trSlides[i] || {};
      out.slides[real] = out.slides[real] || {};
      out.slides[real].translation = {
        lang: targetLang,
        heading: t.heading || '',
        subheading: t.subheading || '',
        bullets: Array.isArray(t.bullets) ? t.bullets : [],
        body: t.body || '',
        notes: t.notes || ''
      };
    });

    res.json({
      success: true,
      language: targetLang,
      glossaryTerms: glossary.length,
      kbArticles: kbArticleIds.length,
      slidesTranslated: slidesToDo.length,
      deck: out
    });
  } catch (e) { res.status(500).json({ error: 'Translate failed: ' + (e && e.message ? e.message : String(e)) }); }
});

// ── Build a .pptx file from a slide-deck JSON, save it to the library, return file id ──
router.post('/build', async (req, res) => {
  try {
    if (!(req.session.user && req.session.user.admin)) return res.status(403).json({ error: 'Admin only.' });
    const deck = req.body.deck || {};
    if (!Array.isArray(deck.slides) || !deck.slides.length) return res.status(400).json({ error: 'No slides in deck.' });
    const category = String(req.body.category || 'Training').trim().slice(0, 80) || 'Training';
    // Output language: 'both' = bilingual (English + translation), 'en' = English only,
    // 'target' = the translated language only (e.g. Thai). Default 'both'.
    const langMode = ['both', 'en', 'target'].includes(String(req.body.langMode || '')) ? String(req.body.langMode) : 'both';
    let outputLangLabel = '';
    if (langMode === 'en') {
      delete deck.translation;
      for (const s of deck.slides) if (s) delete s.translation;
      outputLangLabel = 'English';
    } else if (langMode === 'target') {
      // Promote the translation to primary, drop English, so the deck is monolingual target-language.
      outputLangLabel = (deck.translation && deck.translation.lang) || ((deck.slides.find(s => s && s.translation && s.translation.lang) || {}).translation || {}).lang || 'Translated';
      if (deck.translation) {
        if (deck.translation.title) deck.title = deck.translation.title;
        if (deck.translation.subtitle) deck.subtitle = deck.translation.subtitle;
        if (deck.translation.presenter) deck.presenter = deck.translation.presenter;
        delete deck.translation;
      }
      for (const s of deck.slides) {
        if (!s || !s.translation) { if (s) delete s.translation; continue; }
        const t = s.translation;
        if (t.heading) s.heading = t.heading;
        if (t.subheading) s.subheading = t.subheading;
        if (Array.isArray(t.bullets) && t.bullets.length) s.bullets = t.bullets;
        if (t.body) s.body = t.body;
        if (t.notes) s.notes = t.notes;
        delete s.translation;
      }
    }
    // Bilingual layout (mirrors AI Content Studio): which language leads on each slide.
    const ppTransLayout = String(req.body.transLayout || 'below');
    const ppTransSideOrder = String(req.body.transSideOrder || 'en-first');
    const wantSave = req.body.save !== false; // default save to library; pass save:false to just download

    // Company branding for header / footer
    const [nameCfg, logoCfg] = await Promise.all([
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, [])
    ]);
    const companyName = (nameCfg && nameCfg.cvalue) ? nameCfg.cvalue.trim() : '';
    const companyLogo = (logoCfg && logoCfg.cvalue) ? logoCfg.cvalue : '';

    const PptxGenJS = require('pptxgenjs');
    const pres = new PptxGenJS();
    pres.layout = 'LAYOUT_WIDE';
    pres.author = req.session.user.username;
    pres.company = companyName || 'TrainingPro';
    pres.title   = deck.title || 'Training Deck';

    // ── THEME SYSTEM ──────────────────────────────────────────────────────
    // Four modern themes. Each defines slide-content colours + the master backgrounds.
    // bg = main content slide background; titleBg = title-slide background;
    // sectionBg = full-bleed section divider; accent strip drawn on every content slide.
    const THEMES = {
      'modern-navy': {
        name: 'Navy & Yellow',
        navy: '1E3A5F', orange: 'FBC02D', slate: '334155', text: '0F172A', soft: '64748B',
        bg: 'FFFFFF', altBg: 'F8FAFC',
        titleBg: { type: 'solid', color: '1E3A5F' },
        sectionBg: '1E3A5F',
        accentStrip: 'FBC02D', accentStripW: 0.2,
        chromeColor: '6B7280',
      },
      'industrial-charcoal': {
        name: 'Industrial Charcoal',
        navy: 'FFFFFF', orange: 'F97316', slate: 'E2E8F0', text: 'F1F5F9', soft: '94A3B8',
        bg: '1E293B', altBg: '0F172A',
        titleBg: { type: 'gradient', from: '0F172A', to: '1E3A5F' },
        sectionBg: '0F172A',
        accentStrip: 'F97316', accentStripW: 0.25,
        chromeColor: '94A3B8',
      },
      'clean-white': {
        name: 'Clean White',
        navy: '0F172A', orange: '2563EB', slate: '475569', text: '0F172A', soft: '94A3B8',
        bg: 'FFFFFF', altBg: 'F9FAFB',
        titleBg: { type: 'solid', color: 'F9FAFB' },
        sectionBg: '0F172A',
        accentStrip: '2563EB', accentStripW: 0.15,
        chromeColor: '9CA3AF',
      },
      'bold-orange': {
        name: 'Bold Orange',
        navy: '7C2D12', orange: 'F97316', slate: '57534E', text: '1C1917', soft: '78716C',
        bg: 'FFFBF5', altBg: 'FFF7ED',
        titleBg: { type: 'gradient', from: 'F97316', to: 'C2410C' },
        sectionBg: 'F97316',
        accentStrip: '7C2D12', accentStripW: 0.2,
        chromeColor: '78716C',
      },
      'fresh-teal': {
        name: 'Fresh Teal',
        navy: '0F766E', orange: 'F59E0B', slate: '334155', text: '0F172A', soft: '64748B',
        bg: 'F0FDFA', altBg: 'CCFBF1',
        titleBg: { type: 'gradient', from: '0F766E', to: '14B8A6' },
        sectionBg: '0F766E',
        accentStrip: 'F59E0B', accentStripW: 0.2,
        chromeColor: '64748B',
      },
    };
    const theme = THEMES[String(req.body.theme || 'modern-navy')] || THEMES['modern-navy'];

    // Master slide — accent strip left · company logo top-RIGHT · company name + slide number footer.
    // Slide number uses pptxgenjs's native slideNumber field (the "%{slideNum}" text macro doesn't actually substitute in saved files).
    pres.defineSlideMaster({
      title: 'MAIN',
      background: { color: theme.bg },
      objects: [
        { rect: { x: 0, y: 0, w: theme.accentStripW, h: 7.5, fill: { color: theme.accentStrip }, line: { color: theme.accentStrip, width: 0 } } },
        // Company logo — TOP RIGHT. Master `objects.image` does NOT honor pptxgenjs's `sizing` option,
        // so we pre-compute aspect-preserving w/h from the logo bytes and right-align inside an 0.85×0.45 box.
        (() => {
          if (!companyLogo) return null;
          const boxX = 12.15, boxY = 0.22, boxW = 0.85, boxH = 0.45;
          const fit = fitDataUriInBox(companyLogo, boxX, boxY, boxW, boxH);
          if (fit) return { image: { x: boxX + (boxW - fit.w), y: fit.y, w: fit.w, h: fit.h, data: companyLogo } };
          return { image: { x: 12.55, y: 0.27, w: 0.45, h: 0.4, data: companyLogo } };
        })(),
        // Company name — bottom-left
        { text: { text: companyName || 'TrainingPro',
          options: { x: 0.4, y: 7.05, w: 6, h: 0.3, fontSize: 9, color: theme.chromeColor, fontFace: 'Segoe UI' } } },
      ].filter(Boolean),
      // Native slide-number placeholder — auto-renders the slide number on every slide. fontSize/color must be set.
      slideNumber: { x: 12.4, y: 7.05, w: 0.8, h: 0.3, fontSize: 9, color: theme.chromeColor, align: 'right', fontFace: 'Segoe UI' },
    });

    const NAVY = theme.navy;
    const ORANGE = theme.orange;
    const SLATE = theme.slate;

    (deck.slides || []).forEach((s, idx) => {
      const slide = pres.addSlide({ masterName: 'MAIN' });
      const type = (s.type || 'bullets').toLowerCase();
      let heading = String(s.heading || '');
      let subheading = String(s.subheading || '');
      let body = String(s.body || '');
      let bullets = Array.isArray(s.bullets) ? s.bullets.filter(Boolean).map(String) : [];
      // Bilingual content (when translated) — rendered beneath the original on each slide
      const tr = s.translation || null;
      let tHeading = tr && tr.heading ? String(tr.heading) : '';
      let tSubheading = tr && tr.subheading ? String(tr.subheading) : '';
      let tBullets = tr && Array.isArray(tr.bullets) ? tr.bullets.filter(Boolean).map(String) : [];
      let tBody = tr && tr.body ? String(tr.body) : '';
      // Bilingual ORDER: when the translation should lead (layout "above", or "side" with the translated
      // language first) put the translated text in the primary styled position and English beneath it.
      // Applied once here so every slide type below honours it without changing its own positioning.
      if (tr && (ppTransLayout === 'above' || (ppTransLayout === 'side' && ppTransSideOrder === 'lang-first'))) {
        [heading, tHeading] = [tHeading, heading];
        [subheading, tSubheading] = [tSubheading, subheading];
        [body, tBody] = [tBody, body];
        [bullets, tBullets] = [tBullets, bullets];
      }

      // Pull deck-level translated title/subtitle so the title slide can render bilingual content.
      // Per-slide translations (tHeading/tSubheading/tBullets/tBody) come from `s.translation` and
      // are used for every non-title slide type below.
      const deckTr = deck.translation || {};
      const dtTitle = String(deckTr.title || '');
      const dtSubtitle = String(deckTr.subtitle || '');

      if (type === 'title') {
        // Title slide — full-bleed branded background, big centred title
        if (theme.titleBg.type === 'gradient') {
          // pptxgenjs doesn't support true gradients on backgrounds in all versions; fall back to solid 'from' color with a contrasting strip
          slide.background = { color: theme.titleBg.from };
          slide.addShape(pres.ShapeType.rect, { x: 0, y: 4.0, w: 13.33, h: 3.5, fill: { color: theme.titleBg.to }, line: { color: theme.titleBg.to, width: 0 } });
        } else {
          slide.background = { color: theme.titleBg.color };
        }
        const titleColor = (theme.titleBg.color === 'FFFFFF' || theme.titleBg.color === 'F9FAFB') ? NAVY : 'FFFFFF';
        const subColor   = (theme.titleBg.color === 'FFFFFF' || theme.titleBg.color === 'F9FAFB') ? SLATE : 'F1F5F9';
        // Auto-scale title font + box height so wrapped lines never collide with the rule below.
        // Char thresholds and box heights are calibrated to Segoe UI bold @ 12in width with 1.15× line spacing.
        const headTxt = heading || deck.title || 'Training Deck';
        const titleFs = headTxt.length > 70 ? 28 : headTxt.length > 40 ? 36 : 48;
        // Empirical line-height: ~0.85in @48pt, ~0.65in @36pt, ~0.50in @28pt
        const lineH   = titleFs === 48 ? 0.85 : titleFs === 36 ? 0.65 : 0.50;
        // Char/line budget at given font: 48pt≈30, 36pt≈40, 28pt≈52
        const charsPerLine = titleFs === 48 ? 30 : titleFs === 36 ? 40 : 52;
        const lines   = Math.max(1, Math.ceil(headTxt.length / charsPerLine));
        const titleH  = Math.max(1.0, lines * lineH + 0.15); // +cushion
        const titleY  = 1.6;
        slide.addText(headTxt, { x: 0.6, y: titleY, w: 12.0, h: titleH, fontSize: titleFs, bold: true, color: titleColor, fontFace: 'Segoe UI', align: 'center', valign: 'middle' });
        // Yellow rule sits a generous 0.30in below the title's actual bottom edge — never overlaps wrapped text
        const ruleY = titleY + titleH + 0.30;
        slide.addShape(pres.ShapeType.line, { x: 0.6, y: ruleY, w: 12.0, h: 0, line: { color: ORANGE, width: 4 } });
        slide.addText(subheading || deck.subtitle || '', { x: 0.6, y: ruleY + 0.15, w: 12.0, h: 0.7, fontSize: 20, color: subColor, fontFace: 'Segoe UI', align: 'center' });
        if (deck.presenter) slide.addText('Presented by: ' + deck.presenter, { x: 0.6, y: ruleY + 1.0, w: 12.0, h: 0.5, fontSize: 14, color: subColor, italic: true, fontFace: 'Segoe UI', align: 'center' });
        // Bilingual title slide — render the translated title + subtitle below the English one
        if (dtTitle || dtSubtitle) {
          const trColor = (theme.titleBg.color === 'FFFFFF' || theme.titleBg.color === 'F9FAFB') ? '1D4ED8' : 'BFDBFE';
          if (dtTitle) slide.addText(dtTitle, { x: 0.6, y: ruleY + 1.5, w: 12.0, h: 1.0, fontSize: Math.max(20, titleFs - 16), bold: true, italic: true, color: trColor, fontFace: 'Segoe UI', align: 'center' });
          if (dtSubtitle) slide.addText(dtSubtitle, { x: 0.6, y: ruleY + 2.4, w: 12.0, h: 0.5, fontSize: 16, italic: true, color: trColor, fontFace: 'Segoe UI', align: 'center' });
        }
      } else if (type === 'section') {
        slide.background = { color: theme.sectionBg };
        // Same wrap-aware sizing as title slide — drop font when long, push rule below the actual title bottom
        const secFs = heading.length > 60 ? 28 : heading.length > 36 ? 36 : 44;
        const secLineH = secFs === 44 ? 0.80 : secFs === 36 ? 0.65 : 0.50;
        const secCpl   = secFs === 44 ? 32 : secFs === 36 ? 42 : 56;
        const secLines = Math.max(1, Math.ceil(heading.length / secCpl));
        const secH     = Math.max(1.0, secLines * secLineH + 0.15);
        const secY     = 2.2;
        slide.addText(heading, { x: 0.6, y: secY, w: 12.0, h: secH, fontSize: secFs, bold: true, color: 'FFFFFF', fontFace: 'Segoe UI', align: 'center', valign: 'middle' });
        const secRuleY = secY + secH + 0.30;
        slide.addShape(pres.ShapeType.line, { x: 0.6, y: secRuleY, w: 12.0, h: 0, line: { color: ORANGE, width: 4 } });
        if (subheading) slide.addText(subheading, { x: 0.6, y: secRuleY + 0.15, w: 12.0, h: 0.5, fontSize: 18, color: 'F1F5F9', fontFace: 'Segoe UI', align: 'center', italic: true });
        if (tHeading) slide.addText(tHeading, { x: 0.6, y: secRuleY + 0.9, w: 12.0, h: 0.9, fontSize: 26, bold: true, italic: true, color: 'BFDBFE', fontFace: 'Segoe UI', align: 'center' });
        if (tSubheading) slide.addText(tSubheading, { x: 0.6, y: secRuleY + 1.85, w: 12.0, h: 0.5, fontSize: 14, italic: true, color: 'CBD5E1', fontFace: 'Segoe UI', align: 'center' });
      } else if (type === 'two-column') {
        slide.addText(heading, { x: 0.5, y: 0.5, w: 12.3, h: 0.7, fontSize: 28, bold: true, color: NAVY, fontFace: 'Calibri' });
        if (tHeading) slide.addText(tHeading, { x: 0.5, y: 1.0, w: 12.3, h: 0.4, fontSize: 16, italic: true, color: '1D4ED8', fontFace: 'Calibri' });
        slide.addShape(pres.ShapeType.line, { x: 0.5, y: tHeading ? 1.5 : 1.2, w: 12.3, h: 0, line: { color: ORANGE, width: 2 } });
        const topY = tHeading ? 1.65 : 1.5;
        const left  = Array.isArray(s.leftBullets) ? s.leftBullets.map(String) : bullets.slice(0, Math.ceil(bullets.length / 2));
        const right = Array.isArray(s.rightBullets) ? s.rightBullets.map(String) : bullets.slice(Math.ceil(bullets.length / 2));
        const tLeft  = tBullets.slice(0, Math.ceil(tBullets.length / 2));
        const tRight = tBullets.slice(Math.ceil(tBullets.length / 2));
        const colH = tBullets.length ? 2.4 : 5.0;
        slide.addText(left.map(t => ({ text: t, options: { bullet: { code: '25A0' } } })),
          { x: 0.5, y: topY, w: 6.0, h: colH, fontSize: 16, color: SLATE, fontFace: 'Calibri', valign: 'top' });
        slide.addText(right.map(t => ({ text: t, options: { bullet: { code: '25A0' } } })),
          { x: 6.8, y: topY, w: 6.0, h: colH, fontSize: 16, color: SLATE, fontFace: 'Calibri', valign: 'top' });
        if (tBullets.length) {
          const trY = topY + colH + 0.2;
          slide.addText(tLeft.map(t => ({ text: t, options: { bullet: { code: '25A0' } } })),
            { x: 0.5, y: trY, w: 6.0, h: 2.3, fontSize: 14, color: '1D4ED8', italic: true, fontFace: 'Calibri', valign: 'top' });
          slide.addText(tRight.map(t => ({ text: t, options: { bullet: { code: '25A0' } } })),
            { x: 6.8, y: trY, w: 6.0, h: 2.3, fontSize: 14, color: '1D4ED8', italic: true, fontFace: 'Calibri', valign: 'top' });
        }
      } else if (type === 'quote') {
        const qbody = body || heading;
        const tQuote = tBody || tHeading || '';
        const yMain = tQuote ? 1.8 : 2.2;
        const hMain = tQuote ? 2.0 : 3.0;
        slide.addText('"' + qbody + '"', { x: 1.0, y: yMain, w: 11.3, h: hMain, fontSize: 28, italic: true, color: NAVY, fontFace: 'Calibri', align: 'center' });
        if (tQuote) slide.addText('"' + tQuote + '"', { x: 1.0, y: yMain + hMain + 0.2, w: 11.3, h: 1.8, fontSize: 20, italic: true, color: '1D4ED8', fontFace: 'Calibri', align: 'center' });
        if (subheading) slide.addText('— ' + subheading, { x: 1.0, y: 5.2, w: 11.3, h: 0.6, fontSize: 16, color: SLATE, fontFace: 'Calibri', align: 'center' });
        if (tSubheading) slide.addText('— ' + tSubheading, { x: 1.0, y: 5.8, w: 11.3, h: 0.5, fontSize: 13, italic: true, color: '1D4ED8', fontFace: 'Calibri', align: 'center' });
      } else if (type === 'image') {
        slide.addText(heading, { x: 0.5, y: 0.5, w: 12.3, h: 0.7, fontSize: 28, bold: true, color: NAVY, fontFace: 'Calibri' });
        if (tHeading) slide.addText(tHeading, { x: 0.5, y: 1.0, w: 12.3, h: 0.4, fontSize: 14, italic: true, color: '1D4ED8', fontFace: 'Calibri' });
        slide.addShape(pres.ShapeType.line, { x: 0.5, y: tHeading ? 1.5 : 1.2, w: 12.3, h: 0, line: { color: ORANGE, width: 2 } });
        // If the user uploaded actual image(s) for this image-type slide, render them in the body area.
        // Otherwise show the dashed placeholder + imagePrompt (AI-suggested content).
        const imgList = Array.isArray(s.images) ? s.images.filter(im => im && im.data) : [];
        const IMG_SCALE = { small: 0.30, medium: 0.60, large: 1.00, xlarge: 1.30 };
        if (imgList.length) {
          // Lay out the uploaded images centered in the body area, scaled by their `size` setting.
          // Aspect ratio is preserved per-image by computing natural-fit dimensions from image bytes —
          // pptxgenjs's `sizing:contain` is unreliable on some image types, so we pre-compute w/h.
          const region = { x: 0.5, y: 1.5, w: 12.3, h: 5.0 };
          const eachH = Math.max(1.0, region.h / imgList.length - 0.1);
          let y = region.y;
          imgList.forEach(im => {
            const scale = IMG_SCALE[(im.size || 'large')] || 1.0;
            const boxW = Math.min(region.w * scale, region.w);
            const boxH = Math.min(eachH * scale, eachH * 1.3);
            const boxX = region.x + (region.w - boxW) / 2;
            const boxY = y + (eachH - boxH) / 2;
            const fit = fitDataUriInBox(im.data, boxX, boxY, boxW, boxH);
            if (fit) slide.addImage({ data: im.data, x: fit.x, y: fit.y, w: fit.w, h: fit.h });
            else     slide.addImage({ data: im.data, x: boxX, y: boxY, w: boxW, h: boxH, sizing: { type: 'contain', w: boxW, h: boxH } });
            y += eachH + 0.1;
          });
        } else {
          // Placeholder rectangle where the trainer should insert their own image
          slide.addShape(pres.ShapeType.rect, { x: 2.0, y: 1.7, w: 9.3, h: 4.5, fill: { color: 'F1F5F9' }, line: { color: 'CBD5E1', width: 1 } });
          slide.addText('🖼 ' + (s.imagePrompt || 'Insert relevant image here') + '\n(Click 📷 Add Image on this slide in the developer, or in PowerPoint right-click → Change Picture)',
            { x: 2.0, y: 3.5, w: 9.3, h: 1.0, fontSize: 14, italic: true, color: 'CBD5E1', fontFace: 'Calibri', align: 'center' });
        }
        if (bullets.length) slide.addText(bullets.map(t => ({ text: t, options: { bullet: { code: '25A0' } } })),
          { x: 0.5, y: 6.4, w: 6.0, h: 0.5, fontSize: 11, color: SLATE, fontFace: 'Calibri' });
        if (tBullets.length) slide.addText(tBullets.map(t => ({ text: t, options: { bullet: { code: '25A0' } } })),
          { x: 6.7, y: 6.4, w: 6.1, h: 0.5, fontSize: 11, italic: true, color: '1D4ED8', fontFace: 'Calibri' });
      } else if (type === 'qa') {
        slide.background = { color: theme.altBg };
        slide.addText(heading || 'Questions?', { x: 0.6, y: 2.2, w: 12.0, h: 1.3, fontSize: 56, bold: true, color: NAVY, fontFace: 'Segoe UI', align: 'center' });
        slide.addShape(pres.ShapeType.line, { x: 0.6, y: 3.7, w: 12.0, h: 0, line: { color: ORANGE, width: 4 } });
        slide.addText(subheading || body || 'Thank you for your attention.', { x: 0.6, y: 3.9, w: 12.0, h: 0.6, fontSize: 18, color: SLATE, fontFace: 'Segoe UI', align: 'center', italic: true });
        if (tHeading) slide.addText(tHeading, { x: 0.6, y: 4.7, w: 12.0, h: 1.0, fontSize: 36, bold: true, italic: true, color: '1D4ED8', fontFace: 'Segoe UI', align: 'center' });
        if (tSubheading || tBody) slide.addText(tSubheading || tBody, { x: 0.6, y: 5.7, w: 12.0, h: 0.6, fontSize: 14, italic: true, color: '1D4ED8', fontFace: 'Segoe UI', align: 'center' });
      } else {
        // Default — heading + bullets (or paragraph body if no bullets)
        slide.addText(heading, { x: 0.5, y: 0.5, w: 12.3, h: 0.7, fontSize: 28, bold: true, color: NAVY, fontFace: 'Calibri' });
        if (tHeading) slide.addText(tHeading, { x: 0.5, y: 1.0, w: 12.3, h: 0.4, fontSize: 16, italic: true, color: '2563EB', fontFace: 'Calibri' });
        slide.addShape(pres.ShapeType.line, { x: 0.5, y: tHeading ? 1.5 : 1.2, w: 12.3, h: 0, line: { color: ORANGE, width: 2 } });
        if (subheading) slide.addText(subheading, { x: 0.5, y: tHeading ? 1.65 : 1.3, w: 12.3, h: 0.4, fontSize: 14, italic: true, color: SLATE, fontFace: 'Calibri' });
        const contentY = (tHeading ? 0.5 : 0) + (subheading ? 1.9 : 1.6);
        // ── Media layout — placement-aware ───────────────────────────────────
        // Slide is 13.33 × 6.5 in usable area (after master chrome). Bullets default to left,
        // image goes wherever the per-image .placement says (right | left | top | bottom | full).
        const images = Array.isArray(s.images) ? s.images.filter(im => im && im.data) : [];
        const video  = (s.video && s.video.url) ? s.video : null;
        const hasText = bullets.length || body;
        // Decide a single "media slot" per slide: if multiple images exist, they share one slot but stack within it.
        // Honor the first image's placement for the slot, or fall back to 'right' (or 'full' if no text).
        const place = (images[0] && images[0].placement) || (!hasText ? 'full' : 'right');
        const videoPlace = (video && video.placement) || (!hasText ? 'full' : 'bottom');
        const mediaPlaceUsed = images.length ? place : (video ? videoPlace : null);
        // Compute regions (x, y, w, h) for the text area and the media area based on placement
        let textRegion = { x: 0.7, y: contentY, w: 12.1, h: 4.5 };
        let mediaRegion = null;
        if (images.length || video) {
          if (mediaPlaceUsed === 'right') {
            textRegion = { x: 0.7, y: contentY, w: 6.0, h: 4.5 };
            mediaRegion = { x: 7.0, y: contentY, w: 5.7, h: 4.5 };
          } else if (mediaPlaceUsed === 'left') {
            mediaRegion = { x: 0.5, y: contentY, w: 5.7, h: 4.5 };
            textRegion = { x: 6.5, y: contentY, w: 6.2, h: 4.5 };
          } else if (mediaPlaceUsed === 'top') {
            mediaRegion = { x: 0.7, y: contentY, w: 12.1, h: 2.5 };
            textRegion  = { x: 0.7, y: contentY + 2.7, w: 12.1, h: 2.0 };
          } else if (mediaPlaceUsed === 'bottom') {
            textRegion  = { x: 0.7, y: contentY, w: 12.1, h: 2.0 };
            mediaRegion = { x: 0.7, y: contentY + 2.2, w: 12.1, h: 2.7 };
          } else if (mediaPlaceUsed === 'full') {
            mediaRegion = { x: 0.5, y: contentY, w: 12.3, h: 4.8 };
            textRegion = null; // text suppressed when image is fill
          }
        }
        // ── Render text region ───────────────────────────────────────────────
        if (textRegion && bullets.length) {
          // If we ALSO have translated bullets, split the text region into two columns
          if (tBullets.length) {
            const half = (textRegion.w - 0.2) / 2;
            slide.addText(bullets.map(t => ({ text: t, options: { bullet: { code: '25A0' } } })),
              { x: textRegion.x, y: textRegion.y, w: half, h: textRegion.h, fontSize: 14, color: SLATE, fontFace: 'Calibri', valign: 'top', paraSpaceAfter: 6 });
            slide.addText(tBullets.map(t => ({ text: t, options: { bullet: { code: '25A0' } } })),
              { x: textRegion.x + half + 0.2, y: textRegion.y, w: half, h: textRegion.h, fontSize: 14, color: '1D4ED8', italic: true, fontFace: 'Calibri', valign: 'top', paraSpaceAfter: 6 });
          } else {
            slide.addText(bullets.map(t => ({ text: t, options: { bullet: { code: '25A0' } } })),
              { x: textRegion.x, y: textRegion.y, w: textRegion.w, h: textRegion.h, fontSize: 18, color: SLATE, fontFace: 'Calibri', valign: 'top', paraSpaceAfter: 6 });
          }
        } else if (textRegion && body) {
          if (tBody) {
            const half = (textRegion.w - 0.2) / 2;
            slide.addText(body, { x: textRegion.x, y: textRegion.y, w: half, h: textRegion.h, fontSize: 16, color: SLATE, fontFace: 'Calibri', valign: 'top' });
            slide.addText(tBody, { x: textRegion.x + half + 0.2, y: textRegion.y, w: half, h: textRegion.h, fontSize: 14, color: '1D4ED8', italic: true, fontFace: 'Calibri', valign: 'top' });
          } else {
            slide.addText(body, { x: textRegion.x, y: textRegion.y, w: textRegion.w, h: textRegion.h, fontSize: 16, color: SLATE, fontFace: 'Calibri', valign: 'top' });
          }
        }
        // ── Render image(s) in the media region ──────────────────────────────
        // Honor per-image `size`: small=30%, medium=60%, large=100% (default), xlarge=130%
        // The size scales the image WITHIN the available media region (clamped so it never overruns the slide).
        const SIZE_SCALE = { small: 0.30, medium: 0.60, large: 1.00, xlarge: 1.30 };
        if (images.length && mediaRegion) {
          const baseEachH = Math.max(1.0, (mediaRegion.h - (video ? 1.8 : 0)) / images.length - 0.1);
          let y = mediaRegion.y;
          images.forEach(im => {
            const scale = SIZE_SCALE[(im.size || 'large')] || 1.0;
            const boxW = Math.min(mediaRegion.w * scale, mediaRegion.w);
            const boxH = Math.min(baseEachH * scale, baseEachH * 1.3);
            const boxX = mediaRegion.x + (mediaRegion.w - boxW) / 2;
            const boxY = y + (baseEachH - boxH) / 2;
            const fit = fitDataUriInBox(im.data, boxX, boxY, boxW, boxH) || { x: boxX, y: boxY, w: boxW, h: boxH };
            slide.addImage({ data: im.data, x: fit.x, y: fit.y, w: fit.w, h: fit.h });
            const callouts = Array.isArray(im.callouts) ? im.callouts.filter(c => c && typeof c.dotXf === 'number' && typeof c.dotYf === 'number') : [];
            if (callouts.length) drawCallouts(pres, slide, callouts, fit, theme);
            y += baseEachH + 0.1;
          });
        }
        // ── Render video ─────────────────────────────────────────────────────
        if (video) {
          // Compute a video sub-region. If images already occupy the media slot, stack the video below them.
          let vReg;
          if (images.length && mediaRegion) {
            // Reserve the bottom 1.5" of the media region for the video
            vReg = { x: mediaRegion.x, y: mediaRegion.y + mediaRegion.h - 1.5, w: mediaRegion.w, h: 1.5 };
          } else {
            // No images — use the video's own placement to choose a region
            const vp = videoPlace;
            if (vp === 'right') vReg = { x: 7.0, y: contentY, w: 5.7, h: 4.5 };
            else if (vp === 'left') vReg = { x: 0.5, y: contentY, w: 5.7, h: 4.5 };
            else if (vp === 'top') vReg = { x: 0.7, y: contentY, w: 12.1, h: 2.5 };
            else if (vp === 'bottom') vReg = { x: 0.7, y: contentY + (hasText ? 2.2 : 0), w: 12.1, h: hasText ? 2.7 : 4.8 };
            else if (vp === 'full') vReg = { x: 0.5, y: contentY, w: 12.3, h: 4.8 };
            else vReg = { x: 7.0, y: contentY + 3.0, w: 5.7, h: 1.8 };
          }
          // Scale the video the same way as images, clamped to the region
          const vScale = ({ small: 0.30, medium: 0.60, large: 1.00, xlarge: 1.30 }[(video.size || 'large')]) || 1.0;
          const vW = Math.min(vReg.w * vScale, vReg.w);
          const vH = Math.min(vReg.h * vScale, vReg.h * 1.3);
          const vX = vReg.x + (vReg.w - vW) / 2;
          const vY = vReg.y + (vReg.h - vH) / 2;
          try {
            const url = String(video.url || '').trim();
            if (/youtube\.com|youtu\.be|vimeo\.com/i.test(url)) {
              slide.addMedia({ type: 'online', link: url, x: vX, y: vY, w: vW, h: vH });
            } else if (/\.(mp4|webm|ogv|mov)(\?.*)?$/i.test(url)) {
              slide.addMedia({ type: 'video', link: url, x: vX, y: vY, w: vW, h: vH });
            } else {
              slide.addText([{ text: '🎬 Open video: ' + url, options: { hyperlink: { url } } }],
                { x: vX, y: vY, w: vW, h: 0.4, fontSize: 12, color: '2563EB', underline: true, fontFace: 'Calibri' });
            }
          } catch (mErr) {
            slide.addText([{ text: '🎬 ' + (video.url || ''), options: { hyperlink: { url: video.url || '' } } }],
              { x: vX, y: vY, w: vW, h: 0.4, fontSize: 12, color: '2563EB', underline: true, fontFace: 'Calibri' });
          }
        }
      }

      // Speaker notes — trainer-facing guidance, never visible on the slide
      // Translated notes (if any) appended after the original separated by a marker line
      const baseNotes = String(s.notes || '');
      const transNotes = tr && tr.notes ? String(tr.notes) : '';
      const allNotes = transNotes ? (baseNotes + (baseNotes ? '\n\n──── ' + (tr.lang || 'Translation') + ' ────\n' : '') + transNotes) : baseNotes;
      if (allNotes) slide.addNotes(allNotes);
    });

    // Generate to buffer
    const nodeBuf = await pres.write({ outputType: 'nodebuffer' });

    if (wantSave) {
      let baseName = (deck.title || 'Training Deck').replace(/[<>:"/\\|?*]+/g, '').trim() || 'Training Deck';
      // Tag the output language on the filename when it's a single-language build.
      if (outputLangLabel && !new RegExp('\\b' + outputLangLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(baseName)) baseName += ` (${outputLangLabel})`;
      const fileName = `${baseName}.pptx`;
      const stored   = crypto.randomBytes(16).toString('hex') + '.pptx';
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), nodeBuf);
      const description = `AI-generated (template: ${req.body.template || 'custom'}) — ${(deck.slides || []).length} slides.`;
      // Destination — defaults to the PowerPoint library but the user can route to other folders
      let folder = String(req.body.destination || 'powerpoints').trim();
      const ALLOWED = ['powerpoints', 'library', 'training-standards', 'training-material'];
      if (!ALLOWED.includes(folder)) folder = 'powerpoints';
      let finalCategory = category; // default category from the build request
      if (folder === 'training-material') {
        const cat = String(req.body.materialCategory || '').trim();
        if (!cat) return res.status(400).json({ error: 'Pick or enter a Training Material category (e.g. CAT777, Haul Truck Training Material).' });
        await dbRun('INSERT OR IGNORE INTO tblTrainMatCat (Name) VALUES (?)', [cat]);
        finalCategory = cat;
      }
      // Persist the deck JSON in StructuredData so the user can re-open and edit/preview later.
      // Add a __theme marker so reopen restores the same brand theme used at build time.
      const deckSnapshot = Object.assign({}, deck, { __theme: req.body.theme || 'modern-navy', __template: req.body.template || null });
      const structuredJson = JSON.stringify(deckSnapshot);
      const r = await dbRun(
        `INSERT INTO tblFiles (EntityType, EntityID, FileName, StoredName, MimeType, FileSize, Category, Description, UploadedBy, Approved, Folder, StructuredData)
         VALUES ('powerpoint', 0, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [fileName, stored, PPTX_MIME, nodeBuf.length, finalCategory, description, req.session.user.username, folder, structuredJson]);
      try { await recordLegacyAudit(req.session.user.username, 'tblFiles', 'PPTX_BUILD', r.lastID, folder, null, fileName); } catch {}
      const destLabel = folder === 'training-standards' ? 'Training Standards'
        : folder === 'training-material' ? `Training Material → ${finalCategory}`
        : folder === 'library' ? 'Document Library'
        : 'Training PowerPoint Library';
      return res.json({ success: true, fileId: r.lastID, fileName, slideCount: (deck.slides || []).length, size: nodeBuf.length, folder, category: finalCategory, destLabel });
    }
    // Streaming download path (no save)
    res.setHeader('Content-Type', PPTX_MIME);
    res.setHeader('Content-Disposition', 'attachment; filename="' + ((deck.title || 'Training Deck').replace(/"/g, '') + (outputLangLabel ? ' (' + outputLangLabel + ')' : '') + '.pptx') + '"');
    res.send(nodeBuf);
  } catch (e) {
    res.status(500).json({ error: 'Build failed: ' + (e && e.message ? e.message : String(e)) });
  }
});

// ── Fetch a saved deck's editable JSON ──────────────────────────────────────
// Used by the Edit / Preview buttons in the library list — returns the stored deck snapshot
// (slides + theme + template) so the front-end can re-open the editor on a previously saved file.
router.get('/:id/deck', async (req, res) => {
  try {
    const f = await dbGet(`SELECT FileID, FileName, Category, StructuredData FROM tblFiles WHERE FileID=? AND Folder='powerpoints'`, [req.params.id]);
    if (!f) return res.status(404).json({ error: 'PowerPoint not found.' });
    if (!f.StructuredData) return res.status(409).json({ error: 'No editable deck data — this file was uploaded directly (not built via AI), so the slide content isn\'t recoverable. Download the .pptx instead.' });
    let deck;
    try { deck = JSON.parse(f.StructuredData); }
    catch { return res.status(500).json({ error: 'Stored deck data is malformed.' }); }
    res.json({ success: true, fileId: f.FileID, fileName: f.FileName, category: f.Category, deck });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
