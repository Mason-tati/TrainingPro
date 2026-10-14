// ─────────────────────────────────────────────────────────────────────────────
// "Generate Image from Page Content" — shared backend service.
//
//   content ──Claude──> scene prompt (NO text in image)
//           ──moderation──> gpt-image-1 ──> artwork
//           ──Sharp──> caption overlay ──> final image ──> store
//
// Two regeneration paths:
//   • SCENE   change  → new gpt-image-1 call  (counts against the daily limit)
//   • CAPTION change  → overlay only, reuses the stored artwork (free, instant)
//
// All API keys are read server-side from env (falling back to tblConfig).
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const sharp = require('sharp');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, requirePermission, tenantOf } = require('./auth');
const aiGateway = require('../lib/ai-gateway');
const cfg = require('../lib/imagegen-config');
const { overlayCaption, overlayLogo, findClearBand } = require('../lib/imagetext');
const { brandPpe } = require('../lib/imagebrand');

// The caption is auto-placed into the empty area the artwork actually provides (usually the
// speech bubble), so it can never print over faces, hard hats or equipment. When the artwork
// leaves too little room the caption is shrunk to fit — warn so the user can regenerate.
async function placementNote(artwork) {
  try {
    const band = await findClearBand(artwork);
    if (!band) return 'No clear space was found in the artwork, so the caption used its default position — regenerate for a cleaner layout.';
    if (band.heightPct < 9 || band.widthPct < 35) return 'The artwork left only a small clear area (the speech bubble looks cropped), so the caption was reduced to fit inside it — regenerate for larger text.';
    return '';
  } catch { return ''; }
}
const store = require('../lib/imagestore');

router.use(requireAuth);

// ── Keys (server-side only) ──────────────────────────────────────────────────
async function openaiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  return await require('../lib/secret-config').readSecretConfig(dbGet, 'openai_api_key'); // R7 — decrypt-at-rest
}
let _openai = null;
async function openai() {
  const key = await openaiKey();
  if (!key) {
    const e = new Error('OpenAI API key not configured. Add OPENAI_API_KEY to the environment (or set "openai_api_key" under Admin → Settings) to enable image generation.');
    e.status = 400; throw e;
  }
  if (!_openai || _openai.__key !== key) {
    const OpenAI = require('openai');
    _openai = new OpenAI({ apiKey: key });
    _openai.__key = key;
  }
  return _openai;
}

// ── Logging / daily limit ────────────────────────────────────────────────────
let _tableReady = null;
function ensureTable() {
  if (!_tableReady) _tableReady = dbRun(`CREATE TABLE IF NOT EXISTS tblImageGen (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    UserName TEXT, PageId TEXT, Lang TEXT, Kind TEXT, Attempt INTEGER,
    Prompt TEXT, Success INTEGER, Error TEXT, FileId INTEGER, ArtworkFileId INTEGER,
    TenantID INTEGER DEFAULT 1,
    CreatedAt TEXT DEFAULT (datetime('now'))
  )`, []).then(() => dbRun("ALTER TABLE tblImageGen ADD COLUMN TenantID INTEGER DEFAULT 1", []).catch(() => {}));
  return _tableReady;
}
async function logGen(row) {
  try {
    await ensureTable();
    await dbRun(`INSERT INTO tblImageGen (UserName,PageId,Lang,Kind,Attempt,Prompt,Success,Error,FileId,ArtworkFileId,TenantID)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [row.user || '', row.pageId || '', row.lang || '', row.kind || '', row.attempt || 1,
       String(row.prompt || '').slice(0, 4000), row.success ? 1 : 0, row.error ? String(row.error).slice(0, 500) : null,
       row.fileId || null, row.artworkFileId || null, row.tenantId || 1]);
  } catch { /* logging must never break a generation */ }
}
// Only SCENE generations count against the limit.
async function scenesToday(user) {
  await ensureTable();
  const r = await dbGet(
    `SELECT COUNT(*) n FROM tblImageGen WHERE UserName=? AND Kind='scene' AND Success=1 AND date(CreatedAt)=date('now')`, [user]);
  return (r && r.n) || 0;
}

const localeByCode = code => cfg.LOCALES.find(l => l.code === code) || cfg.LOCALES[0];
const fontsFor = (code, bold) => { const L = localeByCode(code); return bold ? L.fonts.bold : L.fonts.regular; };
// Style preset → the style text prepended to every prompt (defaults to the house style).
async function systemLogo() {
  const row = await dbGet("SELECT cvalue FROM tblConfig WHERE ckey='company_logo'", []);
  return (row && row.cvalue) ? row.cvalue : null;
}
const styleFor = key => ((cfg.STYLE_PRESETS || []).find(s => s.key === key) || {}).style || cfg.HOUSE_STYLE;

// Which artwork engine is actually usable right now.
//   'openai'     → gpt-image-1 (forced, or 'auto' with a key configured)
//   'claude-svg' → Claude vector illustration on the existing Anthropic key
async function activeEngine() {
  const want = cfg.IMAGE.engine || 'auto';
  if (want === 'claude-svg') return 'claude-svg';
  if (want === 'openai') return 'openai';                    // forced — openai() errors clearly if no key
  return (await openaiKey()) ? 'openai' : 'claude-svg';      // auto
}

// ── Artwork engine A (default): Claude → flat vector SVG → Sharp rasterises ──
// Uses the EXISTING Anthropic key. The model draws shapes only — never text — and
// leaves the top third clear for the caption we composite afterwards.
async function claudeSvgArtwork(scenePrompt, L, style) {
  const W = cfg.IMAGE.width, H = cfg.IMAGE.height;
  const ask = async () => {
    const msg = await aiGateway.complete({
      provider: 'anthropic', agent: 'AI-IMG-001', operation: 'generate_scene_svg',
      model: 'claude-sonnet-4-6', max_tokens: 16000,
      system: 'You are a vector illustrator. You output ONLY one complete, self-contained <svg>…</svg> element — no prose, no markdown, nothing else.',
      messages: [{ role: 'user', content:
        `Draw a clean FLAT-STYLE vector illustration for a mining / industrial training page.\n\n` +
        `SCENE: ${scenePrompt}\n\nHOUSE STYLE: ${style || cfg.HOUSE_STYLE}\nPEOPLE: ${L.peopleDescriptor}\n\n` +
        `Requirements:\n` +
        `- Return ONLY one COMPLETE <svg>…</svg> element (it MUST include the closing </svg>). No markdown, no commentary, no <image> tags, no external or raster references.\n` +
        `- Include viewBox="0 0 ${W} ${H}" width="${W}" height="${H}".\n` +
        `- Solid white background. Leave the TOP THIRD as clean empty white space — a caption is composited there afterwards.\n` +
        `- Absolutely NO <text> elements and NO lettering, numerals or signage anywhere.\n` +
        `- Bold, simple, readable shapes. Hi-vis yellow #FBC02D and navy #1E3A5F with greys/white.\n` +
        `- Draw recognisable people (correct PPE: white hard hat, safety glasses, hi-vis) and equipment.` }],
    });
    const t = ((msg.content.find(b => b.type === 'text') || {}).text || '').replace(/```svg|```xml|```/gi, '').trim();
    const m = t.match(/<svg[\s\S]*<\/svg>/i);
    return m ? m[0] : null;
  };
  let svg = await ask();
  if (!svg) svg = await ask();                      // one retry — the model occasionally adds prose
  if (!svg) { const e = new Error('The illustration could not be generated. Try simplifying the prompt.'); e.status = 502; throw e; }
  svg = svg.replace(/<text[\s\S]*?<\/text>/gi, '')  // belt-and-braces: strip any text it sneaked in
           .replace(/<image[\s\S]*?>/gi, '');
  return await sharp(Buffer.from(svg), { density: 150 })
    .resize(W, H, { fit: 'contain', background: '#ffffff' })
    .flatten({ background: '#ffffff' }).png().toBuffer();
}

// ── Artwork engine B (optional): gpt-image-1, only when an OpenAI key exists ──
async function openaiArtwork(scenePrompt, L, style) {
  const client = await openai();
  const full = `${style || cfg.HOUSE_STYLE}\n\nPEOPLE: ${L.peopleDescriptor}\n\n${scenePrompt}\n\n${cfg.NO_TEXT_RULE}`;
  const gen = await client.images.generate({ model: cfg.IMAGE.model, prompt: full, size: cfg.IMAGE.size, n: 1 });
  const d = (gen && gen.data && gen.data[0]) || {};
  if (d.b64_json) return Buffer.from(d.b64_json, 'base64');
  if (d.url) { const r = await fetch(d.url); return Buffer.from(await r.arrayBuffer()); }
  throw new Error('The image service returned no image data.');
}

// ── Prompt moderation ────────────────────────────────────────────────────────
// Uses OpenAI's moderation endpoint when a key is present, otherwise Claude (the
// API already configured here) as a workplace-appropriateness classifier.
async function moderatePrompt(text) {
  if (await openaiKey()) {
    try {
      const client = await openai();
      const mod = await client.moderations.create({ model: 'omni-moderation-latest', input: String(text) });
      if (mod && mod.results && mod.results[0] && mod.results[0].flagged) return { allowed: false, reason: 'flagged by moderation' };
      return { allowed: true };
    } catch { /* fall through to Claude */ }
  }
  try {
    const msg = await aiGateway.complete({
      provider: 'anthropic', agent: 'AI-IMG-001', operation: 'moderate_image_prompt',
      model: 'claude-sonnet-4-6', max_tokens: 300,
      system: 'You are a content-safety classifier. Return ONLY JSON: {"allowed":true|false,"reason":"<short>"}',
      messages: [{ role: 'user', content:
        `Is this illustration prompt appropriate for a workplace safety training document at a mining company? ` +
        `Reject sexual, graphic-violent, hateful, political or otherwise non-workplace content. Depicting hazards, ` +
        `PPE and safe work practices IS appropriate.\n\n"""${String(text).slice(0, 3000)}"""` }],
    });
    const j = parseJson(firstText(msg));
    if (j && j.allowed === false) return { allowed: false, reason: j.reason || 'not workplace-appropriate' };
    return { allowed: true };
  } catch { return { allowed: true }; }   // classifier unavailable → do not block the user
}

// ── Claude helpers ───────────────────────────────────────────────────────────
function firstText(msg) { return ((msg.content || []).find(b => b.type === 'text') || {}).text || ''; }
function parseJson(raw) {
  const cleaned = String(raw || '').replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// ── GET /config — locales, default caption, limit + remaining ────────────────
router.get('/config', async (req, res) => {
  try {
    const user = req.session.user.username;
    const used = await scenesToday(user);
    res.json({
      locales: cfg.LOCALES.map(l => ({ code: l.code, label: l.label, sampleCaption: l.sampleCaption })),
      defaultCaption: cfg.DEFAULT_CAPTION,
      houseStyle: cfg.HOUSE_STYLE,
      stylePresets: (cfg.STYLE_PRESETS||[]).map(s2=>({key:s2.key,label:s2.label})),
      dailyLimit: cfg.DAILY_SCENE_LIMIT,
      used, remaining: Math.max(0, cfg.DAILY_SCENE_LIMIT - used),
      engine: await activeEngine(),          // 'claude-svg' (existing Anthropic key) | 'openai'
      keyConfigured: true,                   // claude-svg needs no extra key
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /prompt — page content → scene prompt (no text in image) ────────────
// §16 — image PURPOSE guidance per learning profile (the image adapts to the audience).
const PROFILE_IMG = {
  L1: 'AUDIENCE — Level 1 operator (low literacy): favour a SIMPLE, uncluttered visual showing ONE clear action or step, with strong focus on the correct PPE and any hazard. Minimal background detail. Where relevant, a clear correct-way depiction. Easy to understand at a glance.',
  L2: 'AUDIENCE — standard workforce: a clear, realistic depiction of the task being performed correctly.',
  L3: 'AUDIENCE — supervisor / leader: show a supervisory moment — a supervisor observing, verifying or checking correct practice, or a decision/verification point in the task.',
  L4: 'AUDIENCE — technical / advanced: favour a precise technical depiction — the equipment and its key components and relationships, or an inspection / diagnostic focus. Still NO text, labels or numerals in the image.',
};

router.post('/prompt', requirePermission('ai.use'), async (req, res) => {
  try {
    const { content, locale, styleKey, learningProfile } = req.body || {};
    const c = content || {};
    const L = localeByCode(locale);
    const keyPoints = Array.isArray(c.keyPoints) ? c.keyPoints.filter(Boolean) : [];
    const brief = [
      c.title ? `TITLE: ${c.title}` : '',
      c.body ? `CONTENT: ${String(c.body).slice(0, 4000)}` : '',
      keyPoints.length ? `KEY POINTS:\n- ${keyPoints.slice(0, 12).join('\n- ')}` : '',
    ].filter(Boolean).join('\n\n');
    if (!brief.trim()) return res.status(400).json({ error: 'No page content to illustrate.' });

    const msg = await aiGateway.complete({
      provider: 'anthropic', agent: 'AI-IMG-001', operation: 'image_prompt',
      model: 'claude-sonnet-4-6', max_tokens: 1200,
      system: 'You write prompts for an illustration model that will draw a workplace-training scene. ' +
        'Return ONLY JSON: {"prompt":"<one paragraph>"} — no markdown, no commentary.',
      messages: [{ role: 'user', content:
        `Write ONE image-generation prompt describing the SCENE ONLY for the training content below.\n\n` +
        `HOUSE STYLE (must be reflected): ${styleFor(styleKey)}\n` +
        `PEOPLE: ${L.peopleDescriptor}\n` +
        `UNIFORM (must be reflected): the worker wears the company uniform — a high-visibility YELLOW long-sleeve work shirt with navy-blue lower sleeves and collar and silver-grey reflective stripes, navy-blue work trousers, a white hard hat, clear safety glasses and work gloves.\n` +
        `HOW MANY & FRAMING (important): ${cfg.SCENE.people} ${cfg.SCENE.framing}\n` +
        (PROFILE_IMG[learningProfile] ? `${PROFILE_IMG[learningProfile]}\n` : '') +
        `${cfg.NO_TEXT_RULE}\n\n` +
        `Rules: describe setting, the single worker, action, PPE, camera framing and mood. Default to ONE worker ` +
        `framed large and close (waist-up), not a group — only describe more than one person if the content truly ` +
        `needs it. Depict SAFE, correct workplace behaviour. Keep it workplace-appropriate. Do NOT describe any ` +
        `words, letters or signage. Do NOT mention the caption. One paragraph, under 130 words.\n\n${brief}` }],
    });
    const j = parseJson(firstText(msg));
    const prompt = (j && j.prompt) ? String(j.prompt).trim() : firstText(msg).trim();
    if (!prompt) return res.status(502).json({ error: 'Could not build an image prompt. Try again.' });
    res.json({ prompt, locale: L.code, peopleDescriptor: L.peopleDescriptor });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── POST /revise — edit the existing prompt per a plain-language instruction ──
// Also classifies the change: "scene" (needs new artwork) vs "caption" (overlay only).
router.post('/revise', requirePermission('ai.use'), async (req, res) => {
  try {
    const { prompt, instruction, caption } = req.body || {};
    if (!prompt || !instruction) return res.status(400).json({ error: 'prompt and instruction are required.' });
    const msg = await aiGateway.complete({
      provider: 'anthropic', agent: 'AI-IMG-001', operation: 'image_prompt_revise',
      model: 'claude-sonnet-4-6', max_tokens: 1400,
      system: 'You revise image-generation prompts and classify change requests. Return ONLY JSON.',
      messages: [{ role: 'user', content:
        `Here is the CURRENT image prompt:\n"""${prompt}"""\n\n` +
        `The current CAPTION settings (text drawn on top afterwards, NOT part of the artwork):\n` +
        `${JSON.stringify(caption || cfg.DEFAULT_CAPTION)}\n\n` +
        `The user asks: "${instruction}"\n\n` +
        `Decide if this changes the ARTWORK/SCENE (people, PPE, background, composition, framing) or ONLY the ` +
        `CAPTION (wording, font size, colour, position, alignment).\n\n` +
        `Return ONLY JSON:\n` +
        `{"kind":"scene"|"caption","prompt":"<the FULL revised scene prompt — EDIT the current one to reflect the ` +
        `change, keep everything else identical; if kind is caption return the current prompt unchanged>",` +
        `"caption":{ optional — ONLY the caption fields that change: "color","align","yPct","sizeScale",` +
        `"lines":[{"locale":"th|en","text":"..."}] },"note":"<one short sentence describing what you changed>"}\n\n` +
        `${cfg.NO_TEXT_RULE}` }],
    });
    const j = parseJson(firstText(msg));
    if (!j || !j.prompt) return res.status(502).json({ error: 'Could not revise the prompt. Try rephrasing.' });
    res.json({
      kind: j.kind === 'caption' ? 'caption' : 'scene',
      prompt: String(j.prompt).trim(),
      caption: j.caption || null,
      note: j.note || '',
    });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── POST /generate — moderation → gpt-image-1 → caption overlay → store ──────
router.post('/generate', requirePermission('ai.use'), async (req, res) => {
  const user = req.session.user.username;
  const { prompt, caption, locale, pageId, attempt, styleKey } = req.body || {};
  const L = localeByCode(locale);
  try {
    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'A prompt is required.' });

    // Daily limit (scene generations only)
    const used = await scenesToday(user);
    if (used >= cfg.DAILY_SCENE_LIMIT) {
      return res.status(429).json({
        error: `Daily image limit reached (${cfg.DAILY_SCENE_LIMIT} per day). Caption-only changes are still free — ` +
               `edit the caption instead, or try again tomorrow.`, remaining: 0 });
    }

    // Moderation on the FINAL prompt before generating
    const mod = await moderatePrompt(prompt);
    if (!mod.allowed) {
      await logGen({ user, pageId, lang: L.code, kind: 'scene', attempt, prompt, success: 0, error: 'moderation:' + (mod.reason || '') });
      return res.status(400).json({ error: `That prompt was flagged as not workplace-appropriate (${mod.reason}). Please rephrase it.` });
    }

    // Artwork — the model draws the SCENE only; the caption is composited afterwards.
    let engine = await activeEngine();
    let engineNote = '', artwork;
    if (engine === 'openai') {
      try {
        artwork = await openaiArtwork(String(prompt).trim(), L, styleFor(styleKey));
      } catch (err) {
        // gpt-image-1 unavailable (billing limit, quota, outage). Unless the engine was explicitly
        // forced to 'openai', fall back to the Anthropic engine so the user still gets an image.
        if (cfg.IMAGE.engine === 'openai') throw err;
        engineNote = `gpt-image-1 unavailable (${err.message || 'error'}) — used the Claude illustration engine instead.`;
        engine = 'claude-svg';
        artwork = await claudeSvgArtwork(String(prompt).trim(), L, styleFor(styleKey));
      }
    } else {
      artwork = await claudeSvgArtwork(String(prompt).trim(), L, styleFor(styleKey));
    }

    const logo = await systemLogo();

    // Print the REAL logo on the hard hats and shirts. Done to the ARTWORK (before the
    // caption) and stored that way, so caption-only changes reuse the branded artwork
    // instead of paying for another vision call — and the branding stays identical
    // across every attempt.
    const branded = await brandPpe(artwork, logo, cfg.LOGO || {});
    artwork = branded.buffer;
    const ppeMarks = branded.marks.length;

    // Store the artwork so caption-only changes never re-generate it
    const art = await store.saveImage(artwork, { fileName: `artwork-${Date.now()}.png`, user, description: 'AI artwork (no caption)' });

    // Composite the caption
    const cap = caption || cfg.DEFAULT_CAPTION;
    let finalBuf = await overlayCaption(artwork, cap, fontsFor);
    finalBuf = await overlayLogo(finalBuf, logo, cfg.LOGO || {});
    const fin = await store.saveImage(finalBuf, { fileName: `illustration-${Date.now()}.png`, user, description: 'AI illustration with caption' });

    await logGen({ user, pageId, lang: L.code, kind: 'scene', attempt, prompt, success: 1, fileId: fin.fileId, artworkFileId: art.fileId });

    res.json({
      kind: 'scene', engine, engineNote, ppeMarks,
      captionNote: await placementNote(artwork),
      artworkFileId: art.fileId,
      fileId: fin.fileId,
      url: fin.url,
      dataUrl: 'data:image/png;base64,' + finalBuf.toString('base64'),
      remaining: Math.max(0, cfg.DAILY_SCENE_LIMIT - (used + 1)),
    });
  } catch (e) {
    await logGen({ user, pageId, lang: L.code, kind: 'scene', attempt, prompt, success: 0, error: e.message });
    res.status(e.status || 500).json({ error: 'Image generation failed: ' + e.message });
  }
});

// ── POST /artwork — generate a branded SCENE with NO caption (for slide / document images) ──
// Same pipeline as /generate: moderation → gpt-image-1 (→ Claude fallback) → brand the REAL company
// logo onto the hard hats & shirts → corner logo. Returns the image data URL. No caption overlay.
router.post('/artwork', requirePermission('ai.use'), async (req, res) => {
  const user = req.session.user.username;
  const { prompt, locale, pageId, styleKey } = req.body || {};
  const L = localeByCode(locale);
  try {
    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'A prompt is required.' });
    const used = await scenesToday(user);
    if (used >= cfg.DAILY_SCENE_LIMIT) return res.status(429).json({ error: `Daily image limit reached (${cfg.DAILY_SCENE_LIMIT} per day). Try again tomorrow.`, remaining: 0 });
    // Optional REFERENCE image — describe it (vision) and fold it into the prompt to guide the picture.
    let finalPrompt = String(prompt).trim();
    const refM = typeof req.body.refImage === 'string' ? /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(req.body.refImage) : null;
    if (refM) {
      try {
        const aiGateway = require('../lib/ai-gateway');
        const dmsg = await aiGateway.complete({ provider: 'anthropic', agent: 'AI-DOC-003', operation: 'describe_ref_image', model: 'claude-sonnet-4-6', max_tokens: 600,
          messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: refM[1].toLowerCase(), data: refM[2] } }, { type: 'text', text: 'Describe this reference image in 2–3 sentences for an illustrator: the subject, equipment, setting, composition and colours. Be concrete.' }] }] });
        const desc = (dmsg.content.find(b => b.type === 'text') || {}).text || '';
        if (desc.trim()) finalPrompt += `\n\nUSE THIS REFERENCE for the subject and scene (match its equipment, setting, layout and composition where relevant): ${desc.trim()}`;
      } catch { /* reference is best-effort — fall back to the text prompt */ }
    }
    const mod = await moderatePrompt(finalPrompt);
    if (!mod.allowed) { await logGen({ user, pageId, lang: L.code, kind: 'scene', prompt: finalPrompt, success: 0, error: 'moderation:' + (mod.reason || '') }); return res.status(400).json({ error: `That prompt was flagged as not workplace-appropriate (${mod.reason}). Please rephrase it.` }); }
    let engine = await activeEngine();
    let engineNote = '', artwork;
    if (engine === 'openai') {
      try { artwork = await openaiArtwork(finalPrompt, L, styleFor(styleKey)); }
      catch (err) {
        if (cfg.IMAGE.engine === 'openai') throw err;
        engineNote = `gpt-image-1 unavailable (${err.message || 'error'}) — used the Claude illustration engine instead.`;
        engine = 'claude-svg';
        artwork = await claudeSvgArtwork(finalPrompt, L, styleFor(styleKey));
      }
    } else {
      artwork = await claudeSvgArtwork(finalPrompt, L, styleFor(styleKey));
    }
    const logo = await systemLogo();
    // Print the REAL company logo on the hard hats & shirts in the artwork, then add the corner logo.
    const branded = await brandPpe(artwork, logo, cfg.LOGO || {});
    let finalBuf = await overlayLogo(branded.buffer, logo, cfg.LOGO || {});
    const fin = await store.saveImage(finalBuf, { fileName: `slide-image-${Date.now()}.png`, user, description: 'AI slide image (branded, no caption)' });
    await logGen({ user, pageId, lang: L.code, kind: 'scene', prompt, success: 1, fileId: fin.fileId });
    res.json({
      engine, engineNote, ppeMarks: branded.marks.length,
      fileId: fin.fileId, url: fin.url,
      dataUrl: 'data:image/png;base64,' + finalBuf.toString('base64'),
      remaining: Math.max(0, cfg.DAILY_SCENE_LIMIT - (used + 1)),
    });
  } catch (e) {
    await logGen({ user, pageId, lang: L.code, kind: 'scene', prompt, success: 0, error: e.message });
    res.status(e.status || 500).json({ error: 'Image generation failed: ' + e.message });
  }
});

// ── POST /recaption — overlay only (no new artwork, no limit cost) ───────────
router.post('/recaption', requirePermission('ai.use'), async (req, res) => {
  const user = req.session.user.username;
  const { artworkFileId, caption, locale, pageId, attempt } = req.body || {};
  try {
    if (!artworkFileId) return res.status(400).json({ error: 'artworkFileId is required.' });
    const f = await dbGet('SELECT FileID, StoredName FROM tblFiles WHERE FileID=?', [artworkFileId]);
    if (!f) return res.status(404).json({ error: 'Original artwork not found — generate a new image.' });

    const artwork = store.readImage(f.StoredName);
    let finalBuf = await overlayCaption(artwork, caption || cfg.DEFAULT_CAPTION, fontsFor);
    finalBuf = await overlayLogo(finalBuf, await systemLogo(), cfg.LOGO || {});
    const fin = await store.saveImage(finalBuf, { fileName: `illustration-${Date.now()}.png`, user, description: 'AI illustration with caption' });

    await logGen({ user, pageId, lang: (localeByCode(locale)).code, kind: 'caption', attempt, prompt: '(caption overlay)', success: 1, fileId: fin.fileId, artworkFileId });
    res.json({ kind: 'caption', captionNote: await placementNote(artwork), artworkFileId, fileId: fin.fileId, url: fin.url, dataUrl: 'data:image/png;base64,' + finalBuf.toString('base64') });
  } catch (e) {
    await logGen({ user, pageId, lang: locale || '', kind: 'caption', attempt, prompt: '(caption overlay)', success: 0, error: e.message });
    res.status(500).json({ error: 'Caption overlay failed: ' + e.message });
  }
});

module.exports = router;
