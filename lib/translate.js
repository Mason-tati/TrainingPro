const AdmZip = require('adm-zip');
// WP-10 A6.1 — AI calls go through the central AI Gateway (audit + policy +
// provider registry) instead of the Anthropic SDK directly. Prompts, models,
// max_tokens, message shapes and response handling are byte-identical.
const aiGateway = require('./ai-gateway');

// Target languages offered in the workspace (Thai first, plus common operational languages).
const LANGUAGES = [
  { code: 'th', name: 'Thai' },
  { code: 'fr', name: 'French' },
  { code: 'es', name: 'Spanish' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'mg', name: 'Malagasy' },
  { code: 'zh', name: 'Chinese (Simplified)' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'tl', name: 'Filipino (Tagalog)' },
  { code: 'ar', name: 'Arabic' },
  { code: 'ru', name: 'Russian' },
  { code: 'hi', name: 'Hindi' },
  { code: 'de', name: 'German' },
  { code: 'ja', name: 'Japanese' }
];

function decodeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}
function encodeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Only translate runs that contain real words (skip numbers, codes, punctuation-only).
const isTranslatable = t => !!t && t.trim().length > 0 && /[A-Za-zÀ-ɏ]/.test(t);

// Translate unique source strings -> { source: translation }.
// opts: { tmMap (approved translation memory, reused directly), glossary ([{SourceTerm,TargetTerm}], enforced via prompt), onProgress }
// Returns { map, tmHits, aiCount }.
async function translateSegments(segments, langName, opts = {}) {
  const tmMap = opts.tmMap || {};
  const glossary = opts.glossary || [];
  const onProgress = opts.onProgress;
  const map = {};
  let tmHits = 0;

  // 1) Reuse approved Translation Memory — skip these from the AI call entirely.
  const toTranslate = [];
  for (const s of segments) {
    if (tmMap[s] != null) { map[s] = tmMap[s]; tmHits++; }
    else toTranslate.push(s);
  }

  // 2) Build the terminology instruction (soft enforcement via the prompt).
  const glossaryBlock = glossary.length
    ? `\nAlways use these EXACT approved translations for these terms wherever they appear:\n` +
      glossary.slice(0, 200).map(g => `- "${g.SourceTerm}" => "${g.TargetTerm}"`).join('\n') + '\n'
    : '';

  const BATCH = 40;
  let aiCount = 0;
  for (let i = 0; i < toTranslate.length; i += BATCH) {
    const chunk = toTranslate.slice(i, i + BATCH);
    const prompt = `You are a professional translator for industrial / mining operational documents.
Translate each string in this JSON array into ${langName}.
Rules:
- Return ONLY a JSON array of the SAME length and SAME order, with each string translated.
- Keep numbers, measurements, units, equipment codes and proper nouns unchanged.
- Preserve any leading/trailing spaces.
- Do not add notes, explanations, or markdown.${glossaryBlock}
Array:
${JSON.stringify(chunk)}`;
    const msg = await aiGateway.complete({
      provider: 'anthropic',
      agent: 'AI-DOC-002',
      operation: 'translate_segments',
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw = (msg.content.find(b => b.type === 'text') || {}).text || '';
    const jsonStr = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    let arr; try { arr = JSON.parse(jsonStr); } catch { arr = null; }
    if (Array.isArray(arr)) chunk.forEach((s, j) => { if (arr[j] != null) { map[s] = String(arr[j]); aiCount++; } });
    if (onProgress) onProgress(Math.min(i + BATCH, toTranslate.length), toTranslate.length);
  }
  return { map, tmHits, aiCount };
}

// Replace the <w:t> run text inside one paragraph string using the translation map.
function translateRunsInString(s, map, onReplace) {
  return s.replace(/(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g, (f, o, i, c) => {
    const t = map[decodeXml(i)];
    if (t) { if (onReplace) onReplace(); return o + encodeXml(t) + c; }
    return f;
  });
}

// Bilingual output: for each TOP-LEVEL paragraph that has translatable text, append a translated copy.
// A depth-aware scanner pairs <w:p>/</w:p> correctly so nested paragraphs (text boxes) never split a
// match — which previously corrupted the document. Paragraphs containing media are translated in place
// (not duplicated) so images aren't doubled.
function bilingualizeDocXml(xml, map) {
  const tagRe = /<w:p\b[^>]*\/>|<w:p\b[^>]*>|<\/w:p>/g;
  let out = '', lastIndex = 0, depth = 0, paraStart = -1, replaced = 0, m;
  while ((m = tagRe.exec(xml))) {
    const tag = m[0];
    if (tag.startsWith('<w:p') && tag.endsWith('/>')) continue;   // self-closing paragraph: no content, depth unchanged
    if (tag === '</w:p>') {
      depth--;
      if (depth === 0 && paraStart >= 0) {
        const end = m.index + tag.length;
        const para = xml.slice(paraStart, end);
        out += xml.slice(lastIndex, paraStart);
        let hasText = false;
        para.replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, (f, i) => { if (map[decodeXml(i)] != null) hasText = true; return f; });
        if (!hasText) {
          out += para;
        } else if (/<w:drawing|<w:object|<w:pict|<mc:AlternateContent/.test(para)) {
          out += translateRunsInString(para, map, () => replaced++);   // media paragraph -> translate in place
        } else {
          out += para + translateRunsInString(para, map, () => replaced++);   // original + translated copy
        }
        lastIndex = end; paraStart = -1;
      }
    } else {                                  // opening <w:p ...>
      if (depth === 0) paraStart = m.index;
      depth++;
    }
  }
  out += xml.slice(lastIndex);
  return { xml: out, replaced };
}

// Translate a .docx buffer in place (text runs only) so layout is preserved by construction.
// mode: 'target' (replace) or 'bilingual' (original paragraph followed by a translated copy).
async function translateDocx(buf, langName, mode, opts = {}) {
  const zip = new AdmZip(buf);
  const parts = zip.getEntries()
    .map(e => e.entryName)
    .filter(n => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n));
  if (!parts.length) throw new Error('Not a valid Word document (no word/document.xml).');

  const partXml = {};
  const segSet = new Set();
  for (const name of parts) {
    const xml = zip.readAsText(name);
    partXml[name] = xml;
    xml.replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g, (f, inner) => {
      const t = decodeXml(inner);
      if (isTranslatable(t)) segSet.add(t);
      return f;
    });
  }
  const segments = [...segSet];
  if (!segments.length) throw new Error('No translatable text found in the document.');

  const { map, tmHits } = await translateSegments(segments, langName, opts);

  let replaced = 0;
  for (const name of parts) {
    let xml = partXml[name];
    if (mode === 'bilingual') {
      const r = bilingualizeDocXml(xml, map);
      xml = r.xml; replaced += r.replaced;
    } else {
      xml = xml.replace(/(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g, (f, o, i, c) => {
        const t = map[decodeXml(i)];
        if (t) { replaced++; return o + encodeXml(t) + c; }
        return f;
      });
    }
    zip.updateFile(name, Buffer.from(xml, 'utf8'));
  }
  return { buffer: zip.toBuffer(), segments: segments.length, replaced, tmHits, pairs: map };
}

// Generic, structurally-safe in-place translator: replace the text inside <runTag>…</runTag>
// across all zip parts matching partRegex. Used for PPTX (<a:t>) and XLSX (<t>).
// opts.bilingual: keep the original and append " / translation" in the same run —
// structure stays valid in both formats (no new XML nodes needed).
async function translateRunsInZip(buf, partRegex, runTag, langName, opts = {}) {
  const zip = new AdmZip(buf);
  const parts = zip.getEntries().map(e => e.entryName).filter(n => partRegex.test(n));
  if (!parts.length) throw new Error('No translatable content parts found in this file.');
  const openRe = new RegExp(`<${runTag}\\b[^>]*>([\\s\\S]*?)<\\/${runTag}>`, 'g');
  const replRe = new RegExp(`(<${runTag}\\b[^>]*>)([\\s\\S]*?)(<\\/${runTag}>)`, 'g');
  const partXml = {}; const segSet = new Set();
  for (const n of parts) {
    const xml = zip.readAsText(n); partXml[n] = xml;
    xml.replace(openRe, (f, inner) => { const t = decodeXml(inner); if (isTranslatable(t)) segSet.add(t); return f; });
  }
  const segments = [...segSet];
  if (!segments.length) throw new Error('No translatable text found in the document.');
  const { map, tmHits } = await translateSegments(segments, langName, opts);
  let replaced = 0;
  for (const n of parts) {
    const xml = partXml[n].replace(replRe, (f, o, i, c) => {
      const src = decodeXml(i);
      const t = map[src];
      if (t) { replaced++; return o + encodeXml(opts.bilingual ? src + ' / ' + t : t) + c; }
      return f;
    });
    zip.updateFile(n, Buffer.from(xml, 'utf8'));
  }
  return { buffer: zip.toBuffer(), segments: segments.length, replaced, tmHits, pairs: map };
}

// ---- Image OCR + translation via Claude Vision ----
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

// OCR + translate an image or a PDF using Claude's native vision/document reading (no rendering deps).
async function ocrTranslateVisual(buf, mediaType, langName, glossary = []) {
  const isPdf = mediaType === 'application/pdf';
  const glossaryBlock = glossary.length
    ? `\nUse these EXACT approved translations where the terms appear:\n` + glossary.slice(0, 200).map(g => `- "${g.SourceTerm}" => "${g.TargetTerm}"`).join('\n') + '\n'
    : '';
  const prompt = `This ${isPdf ? 'PDF (which may be scanned)' : 'image'} contains text.
1. Read ALL the text${isPdf ? ' across every page' : ''}, in natural reading order.
2. Translate it into ${langName}, keeping numbers, units and equipment codes unchanged.${glossaryBlock}
Return ONLY a JSON object: {"segments":[{"source":"<original line/block>","target":"<translation>"}]} — one entry per line or logical block, in order. No markdown, no commentary.`;
  const visualBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } };
  const msg = await aiGateway.complete({
    provider: 'anthropic',
    agent: 'AI-DOC-002',
    operation: 'ocr_translate_visual',
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    messages: [{ role: 'user', content: [visualBlock, { type: 'text', text: prompt }] }]
  });
  const raw = (msg.content.find(b => b.type === 'text') || {}).text || '';
  const jsonStr = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  let parsed; try { parsed = JSON.parse(jsonStr); } catch { parsed = null; }
  const segs = (parsed && Array.isArray(parsed.segments)) ? parsed.segments.filter(s => s && s.target) : [];
  if (!segs.length) throw new Error('No text could be read from the ' + (isPdf ? 'PDF' : 'image') + '.');
  return segs;
}

// Build a clean .docx from extracted segments (target-only or bilingual original+translation).
function buildDocxFromSegments(segs, bilingual) {
  const paras = segs.map(s => {
    if (bilingual) return `<w:p><w:r><w:t xml:space="preserve">${encodeXml(s.source || '')}</w:t></w:r></w:p>` +
      `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${encodeXml(s.target || '')}</w:t></w:r></w:p>`;
    return `<w:p><w:r><w:t xml:space="preserve">${encodeXml(s.target || '')}</w:t></w:r></w:p>`;
  }).join('');
  const z = new AdmZip();
  z.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'));
  z.addFile('_rels/.rels', Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'));
  z.addFile('word/document.xml', Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`, 'utf8'));
  return z.toBuffer();
}

// Dispatch by file extension. DOCX supports bilingual; PPTX/XLSX in-place; images -> OCR to a .docx.
// opts: { tmMap, glossary, onProgress }. Returns { buffer, segments, replaced, tmHits, pairs, outExt }.
async function translateDocument(buf, ext, langName, mode, opts = {}) {
  ext = (ext || '').toLowerCase().replace('.', '');
  if (ext === 'docx') return { ...(await translateDocx(buf, langName, mode, opts)), outExt: 'docx' };
  const zipOpts = mode === 'bilingual' ? { ...opts, bilingual: true } : opts;
  if (ext === 'pptx') return { ...(await translateRunsInZip(buf, /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/, 'a:t', langName, zipOpts)), outExt: 'pptx' };
  if (ext === 'xlsx') return { ...(await translateRunsInZip(buf, /^xl\/sharedStrings\.xml$/, 't', langName, zipOpts)), outExt: 'xlsx' };
  if (IMG_MIME[ext] || ext === 'pdf') {
    const mediaType = ext === 'pdf' ? 'application/pdf' : IMG_MIME[ext];
    const segs = await ocrTranslateVisual(buf, mediaType, langName, opts.glossary || []);
    const pairs = {}; segs.forEach(s => { if (s.source && s.target) pairs[s.source] = s.target; });
    // PDF in -> translated PDF out (embedded Unicode font); images -> translated .docx
    if (ext === 'pdf') {
      const { buildPdfFromSegments } = require('./pdfout');
      const buffer = await buildPdfFromSegments(segs, mode === 'bilingual', opts.title || null);
      return { buffer, segments: segs.length, replaced: segs.length, tmHits: 0, pairs, outExt: 'pdf' };
    }
    const buffer = buildDocxFromSegments(segs, mode === 'bilingual');
    return { buffer, segments: segs.length, replaced: segs.length, tmHits: 0, pairs, outExt: 'docx' };
  }
  throw new Error('Unsupported format: .' + ext + ' (supported: docx, pptx, xlsx, pdf, png, jpg, webp)');
}

const SUPPORTED_EXTS = ['docx', 'pptx', 'xlsx', 'pdf', 'png', 'jpg', 'jpeg', 'webp'];
const MIME_BY_EXT = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif'
};

// Formats that OCR to a fresh .docx (review must rebuild from segments, not re-run OCR)
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'pdf'];

// Common aliases users / AI suggestions might use for the official LANGUAGES names above.
// e.g. "Mandarin Chinese" → zh, "Tagalog" → tl. Keys MUST be lowercase.
const LANGUAGE_ALIAS = {
  'mandarin chinese': 'zh',
  'chinese': 'zh',
  'chinese (simplified)': 'zh',
  'indonesian': 'id',
  'bahasa indonesia': 'id',
  'tagalog': 'tl',
  'filipino': 'tl',
  'filipino (tagalog)': 'tl'
};

// Resolve a target-language NAME (free-text, possibly an alias) into its tblTerminology.LangCode.
// Returns null when nothing matches — callers should treat that as "no glossary lookup possible".
function langCodeFromName(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  const direct = LANGUAGES.find(l => l.name.toLowerCase() === n);
  if (direct) return direct.code;
  if (LANGUAGE_ALIAS[n]) return LANGUAGE_ALIAS[n];
  const prefix = LANGUAGES.find(l => l.name.toLowerCase().startsWith(n));
  return prefix ? prefix.code : null;
}

module.exports = { LANGUAGES, LANGUAGE_ALIAS, langCodeFromName, translateDocx, translateDocument, translateSegments, buildDocxFromSegments, SUPPORTED_EXTS, MIME_BY_EXT, IMAGE_EXTS };
// Additive exports for unit testing pure helpers (WP-07 C4). These do not change
// any runtime behaviour — the functions are unchanged and existing callers use
// the module-internal references, not these exports.
module.exports.decodeXml = decodeXml;
module.exports.encodeXml = encodeXml;
module.exports.isTranslatable = isTranslatable;
