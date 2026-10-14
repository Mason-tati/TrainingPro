const AdmZip = require('adm-zip');
// WP-10 A6.2 — Anthropic calls go through the central AI Gateway (audit + policy
// + provider registry). Prompts, models, max_tokens, message shapes and response
// parsing are byte-identical. (The OpenAI image path stays a direct fetch until
// the openai provider adapter is wired in a later step.)
const aiGateway = require('./ai-gateway');
const { dbRun } = require('../database/db');

const CONTENT_TYPES = [
  // ── Assessments ──────────────────────────────────────────────────────
  { key: 'exam',               label: 'Exam / Question bank',             into: 'Exam Builder'      },
  { key: 'form',               label: 'Competency Assessment (TAR)',       into: 'Form Builder'      },
  { key: 'form-doc',           label: 'Form (copy an uploaded document exactly)', into: 'Template Forms' },
  { key: 'training-request',   label: 'Training Request Form',            into: 'Form Builder'      },
  { key: 'akara-leadership',   label: 'Leadership Expectations',           into: 'Document Library'  },
  // ── Documents ────────────────────────────────────────────────────────
  { key: 'course',             label: 'Course / Lesson content',          into: 'Document Library'  },
  { key: 'training-plan',      label: 'Training Plan',                    into: 'Document Library'  },
  { key: 'induction',          label: 'Induction / Onboarding Pack',      into: 'Document Library'  },
  { key: 'training-manual',    label: 'Training Manual',                  into: 'Document Library'  },
  { key: 'training-handout',   label: 'Training Handout',                 into: 'Document Library'  },
  { key: 'training-deck',      label: 'Training Deck (Slide Outline)',    into: 'Document Library'  },
  { key: 'trainer-assessor-guide', label: 'Trainer and Assessor Guide',   into: 'Document Library'  },
  { key: 'statutory-regulatory',   label: 'Statutory and Regulatory Requirements', into: 'Document Library' },
  // ── Safety & Procedures ──────────────────────────────────────────────
  { key: 'sop',                label: 'SOP / Work procedure',             into: 'Document Library'  },
  { key: 'swp',                label: 'Safe Work Procedure (SWP)',        into: 'Document Library'  },
  { key: 'jsa',                label: 'Job Safety Analysis (JSA/JHA)',    into: 'Document Library'  },
  { key: 'process',            label: 'Process / Workflow Document',      into: 'Document Library'  },
  { key: 'operational-guidelines', label: 'Operational Guidelines',       into: 'Document Library'  },
  { key: 'safety-alert',       label: 'Safety Notice / Alert',           into: 'Document Library'  },
  { key: 'toolbox-talk',       label: 'Toolbox Talk Form',                into: 'Document Library'  },
  // ── Workforce ─────────────────────────────────────────────────────────
  { key: 'transfer-to-training', label: 'Transfer Employee to Training', into: 'Document Library'  },
  { key: 'return-to-ops',      label: 'Return Employee to Operations',    into: 'Document Library'  },
  // ── Training Standards ────────────────────────────────────────────────
  { key: 'training-standards',  label: 'Training Standards Document',     into: 'Training Standards' },
  { key: 'policy',              label: 'Policy',                           into: 'Training Standards' },
  { key: 'standard',            label: 'Standard',                         into: 'Training Standards' },
  { key: 'plan',                label: 'Plan / Program',                   into: 'Training Standards' },
  { key: 'management-plan',     label: 'Management Plan',                  into: 'Training Standards' },
  { key: 'strategy-plan',       label: 'Strategy Plan',                    into: 'Training Standards' },
  { key: 'record-form',         label: 'Record Form',                      into: 'Form Builder'       },
  { key: 'excel-form',          label: 'Excel Form (spreadsheet)',         into: 'Template Forms'     },
  { key: 'checklist',           label: 'Checklist',                        into: 'Training Standards' },
];

function encodeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getImageDimensions(buf, mime) {
  try {
    if (mime === 'image/png') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i < buf.length - 8) {
        if (buf[i] !== 0xFF) break;
        const marker = buf[i + 1];
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
    }
    if (mime === 'image/gif') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (mime === 'image/webp' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
      const chunk = buf.slice(12, 16).toString('ascii');
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF };
      if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { width: (b & 0x3FFF) + 1, height: ((b >> 14) & 0x3FFF) + 1 }; }
    }
  } catch {}
  return null;
}

// Repair JSON that contains literal newlines/tabs inside string values (common with AI output)
function repairJson(str) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped) { result += ch; escaped = false; continue; }
    if (ch === '\\') { result += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; result += ch; continue; }
    if (inString) {
      if (ch === '\n') { result += '\\n'; continue; }
      if (ch === '\r') { result += '\\r'; continue; }
      if (ch === '\t') { result += '\\t'; continue; }
    }
    result += ch;
  }
  return result;
}

// Salvage a document from a TRUNCATED generation (the model hit max_tokens mid-JSON, so the whole thing
// won't parse). Keeps the completed preamble (title/meta) and every COMPLETE section object in the
// "sections" array, dropping only the half-written trailing one. Returns the parsed data (with a
// _truncated flag) or null. Lets a very large document still return the sections that finished.
function _salvageTruncatedSections(raw) {
  const sm = raw.match(/"sections"\s*:\s*\[/);
  const objStart = raw.indexOf('{');
  if (!sm || objStart === -1 || objStart > sm.index) return null;
  const preamble = raw.slice(objStart + 1, sm.index).trim().replace(/,\s*$/, ''); // keys before "sections"
  const arrStart = sm.index + sm[0].length;
  const objs = [];
  let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = arrStart; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start !== -1) { objs.push(raw.slice(start, i + 1)); start = -1; } }
    else if (ch === ']' && depth === 0) break; // array already closed
  }
  if (!objs.length) return null;
  const rebuilt = '{' + (preamble ? preamble + ',' : '') + '"sections":[' + objs.join(',') + ']}';
  let data = null;
  try { data = JSON.parse(rebuilt); } catch { try { data = JSON.parse(repairJson(rebuilt)); } catch { data = null; } }
  if (data && Array.isArray(data.sections) && data.sections.length) { data._truncated = true; return data; }
  return null;
}

function extractDocxText(buf) {
  try {
    const xml = new AdmZip(buf).readAsText('word/document.xml');
    const runs = (xml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || []).map(m => m.replace(/<[^>]+>/g, ''));
    return runs.join(' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s{2,}/g, ' ').trim();
  } catch { return ''; }
}

// Extract the plain text of a PDF (pdf-parse v2). Used to feed a source PDF's content to the
// model as light TEXT instead of the whole PDF binary — essential when TWO documents are
// combined, where two full PDFs would blow past the request's page/size limits.
async function extractPdfText(buf) {
  try {
    const { PDFParse } = require('pdf-parse');
    const p = new PDFParse({ data: buf });
    const r = await p.getText();
    try { if (p.destroy) await p.destroy(); } catch { /* ignore */ }
    return (r && r.text) ? String(r.text).replace(/\s{3,}/g, '  ').trim() : '';
  } catch { return ''; }
}

// Pull embedded raster images (word/media/*) from a DOCX so the AI can SEE diagrams /
// flowcharts that are pasted as pictures. Returns Claude image content-blocks.
// Skips tiny images (likely logos/icons) and caps the count to keep the request light.
function extractDocxImages(buf, { max = 6, minBytes = 6000 } = {}) {
  const MEDIA = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  try {
    const zip = new AdmZip(buf);
    const entries = zip.getEntries()
      .filter(e => /^word\/media\/[^/]+\.(png|jpe?g|gif|webp)$/i.test(e.entryName))
      .map(e => ({ name: e.entryName, data: e.getData() }))
      .filter(e => e.data && e.data.length >= minBytes)
      .sort((a, b) => b.data.length - a.data.length) // biggest first — diagrams over icons
      .slice(0, max);
    return entries.map(e => {
      const ext = (e.name.match(/\.([a-z0-9]+)$/i) || [, 'png'])[1].toLowerCase();
      return { type: 'image', source: { type: 'base64', media_type: MEDIA[ext] || 'image/png', data: e.data.toString('base64') } };
    });
  } catch { return []; }
}

// Extract embedded JPEG pictures from a PDF, in order of appearance, as data URLs — so the source
// document's photos/figures can be copied into a generated Training Manual at the right positions. Scans
// stream objects for the JPEG SOI marker (handles the common DCTDecode photos); de-dupes repeats (logos)
// and skips tiny icons. FlateDecode raster images (rarer) are not reconstructed.
function extractPdfImages(buf, { max = 40, minBytes = 12000 } = {}) {
  const out = [];
  try {
    const s = buf.toString('latin1');
    const re = /stream\r?\n/g; let m; const seen = new Set();
    while ((m = re.exec(s)) && out.length < max) {
      const start = m.index + m[0].length;
      const end = s.indexOf('endstream', start);
      if (end < 0) continue;
      let chunk = buf.slice(start, end);
      if (chunk.length < minBytes || !(chunk[0] === 0xFF && chunk[1] === 0xD8 && chunk[2] === 0xFF)) continue;
      // Trim to the JPEG End-Of-Image marker (FF D9) so Word embeds a clean file.
      let eoi = -1;
      for (let i = chunk.length - 1; i > 0; i--) { if (chunk[i] === 0xD9 && chunk[i - 1] === 0xFF) { eoi = i + 1; break; } }
      if (eoi > 0) chunk = chunk.slice(0, eoi);
      const key = chunk.length + ':' + chunk.slice(0, 24).toString('hex');
      if (seen.has(key)) continue;   // duplicate (e.g. a repeated header logo)
      seen.add(key);
      const dims = getImageDimensions(chunk, 'image/jpeg') || {};
      out.push({ data: 'data:image/jpeg;base64,' + chunk.toString('base64'), mimeType: 'image/jpeg', width: dims.width || 0, height: dims.height || 0 });
    }
  } catch { /* best-effort */ }
  return out;
}

// ── DOCX → Content Studio sections ─────────────────────────────────────────────
// Duplicate the LAYOUT of an uploaded .docx as editable Content Studio sections: headings, body text
// and TABLES in reading order. Round-trips through buildDocx() (which re-renders headings/body/tables
// with company branding), so an uploaded template form can be edited / AI-assisted / translated in
// Content Studio and saved back as a branded Word document. Structural fidelity (not pixel-exact).
function _xmlDecode(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&');
}
function _docxParaText(pXml) {
  const withBreaks = pXml.replace(/<w:tab\/>/g, ' ').replace(/<w:br\/?>/g, '\n').replace(/<w:cr\/?>/g, '\n');
  // Match ONLY real text runs: <w:t> or <w:t xml:space="preserve">. The looser <w:t[^>]*> also matches
  // <w:textInput/>, <w:tblPr>, <w:tcPr> … which made legacy form-field codes (<w:instrText> FORMTEXT </…>)
  // leak into the extracted text.
  const runs = (withBreaks.match(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g) || []).map(m => _xmlDecode(m.replace(/<[^>]+>/g, '')));
  return runs.join('').replace(/[ \t]{2,}/g, ' ').replace(/\s+\n/g, '\n').trim();
}
function _docxIsHeading(pXml, text) {
  const style = (pXml.match(/<w:pStyle\s+w:val="([^"]+)"/) || [])[1] || '';
  if (/^(Heading|Title|Subtitle)/i.test(style)) return true;
  // Fallback heuristic: a short, bold, non-sentence line reads as a heading.
  if (/<w:b\/>/.test(pXml) && /[A-Za-z]/.test(text) && text.length <= 80 && !/[.!?,;:]$/.test(text)) return true;
  return false;
}
function _docxHeadingLevel(pXml) {
  const m = pXml.match(/<w:pStyle\s+w:val="Heading(\d)"/);
  return m ? Math.min(3, Math.max(1, parseInt(m[1], 10))) : 2;
}
function _docxCellText(tcXml) {
  const paras = tcXml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
  return paras.map(_docxParaText).filter(Boolean).join('\n').trim();
}
// Parse one <w:tbl> into a grid honouring the true column count (<w:tblGrid>), gridSpan (colspan)
// and vMerge (rowspan). Returns { colCount, matrix } where matrix[r][c] is { text, span } for the
// anchoring cell, 'X' for a column covered by a span/merge, or null for an empty grid slot.
function _docxTableMatrix(tblXml) {
  const colCount = (tblXml.match(/<w:gridCol\b/g) || []).length || 1;
  const trs = tblXml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || [];
  const matrix = [];
  for (const tr of trs) {
    const tcs = tr.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || [];
    const row = new Array(colCount).fill(null);
    let c = 0;
    for (const tc of tcs) {
      while (c < colCount && row[c] === 'X') c++;               // skip columns already covered by a span
      const span = parseInt((tc.match(/<w:gridSpan\s+w:val="(\d+)"/) || [, '1'])[1], 10) || 1;
      const vContinue = /<w:vMerge\s*\/>|<w:vMerge\s+w:val="continue"/.test(tc);
      const text = vContinue ? '' : _docxCellText(tc);          // vertical-merge continuation cells are blank
      if (c < colCount) {
        row[c] = { text, span };
        for (let k = 1; k < span && c + k < colCount; k++) row[c + k] = 'X';
      }
      c += span;
    }
    matrix.push(row);
  }
  return { colCount, matrix };
}
// Flatten a matrix row to exactly colCount plain-text cells (spanned/covered slots -> '').
function _flattenRow(rowArr, colCount) {
  const out = [];
  for (let i = 0; i < colCount; i++) {
    const cell = rowArr[i];
    out.push(cell && cell !== 'X' && cell.text != null ? cell.text : '');
  }
  return out;
}
// A row that is a single cell spanning the whole table = a full-width banner/title (common in forms).
function _bannerText(rowArr, colCount) {
  const present = (rowArr || []).filter(c => c && c !== 'X');
  if (present.length === 1 && (present[0].span >= colCount || colCount === 1)) {
    const t = (present[0].text || '').trim();
    if (t) return t;
  }
  return '';
}
function _docxParseTable(tblXml) {
  const { colCount, matrix } = _docxTableMatrix(tblXml);
  if (!matrix.length) return null;
  const rows = matrix.map(r => _flattenRow(r, colCount));
  return { headers: rows[0], rows: rows.slice(1) };
}
function parseDocxToSections(buf) {
  let xml = '';
  try { xml = new AdmZip(buf).readAsText('word/document.xml'); } catch (e) { return { title: '', sections: [] }; }
  const bodyMatch = xml.match(/<w:body>([\s\S]*)<\/w:body>/);
  const body = bodyMatch ? bodyMatch[1] : xml;
  const blocks = body.match(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g) || [];
  const sections = [];
  let cur = null;
  let title = '';
  for (const blk of blocks) {
    if (blk.startsWith('<w:tbl')) {
      if (cur) { sections.push(cur); cur = null; }
      const { colCount, matrix } = _docxTableMatrix(blk);
      if (!matrix.length) continue;
      // Lift a leading full-width banner row out of the grid and use it as the section heading —
      // this reproduces the form's "titled block" look far better than a lone cell padded with blanks.
      let start = 0;
      const banner = _bannerText(matrix[0], colCount);
      if (banner) { if (!title) title = banner; start = 1; }
      const rows = matrix.slice(start).map(r => _flattenRow(r, colCount));
      if (rows.length) {
        const sec = { table: { headers: rows[0], rows: rows.slice(1) } };
        if (banner) { sec.heading = banner; sec.level = 2; }
        sections.push(sec);
      } else if (banner) {
        sections.push({ heading: banner, level: 2 });
      }
      continue;
    }
    const text = _docxParaText(blk);
    if (!text) continue;
    if (_docxIsHeading(blk, text)) {
      if (!title) title = text;
      if (cur) sections.push(cur);
      cur = { heading: text, level: _docxHeadingLevel(blk), body: '' };
    } else {
      if (!cur) cur = { body: '' };
      cur.body += (cur.body ? '\n' : '') + text;
    }
  }
  if (cur) sections.push(cur);
  for (const s of sections) { if (s.body === '') delete s.body; }
  return { title, sections };
}

// Replace text across the <w:t> runs of each paragraph, leaving every tag and run property intact —
// so a phrase that Word split across runs (e.g. "(RTIO)" stored as "(" + "RTIO" + ")") is still matched
// and swapped. Each replacement is { pattern: RegExp, replace: string }. The replacement text lands in
// the run owning the match start; matched characters are removed from every run the match spans.
function _replaceRunText(xml, replacements) {
  return xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, para => {
    const runRe = /(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g;
    const runs = [];
    let m;
    while ((m = runRe.exec(para))) runs.push({ start: m.index, end: runRe.lastIndex, open: m[1], text: m[2], close: m[3] });
    if (!runs.length) return para;
    // Flatten to a character buffer that remembers which run each char came from.
    const buf = [];
    runs.forEach((r, ri) => { for (const ch of r.text) buf.push({ ch, ri }); });
    const concat = buf.map(b => b.ch).join('');
    // Collect matches across all patterns, then keep only non-overlapping ones (earliest/longest wins).
    const matches = [];
    for (const rep of replacements) {
      const flags = rep.pattern.flags.includes('g') ? rep.pattern.flags : rep.pattern.flags + 'g';
      const re = new RegExp(rep.pattern.source, flags);
      let mm;
      while ((mm = re.exec(concat))) { if (mm[0] === '') { re.lastIndex++; continue; } matches.push({ start: mm.index, end: mm.index + mm[0].length, replace: rep.replace }); }
    }
    if (!matches.length) return para;
    matches.sort((a, b) => a.start - b.start || b.end - a.end);
    const chosen = []; let last = -1;
    for (const mt of matches) { if (mt.start >= last) { chosen.push(mt); last = mt.end; } }
    // Rebuild each run's text: drop matched chars, drop the replacement into the match-start run.
    const insertAt = {}; const del = new Array(buf.length).fill(false);
    for (const mt of chosen) { insertAt[mt.start] = (insertAt[mt.start] || '') + mt.replace; for (let i = mt.start; i < mt.end; i++) del[i] = true; }
    const newText = runs.map(() => '');
    for (let i = 0; i < buf.length; i++) { const ri = buf[i].ri; if (insertAt[i]) newText[ri] += insertAt[i]; if (!del[i]) newText[ri] += buf[i].ch; }
    // Reassemble the paragraph, preserving all inter-run markup (rPr, breaks, etc.).
    let out = ''; let cursor = 0;
    for (let ri = 0; ri < runs.length; ri++) { out += para.slice(cursor, runs[ri].start) + runs[ri].open + newText[ri] + runs[ri].close; cursor = runs[ri].end; }
    out += para.slice(cursor);
    return out;
  });
}

function _reEsc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Auto-detect the third-party organisation that owns an uploaded document, and return run-replacements
// that swap it (its full legal name, shorter variants, and derived acronym) for the company name.
// Signals used: docProps/app.xml <Company>, and any "© / Copyright … {Org} Pty Ltd/Limited/…" line in the
// headers/footers. Only names/acronyms that ACTUALLY appear in the visible text are replaced, so nothing
// fires off a stale template value. Generic — works for any source document, not just Rio Tinto / RTIO.
function _detectOrgReplacements(zip, org) {
  const read = p => { try { return zip.readAsText(p); } catch (e) { return ''; } };
  const runText = xml => (xml.match(/<w:t[ >][\s\S]*?<\/w:t>/g) || []).map(r => r.replace(/<[^>]+>/g, '')).join('');
  const candidates = new Set();

  // 1) Authoring company property.
  const app = read('docProps/app.xml');
  const cm = app.match(/<Company>([^<]{2,80})<\/Company>/i);
  if (cm && cm[1].trim()) candidates.add(cm[1].trim());

  // 2) Copyright line in any header/footer, e.g. "© remains with RioTinto Iron Ore Pty Limited".
  const chromeParts = zip.getEntries().map(e => e.entryName).filter(n => /^word\/(footer|header)\d*\.xml$/.test(n));
  const nameChars = "A-Za-z0-9 .,&’'\\-";
  for (const p of chromeParts) {
    const t = runText(read(p));
    const m1 = t.match(new RegExp('(?:©|\\(c\\)|copyright)\\s*(?:\\d{4}\\s*)?(?:remains with|property of|owned by|belongs to)?\\s*([A-Z][' + nameChars + ']{2,70}?(?:Pty\\.?\\s*(?:Ltd\\.?|Limited)|Ltd\\.?|Limited|Inc\\.?|LLC|PLC|Corporation|Company))', 'i'));
    if (m1 && m1[1]) candidates.add(m1[1].trim());
    else {
      const m2 = t.match(new RegExp('(?:©|\\(c\\)|copyright)\\s+(?:\\d{4}\\s*)?(?:remains with|property of|owned by|belongs to)\\s+([A-Z][' + nameChars + ']{2,50})', 'i'));
      if (m2 && m2[1]) candidates.add(m2[1].trim());
    }
  }
  if (!candidates.size) return [];

  const SUFFIX = /^(Pty|Ltd|Limited|Inc|Incorporated|Corp|Corporation|Company|Co|LLC|PLC|Group|Holdings)$/i;
  const STOP = /^(and|of|the|for|a|an)$/i;
  const tokenize = name => name.replace(/[.,]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/).filter(Boolean);

  const LEGAL = /^(Pty|Ltd|Limited|Inc|Incorporated|LLC|PLC|Co)$/i; // legal suffixes never in an acronym
  const seqs = [];
  for (const c of candidates) {
    const toks = tokenize(c);
    if (!toks.length) continue;
    seqs.push(toks);
    const core = toks.filter(t => !SUFFIX.test(t));
    if (core.length) seqs.push(core);
  }
  seqs.sort((a, b) => b.length - a.length);
  const seen = new Set(); const uniq = [];
  for (const s of seqs) { const k = s.join(' ').toLowerCase(); if (!seen.has(k)) { seen.add(k); uniq.push(s); } }

  // Only replace text that actually appears in the document (guards against stale template metadata).
  const visible = runText(read('word/document.xml')) + ' ' + chromeParts.map(p => runText(read(p))).join(' ');
  const out = [];

  // Acronym: derive candidates from each detected name — including the "corporate" words (Corporation,
  // Group…) since acronyms like "AMC" (Acme Mining Corporation) keep them, and without them for cases
  // like "RTIO" (Rio Tinto Iron Ore Pty Limited). Keep whichever actually appears in the text; longest wins.
  const acrSet = new Set();
  for (const s of uniq) {
    const full = s.filter(t => !LEGAL.test(t) && !STOP.test(t));
    const core = s.filter(t => !SUFFIX.test(t) && !STOP.test(t));
    [full, core].forEach(arr => { if (arr.length >= 2) acrSet.add(arr.map(t => t[0]).join('').toUpperCase()); });
  }
  const acrs = [...acrSet]
    .filter(a => a.length >= 2 && a.toLowerCase() !== org.toLowerCase() && new RegExp('\\b' + _reEsc(a) + '\\b').test(visible))
    .sort((a, b) => b.length - a.length);
  if (acrs.length) {
    const acr = acrs[0];
    out.push({ pattern: new RegExp('\\s*\\(\\s*' + _reEsc(acr) + '\\s*\\)', 'g'), replace: '' }); // drop "(ACRONYM)" definition
    out.push({ pattern: new RegExp('\\b' + _reEsc(acr) + '\\b', 'g'), replace: org });
  }

  // Short-names that are themselves tokens of the org name (e.g. "BHP" in "BHP Billiton"). Require ≥3
  // all-caps chars so common two-letter words (IT, HR, ID) can't be swept up.
  const capSeen = new Set();
  for (const s of uniq) for (const tk of s) {
    if (/^[A-Z0-9]{3,}$/.test(tk) && !capSeen.has(tk) && tk.toLowerCase() !== org.toLowerCase() && new RegExp('\\b' + _reEsc(tk) + '\\b').test(visible)) {
      capSeen.add(tk);
      out.push({ pattern: new RegExp('\\b' + _reEsc(tk) + '\\b', 'g'), replace: org });
    }
  }

  for (const s of uniq) {
    if (s.join(' ').toLowerCase() === org.toLowerCase()) continue;   // already the company name
    const pat = s.map(_reEsc).join('\\s*');
    if (new RegExp(pat, 'i').test(visible)) out.push({ pattern: new RegExp(pat, 'gi'), replace: org });
  }
  return out;
}

// Give a run white + bold text (used inside recoloured header cells so the text stays readable on the
// dark-blue fill). Preserves the run's other properties (font, size); only the colour changes.
function _whitenRun(full, attrs, inner) {
  if (!/<w:t[ >]/.test(inner)) return full;                 // only real text runs
  const rprMatch = inner.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
  if (rprMatch) {
    let rpr = rprMatch[0].replace(/<w:color\b[^>]*\/>/g, '');
    if (!/<w:b\/>/.test(rpr)) rpr = rpr.replace('<w:rPr>', '<w:rPr><w:b/>');
    rpr = rpr.replace('</w:rPr>', '<w:color w:val="FFFFFF"/></w:rPr>');
    return full.replace(rprMatch[0], rpr);
  }
  return `<w:r${attrs}><w:rPr><w:b/><w:color w:val="FFFFFF"/></w:rPr>${inner}</w:r>`;
}
// Set every text run's font colour to `color` (adds an rPr if missing). Used to bring the cloned
// footer's carried-over colour (e.g. the source's brown copyright text) onto the brand theme grey.
function _recolorRunsColor(xml, color) {
  return xml.replace(/<w:r\b([^>]*)>([\s\S]*?)<\/w:r>/g, (full, attrs, inner) => {
    if (!/<w:t[ >]/.test(inner)) return full;                 // only real text runs
    const rprMatch = inner.match(/<w:rPr>[\s\S]*?<\/w:rPr>/);
    if (rprMatch) {
      const rpr = rprMatch[0].replace(/<w:color\b[^>]*\/>/g, '').replace('</w:rPr>', `<w:color w:val="${color}"/></w:rPr>`);
      return full.replace(rprMatch[0], rpr);
    }
    return `<w:r${attrs}><w:rPr><w:color w:val="${color}"/></w:rPr>${inner}</w:r>`;
  });
}

// Recolour a cloned document's shaded header cells to the TrainingPro dark-blue (#1E3A5F) with white
// text — so the exact-clone form (which keeps every merge, column width and fill-in cell) also carries
// the brand colour scheme on exactly the cells the source marked as headers/labels. Fill-in cells are
// left untouched (they are unshaded in the source), so there is still room to write.
function _brandCloneTables(docXml) {
  const DARK = '1E3A5F';
  return docXml.replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, tc => {
    const shd = tc.match(/<w:shd\b[^>]*w:fill="([0-9A-Fa-f]{6})"[^>]*\/>/);
    if (!shd) return tc;
    const fill = shd[1].toUpperCase();
    if (fill === 'FFFFFF' || fill === 'auto') return tc;
    let out = tc.replace(shd[0], shd[0].replace(/w:fill="[0-9A-Fa-f]{6}"/, `w:fill="${DARK}"`));
    out = out.replace(/<w:r\b([^>]*)>([\s\S]*?)<\/w:r>/g, (full, attrs, inner) => _whitenRun(full, attrs, inner));
    return out;
  });
}

// A clean, brand-coloured letterhead: the company logo (correctly proportioned, ~0.55" tall) on the
// left and the company name on the right, over a TrainingPro dark-blue rule. Replaces a third-party
// header whose logo box was shaped for a different logo (which otherwise squashes/stretches ours).
function _brandedHeaderXml(relId, companyName, cx, cy) {
  const BLUE = '1E3A5F';
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const logo = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="1" name="CompanyLogo"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="CompanyLogo"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  const name = companyName
    ? `<w:p><w:pPr><w:jc w:val="right"/><w:spacing w:before="60" w:after="0"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="${BLUE}"/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr><w:t xml:space="preserve">${esc(companyName)}</w:t></w:r></w:p>`
    : '<w:p/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:tbl><w:tblPr><w:tblW w:w="9639" w:type="dxa"/><w:tblBorders><w:bottom w:val="single" w:sz="18" w:space="0" w:color="${BLUE}"/></w:tblBorders><w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="0"/></w:tblPr><w:tblGrid><w:gridCol w:w="4819"/><w:gridCol w:w="4820"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="4819" w:type="dxa"/><w:vAlign w:val="bottom"/></w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${logo}</w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="4820" w:type="dxa"/><w:vAlign w:val="bottom"/></w:tcPr>${name}</w:tc></w:tr></w:tbl>
<w:p><w:pPr><w:spacing w:after="0" w:line="60" w:lineRule="exact"/></w:pPr></w:p>
</w:hdr>`;
}

// Apply run-replacements to a plain string.
function _applyReplace(text, replacements) {
  let t = String(text == null ? '' : text);
  for (const rep of replacements) t = t.replace(rep.pattern, rep.replace);
  return t;
}

// De-brand parsed Content Studio sections (title, headings, body, table cells) using the same org-name
// detection as the exact clone — so the Content Studio preview matches the saved document (no leftover
// third-party names shown while editing).
function debrandSections(parsed, buf, companyName) {
  if (!parsed || !buf || !companyName || !companyName.trim()) return parsed;
  let reps = [];
  try { reps = _detectOrgReplacements(new (require('adm-zip'))(buf), companyName.trim()); } catch (e) { reps = []; }
  if (!reps.length) return parsed;
  parsed.title = _applyReplace(parsed.title, reps);
  for (const s of (parsed.sections || [])) {
    if (s.heading) s.heading = _applyReplace(s.heading, reps);
    if (s.body) s.body = _applyReplace(s.body, reps);
    if (s.table) {
      if (Array.isArray(s.table.headers)) s.table.headers = s.table.headers.map(h => _applyReplace(h, reps));
      if (Array.isArray(s.table.rows)) s.table.rows = s.table.rows.map(row => row.map(c => _applyReplace(c, reps)));
    }
  }
  return parsed;
}

// EXACT clone of an uploaded .docx: keeps word/document.xml (the body — every table, merged cell,
// column width, font and form field) plus styles/numbering/theme structurally intact, so the produced
// Word document matches the uploaded document precisely. De-branding changes:
//   1) each logo-bearing header is rebuilt as a clean company letterhead (correctly-sized company logo +
//      name over a brand rule), replacing the third-party logo and its ill-fitting logo box;
//   2) any opts.replacements / auto-detected org names are swapped for the company name in the
//      body/header/footer text — leaving every table, column width and font exactly as they were.
// Returns a Buffer.
// Render a .docx body to faithful HTML for the Content Studio "Form (copy exactly)" preview — so the user
// SEES the real, exact copy (all tables, columns, merges, shading, bold, alignment) instead of a flattened
// rebuild. Pass the buffer that cloneDocxAsForm produced so the preview mirrors the de-branded, brand-
// recoloured document that will actually be saved/downloaded. Handles horizontal merges (gridSpan),
// cell shading, run bold/colour and paragraph alignment. (Vertical merges are rare in these forms and
// render as separate cells — acceptable for a preview.)
// Apply a transform to only the FIRST <table> in an HTML string (the letterhead table), leaving the rest.
function _applyToFirstTable(html, fn) {
  const m = html.match(/<table\b[^>]*>[\s\S]*?<\/table>/);
  if (!m) return html;
  return html.slice(0, m.index) + fn(m[0]) + html.slice(m.index + m[0].length);
}
// Move the "Date:" cell up into the top-right header cell of the first table, stacked directly under the
// existing content (e.g. "MoC Register #:"), then drop the now-empty row it came from. Gives the clean
// letterhead layout: logo top-left · title centre · (Register # / Date) top-right. Best-effort on the
// generated HTML for that table; if no separate "Date" cell is found, the table is returned unchanged.
function _hoistDateIntoHeaderRow(tableHtml) {
  const rowRe = /<tr\b[^>]*>[\s\S]*?<\/tr>/g;
  const rows = tableHtml.match(rowRe);
  if (!rows || rows.length < 2) return tableHtml;
  const tdRe = /<td\b[^>]*>[\s\S]*?<\/td>/g;
  const strip = s => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const innerOf = td => td.replace(/^<td\b[^>]*>/, '').replace(/<\/td>$/, '');
  const openOf = td => (td.match(/^<td\b[^>]*>/) || ['<td>'])[0];
  // Find the first "Date" cell in any row AFTER the first (header) row.
  let dateRowIdx = -1, dateCell = '';
  for (let i = 1; i < rows.length; i++) {
    const tds = rows[i].match(tdRe) || [];
    const hit = tds.find(td => /^date\b/i.test(strip(td)));
    if (hit) { dateRowIdx = i; dateCell = hit; break; }
  }
  if (dateRowIdx < 0) return tableHtml;
  // Append the Date cell's content under the first row's LAST cell (the top-right "MoC Register #:" cell).
  const headTds = rows[0].match(tdRe) || [];
  if (!headTds.length) return tableHtml;
  const lastTd = headTds[headTds.length - 1];
  const merged = openOf(lastTd) + innerOf(lastTd) + `<div class="fd-hdr-date">${innerOf(dateCell)}</div></td>`;
  rows[0] = rows[0].replace(lastTd, () => merged);
  // Remove the Date cell from its row; drop the whole row if nothing else in it has content.
  const drTds = (rows[dateRowIdx].match(tdRe) || []).filter(td => td !== dateCell);
  const otherContent = drTds.some(td => strip(td) !== '');
  if (!otherContent) rows.splice(dateRowIdx, 1);
  else rows[dateRowIdx] = rows[dateRowIdx].replace(dateCell, '');
  const firstTr = tableHtml.indexOf('<tr');
  const lastTrEnd = tableHtml.lastIndexOf('</tr>') + 5;
  return tableHtml.slice(0, firstTr) + rows.join('') + tableHtml.slice(lastTrEnd);
}

function renderDocxBodyHtml(buf, opts = {}) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(buf);
  // Company logo for the top-left letterhead cell (so the preview shows the logo in the corner the user
  // expects it). Injected into the first empty cell of the first table only.
  const _logoSrc = (opts.companyLogo && /^data:image\//i.test(opts.companyLogo)) ? opts.companyLogo : '';
  const _company = String(opts.companyName || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let _logoPlaced = false, _tblIndex = 0;
  let doc;
  try { doc = zip.readAsText('word/document.xml'); } catch { return ''; }
  const bodyM = doc.match(/<w:body>([\s\S]*)<\/w:body>/);
  let body = bodyM ? bodyM[1] : doc;
  // Drop ONLY the final body-level section properties (not a greedy strip from the first <w:sectPr>, which
  // would gut a document that has section breaks).
  { const ls = body.lastIndexOf('<w:sectPr'); if (ls >= 0 && /^<w:sectPr\b[\s\S]*?<\/w:sectPr>\s*$/.test(body.slice(ls))) body = body.slice(0, ls); }

  const escH = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const decode = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const jcMap = { center: 'center', right: 'right', both: 'justify', left: 'left' };

  function runsHtml(container) {
    // Each <w:r> may carry bold/colour; <w:t> holds the text, <w:tab/> a tab, <w:br/> a line break.
    let out = '';
    const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g; let rm;
    while ((rm = runRe.exec(container))) {
      const inner = rm[1];
      const rpr = (inner.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [, ''])[1];
      const bold = /<w:b\b(?![^>]*w:val="0")/.test(rpr);
      const ital = /<w:i\b(?![^>]*w:val="0")/.test(rpr);
      const uline = /<w:u\b[^>]*w:val="(?!none)/.test(rpr);
      const colorM = rpr.match(/<w:color w:val="([0-9A-Fa-f]{6})"/);
      let piece = '';
      const partRe = /<w:t[ >][\s\S]*?<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g; let pm;
      while ((pm = partRe.exec(inner))) {
        const tok = pm[0];
        if (tok.startsWith('<w:tab')) piece += '&nbsp;&nbsp;&nbsp;&nbsp;';
        else if (tok.startsWith('<w:br')) piece += '<br>';
        else piece += escH(decode(tok.replace(/^<w:t[^>]*>/, '').replace(/<\/w:t>$/, '')));
      }
      if (!piece) continue;
      let style = '';
      if (bold) style += 'font-weight:bold;';
      if (ital) style += 'font-style:italic;';
      if (uline) style += 'text-decoration:underline;';
      if (colorM && colorM[1].toUpperCase() !== '000000') style += `color:#${colorM[1]};`;
      out += style ? `<span style="${style}">${piece}</span>` : piece;
    }
    // Legacy fill-in fields (FORMTEXT) have no run text — show a light underline so blanks are visible.
    if (!out && /FORMTEXT/.test(container)) out = '<span class="cs-exact-blank">&nbsp;</span>';
    return out;
  }

  function paraHtml(p, inCell) {
    const ppr = (p.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/) || [, ''])[1];
    const jc = (ppr.match(/<w:jc w:val="(\w+)"/) || [])[1];
    const align = jcMap[jc] || '';
    const html = runsHtml(p);
    if (!html) return inCell ? '' : '';
    const style = align ? ` style="text-align:${align}"` : '';
    return `<p class="cs-exact-p"${style}>${html}</p>`;
  }

  function tblHtml(tblXml) {
    _tblIndex++;
    const tblInner = tblXml.slice(7, tblXml.length - 8); // strip the outer <w:tbl> … </w:tbl>
    // Column widths from the grid → proportional <col> so the copy keeps the source's column layout.
    const grid = (tblInner.match(/<w:tblGrid>([\s\S]*?)<\/w:tblGrid>/) || [, ''])[1];
    const cols = (grid.match(/<w:gridCol\b[^>]*w:w="(\d+)"/g) || []).map(g => parseInt(g.match(/w:w="(\d+)"/)[1], 10) || 1);
    const total = cols.reduce((a, b) => a + b, 0) || 1;
    let colgroup = '';
    if (cols.length) colgroup = '<colgroup>' + cols.map(w => `<col style="width:${(w / total * 100).toFixed(3)}%">`).join('') + '</colgroup>';
    let rowsHtml = ''; let rowIdx = -1;
    for (const rowXml of _wmlDirectChildren(tblInner, 'w:tr')) {
      rowIdx++;
      const row = _wmlInner(rowXml, 'w:tr');
      let cellsHtml = ''; let cellIdx = -1;
      for (const cellXml of _wmlDirectChildren(row, 'w:tc')) {
        const tc = _wmlInner(cellXml, 'w:tc');
        const tcpr = (tc.match(/<w:tcPr>([\s\S]*?)<\/w:tcPr>/) || [, ''])[1];
        // vMerge continue cells are absorbed by the cell above — skip so columns stay aligned.
        if (/<w:vMerge\b(?![^>]*w:val="restart")/.test(tcpr) && /<w:vMerge\b[^>]*\/>/.test(tcpr) && !/w:val="restart"/.test(tcpr)) continue;
        cellIdx++;
        const span = parseInt((tcpr.match(/<w:gridSpan w:val="(\d+)"/) || [])[1] || '1', 10);
        const shdM = tcpr.match(/<w:shd\b[^>]*w:fill="([0-9A-Fa-f]{6})"/);
        const fill = shdM && shdM[1].toUpperCase();
        const vAlign = (tcpr.match(/<w:vAlign w:val="(\w+)"/) || [])[1];
        let cellStyle = '';
        if (fill && fill !== 'FFFFFF' && fill !== 'AUTO') cellStyle += `background:#${fill};`;
        if (vAlign === 'center') cellStyle += 'vertical-align:middle;';
        else if (vAlign === 'bottom') cellStyle += 'vertical-align:bottom;';
        let inner;
        if (/<w:tbl>/.test(tc)) {
          // Nested table in this cell → render the cell's blocks (paragraphs + nested tables) in order.
          const body2 = tc.replace(/^\s*<w:tcPr>[\s\S]*?<\/w:tcPr>/, '');
          inner = _wmlTopBlocks(body2).map(b => b.kind === 'tbl' ? tblHtml(b.xml) : paraHtml(b.xml, true)).join('') || '&nbsp;';
        } else {
          inner = _wmlDirectChildren(tc, 'w:p').map(p => paraHtml(p, true)).join('');
          // Drop the company logo into the top-left cell of the first table (letterhead corner) — this cell
          // renders empty here because it holds only the source's own logo image this text-only preview
          // can't draw. Skip only if it holds a checkbox.
          if (!_logoPlaced && _logoSrc && _tblIndex === 1 && rowIdx === 0 && cellIdx === 0 && !inner.trim() && !/<w:checkBox/.test(tc)) {
            inner = `<img class="cs-exact-logo" src="${_logoSrc}" alt="${_company || 'Company'} logo" style="max-height:52px;max-width:180px;object-fit:contain">`;
            _logoPlaced = true;
          } else if (!inner.trim()) inner = '&nbsp;';
        }
        cellsHtml += `<td colspan="${span}"${cellStyle ? ` style="${cellStyle}"` : ''}>${inner}</td>`;
      }
      rowsHtml += `<tr>${cellsHtml}</tr>`;
    }
    return `<table class="cs-exact-tbl">${colgroup}<tbody>${rowsHtml}</tbody></table>`;
  }

  let html = '';
  for (const b of _wmlTopBlocks(body)) {
    html += b.kind === 'tbl' ? tblHtml(b.xml) : paraHtml(b.xml, false);
  }
  // Form-doc letterhead: tidy the top row — Date moves up under "MoC Register #:". Driven by an explicit
  // flag (not logo presence) so the relocation shows even when no company logo is configured.
  if (opts.hoistDate) html = _applyToFirstTable(html, _hoistDateIntoHeaderRow);
  return html;
}

// ── Balanced WordprocessingML parsing (handles NESTED tables) ───────────────────
// A cell can contain another table; the old flat/non-greedy regexes mis-parse that (a nested </w:tbl> or
// </w:tc> closes the wrong element), which collapses the whole form. These walk the markup with depth
// counting so tables, rows and cells are split correctly however deeply they nest.
function _wmlTblEnd(xml, start) { // index just past the </w:tbl> that balances the <w:tbl> at `start`
  let depth = 0, i = start;
  while (i < xml.length) {
    const no = xml.indexOf('<w:tbl>', i), nc = xml.indexOf('</w:tbl>', i);
    if (nc < 0) return xml.length;
    if (no >= 0 && no < nc) { depth++; i = no + 7; }
    else { depth--; i = nc + 8; if (depth <= 0) return i; }
  }
  return xml.length;
}
// End of the <tag …>…</tag> element starting at `start`, skipping any nested <w:tbl> subtree (used for
// <w:tr>/<w:tc>, which never self-nest — they only reappear inside a nested table, which we jump over).
function _wmlElemEnd(xml, start, tag) {
  const close = '</' + tag + '>';
  let i = start;
  while (i < xml.length) {
    const nt = xml.indexOf('<w:tbl>', i), nc = xml.indexOf(close, i);
    if (nc < 0) return xml.length;
    if (nt >= 0 && nt < nc) { i = _wmlTblEnd(xml, nt); continue; }
    return nc + close.length;
  }
  return xml.length;
}
// Ordered top-level blocks (tables + paragraphs) of a body/cell, nesting-aware.
function _wmlTopBlocks(xml) {
  const out = []; let i = 0; const n = xml.length;
  while (i < n) {
    let tbl = xml.indexOf('<w:tbl>', i);
    let p = xml.indexOf('<w:p>', i); const pA = xml.indexOf('<w:p ', i);
    if (p < 0 || (pA >= 0 && pA < p)) p = pA;
    if (tbl < 0 && p < 0) break;
    if (tbl >= 0 && (p < 0 || tbl < p)) { const end = _wmlTblEnd(xml, tbl); out.push({ kind: 'tbl', xml: xml.slice(tbl, end) }); i = end; }
    else { const ce = xml.indexOf('</w:p>', p); const end = ce < 0 ? n : ce + 6; out.push({ kind: 'p', xml: xml.slice(p, end) }); i = end; }
  }
  return out;
}
// Direct <w:tr>/<w:tc> children of a table/row (skips those inside nested tables).
function _wmlDirectChildren(xml, tag) {
  const res = []; const open = '<' + tag; let i = 0;
  while (i < xml.length) {
    const nt = xml.indexOf('<w:tbl>', i), st = xml.indexOf(open, i);
    if (st < 0) break;
    if (nt >= 0 && nt < st) { i = _wmlTblEnd(xml, nt); continue; }
    const c = xml[st + open.length];
    if (!(c === ' ' || c === '>' || c === '/' || c === '\n' || c === '\r' || c === '\t')) { i = st + open.length; continue; }
    const end = _wmlElemEnd(xml, st, tag);
    res.push(xml.slice(st, end)); i = end;
  }
  return res;
}
// Inner content of a <w:tc …>…</w:tc> (everything after the opening tag, minus the final </w:tc>).
function _wmlInner(xml, tag) {
  const m = xml.match(new RegExp('^<' + tag + '\\b[^>]*>'));
  if (!m) return xml;
  return xml.slice(m[0].length, xml.length - ('</' + tag + '>').length);
}

// Build a FILLABLE, printable HTML FORM from a cloned .docx (the "Form — copy an uploaded document
// exactly" type). It reproduces the document's tables/paragraphs faithfully, but turns each blank fill-in
// cell into a real input — a single-line box, a date picker, or an auto-growing (expandable) comment box —
// converts checkbox glyphs / Word checkbox fields into real tick boxes, drops the COMPANY LOGO into the
// empty top-left letterhead cell, and adds a Print/Submit bar plus a page-number / created-date / document-
// name footer. The result downloads as a standalone .html the user can fill in, print, or save as PDF.
function buildFormDocHtml(buf, opts = {}) {
  const AdmZip = require('adm-zip');
  let doc = '';
  try { doc = new AdmZip(buf).readAsText('word/document.xml'); } catch { doc = ''; }
  const bodyM = doc.match(/<w:body>([\s\S]*)<\/w:body>/);
  let body = bodyM ? bodyM[1] : doc;
  // Strip ONLY the final body-level section properties. A greedy strip from the first <w:sectPr> would gut
  // the whole body in a document that has section breaks (many <w:sectPr> inside paragraph properties).
  { const ls = body.lastIndexOf('<w:sectPr'); if (ls >= 0 && /^<w:sectPr\b[\s\S]*?<\/w:sectPr>\s*$/.test(body.slice(ls))) body = body.slice(0, ls); }

  const escH = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const decode = s => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const jcMap = { center: 'center', right: 'right', both: 'justify', left: 'left' };
  // Checkbox / tick glyphs — includes Wingdings private-use code points Word uses for form check boxes.
  const CBOX = /[☐☑☒□■❑❒❏❍⬜⬛✓✔✗✘]/;
  const CBOX_G = new RegExp(CBOX.source, 'g');

  let fieldN = 0, logoPlaced = false, tblIndex = 0;
  const company = escH(opts.companyName || '');
  const logoSrc = (opts.companyLogo && /^data:image\//i.test(opts.companyLogo)) ? opts.companyLogo : '';

  const cellText = tc => (tc.match(/<w:t[ >][\s\S]*?<\/w:t>/g) || [])
    .map(t => decode(t.replace(/^<w:t[^>]*>/, '').replace(/<\/w:t>$/, ''))).join('').replace(/\s+/g, ' ').trim();

  // Choose the fill-in control for an empty cell from its label (the nearest text to its left / above).
  const fieldKind = (label, wide) => {
    const L = String(label || '').toLowerCase();
    if (/date/.test(L)) return 'date';
    if (/sign(ature|ed)?\b|signature/.test(L)) return 'sign';
    if (/comment|remark|note|detail|descrip|reason|justif|action|finding|observ|scope|hazard|control|measure|mitigat|method|outcome|recommend/.test(L) || wide) return 'textarea';
    return 'text';
  };
  const inputHtml = (kind) => {
    const id = 'fd' + (++fieldN);
    if (kind === 'date') return `<input type="date" class="fd-in fd-date" id="${id}">`;
    if (kind === 'sign') return `<input type="text" class="fd-in fd-sign" id="${id}" placeholder="Name / signature">`;
    if (kind === 'textarea') return `<textarea class="fd-ta" id="${id}" rows="2" oninput="fdGrow(this)"></textarea>`;
    return `<input type="text" class="fd-in" id="${id}">`;
  };

  function runsHtml(container) {
    let out = '';
    const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g; let rm;
    while ((rm = runRe.exec(container))) {
      const inner = rm[1];
      const rpr = (inner.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/) || [, ''])[1];
      const bold = /<w:b\b(?![^>]*w:val="0")/.test(rpr);
      const ital = /<w:i\b(?![^>]*w:val="0")/.test(rpr);
      const uline = /<w:u\b[^>]*w:val="(?!none)/.test(rpr);
      const colorM = rpr.match(/<w:color w:val="([0-9A-Fa-f]{6})"/);
      let piece = '';
      const partRe = /<w:t[ >][\s\S]*?<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g; let pm;
      while ((pm = partRe.exec(inner))) {
        const tok = pm[0];
        if (tok.startsWith('<w:tab')) piece += '&nbsp;&nbsp;&nbsp;&nbsp;';
        else if (tok.startsWith('<w:br')) piece += '<br>';
        else {
          let txt = decode(tok.replace(/^<w:t[^>]*>/, '').replace(/<\/w:t>$/, ''));
          // Turn any checkbox / tick glyph into a real tick box (keeps the text around it).
          if (CBOX.test(txt)) txt = escH(txt).replace(CBOX_G, '<input type="checkbox" class="fd-cb">');
          else txt = escH(txt);
          piece += txt;
        }
      }
      if (!piece) continue;
      let style = '';
      if (bold) style += 'font-weight:bold;';
      if (ital) style += 'font-style:italic;';
      if (uline) style += 'text-decoration:underline;';
      if (colorM && colorM[1].toUpperCase() !== '000000') style += `color:#${colorM[1]};`;
      out += style ? `<span style="${style}">${piece}</span>` : piece;
    }
    return out;
  }

  function paraHtml(p, inCell, noListCheckbox) {
    const ppr = (p.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/) || [, ''])[1];
    const jc = (ppr.match(/<w:jc w:val="(\w+)"/) || [])[1];
    const align = jcMap[jc] || '';
    const html = runsHtml(p);
    if (!html) return '';
    const style = align ? ` style="text-align:${align}"` : '';
    // A numbered/bulleted LIST item in a form is a checklist line — give it a real tick box so the form is
    // actually checkable (unless the run already produced one, or the row already has a tick column on the
    // left, in which case the box lives there instead of inline — noListCheckbox).
    const isListItem = /<w:numPr>/.test(ppr);
    if (isListItem && !noListCheckbox && !/type="checkbox"/.test(html)) {
      return `<p class="cs-exact-p fd-li"${style}><input type="checkbox" class="fd-cb">${html}</p>`;
    }
    return `<p class="cs-exact-p"${style}>${html}</p>`;
  }

  function tblHtml(tblXml) {
    tblIndex++;
    const inner = tblXml.slice(7, tblXml.length - 8); // strip the outer <w:tbl> … </w:tbl>
    const grid = (inner.match(/<w:tblGrid>([\s\S]*?)<\/w:tblGrid>/) || [, ''])[1];
    const cols = (grid.match(/<w:gridCol\b[^>]*w:w="(\d+)"/g) || []).map(g => parseInt(g.match(/w:w="(\d+)"/)[1], 10) || 1);
    const total = cols.reduce((a, b) => a + b, 0) || 1;
    let colgroup = '';
    if (cols.length) colgroup = '<colgroup>' + cols.map(w => `<col style="width:${(w / total * 100).toFixed(3)}%">`).join('') + '</colgroup>';
    const allRows = _wmlDirectChildren(inner, 'w:tr');

    // ── Pre-pass: build a cell-meta matrix so every cell knows its TRUE starting grid column (honouring
    // gridSpan) and its vertical-merge state. This is what lets rows that sit under a vertically-merged
    // cell line up with the correct columns (and reach the right-hand page edge) instead of shifting left.
    const meta = [];
    for (let r = 0; r < allRows.length; r++) {
      const row = _wmlInner(allRows[r], 'w:tr');
      const rowCells = _wmlDirectChildren(row, 'w:tc');
      let colCursor = 0;
      const rowMeta = [];
      for (const cellXml of rowCells) {
        const tc = _wmlInner(cellXml, 'w:tc');
        const tcpr = (tc.match(/<w:tcPr>([\s\S]*?)<\/w:tcPr>/) || [, ''])[1];
        const span = parseInt((tcpr.match(/<w:gridSpan w:val="(\d+)"/) || [])[1] || '1', 10);
        const vm = tcpr.match(/<w:vMerge\b([^>]*?)\/?>/);
        const vrestart = !!(vm && /restart/.test(vm[1]));
        const vcont = !!(vm && !vrestart);
        const shdM = tcpr.match(/<w:shd\b[^>]*w:fill="([0-9A-Fa-f]{6})"/);
        const fill = shdM && shdM[1].toUpperCase();
        const shaded = !!(fill && fill !== 'FFFFFF' && fill !== 'AUTO');
        rowMeta.push({ tc, tcpr, span, startCol: colCursor, vrestart, vcont, shaded, text: cellText(tc) });
        colCursor += span;
      }
      meta.push(rowMeta);
    }
    // Rowspan for a vertical-merge RESTART cell = itself + the run of following rows that carry a
    // continuation cell starting at the same grid column.
    const rowspanFor = (r, startCol) => {
      let rs = 1;
      for (let rr = r + 1; rr < meta.length; rr++) {
        if (meta[rr].some(c => c.startCol === startCol && c.vcont)) rs++; else break;
      }
      return rs;
    };
    // Column-header lookup: an empty data cell often takes its meaning from a short header cell above or
    // below it in the SAME grid column (e.g. an empty cell under a "Date" / "Signature" header). A header
    // cell that aligns EXACTLY with the data cell's column (same start, same width) is a true per-column
    // header and beats a wide banner that merely overlaps the column (e.g. a multi-column checkbox label).
    // Among equals, prefer the nearer row and the shorter label.
    const colHeader = (startCol, span, fromRow) => {
      let best = null, bestScore = -1e9;
      for (let r = 0; r < meta.length; r++) {
        if (r === fromRow) continue;
        for (const c of meta[r]) {
          if (!c.shaded || !c.text) continue;
          if (startCol < c.startCol || startCol >= c.startCol + c.span) continue;
          const a = c.text.replace(/[^a-z0-9]/gi, '');
          if (a.length < 1 || a.length > 24) continue; // a short label, not a sentence/banner
          const exact = (c.startCol === startCol && c.span === span) ? 2 : (c.startCol === startCol ? 1 : 0);
          const score = exact * 1000 - Math.abs(r - fromRow) * 10 - Math.min(a.length, 24) * 0.1;
          if (score > bestScore) { bestScore = score; best = c.text; }
        }
      }
      return best;
    };

    // Width (in grid columns) of this table's FIRST header cell — the tick column of a checklist row is
    // widened to match it, so the check boxes line up as one column directly under that header.
    let headerFirstSpan = meta[0] && meta[0][0] ? meta[0][0].span : 1;

    let rowsHtml = '';
    for (let rowIdx = 0; rowIdx < allRows.length; rowIdx++) {
      const rowMeta = meta[rowIdx];
      let cellsHtml = ''; let lastLabel = ''; let cellIdx = -1; let rowTick = false; let colSteal = 0;
      for (let rc = 0; rc < rowMeta.length; rc++) {
        const m = rowMeta[rc];
        // A vertical-merge continuation cell is covered by the RESTART cell's rowspan above — emit nothing.
        if (m.vcont) continue;
        cellIdx++;
        const { tc, tcpr, span, startCol, shaded, text } = m;
        const fill = shaded ? (tcpr.match(/<w:shd\b[^>]*w:fill="([0-9A-Fa-f]{6})"/) || [])[1] : '';
        const vAlign = (tcpr.match(/<w:vAlign w:val="(\w+)"/) || [])[1];
        let cellStyle = '';
        if (shaded && fill) cellStyle += `background:#${fill};`;
        if (vAlign === 'center') cellStyle += 'vertical-align:middle;';
        else if (vAlign === 'bottom') cellStyle += 'vertical-align:bottom;';
        const widthFrac = cols.length ? (cols.slice(startCol, startCol + span).reduce((a, b) => a + b, 0) / total) : 0;
        const rowspan = m.vrestart ? rowspanFor(rowIdx, startCol) : 1;
        const hasNested = /<w:tbl>/.test(tc);
        const alnum = text.replace(/[^a-z0-9]/gi, ''); // real content (ignoring box glyphs / punctuation)
        // Word legacy checkbox FORM fields carry no text, so count them directly; glyph check boxes in
        // text are turned into tick boxes inside runsHtml. Both must survive into the fillable form.
        const nCheck = (tc.match(/<w:checkBox\b/g) || []).length;
        const boxes = nCheck ? '<input type="checkbox" class="fd-cb">'.repeat(nCheck) : '';
        const nextMeta = rowMeta[rc + 1];
        const nextListItem = nextMeta ? /<w:numPr>/.test(nextMeta.tc) : false;
        const isTickCell = !hasNested && !alnum && (nCheck > 0 || CBOX.test(text) || /<w:numPr>/.test(tc) || (cellIdx === 0 && nextListItem));
        let inner2;
        if (hasNested) {
          const body2 = tc.replace(/^\s*<w:tcPr>[\s\S]*?<\/w:tcPr>/, '');
          inner2 = _wmlTopBlocks(body2).map(b => b.kind === 'tbl' ? tblHtml(b.xml) : paraHtml(b.xml, true)).join('') || '&nbsp;';
        } else if (!logoPlaced && logoSrc && tblIndex === 1 && rowIdx === 0 && cellIdx === 0 && !text && !nCheck) {
          inner2 = `<img class="fd-logo" src="${logoSrc}" alt="${company || 'Company'} logo">`;
          logoPlaced = true;
        } else if (isTickCell && !shaded) {
          inner2 = '<input type="checkbox" class="fd-cb">'.repeat(Math.max(1, nCheck));
          rowTick = true;
        } else if (!text && (shaded || widthFrac < 0.03)) {
          // A shaded (header/divider) empty cell or a tiny spacer column is NOT a data field.
          inner2 = '&nbsp;';
        } else if (!text) {
          // Empty data cell: pick the control from the nearest label — the text to its left in this row,
          // otherwise the column header above/below (so a "Date" column gets a date picker, "Signature" a
          // signature box, etc.).
          const wide = span >= 3 || widthFrac >= 0.45;
          const label = lastLabel || colHeader(startCol, span, rowIdx) || '';
          inner2 = `<div class="fd-fill">${inputHtml(fieldKind(label, wide))}</div>`;
        } else if (/^d{1,2}m{1,2}y{2,4}$/.test(text.replace(/[^a-z]/gi, '').toLowerCase()) && !nCheck) {
          // A date-format placeholder on its own (e.g. "dd/mm/yyyy", "dd/mm/yy") → a real date picker.
          inner2 = `<div class="fd-fill">${inputHtml('date')}</div>`;
        } else {
          // If this checklist row already placed its tick box in a left column, don't repeat it inline.
          const paras = _wmlDirectChildren(tc, 'w:p');
          let rendered = paras.map(p => paraHtml(p, true, rowTick)).join('');
          if (!rendered.trim()) rendered = '';
          // Add a fill-in for a "Label:" when there is NO separate empty value cell to its right.
          const nextEmpty = nextMeta ? (!nextMeta.text.trim() && !/<w:tbl>|<w:checkBox|<w:numPr>/.test(nextMeta.tc)) : false;
          const wantInline = !shaded && /:\s*$/.test(text) && text.length <= 60 && !nextEmpty && !/<input|<textarea/.test(rendered);
          let inlineFill = '';
          if (wantInline) {
            const ikind = fieldKind(text.replace(/:\s*$/, ''), span >= 3 || widthFrac >= 0.45);
            // A comment/notes field (or any wide cell) gets a FULL-WIDTH box on its own line — not a cramped
            // inline box — so it uses the whole width of the cell.
            inlineFill = ikind === 'textarea'
              ? `<div class="fd-fill">${inputHtml('textarea')}</div>`
              : ` <span class="fd-inline">${inputHtml(ikind)}</span>`;
          }
          inner2 = (boxes ? boxes + ' ' : '') + (rendered || '&nbsp;') + inlineFill;
          lastLabel = text;
        }
        // Widen a checklist row's left tick cell to match the header's first cell, so the tick boxes form
        // one column directly under that header; the freed columns are taken from the next (item text) cell.
        let outSpan = span;
        if (rowTick && cellIdx === 0 && headerFirstSpan > span) { outSpan = headerFirstSpan; colSteal = headerFirstSpan - span; }
        else if (colSteal > 0) { outSpan = Math.max(1, span - colSteal); colSteal = 0; }
        const rsAttr = rowspan > 1 ? ` rowspan="${rowspan}"` : '';
        cellsHtml += `<td colspan="${outSpan}"${rsAttr}${cellStyle ? ` style="${cellStyle}"` : ''}>${inner2}</td>`;
      }
      rowsHtml += `<tr>${cellsHtml}</tr>`;
    }
    return `<table class="cs-exact-tbl">${colgroup}<tbody>${rowsHtml}</tbody></table>`;
  }

  let formHtml = '';
  for (const b of _wmlTopBlocks(body)) {
    formHtml += b.kind === 'tbl' ? tblHtml(b.xml) : paraHtml(b.xml, false);
  }
  // Tidy the letterhead: move the Date up into the top-right header cell, under "MoC Register #:".
  if (opts.hoistDate !== false) formHtml = _applyToFirstTable(formHtml, _hoistDateIntoHeaderRow);

  const title = escH(opts.title || opts.fileName || 'Form');
  const created = escH(new Date().toLocaleDateString('en-GB'));
  const orientation = opts.orientation === 'landscape' ? 'landscape' : 'portrait';
  // A standalone logo band only when the logo wasn't placed into a letterhead cell above.
  const topLogo = (logoSrc && !logoPlaced) ? `<div class="fd-head"><img class="fd-logo" src="${logoSrc}" alt="${company || 'Company'} logo">${company ? `<span class="fd-co">${company}</span>` : ''}</div>` : '';
  const submitEmail = (opts.submitEmail && /.+@.+\..+/.test(String(opts.submitEmail))) ? String(opts.submitEmail) : '';
  const submitBtn = submitEmail ? `<button type="button" id="fd-submit" class="fd-btn">✅ Submit</button>` : '';
  const css = `
    :root{color-scheme:light}
    *{box-sizing:border-box} body{font-family:Segoe UI,Arial,sans-serif;color:#1A1A1A;margin:0;padding:24px 30px;font-size:12.5px;line-height:1.45}
    .fd-bar{position:sticky;top:0;background:#fff;padding:8px 0 12px;display:flex;gap:10px;align-items:center;z-index:5;border-bottom:1px solid #E3E6EE;margin-bottom:14px}
    .fd-btn{background:#1E3A5F;color:#fff;border:0;border-radius:5px;padding:8px 16px;font:inherit;font-weight:600;cursor:pointer}
    .fd-note{color:#5A6072;font-size:11px;margin:0}
    .fd-head{display:flex;align-items:center;gap:14px;border-bottom:3px solid #1E3A5F;padding-bottom:8px;margin:0 0 14px}
    .fd-co{color:#1E3A5F;font-weight:700;font-size:15px}
    .fd-logo{max-height:56px;max-width:190px;object-fit:contain}
    .fd-hdr-date{margin-top:4px}
    .fd-hdr-date .cs-exact-p{margin:2px 0}
    table.cs-exact-tbl{border-collapse:collapse;width:100%;margin:0 0 12px;table-layout:fixed}
    table.cs-exact-tbl td{border:1px solid #9AA0B0;padding:0;vertical-align:top;word-wrap:break-word}
    table.cs-exact-tbl td>.cs-exact-p,table.cs-exact-tbl td>.fd-cb,table.cs-exact-tbl td>.fd-hdr-date{margin:4px 6px}
    .cs-exact-p{margin:2px 0}
    /* Fill-in areas are BORDERLESS and fill the whole cell — the cell border is the field boundary (no box-in-a-box). */
    .fd-in{display:block;width:100%;padding:4px 6px;border:0;background:transparent;font:inherit;color:#1A1A1A}
    .fd-in:focus,.fd-ta:focus{outline:0;background:#EAF1FB}
    .fd-date{color:#1A1A1A}
    .fd-ta{display:block;width:100%;min-height:30px;padding:4px 6px;border:0;background:transparent;font:inherit;resize:vertical;overflow:hidden}
    .fd-fill{width:100%}
    /* Inline fills (after a "Label:") are borderless — the cell is the writable area, no underline. */
    .fd-inline{display:inline-block;min-width:120px;vertical-align:baseline}
    .fd-inline .fd-in{display:inline-block;width:auto;min-width:110px;padding:1px 3px;border:0}
    .fd-inline .fd-date{min-width:140px}
    .fd-cb{width:15px;height:15px;vertical-align:middle;margin:0 4px 0 0}
    .fd-li{display:flex;align-items:flex-start;gap:6px}.fd-li .fd-cb{margin-top:2px;flex:0 0 auto}
    .fd-foot{margin-top:20px;border-top:1px solid #D7DAE3;padding-top:8px;color:#5A6072;font-size:11px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
    @page{size:A4 ${orientation};margin:12mm 12mm 14mm 12mm;@bottom-right{content:"Page " counter(page) " of " counter(pages);font-size:9pt;color:#5A6072}}
    @media print{body{padding:6mm}.no-print{display:none!important}}`;
  const script = `(function(){
    function fdGrow(t){t.style.height='auto';t.style.height=(t.scrollHeight+2)+'px';}
    window.fdGrow=fdGrow;
    document.querySelectorAll('textarea.fd-ta').forEach(fdGrow);
    var p=document.getElementById('fd-print'); if(p)p.addEventListener('click',function(){window.print();});
    var sb=document.getElementById('fd-submit');
    if(sb)sb.addEventListener('click',function(){
      var T=${JSON.stringify(String(opts.title || opts.fileName || 'Form'))}, R=${JSON.stringify(submitEmail)};
      var lines=[];
      document.querySelectorAll('input.fd-in,textarea.fd-ta,input.fd-date').forEach(function(inp){
        if(inp.value && inp.value.trim()) lines.push((inp.getAttribute('placeholder')||'Field')+': '+inp.value.trim());
      });
      var nCb=document.querySelectorAll('input.fd-cb:checked').length;
      var subject=encodeURIComponent(T+' — '+new Date().toLocaleDateString('en-GB'));
      var mail=encodeURIComponent(T+'\\nSubmitted: '+new Date().toLocaleString('en-GB')+'\\n\\n'+lines.join('\\n')+'\\n\\nTicked boxes: '+nCb);
      window.location.href='mailto:'+R+'?subject='+subject+'&body='+mail;
    });
  })();`;
  // ── WYSIWYG layout editing (preview only) — click a cell to select, then type/replace text, insert a
  // field, add/move/delete a row, or clear a cell. The editing chrome is stripped out on download.
  const editable = !!opts.editable;
  const editCss = editable ? `
    .fd-ebar{position:sticky;top:0;z-index:30;background:#1E3A5F;color:#fff;padding:8px 10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;border-radius:6px;margin:0 0 12px}
    .fd-ebar b{margin-right:4px}.fd-ehint{color:#C7D2E8;font-size:11px;margin-right:4px}
    .fd-ebtn{background:#fff;color:#1E3A5F;border:0;border-radius:4px;padding:5px 9px;font:inherit;font-size:12px;font-weight:600;cursor:pointer}
    .fd-ebtn.danger{background:#B4232A;color:#fff}
    .fd-ebar select{padding:4px 6px;border-radius:4px;border:0;font:inherit;font-size:12px}
    table.cs-exact-tbl td.fd-active{outline:2px solid #1E7F3C;outline-offset:-2px;background:#EAF7EE!important}
    input.fd-cb-active{outline:2px solid #B4232A;outline-offset:2px}
    [contenteditable="true"]:focus{outline:2px solid #1E3A5F}
    /* Draggable column boundary ("ruler line") handles. */
    .fd-rsz{position:absolute;top:0;right:-4px;width:8px;height:100%;cursor:col-resize;z-index:8;user-select:none}
    .fd-rsz:hover,.fd-rsz.on{box-shadow:inset -3px 0 0 -1px #1E7F3C}
    body.fd-rsz-drag{cursor:col-resize!important}
    @media print{.fd-ebar{display:none!important}.fd-rsz{display:none!important}}` : '';
  const editBar = editable ? `<div class="fd-ebar no-print">
    <b>✏️ Edit layout</b>
    <button type="button" class="fd-ebtn" data-act="undo" title="Undo the last change">↩ Undo</button>
    <span class="fd-ehint">|</span>
    <select id="fd-ftype"><option value="text">Text field</option><option value="date">Date field</option><option value="time">Time field</option><option value="tel">Phone number</option><option value="email">Email</option><option value="number">Number</option><option value="currency">Currency / amount</option><option value="checkbox">Check box</option><option value="textarea">Comment box</option><option value="sign">Signature</option><option value="yesno">Yes / No</option><option value="select">Dropdown (choices)</option></select>
    <button type="button" class="fd-ebtn" data-act="addfield">➕ Insert field</button>
    <button type="button" class="fd-ebtn" data-act="rowabove">＋Row above</button>
    <button type="button" class="fd-ebtn" data-act="rowbelow">＋Row below</button>
    <button type="button" class="fd-ebtn" data-act="up">⬆ Move up</button>
    <button type="button" class="fd-ebtn" data-act="down">⬇ Move down</button>
    <button type="button" class="fd-ebtn danger" data-act="clear">Clear cell</button>
    <button type="button" class="fd-ebtn danger" data-act="delcb">✕ Remove check box</button>
    <button type="button" class="fd-ebtn danger" data-act="delcell">✂ Delete cell</button>
    <button type="button" class="fd-ebtn danger" data-act="delrow">🗑 Delete row</button>
    <span class="fd-ehint">Type in a cell to edit text · click a check box to select it, then Remove · drag a column edge to move the ruler lines.</span>
  </div>` : '';
  const editScript = editable ? `(function(){
    var active=null, activeCb=null, undo=[], lastFocus=null;
    var FORM=function(){return document.querySelector('form');};
    function snapshot(){ try{ var f=FORM(); if(f){ undo.push(f.innerHTML); if(undo.length>80)undo.shift(); } }catch(e){} }
    function doUndo(){ var f=FORM(); if(f&&undo.length){ f.innerHTML=undo.pop(); active=null; activeCb=null; lastFocus=null; addResizers(); } else { alert('Nothing to undo.'); } }
    document.querySelectorAll('table.cs-exact-tbl td').forEach(function(td){ td.setAttribute('contenteditable','true'); });
    // Snapshot before the first edit in a newly-focused cell, so Undo steps back one edit at a time.
    document.addEventListener('focusin',function(ev){ var td=ev.target.closest?ev.target.closest('td'):null; if(td&&td!==lastFocus){ snapshot(); lastFocus=td; } });
    document.addEventListener('click',function(ev){
      if(ev.target.classList && ev.target.classList.contains('fd-rsz')) return;
      // Clicking a check box selects it (for Remove check box) as well as its cell.
      if(ev.target.matches && ev.target.matches('input[type=checkbox]')){ if(activeCb)activeCb.classList.remove('fd-cb-active'); activeCb=ev.target; activeCb.classList.add('fd-cb-active'); }
      else if(activeCb){ activeCb.classList.remove('fd-cb-active'); activeCb=null; }
      var td=ev.target.closest?ev.target.closest('td'):null;
      if(td){ if(active)active.classList.remove('fd-active'); active=td; td.classList.add('fd-active'); }
    },true);
    function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
    function fld(t){
      if(t==='checkbox')return '<input type="checkbox" class="fd-cb">';
      if(t==='date')return '<input type="date" class="fd-in fd-date">';
      if(t==='time')return '<input type="time" class="fd-in fd-date">';
      if(t==='tel')return '<input type="tel" class="fd-in" placeholder="Phone number">';
      if(t==='email')return '<input type="email" class="fd-in" placeholder="name@example.com">';
      if(t==='number')return '<input type="number" step="any" class="fd-in fd-date">';
      if(t==='currency')return '<input type="number" step="0.01" min="0" class="fd-in fd-date" placeholder="0.00">';
      if(t==='textarea')return '<textarea class="fd-ta" rows="2" oninput="fdGrow(this)"></textarea>';
      if(t==='sign')return '<input type="text" class="fd-in fd-sign" placeholder="Name / signature">';
      if(t==='yesno')return '<span class="fd-rad"><label><input type="radio"> Yes</label> <label><input type="radio"> No</label></span>';
      if(t==='select'){ var o=prompt('Dropdown choices (comma-separated):','Option 1, Option 2, Option 3'); if(o===null)return ''; var opts=o.split(',').map(function(x){return x.trim();}).filter(Boolean); return '<select class="fd-in"><option value=""></option>'+opts.map(function(x){return '<option>'+esc(x)+'</option>';}).join('')+'</select>'; }
      return '<input type="text" class="fd-in">';
    }
    function act(a){
      if(a==='undo'){ doUndo(); return; }
      if(a==='delcb'){ if(activeCb){ snapshot(); activeCb.remove(); activeCb=null; } else if(active){ var cb=active.querySelector('input[type=checkbox]'); if(cb){ snapshot(); cb.remove(); } else alert('Click the check box you want to remove first.'); } else alert('Click a check box to remove.'); return; }
      if(!active){ alert('Click a cell first.'); return; }
      snapshot();
      var tr=active.closest('tr');
      if(a==='addfield'){ var t=(document.getElementById('fd-ftype')||{}).value||'text'; var f=fld(t); if(!f){undo.pop();return;} if(active.innerHTML.replace(/&nbsp;|\\s/g,'')==='') active.innerHTML=''; active.insertAdjacentHTML('beforeend',' '+f); }
      else if(a==='clear'){ active.innerHTML='&nbsp;'; }
      else if(a==='delcell'){ var nx=active.nextElementSibling||active.previousElementSibling; active.remove(); active=nx||null; if(active)active.classList.add('fd-active'); }
      else if(a==='delrow'){ if(tr&&confirm('Delete this row?')){ tr.remove(); active=null; } else { undo.pop(); } }
      else if(a==='up'){ if(tr&&tr.previousElementSibling) tr.parentNode.insertBefore(tr,tr.previousElementSibling); else undo.pop(); }
      else if(a==='down'){ if(tr&&tr.nextElementSibling) tr.parentNode.insertBefore(tr.nextElementSibling,tr); else undo.pop(); }
      else if(a==='rowabove'||a==='rowbelow'){ if(tr){ var nr=tr.cloneNode(true); nr.querySelectorAll('td').forEach(function(c){c.innerHTML='&nbsp;';c.setAttribute('contenteditable','true');c.classList.remove('fd-active');c.querySelectorAll('.fd-rsz').forEach(function(x){x.remove();});}); tr.parentNode.insertBefore(nr, a==='rowabove'?tr:tr.nextElementSibling); addResizers(); } else undo.pop(); }
    }
    document.querySelectorAll('.fd-ebar [data-act]').forEach(function(b){ b.addEventListener('click',function(){act(b.getAttribute('data-act'));}); });
    document.addEventListener('keydown',function(ev){ if((ev.ctrlKey||ev.metaKey)&&(ev.key==='z'||ev.key==='Z')){ ev.preventDefault(); doUndo(); } });
    // Draggable column boundaries — adjust the <colgroup> widths of each table ("move the ruler lines").
    function addResizers(){
      document.querySelectorAll('table.cs-exact-tbl').forEach(function(tbl){
        var cg=tbl.querySelector('colgroup'); if(!cg) return;
        var cols=[].slice.call(cg.children); if(cols.length<2) return;
        var firstRow=tbl.querySelector('tr'); if(!firstRow) return;
        [].slice.call(firstRow.children).forEach(function(td){ td.querySelectorAll('.fd-rsz').forEach(function(x){x.remove();}); });
        var gridIdx=0;
        [].slice.call(firstRow.children).forEach(function(td){
          var span=parseInt(td.getAttribute('colspan')||'1',10); gridIdx+=span;
          if(gridIdx<cols.length){
            var leftColIdx=gridIdx-1;
            var h=document.createElement('div'); h.className='fd-rsz'; h.setAttribute('contenteditable','false');
            if(getComputedStyle(td).position==='static') td.style.position='relative';
            td.appendChild(h);
            h.addEventListener('mousedown',function(e){
              e.preventDefault(); e.stopPropagation(); h.classList.add('on'); document.body.classList.add('fd-rsz-drag');
              var startX=e.clientX, tblW=tbl.offsetWidth||1;
              var lC=cols[leftColIdx], rC=cols[leftColIdx+1];
              var lW=parseFloat((lC.style.width||'10')), rW=parseFloat((rC.style.width||'10'));
              function mv(ev){ var d=(ev.clientX-startX)/tblW*100; var nl=lW+d, nr=rW-d; if(nl>1.5&&nr>1.5){ lC.style.width=nl.toFixed(3)+'%'; rC.style.width=nr.toFixed(3)+'%'; } }
              function up(){ h.classList.remove('on'); document.body.classList.remove('fd-rsz-drag'); document.removeEventListener('mousemove',mv); document.removeEventListener('mouseup',up); }
              document.addEventListener('mousemove',mv); document.addEventListener('mouseup',up);
            });
          }
        });
      });
    }
    addResizers();
    window.__fdAddResizers=addResizers;
  })();` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${title}</title><style>${css}${editCss}</style></head><body>`
    + `<div class="fd-bar no-print"><button type="button" id="fd-print" class="fd-btn">🖨 Print / Save as PDF</button>${submitBtn}`
    + `<span class="fd-note">${editable ? 'Editing layout — changes here are saved into the download. ' : 'This form is fillable — type into the fields, tick the boxes, then Print or Save as PDF.'}${submitEmail ? ' Submit emails it to ' + escH(submitEmail) + '.' : ''}</span></div>`
    + editBar
    + topLogo
    + `<form onsubmit="return false">${formHtml}</form>`
    + `<div class="fd-foot"><span>${title}</span><span>Created: ${created}</span></div>`
    + `<script>${script}</script>${editable ? `<script>${editScript}</script>` : ''}</body></html>`;
}

// ── AI SMART FORM ───────────────────────────────────────────────────────────────
// Reads a form's text and reconstructs it as a CLEAN structured model — correctly grouped check boxes
// (one box per logical item, wrapped lines merged, distinct items separated), labelled fields and tables,
// with no blank cells. This is the intelligent alternative to the exact copy, which faithfully reproduces
// the source's quirks. Returns { title, intro, sections:[{heading,intro,checklist[],fields[],table}] }.
async function aiSmartForm(src = {}) {
  const text = String(src.text || '').slice(0, 55000);
  if (!text.trim()) return null;
  const sys = `You reconstruct workplace forms (checklists, permits, registers, declarations) into a CLEAN, correctly-structured model for a fillable form builder. You read and UNDERSTAND the content; you do not copy its layout quirks.`;
  const instr = `Read the FORM below and return ONLY JSON (no markdown):
{"title":"<form title>","intro":"<the one-line completion instruction, if any>","sections":[{"heading":"<section heading, or ''>","intro":"<optional lead-in sentence for this section>","fields":[{"label":"<label>","type":"text|date|signature|yesno|number|textarea|select","options":["..."]}],"checklist":["<item>","<item>"],"table":{"headers":["..."],"rows":[["","",""]]}}]}
RULES — follow exactly:
1. A CHECKLIST item is ONE complete logical statement. MERGE text that wraps across lines into a single item — e.g. "LVs are roadworthy, registered, equipped with buggy whip and amber flashing light" is ONE item (one check box), never split.
2. SEPARATE distinct items into their own entries, each with its own check box — e.g. "Inductions for Persons on Site", "Visitor Only" and "Site Induction Training & Assessment" are SEPARATE items.
3. When items sit under a lead-in that ends with ":" (e.g. "Electronic Copies of Procedures, SWI's and JSEA's supplied including:"), put the lead-in in the section "intro" and list the items in "checklist".
4. Use "fields" for labelled inputs (Contractor's Name, Company Name, Email, Phone, Date, Signature). Give every field a clear label — NO blank or unlabelled cells.
5. For a "Yes/No - Comments" style block (e.g. Equipment/Machinery/Vehicles), use a "table" with headers ["Item","Yes / No","Comments"] and one row per item (leave the Yes/No and Comments cells empty strings).
6. Keep the REAL wording from the source. Do not invent, omit, or re-order meaning. Group everything under the right heading.
7. Every section must have at least one of: fields, checklist, or table. No empty sections, no blank cells.

FORM:
${text}`;
  try {
    const msg = await aiGateway.complete({ provider: 'anthropic', agent: 'AI-DOC-001', operation: 'smart_form', model: 'claude-sonnet-4-6', max_tokens: 8000, system: sys, messages: [{ role: 'user', content: instr }] });
    const raw = (msg.content.find(b => b.type === 'text') || {}).text || '';
    const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    let j; try { j = JSON.parse(cleaned); } catch { try { j = JSON.parse((cleaned.match(/\{[\s\S]*\}/) || [''])[0]); } catch { return null; } }
    if (!j || !Array.isArray(j.sections)) return null;
    return j;
  } catch { return null; }
}

// Build a CLEAN fillable HTML form from an AI smart-form model: section headings, lead-ins, check lists
// (one left-column tick box per item), labelled fields and Yes/No-Comments tables — no blank cells.
function buildSmartFormHtml(model, opts = {}) {
  const e = encodeXml;
  const m = model || {};
  const title = e(m.title || opts.title || 'Form');
  const created = e(new Date().toLocaleDateString('en-GB'));
  const company = e(opts.companyName || '');
  const logo = (opts.companyLogo && /^data:image\//i.test(opts.companyLogo)) ? `<img class="sf-logo" src="${opts.companyLogo}" alt="${company || 'Company'} logo">` : '';
  const orientation = opts.orientation === 'landscape' ? 'landscape' : 'portrait';
  let n = 0;
  const inputFor = (f) => {
    const id = 'sf' + (++n); const t = (f.type || 'text').toLowerCase();
    if (t === 'date') return `<input type="date" id="${id}" class="sf-in sf-date">`;
    if (t === 'number') return `<input type="number" step="any" id="${id}" class="sf-in sf-short">`;
    if (t === 'textarea') return `<textarea id="${id}" class="sf-ta" rows="2" oninput="sfGrow(this)"></textarea>`;
    if (t === 'signature') return `<input type="text" id="${id}" class="sf-in sf-sign" placeholder="Name / signature">`;
    if (t === 'yesno') return `<span class="sf-rad"><label><input type="radio" name="${id}" value="Yes"> Yes</label><label><input type="radio" name="${id}" value="No"> No</label></span>`;
    if ((t === 'select' || t === 'radio') && Array.isArray(f.options) && f.options.length) return `<select id="${id}" class="sf-in sf-sel"><option value=""></option>${f.options.map(o => `<option>${e(String(o))}</option>`).join('')}</select>`;
    return `<input type="text" id="${id}" class="sf-in">`;
  };
  let body = '';
  for (const s of (m.sections || [])) {
    if (!s) continue;
    if (s.heading) body += `<h2 class="sf-sec">${e(s.heading)}</h2>`;
    if (s.intro) body += `<p class="sf-intro">${e(s.intro)}</p>`;
    if (Array.isArray(s.fields) && s.fields.length) {
      body += '<div class="sf-fields">' + s.fields.filter(f => f && f.label).map(f =>
        `<div class="sf-field"><label>${e(f.label)}</label><div class="sf-input">${inputFor(f)}</div></div>`).join('') + '</div>';
    }
    if (Array.isArray(s.checklist) && s.checklist.length) {
      body += '<table class="sf-check"><tbody>' + s.checklist.filter(Boolean).map(it =>
        `<tr><td class="sf-check-box"><input type="checkbox" class="sf-cb"></td><td class="sf-check-lbl">${e(String(it))}</td></tr>`).join('') + '</tbody></table>';
    }
    if (s.table && Array.isArray(s.table.headers) && s.table.headers.length) {
      const heads = s.table.headers;
      // Classify each column so Yes/No stays narrow and Comments gets the room (as an expandable field).
      const roles = heads.map((h, i) => {
        const t = String(h || '').toLowerCase();
        if (i === 0) return 'label';
        if (/comment|note|detail|remark|action|finding|observ/.test(t)) return 'comment';
        if (/yes\s*\/?\s*no|y\s*\/\s*n|result|compliant|conform|status|\bn\/a\b/.test(t)) return 'yesno';
        if (/date/.test(t)) return 'date';
        if (/sign/.test(t)) return 'sign';
        return 'text';
      });
      // Column widths: Yes/No narrow, Comments wide, the item label takes the balance.
      const commentCols = roles.filter(r => r === 'comment').length;
      const widthFor = (r) => r === 'yesno' ? 10 : r === 'date' ? 12 : r === 'comment' ? (commentCols ? Math.round(52 / commentCols) : 40) : r === 'sign' ? 18 : 16;
      const fixedPct = roles.slice(1).reduce((a, r) => a + widthFor(r), 0);
      const colg = '<colgroup>' + roles.map((r, i) => `<col style="width:${i === 0 ? Math.max(20, 100 - fixedPct) : widthFor(r)}%">`).join('') + '</colgroup>';
      const cell = (r, v) => {
        const id = 'sf' + (++n);
        if (r === 'label') return `<td>${e(String(v))}</td>`;
        if (r === 'comment') return `<td><textarea id="${id}" class="sf-ta sf-cell-ta" rows="1" oninput="sfGrow(this)">${e(String(v))}</textarea></td>`;
        if (r === 'yesno') return `<td class="sf-yn-td"><select id="${id}" class="sf-in sf-yn"><option value=""></option><option>Yes</option><option>No</option><option>N/A</option></select></td>`;
        if (r === 'date') return `<td><input type="date" id="${id}" class="sf-in"></td>`;
        if (r === 'sign') return `<td><input type="text" id="${id}" class="sf-in" placeholder="Name / signature"></td>`;
        return `<td><input type="text" id="${id}" class="sf-in sf-cell" value="${e(String(v))}"></td>`;
      };
      body += '<table class="sf-tbl">' + colg + '<thead><tr>' + heads.map(h => `<th>${e(String(h))}</th>`).join('') + '</tr></thead><tbody>'
        + (s.table.rows || []).map(r => '<tr>' + roles.map((role, i) => cell(role, (r || [])[i] || '')).join('') + '</tr>').join('')
        + '</tbody></table>';
    }
  }
  const css = `
    :root{color-scheme:light}*{box-sizing:border-box}
    body{font-family:Segoe UI,Arial,sans-serif;color:#1A1A1A;margin:0;padding:24px 30px;font-size:13px;line-height:1.5}
    .sf-bar{position:sticky;top:0;background:#fff;padding:8px 0 12px;border-bottom:1px solid #E3E6EE;margin-bottom:14px;display:flex;gap:10px;align-items:center}
    .sf-btn{background:#1E3A5F;color:#fff;border:0;border-radius:5px;padding:8px 16px;font:inherit;font-weight:600;cursor:pointer}
    .sf-note{color:#5A6072;font-size:11px;margin:0}
    .sf-head{display:flex;align-items:center;gap:14px;border-bottom:3px solid #1E3A5F;padding-bottom:8px;margin:0 0 6px}
    .sf-logo{max-height:56px;max-width:190px;object-fit:contain}
    h1{font-size:20px;color:#1E3A5F;margin:0}.sf-co{color:#5A6072;font-size:12px;margin:2px 0 0}
    .sf-form-intro{color:#2A3042;font-size:12.5px;margin:8px 0 14px}
    h2.sf-sec{font-size:14px;color:#fff;background:#1E3A5F;padding:6px 10px;border-radius:4px;margin:18px 0 8px}
    .sf-intro{color:#2A3042;margin:0 0 8px;font-weight:600}
    .sf-fields{display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;margin:0 0 10px}
    .sf-field{display:flex;gap:10px;align-items:center;padding:4px 0;border-bottom:1px dotted #D7DAE3}
    .sf-field label{flex:0 0 42%;font-weight:600;color:#2A3042}.sf-input{flex:1}
    .sf-in{width:100%;padding:5px 8px;border:1px solid #8A90A2;border-radius:4px;font:inherit;background:#fff}
    .sf-in:focus,.sf-ta:focus{outline:2px solid #1E3A5F;border-color:#1E3A5F}
    .sf-date,.sf-short{max-width:200px}.sf-ta{width:100%;min-height:34px;padding:5px 8px;border:1px solid #8A90A2;border-radius:4px;font:inherit;resize:vertical;overflow:hidden}
    .sf-rad{display:inline-flex;gap:16px}.sf-rad label{font-weight:500;display:inline-flex;gap:5px;align-items:center}
    table.sf-check{border-collapse:collapse;width:100%;margin:0 0 10px}
    .sf-check td{border:1px solid #C7CCD8;padding:6px 8px;vertical-align:top}
    .sf-check-box{width:34px;text-align:center}.sf-cb{width:16px;height:16px}
    .sf-check-lbl{color:#1A1A1A}
    table.sf-tbl{border-collapse:collapse;width:100%;margin:0 0 12px;table-layout:fixed}
    .sf-tbl th{background:#1E3A5F;color:#fff;border:1px solid #1E3A5F;padding:6px 8px;text-align:left;font-size:12px}
    .sf-tbl td{border:1px solid #9AA0B0;padding:3px 5px;vertical-align:top;word-wrap:break-word}
    .sf-cell{border:0;background:transparent}
    /* Yes/No stays compact; Comments is a roomy, auto-growing (expandable) field. */
    .sf-yn-td{text-align:center}
    .sf-yn{width:100%;max-width:72px;padding:3px 4px;border:1px solid #8A90A2;border-radius:4px;font:inherit;background:#fff}
    .sf-cell-ta{width:100%;min-height:30px;padding:4px 6px;border:0;background:transparent;font:inherit;resize:vertical;overflow:hidden;line-height:1.4}
    .sf-foot{margin-top:22px;border-top:1px solid #D7DAE3;padding-top:8px;color:#5A6072;font-size:11px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
    @page{size:A4 ${orientation};margin:12mm 12mm 14mm 12mm;@bottom-right{content:"Page " counter(page) " of " counter(pages);font-size:9pt;color:#5A6072}}
    @media print{body{padding:6mm}.no-print{display:none!important}@media print{.sf-fields{grid-template-columns:1fr 1fr}}}`;
  const script = `(function(){function g(t){t.style.height='auto';t.style.height=(t.scrollHeight+2)+'px';}window.sfGrow=g;document.querySelectorAll('textarea.sf-ta').forEach(g);var p=document.getElementById('sf-print');if(p)p.addEventListener('click',function(){window.print();});})();`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${css}</style></head><body>`
    + `<div class="sf-bar no-print"><button type="button" id="sf-print" class="sf-btn">🖨 Print / Save as PDF</button><span class="sf-note">AI-rebuilt clean form — fillable: type into the fields, tick the boxes, then print or save as PDF.</span></div>`
    + `<div class="sf-head">${logo}<div><h1>${title}</h1>${company ? `<p class="sf-co">${company}</p>` : ''}</div></div>`
    + (m.intro ? `<p class="sf-form-intro">${e(m.intro)}</p>` : '')
    + `<form onsubmit="return false">${body}</form>`
    + `<div class="sf-foot"><span>${title}</span><span>Created: ${created}</span></div>`
    + `<script>${script}</script></body></html>`;
}

// Map an AI smart-form model to buildDocx sections (headings, lead-in body, check lists and tables) and
// render a clean Word .docx with real check boxes — the Word twin of buildSmartFormHtml.
function smartFormToDocx(model, opts = {}) {
  const m = model || {};
  const sections = [];
  // Fields → a 2-column form table (Label | fillable cell). Yes/No gets a "☐ Yes ☐ No" cell.
  const fieldsTable = (fields) => {
    const rows = fields.filter(f => f && f.label).map(f => {
      const t = (f.type || 'text').toLowerCase();
      const label = String(f.label) + (t === 'date' ? ' (DD/MM/YYYY)' : '');
      const val = t === 'yesno' ? '☐ Yes      ☐ No' : (t === 'select' && Array.isArray(f.options) && f.options.length) ? f.options.map(o => '☐ ' + o).join('      ') : '';
      return [label, val];
    });
    return rows.length ? { headers: ['', ''], rows, plain: true, colW: [3400, 5600] } : null;
  };
  // Checklist → a 2-column table with a tick box in a narrow left column and the item text in a wide one.
  const checklistTable = (items) => {
    const rows = items.filter(Boolean).map(it => ['☐', String(it)]);
    return rows.length ? { headers: ['', ''], rows, plain: true, colW: [520, 8480] } : null;
  };
  for (const s of (m.sections || [])) {
    if (!s) continue;
    // Emit each block as its own table so the whole form reads as a structured, fillable table view; the
    // first block carries the section heading and lead-in.
    const blocks = [];
    const ft = (Array.isArray(s.fields) && s.fields.length) ? fieldsTable(s.fields) : null;
    if (ft) blocks.push({ table: ft });
    const ct = (Array.isArray(s.checklist) && s.checklist.length) ? checklistTable(s.checklist) : null;
    if (ct) blocks.push({ table: ct });
    if (s.table && Array.isArray(s.table.headers) && s.table.headers.length) {
      blocks.push({ table: { headers: s.table.headers.map(String), rows: (s.table.rows || []).map(r => s.table.headers.map((_, i) => String((r || [])[i] == null ? '' : (r || [])[i]))) } });
    }
    if (!blocks.length) { if (s.heading || s.intro) sections.push({ heading: s.heading || '', body: s.intro ? String(s.intro) : '', level: 1 }); continue; }
    blocks[0].heading = s.heading || '';
    blocks[0].level = 1;
    if (s.intro) blocks[0].body = String(s.intro);
    for (const b of blocks) sections.push(b);
  }
  return buildDocx(m.title || opts.title || 'Form', sections, {
    type: 'checklist', companyName: opts.companyName || '', companyLogo: opts.companyLogo || '',
    subtitle: m.intro || '', meta: {}
  });
}

// From a .docx that contains SEVERAL forms, produce a NEW .docx holding ONLY the selected form — the body
// blocks (tables + paragraphs) from the selected form's title up to the next form's title — plus the
// document's letterhead (its first table) so the extracted form keeps the company header. Used by the
// "Form (copy exactly)" flow when the user analyses the document and picks one form to create first.
// Best-effort: if the title can't be located, the original buffer is returned unchanged (copy the lot).
function extractDocxFormBody(buf, selectedTitle, allTitles) {
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buf);
    let doc = zip.readAsText('word/document.xml');
    const bodyM = doc.match(/<w:body>([\s\S]*)<\/w:body>/);
    if (!bodyM) return buf;
    const body = bodyM[1];
    // Keep ONLY the final body-level section properties (page setup) at the end. A document with section
    // breaks has many <w:sectPr> (inside paragraph properties), so match just the LAST one that closes the
    // body — anchoring from its position, not the first occurrence (which would swallow most of the body).
    let sectPr = '', bodyNoSect = body;
    const lastSect = body.lastIndexOf('<w:sectPr');
    if (lastSect >= 0) {
      const m = body.slice(lastSect).match(/^<w:sectPr\b[\s\S]*?<\/w:sectPr>\s*$/);
      if (m) { sectPr = m[0]; bodyNoSect = body.slice(0, lastSect); }
    }
    // Ordered top-level blocks (tables + paragraphs).
    const blocks = bodyNoSect.match(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g) || [];
    if (blocks.length < 2) return buf;
    // Tight normalisation drops ALL non-alphanumerics (incl. spaces) so decorative drop-caps that split the
    // first letter into its own run ("A UTHORISATION"), punctuation and spacing differences don't break the
    // match between the AI-detected title and the real heading text.
    const tight = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[^a-z0-9]+/gi, '').toLowerCase();
    const texts = blocks.map(b => tight((b.match(/<w:t[ >][\s\S]*?<\/w:t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join(' ')));
    // The block that is the form's REAL heading is the one most DOMINATED by the title (highest
    // titleLen/blockLen ratio ≈ 1.0 — the block is essentially just the title). This beats a table-of-
    // contents line ("contractor checklist 20" — trailing page number) and a sentence that merely mentions
    // the title. Ties break to the LATER block (real sections come after the contents list).
    const bestIdxOf = (title) => {
      const tN = tight(title);
      if (tN.length < 4) return -1;
      let best = -1, bestScore = 0;
      for (let i = 0; i < texts.length; i++) {
        const tx = texts[i];
        if (!tx || !tx.includes(tN)) continue;
        const score = tN.length / tx.length;
        if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) < 1e-9 && i > best)) { bestScore = score; best = i; }
      }
      // Require a reasonably header-like match (the title dominates the block). A low score means the title
      // only appears inside a sentence — not a real heading — so we can't locate the form reliably.
      return bestScore >= 0.5 ? best : -1;
    };
    const startIdx = bestIdxOf(selectedTitle);
    if (startIdx < 0) return buf;
    // Next-form boundary = the earliest OTHER form's real heading that comes after the selected form.
    let endIdx = blocks.length;
    const selT = tight(selectedTitle);
    for (const t of (Array.isArray(allTitles) ? allTitles : [])) {
      if (tight(t) === selT) continue;
      const i = bestIdxOf(t);
      if (i > startIdx && i < endIdx) endIdx = i;
    }
    const kept = blocks.slice(startIdx, endIdx);
    if (!kept.length) return buf;
    const newBody = kept.join('') + sectPr;
    doc = doc.replace(/<w:body>[\s\S]*<\/w:body>/, () => `<w:body>${newBody}</w:body>`);
    zip.updateFile('word/document.xml', Buffer.from(doc, 'utf8'));
    return zip.toBuffer();
  } catch { return buf; }
}

function cloneDocxAsForm(buf, opts = {}) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(buf);
  const entries = zip.getEntries().map(e => e.entryName);

  // Decode the company logo data URI once (png/jpeg/…).
  let logoBytes = null, logoExt = '';
  const m = String(opts.companyLogo || '').match(/^data:image\/([a-z0-9]+);base64,(.+)$/i);
  if (m) { logoExt = m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase(); logoBytes = Buffer.from(m[2], 'base64'); }

  // Company logo dimensions → keep aspect ratio so the logo isn't stretched into a foreign logo box.
  let logoCx = 1600200, logoCy = 502920; // default ~1.75" x 0.55"
  if (logoBytes) {
    const dims = getImageDimensions(logoBytes, 'image/' + logoExt);
    logoCy = 502920; // ~0.55" tall
    const ar = (dims && dims.width && dims.height) ? dims.width / dims.height : 3;
    logoCx = Math.max(300000, Math.min(Math.round(logoCy * ar), 2743200)); // cap ~3" wide
  }

  const headerParts = entries.filter(n => /^word\/header\d*\.xml$/.test(n));
  let addedLogoName = null;                       // e.g. "media/formLogo.png"
  for (const hp of headerParts) {
    let xml = zip.readAsText(hp);
    if (!/<w:drawing>|<w:pict>/.test(xml)) continue;   // this header has no image → leave it untouched
    if (logoBytes) {
      // Add the company logo as a media part once and declare its type.
      if (!addedLogoName) {
        addedLogoName = 'media/formLogo.' + (logoExt || 'png');
        zip.addFile('word/' + addedLogoName, logoBytes);
        let ct = zip.readAsText('[Content_Types].xml');
        if (!new RegExp('Extension="' + logoExt + '"', 'i').test(ct)) {
          const mime = logoExt === 'jpeg' ? 'image/jpeg' : logoExt === 'png' ? 'image/png' : 'image/' + logoExt;
          ct = ct.replace('</Types>', `<Default Extension="${logoExt}" ContentType="${mime}"/></Types>`);
          zip.updateFile('[Content_Types].xml', Buffer.from(ct, 'utf8'));
        }
      }
      // Ensure the header rels has an image relationship to the company logo; capture/create its id.
      const relPath = hp.replace(/^word\//, 'word/_rels/') + '.rels';
      const relExists = entries.includes(relPath);
      let rels = relExists ? zip.readAsText(relPath)
        : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
      let relId;
      const imgRel = rels.match(/<Relationship\b[^>]*Type="[^"]*\/image"[^>]*\/>/);
      if (imgRel) {
        relId = (imgRel[0].match(/Id="([^"]+)"/) || [])[1] || 'rIdLogo';
        rels = rels.replace(imgRel[0], imgRel[0].replace(/Target="[^"]*"/, `Target="${addedLogoName}"`));
      } else {
        relId = 'rIdLogo';
        while (new RegExp('Id="' + relId + '"').test(rels)) relId += 'x';
        rels = rels.replace('</Relationships>', `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${addedLogoName}"/></Relationships>`);
      }
      if (relExists) zip.updateFile(relPath, Buffer.from(rels, 'utf8')); else zip.addFile(relPath, Buffer.from(rels, 'utf8'));
      // Replace the header with a clean, brand-coloured company letterhead (fixes the distorted logo box).
      zip.updateFile(hp, Buffer.from(_brandedHeaderXml(relId, (opts.companyName || '').trim(), logoCx, logoCy), 'utf8'));
    } else {
      // No company logo — strip the logo drawing/picture but keep the header's text.
      xml = xml.replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, '').replace(/<w:pict>[\s\S]*?<\/w:pict>/g, '');
      zip.updateFile(hp, Buffer.from(xml, 'utf8'));
    }
  }

  // De-brand the text: replace third-party organisation names with the company name across the body,
  // headers and footers (run-level, so layout/fonts are untouched). Auto-detected names come first, then
  // any explicit opts.replacements as extra/manual overrides.
  let replacements = [];
  if (opts.autoDetectOrg && opts.companyName && opts.companyName.trim()) {
    replacements = replacements.concat(_detectOrgReplacements(zip, opts.companyName.trim()));
  }
  if (Array.isArray(opts.replacements)) replacements = replacements.concat(opts.replacements.filter(r => r && r.pattern));
  if (replacements.length) {
    const textParts = entries.filter(n => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n));
    for (const tp of textParts) {
      const before = zip.readAsText(tp);
      const after = _replaceRunText(before, replacements);
      if (after !== before) zip.updateFile(tp, Buffer.from(after, 'utf8'));
    }
  }

  // Apply the user's in-place text edits from Content Studio (each { pattern: old text, replace: new text }).
  // Runs AFTER de-branding so the "old" text matches the de-branded clone — this reflects edits to labels,
  // questions and body lines in the exact-clone output without reflowing the layout.
  if (Array.isArray(opts.editReplacements) && opts.editReplacements.length) {
    const before = zip.readAsText('word/document.xml');
    const after = _replaceRunText(before, opts.editReplacements.filter(r => r && r.pattern));
    if (after !== before) zip.updateFile('word/document.xml', Buffer.from(after, 'utf8'));
  }

  // Apply the brand colour scheme to the (exactly-preserved) tables: recolour the source's shaded header
  // cells to TrainingPro dark-blue with white text. Structure — merges, column widths, fill-in cells — is
  // untouched, so Y/N stay in their narrow right columns, comment cells stay writable, and there are no gaps.
  // Bilingual: append the translated text inline right after each matching English paragraph, so the
  // translation rides along in the very same cell/position — the form's tables and columns are untouched
  // and rows simply grow to fit. Runs added inside a header cell are whitened by the recolour pass below.
  if (Array.isArray(opts.translations) && opts.translations.length) {
    const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const map = new Map();
    for (const p of opts.translations) { const k = norm(p.en); if (k && p.tr && !map.has(k)) map.set(k, String(p.tr)); }
    const langFirst = opts.transSideOrder === 'lang-first';
    const runText = xml => (xml.match(/<w:t[ >][\s\S]*?<\/w:t>/g) || []).map(r => r.replace(/<[^>]+>/g, '')).join('');
    // Join a block's paragraphs with spaces — a table cell often splits e.g. "1" and "Competent…" across
    // paragraphs, so cell text must be compared paragraph-joined (not run-joined) to match the section key.
    const blockKey = block => norm((block.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [block]).map(runText).join(' '));
    const appendToPara = (para, tr) => {
      const safe = String(tr).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      if (langFirst) { // translation first, then English — prepend after pPr (which must stay first)
        const run = `<w:r><w:rPr><w:color w:val="5A6072"/></w:rPr><w:t xml:space="preserve">${safe}   ·   </w:t></w:r>`;
        return /<\/w:pPr>/.test(para) ? para.replace('</w:pPr>', '</w:pPr>' + run) : para.replace(/^(<w:p\b[^>]*>)/, '$1' + run);
      }
      const run = `<w:r><w:rPr><w:color w:val="5A6072"/></w:rPr><w:t xml:space="preserve">   ·   ${safe}</w:t></w:r>`;
      return para.replace(/<\/w:p>$/, run + '</w:p>');
    };
    let doc = zip.readAsText('word/document.xml');
    doc = doc.replace(/(<w:trHeight\b[^>]*w:hRule=")exact(")/g, '$1atLeast$2'); // let rows grow to fit
    // Walk top-level blocks: tables → match each CELL (paragraphs joined); body paragraphs → match the line.
    doc = doc.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g, block => {
      if (block.startsWith('<w:tbl')) {
        return block.replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, tc => {
          const paras = tc.match(/<w:p\b[\s\S]*?<\/w:p>/g);
          if (!paras || !paras.length) return tc;
          const texts = paras.map(p => norm(runText(p)));
          // PER-LINE: if any paragraph text matches a translation (e.g. a label, or each item in a bullet
          // list where the translation preserved line breaks), translate every matching paragraph inline.
          const perLine = texts.some(t => t && map.has(t) && norm(map.get(t)) !== t);
          if (perLine) {
            let idx = -1;
            return tc.replace(/<w:p\b[\s\S]*?<\/w:p>/g, para => {
              idx++;
              const t = texts[idx];
              if (!t) return para;
              const tr = map.get(t);
              if (!tr || norm(tr) === t) return para;
              return appendToPara(para, tr);
            });
          }
          // FALLBACK: whole-cell translation as one block (e.g. a rating "1" + wrapped text whose
          // translation didn't keep the same line count). Keep the number once; honour the column order.
          const key = blockKey(tc);
          const tr = key && map.get(key);
          if (!tr || norm(tr) === key) return tc;
          const nonEmpty = paras.map(p => ({ p, t: norm(runText(p)) })).filter(x => x.t !== '');
          if (!nonEmpty.length) return tc;
          if (nonEmpty.length === 1) {
            const p = nonEmpty[0].p, i = tc.lastIndexOf(p);
            return tc.slice(0, i) + appendToPara(p, tr) + tc.slice(i + p.length);
          }
          const firstNE = nonEmpty[0], lastNE = nonEmpty[nonEmpty.length - 1];
          const numLead = /^\d+$/.test(firstNE.t);
          let trText = String(tr);
          if (numLead) { const s = trText.replace(new RegExp('^\\s*' + firstNE.t + '[\\s.):\\-]*'), ''); if (s.trim()) trText = s; }
          const safe = trText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const transPara = `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:color w:val="5A6072"/></w:rPr><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
          if (langFirst) {
            const at = numLead ? (tc.indexOf(firstNE.p) + firstNE.p.length) : tc.indexOf(firstNE.p);
            return tc.slice(0, at) + transPara + tc.slice(at);
          }
          const at = tc.lastIndexOf(lastNE.p) + lastNE.p.length;
          return tc.slice(0, at) + transPara + tc.slice(at);
        });
      }
      const key = norm(runText(block));
      if (!key) return block;
      const tr = map.get(key);
      if (!tr || norm(tr) === key) return block;
      return appendToPara(block, tr);
    });
    zip.updateFile('word/document.xml', Buffer.from(doc, 'utf8'));
  }

  if (opts.brandTables) {
    const before = zip.readAsText('word/document.xml');
    const after = _brandCloneTables(before);
    if (after !== before) zip.updateFile('word/document.xml', Buffer.from(after, 'utf8'));
    // Footer text keeps the source's colour (e.g. RTIO's brown copyright line) — bring it onto the
    // theme's muted grey (#9CA3AF, matching the branded buildDocx footer) so the footer follows the theme.
    for (const fp of entries.filter(n => /^word\/footer\d*\.xml$/.test(n))) {
      const fb = zip.readAsText(fp);
      // Repoint every existing colour (incl. paragraph-mark properties) to grey, then colour any
      // still-uncoloured text runs — so no source colour (e.g. brown) survives anywhere in the footer.
      let fa = fb.replace(/<w:color w:val="[0-9A-Fa-f]{6}"\s*\/>/g, '<w:color w:val="9CA3AF"/>');
      fa = _recolorRunsColor(fa, '9CA3AF');
      if (fa !== fb) zip.updateFile(fp, Buffer.from(fa, 'utf8'));
    }
  }

  return zip.toBuffer();
}

// Extract text from a .pptx — labels each slide and appends trainer notes if present.
// Lets any AI-generation route accept a PowerPoint as a source document.
function extractPptxText(buf) {
  try {
    const AdmZip = require('adm-zip');
    const z = new AdmZip(buf);
    const entries = z.getEntries();
    const slideEntries = entries
      .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
      .sort((a, b) => {
        const ai = parseInt((a.entryName.match(/slide(\d+)\.xml$/) || [])[1] || '0', 10);
        const bi = parseInt((b.entryName.match(/slide(\d+)\.xml$/) || [])[1] || '0', 10);
        return ai - bi;
      });
    const notesByNum = {};
    entries.filter(e => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(e.entryName)).forEach(e => {
      const n = parseInt((e.entryName.match(/notesSlide(\d+)\.xml$/) || [])[1] || '0', 10);
      const xml = e.getData().toString('utf8');
      const runs = (xml.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g) || []).map(m => m.replace(/<[^>]+>/g, ''));
      notesByNum[n] = runs.join(' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s{2,}/g, ' ').trim();
    });
    return slideEntries.map((e, idx) => {
      const n = parseInt((e.entryName.match(/slide(\d+)\.xml$/) || [])[1] || (idx + 1), 10);
      const xml = e.getData().toString('utf8');
      const runs = (xml.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g) || []).map(m => m.replace(/<[^>]+>/g, ''));
      const text = runs.join('\n').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{2,}/g, '\n').trim();
      const notes = notesByNum[n] || '';
      return `=== Slide ${n} ===\n${text}${notes ? '\n[trainer notes] ' + notes : ''}`;
    }).join('\n\n');
  } catch (e) { return ''; }
}

// ── Enhanced buildDocx ────────────────────────────────────────────────────────
// Supports tables, checklists, callouts, metadata block, page breaks.
// opts: { subtitle, docNumber }
// Safety Prompts legend text (used by buildDocx, and translated by the /save route for Training Manuals).
const SAFETY_PROMPTS_CONTENT = {
  intro: 'Specific prompts are used throughout this document to highlight particular points, particularly those that involve safety. The prompts and their meaning are shown below.',
  rows: [
    { label: 'DANGER',   color: 'C0392B', text: 'This prompt is used when there is an immediate hazard that IS LIKELY TO result in severe personal injury or death if proper procedures are not followed.' },
    { label: 'CAUTION',  color: 'E67E22', text: 'This prompt is used to warn against potentially unsafe practices that COULD result in personal injury or death and/or property damage if correct procedures are not followed.' },
    { label: 'NOTE',     color: '1E3A5F', text: 'This prompt is used when an operation, condition, or information is of sufficient importance to warrant highlighting.' },
    { label: 'ACTIVITY', color: '27AE60', text: 'An activity is a task to be done before continuing; this can be group based, one-on-one, or external research.' },
  ]
};

// ── AKARA Risk Rank Matrix ────────────────────────────────────────────────
// The site risk matrix scores a hazard 1–25 (Likelihood A–E × Consequence 1–5).
// Scores band into four colours per the official matrix. Used to draw a small
// conditionally-formatted risk table whenever a source document carries a score.
function riskBand(score) {
  const n = Number(score);
  if (!Number.isFinite(n) || n < 1)  return { fill: 'E8EAF0', text: '1E3A5F', level: '' };
  if (n <= 5)   return { fill: '8DC63F', text: '1A1A1A', level: 'Low' };       // green
  if (n <= 10)  return { fill: '3C6FC4', text: 'FFFFFF', level: 'Moderate' };  // blue
  if (n <= 17)  return { fill: 'FFF200', text: '1A1A1A', level: 'High' };      // yellow
  return { fill: 'E01B1B', text: 'FFFFFF', level: 'Critical' };               // red (18–25)
}
// A table column whose header names a risk RATING (not a control/hazard/description) — its
// bare 1–25 number cells get matrix colour-coding. Matches "Risk", "Risk Rating/Rank/Score/Level",
// "Initial/Residual Risk", "RR"; excludes control/hazard/description/action columns.
function isRiskRatingHeader(h) {
  const s = String(h || '').toLowerCase().replace(/[^a-z ]/g, ' ');
  if (/control|hazard|descrip|manage|matrix|owner|treatment|mitigat|comment|note|action|person|respons|method|step|task|activit/.test(s)) return false;
  return /\brisk\b/.test(s) || /\brr\b/.test(s);
}
const RISK_LIKELIHOOD = { A: 'Almost Certain', B: 'Likely', C: 'Possible', D: 'Unlikely', E: 'Rare' };
const RISK_CONSEQUENCE = { 1: 'Insignificant', 2: 'Minor', 3: 'Moderate', 4: 'Major', 5: 'Catastrophic' };
// Accept s.risk as a single object or an array; normalise to an array of clean entries.
function normRisk(risk) {
  const arr = Array.isArray(risk) ? risk : (risk ? [risk] : []);
  return arr.map(r => {
    if (!r || typeof r !== 'object') return null;
    const score = Number(r.score != null ? r.score : r.initial);
    const residual = (r.residual != null && r.residual !== '') ? Number(r.residual) : null;
    if (!Number.isFinite(score) && !Number.isFinite(residual)) return null;
    return {
      hazard: r.hazard ? String(r.hazard) : '',
      likelihood: r.likelihood != null ? String(r.likelihood).trim().toUpperCase().slice(0, 1) : '',
      consequence: (r.consequence != null && r.consequence !== '') ? Number(r.consequence) : null,
      score: Number.isFinite(score) ? score : null,
      residual: Number.isFinite(residual) ? residual : null,
      controls: r.controls ? String(r.controls) : '',
    };
  }).filter(Boolean);
}

// The fixed AKARA Risk Rank Matrix as a colour-coded HTML table (uses riskBand for the cell colours).
function akaraMatrixHtml() {
  const e = encodeXml;
  const likelihood = [['A', 'Almost Certain'], ['B', 'Likely'], ['C', 'Possible'], ['D', 'Unlikely'], ['E', 'Rare']];
  const conseq = ['1 - Insignificant', '2 - Minor', '3 - Moderate', '4 - Major', '5 - Catastrophic'];
  const grid = [[11, 16, 20, 23, 25], [7, 12, 17, 21, 24], [4, 8, 13, 18, 22], [2, 5, 9, 14, 19], [1, 3, 6, 10, 15]];
  let h = `<table class="akara-matrix"><thead>`
    + `<tr><th class="mx-title" colspan="6">AKARA RISK RANK MATRIX</th></tr>`
    + `<tr><th>Likelihood</th>${conseq.map(c => `<th>${e(c)}</th>`).join('')}</tr></thead><tbody>`;
  grid.forEach((row, i) => {
    h += `<tr><th class="mx-row">${likelihood[i][0]} - ${e(likelihood[i][1])}</th>`
      + row.map(n => { const b = riskBand(n); return `<td style="background:#${b.fill};color:#${b.text}">${n}</td>`; }).join('')
      + `</tr>`;
  });
  h += `</tbody></table>`;
  const legend = [['1–5', '8DC63F', 'Low'], ['6–10', '3C6FC4', 'Moderate'], ['11–17', 'FFF200', 'High'], ['18–25', 'E01B1B', 'Critical']];
  h += `<div class="mx-legend">` + legend.map(([r, c, l]) => `<span class="mx-leg"><span class="mx-sw" style="background:#${c}"></span>${r} ${l}</span>`).join('') + `</div>`;
  return h;
}

// A label is a TRUE section divider when it is numbered (e.g. "1. …", "2 …", "Section 3", "Part 2",
// "Step 4") OR it is a well-known STRUCTURAL heading (document control, sign-off, authorisation …).
// Anything else the AI tagged as a "section" that is NOT one of these is really a fillable field that
// was mis-classified (so it rendered as a dead header bar with no input) — see normalizeRecordFields.
function _isNumberedSection(label) {
  const l = String(label || '').trim();
  if (/^(section|part|step|stage)?\s*\d+\s*[.\):\-]/i.test(l) || /^\d+\s+[A-Za-z]/.test(l)) return true;
  // Structural headings that carry their own fields underneath (no answer of their own).
  return /^(document control|sign[\s\-]?off|authoris(?:ation|ed by)|authoriz(?:ation|ed by)|approval|review and approval|revision history|record details|declaration|verification)\b/i.test(l);
}
// Risk-level choices follow the AKARA Risk Rank Matrix bands (see riskBand).
const RISK_LEVEL_OPTIONS = ['Low', 'Moderate', 'High', 'Critical'];

// Normalise AI-generated record-form fields so every item is fillable: keep the numbered section
// dividers, but turn any non-numbered "section" into a real field (risk-level items become a
// dropdown; everything else becomes a text field). This rescues the "dead bar" items the AI
// mis-classified (Change Type, MOC Tier, Initial/Residual Risk Level, Approval Authority, …).
function normalizeRecordFields(fields) {
  const out = [];
  for (const f of (Array.isArray(fields) ? fields : [])) {
    if (!f) continue;
    if (f.type === 'section' && !_isNumberedSection(f.label)) {
      const lbl = String(f.label || '');
      if (/risk\s*(level|rating)/i.test(lbl)) out.push({ type: 'select', label: lbl, options: RISK_LEVEL_OPTIONS });
      else if (Array.isArray(f.options) && f.options.length) out.push({ type: 'select', label: lbl, options: f.options });
      else out.push({ type: 'text', label: lbl });
      continue;
    }
    out.push(f);
  }
  return out;
}

// Render a record-form ({name, fields[]}) as a standalone, EDITABLE + printable HTML file:
// every item is a real form control (text/date/number inputs, textareas, Yes/No & rating radios,
// dropdowns) so the end user can fill it in on screen, then Save (💾) or Print. opts.riskMatrix
// appends the colour AKARA matrix; opts.companyLogo shows the company letterhead logo.
function buildRecordFormHtml(data, opts = {}) {
  const e = encodeXml;
  const d = data || {};
  const fields = normalizeRecordFields(Array.isArray(d.fields) ? d.fields : []);
  let body = '';
  let n = 0;
  for (const f of fields) {
    if (!f) continue;
    const label = e(f.label || '');
    if (f.type === 'section') { body += `<h2 class="rf-sec">${label}</h2>`; continue; }
    const id = 'f' + (++n);
    const nm = 'n' + n;
    let input;
    switch (f.type) {
      case 'textarea':
        input = `<textarea id="${id}" rows="3" class="rf-ta"></textarea>`; break;
      case 'checkbox':
      case 'yesno':
        input = `<span class="rf-radset"><label><input type="radio" name="${nm}" value="Yes"> Yes</label>`
              + `<label><input type="radio" name="${nm}" value="No"> No</label></span>`; break;
      case 'competency':
        input = `<span class="rf-radset"><label><input type="radio" name="${nm}" value="Competent"> Competent</label>`
              + `<label><input type="radio" name="${nm}" value="Not Yet Competent"> Not Yet Competent</label></span>`; break;
      case 'rating':
        input = `<span class="rf-radset">` + [1, 2, 3, 4, 5].map(v =>
          `<label><input type="radio" name="${nm}" value="${v}"> ${v}</label>`).join('') + `</span>`; break;
      case 'date':
        input = `<input type="date" id="${id}" class="rf-in rf-date">`; break;
      case 'number':
        input = `<input type="number" id="${id}" class="rf-in rf-short" step="any">`; break;
      case 'signature':
        input = `<input type="text" id="${id}" class="rf-in rf-sign" placeholder="Name / signature">`; break;
      case 'select':
      case 'radio':
        if (Array.isArray(f.options) && f.options.length) {
          input = `<select id="${id}" class="rf-in rf-sel"><option value=""></option>`
                + f.options.map(o => `<option value="${e(String(o))}">${e(String(o))}</option>`).join('') + `</select>`;
        } else {
          input = `<input type="text" id="${id}" class="rf-in">`;
        }
        break;
      default:
        if (Array.isArray(f.options) && f.options.length) {
          input = `<select id="${id}" class="rf-in rf-sel"><option value=""></option>`
                + f.options.map(o => `<option value="${e(String(o))}">${e(String(o))}</option>`).join('') + `</select>`;
        } else {
          input = `<input type="text" id="${id}" class="rf-in">`;
        }
    }
    body += `<div class="rf-field"><label for="${id}">${label}</label><div class="rf-input">${input}</div></div>`;
  }
  const matrix = opts.riskMatrix ? `<div class="rf-matrix"><h2 class="rf-sec">Risk Assessment Matrix</h2>${akaraMatrixHtml()}</div>` : '';
  const title = e(d.name || d.title || 'Record Form');
  const created = e(new Date().toLocaleDateString('en-GB')); // DD/MM/YYYY — the day the form was created
  const orientation = opts.orientation === 'landscape' ? 'landscape' : 'portrait';
  const company = e(opts.companyName || '');
  const logo = (opts.companyLogo && /^data:image\//i.test(opts.companyLogo))
    ? `<img class="rf-logo" src="${opts.companyLogo}" alt="${company || 'Company'} logo">` : '';
  const css = `
    :root{color-scheme:light}
    *{box-sizing:border-box} body{font-family:Segoe UI,Arial,sans-serif;color:#1A1A1A;margin:0;padding:28px 34px;font-size:13px;line-height:1.5}
    .rf-head{display:flex;align-items:center;gap:16px;border-bottom:3px solid #1E3A5F;padding-bottom:8px;margin:0 0 4px}
    .rf-logo{max-height:60px;max-width:200px;object-fit:contain}
    .rf-titles{flex:1}
    h1{font-size:20px;color:#1E3A5F;margin:0}
    .rf-co{color:#5A6072;font-size:12px;margin:2px 0 16px}
    h2.rf-sec{font-size:14px;color:#fff;background:#1E3A5F;padding:6px 10px;border-radius:4px;margin:18px 0 10px}
    .rf-field{display:flex;gap:12px;align-items:center;padding:6px 0;border-bottom:1px dotted #D7DAE3}
    .rf-field label{flex:0 0 38%;font-weight:600;color:#2A3042}
    .rf-input{flex:1}
    .rf-in{width:100%;max-width:520px;padding:5px 8px;border:1px solid #8A90A2;border-radius:4px;font:inherit;color:#1A1A1A;background:#fff}
    .rf-in:focus{outline:2px solid #1E3A5F;border-color:#1E3A5F}
    .rf-date,.rf-short{max-width:220px}.rf-sign{max-width:360px}.rf-sel{max-width:360px}
    .rf-ta{width:100%;max-width:640px;padding:6px 8px;border:1px solid #8A90A2;border-radius:4px;font:inherit;resize:vertical}
    .rf-radset{display:inline-flex;gap:18px;flex-wrap:wrap}
    .rf-radset label{font-weight:500;color:#2A3042;display:inline-flex;align-items:center;gap:5px}
    .rf-bar{position:sticky;top:0;background:#fff;padding:8px 0 12px;display:flex;gap:10px;z-index:5}
    .rf-btn{background:#1E3A5F;color:#fff;border:0;border-radius:5px;padding:8px 16px;font:inherit;font-weight:600;cursor:pointer}
    .rf-btn.sec{background:#fff;color:#1E3A5F;border:1px solid #1E3A5F}
    .rf-note{color:#5A6072;font-size:11px;margin:0 0 12px}
    .rf-matrix{margin-top:22px;page-break-inside:avoid}
    table.akara-matrix{border-collapse:collapse;width:100%;font-size:12px;margin-top:6px}
    .akara-matrix th,.akara-matrix td{border:1px solid #fff;padding:7px 6px;text-align:center}
    .akara-matrix .mx-title{background:#1E3A5F;color:#fff;font-size:14px;letter-spacing:.5px}
    .akara-matrix thead th{background:#1E3A5F;color:#fff}
    .akara-matrix .mx-row{background:#E8EAF0;color:#1E3A5F;text-align:left;font-weight:700}
    .akara-matrix td{font-weight:700}
    .mx-legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;font-size:11px}
    .mx-leg{display:inline-flex;align-items:center;gap:5px}
    .mx-sw{width:14px;height:14px;border-radius:3px;display:inline-block;border:1px solid #ccc}
    .rf-field{break-inside:avoid;page-break-inside:avoid}
    .rf-matrix{break-inside:avoid}
    .rf-foot{margin-top:26px;border-top:1px solid #D7DAE3;padding-top:8px;color:#5A6072;font-size:11px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
    @page{size:A4 ${orientation};margin:14mm 14mm 15mm 14mm;@bottom-right{content:"Page " counter(page) " of " counter(pages);font-size:9pt;color:#5A6072}}
    @media print{body{padding:10mm}.no-print{display:none!important}.rf-in,.rf-ta,.rf-sel{border-color:#8A90A2}}`;
  // Submit button → emails the completed form to the configured recipient (works offline via mailto).
  const rawTitle = String(d.name || d.title || 'Record Form');
  const submitEmail = (opts.submitEmail && /.+@.+\..+/.test(String(opts.submitEmail))) ? String(opts.submitEmail) : '';
  const submitBtn = submitEmail ? `<button type="button" id="rf-submit" class="rf-btn">✅ Submit</button>` : '';
  // Script: Print; and Submit (collect the filled values → open the email client to the recipient).
  const script = `(function(){
    var p=document.getElementById('rf-print'); if(p)p.addEventListener('click',function(){window.print();});
    var sb=document.getElementById('rf-submit');
    if(sb)sb.addEventListener('click',function(){
      var T=${JSON.stringify(rawTitle)}, R=${JSON.stringify(submitEmail)};
      var lines=[];
      document.querySelectorAll('.rf-field').forEach(function(row){
        var lbl=row.querySelector('label'); var label=lbl?lbl.textContent.trim():'';
        var v=''; var inp=row.querySelector('input[type="text"],input[type="date"],input[type="number"],textarea,select');
        if(inp){v=inp.value;} else {var c=row.querySelector('input:checked'); if(c)v=c.value;}
        lines.push(label+': '+v);
      });
      var subject=encodeURIComponent(T+' — '+new Date().toLocaleDateString('en-GB'));
      var body=encodeURIComponent(T+'\\nSubmitted: '+new Date().toLocaleString('en-GB')+'\\n\\n'+lines.join('\\n'));
      window.location.href='mailto:'+R+'?subject='+subject+'&body='+body;
    });
  })();`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${title}</title><style>${css}</style></head><body>`
    + `<div class="rf-bar no-print"><button type="button" id="rf-print" class="rf-btn">🖨 Print / Save as PDF</button>${submitBtn}${submitEmail ? `<span class="rf-note" style="margin:0">Submit emails this form to ${e(submitEmail)}</span>` : ''}</div>`
    + `<div class="rf-head">${logo}<div class="rf-titles"><h1>${title}</h1>${company ? `<p class="rf-co">${company}</p>` : ''}</div></div>`
    + `<p class="rf-note no-print">This form is fillable — type directly into the fields, then Print or Save as PDF.</p>`
    + `<form onsubmit="return false">${body}</form>${matrix}`
    + `<div class="rf-foot"><span>${title}</span><span>Created: ${created}</span></div>`
    + `<script>${script}</script></body></html>`;
}

// Build a standalone, Word-document-style PRINTABLE exam paper (HTML the browser prints / saves as PDF).
// Letterhead (company logo + name + course title), a trainee/trainer details block (names, date,
// signatures, pass mark obtained), then the numbered questions. opts.showAnswers marks the correct
// option(s) for a trainer answer key; without it the paper is blank for trainees to work through.
function buildExamHtml(data, opts = {}) {
  const e = encodeXml;
  const d = data || {};
  const showAnswers = !!opts.showAnswers;
  const questions = Array.isArray(d.questions) ? d.questions : [];
  const passScore = Number(d.passScore) || 80;
  const courseTitle = e(opts.courseTitle || d.title || d.examName || 'Assessment');
  const examName = e(d.examName || d.title || '');
  const company = e(opts.companyName || '');
  const logo = (opts.companyLogo && /^data:image\//i.test(opts.companyLogo))
    ? `<img class="ex-logo" src="${opts.companyLogo}" alt="${company || 'Company'} logo">` : '';

  // Trainee / trainer details block (fill-in on print)
  const line = '<span class="ex-line">&nbsp;</span>';
  const details = `<table class="ex-details"><tbody>
    <tr><td class="ex-dl">Employee First Name</td><td>${line}</td><td class="ex-dl">Employee Last Name</td><td>${line}</td></tr>
    <tr><td class="ex-dl">Employee ID</td><td>${line}</td><td class="ex-dl">Assigned Shift Crew</td><td>${line}</td></tr>
    <tr><td class="ex-dl">Employee Supervisor</td><td>${line}</td><td class="ex-dl">Employee Signature</td><td>${line}</td></tr>
    <tr><td class="ex-dl">Pass Mark Required</td><td>${passScore}%</td><td class="ex-dl">Pass Mark Obtained</td><td><span class="ex-line ex-short">&nbsp;</span> %</td></tr>
    <tr><td class="ex-dl">Result</td><td colspan="3">☐ Competent&nbsp;&nbsp;&nbsp;&nbsp; ☐ Not Yet Competent</td></tr>
    <tr><td class="ex-dl">Trainer Name</td><td>${line}</td><td class="ex-dl">Trainer ID</td><td>${line}</td></tr>
    <tr><td class="ex-dl">Trainer Signature</td><td>${line}</td><td class="ex-dl">Date</td><td><span class="ex-line ex-short">&nbsp;</span> <span class="ex-hint">(DD/MM/YYYY)</span></td></tr>
  </tbody></table>`;

  const instructions = d.instructions
    ? `<div class="ex-instr"><b>Instructions:</b> ${e(String(d.instructions))}</div>` : '';

  // Questions
  const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const qHtml = questions.map((q, qi) => {
    let ans = Array.isArray(q.answers) ? q.answers.slice() : [];
    // Defensive: a True/False question whose options were never saved still prints True / False
    // (preserving any stored correct flag). Prevents blank true/false questions like the MOC Q20.
    const isTF = /true|false|\btf\b/i.test(q.QuestionType || '');
    if (isTF && ans.length < 2) {
      const hasTrue  = ans.find(a => /true/i.test(a.Answer || ''));
      const hasFalse = ans.find(a => /false/i.test(a.Answer || ''));
      ans = [
        hasTrue  || { AnswerLetter: 'A', Answer: 'True',  IsCorrect: 0 },
        hasFalse || { AnswerLetter: 'B', Answer: 'False', IsCorrect: 0 },
      ];
    }
    const opts2 = ans.map((a, ai) => {
      const letter = a.AnswerLetter || letters[ai] || String(ai + 1);
      const correct = showAnswers && (a.IsCorrect === 1 || a.IsCorrect === true);
      const box = correct ? '☑' : '☐';
      return `<div class="ex-opt${correct ? ' ex-correct' : ''}"><span class="ex-box">${box}</span><span class="ex-ol">${e(String(letter))}.</span> ${e(String(a.Answer || ''))}${correct ? ' <span class="ex-tick">✓ correct</span>' : ''}</div>`;
    }).join('');
    const typeHint = /multi/i.test(q.QuestionType || '') ? ' <span class="ex-qtype">(select all that apply)</span>' : '';
    return `<div class="ex-q"><div class="ex-qh"><span class="ex-qn">${qi + 1}.</span> ${e(String(q.Question || ''))}${typeHint}</div><div class="ex-opts">${opts2}</div></div>`;
  }).join('');

  const keyBanner = showAnswers
    ? `<div class="ex-key no-screen-hide">★ TRAINER ANSWER KEY — correct answers are marked. Do not distribute to trainees.</div>` : '';

  // Marking guide: number of questions INCORRECT → score %. Each question is worth 100/total %
  // (e.g. 20 questions → 5% each: 10 wrong = 50%, 5 wrong = 75%, 4 wrong = 80%). Pass rows are green.
  const total = questions.length;
  let markingGuide = '';
  if (total > 0) {
    const cells = [];
    for (let w = 0; w <= total; w++) {
      const pctNum = ((total - w) / total) * 100;
      const pct = Math.round(pctNum * 10) / 10;                 // 1 dp, trims to integer when whole
      const pass = pctNum >= passScore;
      cells.push(`<span class="ex-mg-cell ${pass ? 'ex-mg-pass' : 'ex-mg-fail'}"><b>${w}</b> wrong = ${pct % 1 === 0 ? pct : pct.toFixed(1)}%</span>`);
    }
    const perQ = Math.round((100 / total) * 10) / 10;
    markingGuide = `<div class="ex-mg"><div class="ex-mg-h">Marking Guide — ${total} questions · each worth ${perQ % 1 === 0 ? perQ : perQ.toFixed(1)}% · pass mark ${passScore}%</div>`
      + `<div class="ex-mg-grid">${cells.join('')}</div></div>`;
  }

  const css = `
    @page{size:A4 landscape;margin:12mm}
    :root{color-scheme:light}
    *{box-sizing:border-box} body{font-family:'Segoe UI',Arial,sans-serif;color:#1A1A1A;margin:0;padding:24px 30px;font-size:13px;line-height:1.5}
    .ex-bar{position:sticky;top:0;background:#fff;padding:8px 0 12px;display:flex;gap:12px;align-items:center;z-index:5}
    .ex-btn{background:#1E3A5F;color:#fff;border:0;border-radius:5px;padding:8px 16px;font:inherit;font-weight:600;cursor:pointer}
    .ex-tip{color:#5A6072;font-size:12px}
    .ex-head{display:flex;align-items:center;gap:16px;border-bottom:3px solid #1E3A5F;padding-bottom:10px;margin:0 0 10px}
    .ex-logo{max-height:64px;max-width:220px;object-fit:contain}
    .ex-titles{flex:1}
    h1.ex-course{font-size:21px;color:#1E3A5F;margin:0;line-height:1.25}
    .ex-co{color:#5A6072;font-size:12px;margin:3px 0 0}
    .ex-sub{color:#2A3042;font-size:14px;font-weight:600;margin:3px 0 0}
    .ex-key{background:#FDECEC;border:1px solid #E01B1B;color:#8A1414;font-weight:700;border-radius:5px;padding:7px 12px;margin:12px 0}
    table.ex-details{border-collapse:collapse;width:100%;table-layout:fixed;margin:12px 0 12px;font-size:12.5px}
    .ex-details td{border:1px solid #C9CEDA;padding:8px 10px;vertical-align:middle;height:28px}
    .ex-details .ex-dl{background:#1E3A5F;color:#fff;font-weight:600;width:170px;white-space:nowrap;font-size:12px}
    .ex-line{display:inline-block;border-bottom:1px solid #8A90A2;width:100%;min-height:16px}
    .ex-short{display:inline-block;width:120px;min-width:120px}.ex-hint{color:#8A90A2;font-size:11px}
    .ex-instr{background:#EEF2F9;border:1px solid #D7DAE3;border-radius:6px;padding:9px 13px;margin:0 0 12px;font-size:12.5px}
    .ex-mg{border:1px solid #C9CEDA;border-radius:6px;padding:8px 12px;margin:0 0 14px}
    .ex-mg-h{font-weight:700;color:#1E3A5F;font-size:12.5px;margin-bottom:6px}
    .ex-mg-grid{display:flex;flex-wrap:wrap;gap:5px}
    .ex-mg-cell{font-size:11.5px;padding:3px 8px;border-radius:4px;border:1px solid #D7DAE3;white-space:nowrap}
    .ex-mg-pass{background:#EAF7EF;color:#1E7A44;border-color:#BfE6CE}
    .ex-mg-fail{background:#FDECEC;color:#8A1414;border-color:#F3C9C9}
    .ex-questions{column-count:1}
    .ex-q{margin:0 0 16px;padding:0 0 8px;page-break-inside:avoid;break-inside:avoid;border-bottom:1px solid #E3E6EE}
    .ex-qh{font-weight:600;color:#2A3042;margin-bottom:8px;line-height:1.45}
    .ex-qn{color:#1E3A5F;margin-right:5px}
    .ex-qtype{font-weight:400;color:#8A90A2;font-size:11px}
    .ex-opts{padding-left:24px}
    .ex-opt{padding:5px 0;font-size:12.5px;line-height:1.45}
    .ex-box{display:inline-block;width:20px;font-size:15px}.ex-ol{font-weight:600;color:#5A6072;margin-right:4px}
    .ex-correct{background:#EAF7EF;border-radius:4px;padding:2px 6px 2px 4px}
    .ex-tick{color:#1E7A44;font-weight:700;font-size:11px;margin-left:4px}
    @media print{body{padding:0}.no-print{display:none!important}.ex-q{break-inside:avoid;page-break-inside:avoid}}`;
  const script = `(function(){var p=document.getElementById('ex-print');if(p)p.addEventListener('click',function(){window.print();});})();`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${courseTitle}${showAnswers ? ' — Answer Key' : ''}</title><style>${css}</style></head><body>`
    + `<div class="ex-bar no-print"><button type="button" id="ex-print" class="ex-btn">🖨 Print / Save as PDF</button>`
    + `<span class="ex-tip">Printing: choose <b>Landscape</b> (already set), <b>One-sided</b> (single-sided), and turn off the browser's Headers &amp; footers.</span></div>`
    + `<div class="ex-head">${logo}<div class="ex-titles"><h1 class="ex-course">${courseTitle}</h1>${company ? `<p class="ex-co">${company}</p>` : ''}${examName && examName !== courseTitle ? `<p class="ex-sub">Assessment: ${examName}</p>` : ''}</div></div>`
    + keyBanner + details + instructions + markingGuide
    + `<div class="ex-questions">${qHtml || '<p>This exam has no questions yet.</p>'}</div>`
    + `<script>${script}</script></body></html>`;
}

// Convert a record-form definition ({name, fields[]}) into buildDocx `{title, sections}` so a
// record form can be emitted as a proper Word document (with the fill-in grid laid out as a
// borderless two-column table), rather than going through the Form Builder. Fields are grouped
// under `section`-type dividers; each field becomes a label row with a response placeholder.
function recordFormToDocx(data = {}) {
  const fields = normalizeRecordFields(Array.isArray(data.fields) ? data.fields : []);
  const placeholder = (f) => {
    switch (f.type) {
      case 'yesno':
      case 'checkbox': return '☐ Yes      ☐ No';
      case 'competency': return '☐ Competent      ☐ Not Yet Competent';
      case 'rating': return '☐ 1    ☐ 2    ☐ 3    ☐ 4    ☐ 5';
      case 'date': return '____ / ____ / ________   (DD/MM/YYYY)';
      case 'signature': return '';
      case 'textarea': return '';
      default:
        if (Array.isArray(f.options) && f.options.length) return f.options.map(o => '☐ ' + o).join('      ');
        return '';
    }
  };
  const sections = [];
  let cur = null;
  const flush = () => { if (cur && cur._rows.length) { cur.table = { headers: ['Field', 'Response'], rows: cur._rows, plain: true }; delete cur._rows; sections.push(cur); } cur = null; };
  for (const f of fields) {
    if (!f) continue;
    if (f.type === 'section') { flush(); cur = { heading: f.label || 'Section', _rows: [] }; continue; }
    if (!cur) cur = { heading: '', _rows: [] };
    cur._rows.push([String(f.label || ''), placeholder(f)]);
  }
  flush();
  if (!sections.length && fields.length === 0) sections.push({ heading: '', body: '' });
  return { title: data.name || data.title || 'Record Form', sections };
}

// Build a minimal, valid .xlsx (SpreadsheetML) for a fillable form ({name, fields[]}).
// Each field is a labelled row with a bordered fill-in cell; sections are dark header rows.
// Hand-rolled (like buildDocx for .docx) and zipped with adm-zip — no Excel library needed.
function buildExcelForm(data, opts = {}) {
  const AdmZip = require('adm-zip');
  const e = encodeXml;
  const d = data || {};
  const fields = Array.isArray(d.fields) ? d.fields : [];
  const title = d.name || d.title || 'Form';

  // Style indices (must match styles.xml below):
  //  0 default · 1 title · 2 section header (white on blue) · 3 bold label · 4 input box · 5 hint
  //  6 register header (white on blue, bordered, centred, wrap) · 7 register data cell (bordered, wrap)
  const rows = [];
  const merges = [];
  let r = 1;
  const inlineCell = (col, row, style, text) =>
    `<c r="${col}${row}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${e(text)}</t></is></c>`;
  const blankCell = (col, row, style) => `<c r="${col}${row}" s="${style}"/>`;
  // A formula cell (e.g. COUNTIF/COUNTA) with a cached 0 — Excel recalculates it on open.
  const fCell = (col, row, style, formula) => `<c r="${col}${row}"${style ? ` s="${style}"` : ''}><f>${e(formula)}</f><v>0</v></c>`;
  // Excel column letter for a 1-based index (1→A … 26→Z, 27→AA …) — registers can be >26 columns wide.
  const colLetter = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

  // Company logo (letterhead) — parse the data URL, size it (cap height), and reserve a top band so
  // the image floats above the title without overlapping it. Embedded as a worksheet drawing below.
  const EMU_PER_PX = 9525;
  let logoImg = null; // { buf, ext, mime, cx, cy, rowPt }
  if (opts.companyLogo) {
    const m = String(opts.companyLogo).match(/^data:(image\/(png|jpeg|jpg|gif|webp));base64,(.+)$/i);
    if (m) {
      const mime = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
      const ext = mime === 'image/jpeg' ? 'jpeg' : mime.split('/')[1];
      const buf = Buffer.from(m[3], 'base64');
      const dim = getImageDimensions(buf, mime) || { width: 160, height: 60 };
      const maxH = 64, maxW = 240;
      let wpx = dim.width, hpx = dim.height;
      const scale = Math.min(maxH / hpx, maxW / wpx, 1);
      wpx = Math.round(wpx * scale); hpx = Math.round(hpx * scale);
      logoImg = { buf, ext, mime, cx: wpx * EMU_PER_PX, cy: hpx * EMU_PER_PX, rowPt: Math.ceil(hpx * 0.75) + 6 };
    }
  }
  // Reserve the top band row for the logo (its anchor sits at row 0, col 0).
  if (logoImg) {
    rows.push(`<row r="${r}" ht="${logoImg.rowPt}" customHeight="1"></row>`);
    r++;
  }

  // A REGISTER / LOG / TRACKER layout: column headers across the top, with blank rows to log many
  // entries (e.g. a Management of Change register). Columns come from data.columns, else from the
  // (non-section) fields. Otherwise fall through to the vertical single-record fillable form.
  const isRegister = d.layout === 'register' || d.type === 'register' || Array.isArray(d.columns);
  const regCols = isRegister
    ? (Array.isArray(d.columns) && d.columns.length
        ? d.columns.map(c => (typeof c === 'string' ? { label: c } : (c || {})))
        : fields.filter(f => f && f.type !== 'section').map(f => ({ label: f.label || '', options: f.options })))
    : null;
  let colsXml;
  let dashInfo = null; // { firstData, lastData, cols } — for the optional dashboard sheet

  if (isRegister && regCols && regCols.length) {
    const nCols = regCols.length;
    const lastCol = colLetter(nCols);
    // Title row across the whole table
    rows.push(`<row r="${r}" ht="26" customHeight="1">${inlineCell('A', r, 1, title)}${Array.from({ length: nCols - 1 }, (_, i) => blankCell(colLetter(i + 2), r, 1)).join('')}</row>`);
    merges.push(`A${r}:${lastCol}${r}`); r++;
    if (opts.companyName) { rows.push(`<row r="${r}">${inlineCell('A', r, 5, opts.companyName)}${Array.from({ length: nCols - 1 }, (_, i) => blankCell(colLetter(i + 2), r, 5)).join('')}</row>`); merges.push(`A${r}:${lastCol}${r}`); r++; }
    // Optional instruction / notes line(s)
    const notes = Array.isArray(d.notes) ? d.notes : (d.description ? [String(d.description)] : []);
    for (const note of notes) { rows.push(`<row r="${r}">${inlineCell('A', r, 5, String(note))}${Array.from({ length: nCols - 1 }, (_, i) => blankCell(colLetter(i + 2), r, 5)).join('')}</row>`); merges.push(`A${r}:${lastCol}${r}`); r++; }
    r++; // spacer
    // Column header row
    const headerRow = r;
    rows.push(`<row r="${r}" ht="30" customHeight="1">`
      + regCols.map((c, i) => inlineCell(colLetter(i + 1), r, 6, String(c.label || ''))).join('') + `</row>`);
    r++;
    // Blank data rows for logging entries
    const nData = Math.min(Math.max(parseInt(d.rowsToProvide, 10) || 20, 5), 200);
    const firstDataRow = r;
    for (let k = 0; k < nData; k++) {
      rows.push(`<row r="${r}" ht="20" customHeight="1">`
        + regCols.map((c, i) => blankCell(colLetter(i + 1), r, 7)).join('') + `</row>`);
      r++;
    }
    dashInfo = { headerRow, firstData: firstDataRow, lastData: r - 1, cols: regCols };
    // Column widths: scale to header length (min 12, max 32)
    colsXml = '<cols>' + regCols.map((c, i) => {
      const w = Math.min(Math.max(String(c.label || '').length + 3, 12), 32);
      return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
    }).join('') + '</cols>';
  } else {
    // Title row (merged A:C)
    rows.push(`<row r="${r}" ht="26" customHeight="1">${inlineCell('A', r, 1, title)}${blankCell('B', r, 1)}${blankCell('C', r, 1)}</row>`);
    merges.push(`A${r}:C${r}`);
    r++;
    if (opts.companyName) { rows.push(`<row r="${r}">${inlineCell('A', r, 5, opts.companyName)}${blankCell('B', r, 5)}${blankCell('C', r, 5)}</row>`); merges.push(`A${r}:C${r}`); r++; }
    r++; // spacer row

    for (const f of fields) {
      if (!f) continue;
      const label = String(f.label || '');
      if (f.type === 'section') {
        rows.push(`<row r="${r}" ht="20" customHeight="1">${inlineCell('A', r, 2, label)}${blankCell('B', r, 2)}${blankCell('C', r, 2)}</row>`);
        merges.push(`A${r}:C${r}`);
        r++;
        continue;
      }
      let hint = '';
      if (f.type === 'yesno' || f.type === 'checkbox') hint = 'Yes / No';
      else if (f.type === 'competency') hint = 'Competent / Not Yet Competent';
      else if (f.type === 'rating') hint = '1 – 5';
      else if (f.type === 'date') hint = 'DD/MM/YYYY';
      else if (f.type === 'signature') hint = 'Signature';
      else if (Array.isArray(f.options) && f.options.length) hint = f.options.join(' / ');
      // label in A (merged A:B is overkill); put label in A, input box spanning B:C
      rows.push(`<row r="${r}" ht="22" customHeight="1">`
        + inlineCell('A', r, 3, label)
        + blankCell('B', r, 4) + blankCell('C', r, 4)
        + (hint ? inlineCell('D', r, 5, '(' + hint + ')') : '')
        + `</row>`);
      merges.push(`B${r}:C${r}`);
      r++;
    }
    colsXml = '<cols><col min="1" max="1" width="34" customWidth="1"/><col min="2" max="3" width="24" customWidth="1"/><col min="4" max="4" width="22" customWidth="1"/></cols>';
  }

  const sheetData = rows.join('');
  const mergeXml = merges.length ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
  // The <drawing> element (if a logo) must come AFTER mergeCells in the worksheet schema order.
  const drawingTag = logoImg ? '<drawing r:id="rId1"/>' : '';
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${colsXml}
<sheetData>${sheetData}</sheetData>${mergeXml}${drawingTag}</worksheet>`;

  // ---- Optional Dashboard sheet (live, auto-updating formulas over the Register) ----
  // Enabled only for a register layout when opts.dashboard is set. It uses COUNTA for the running
  // total and COUNTIF breakdowns for every column that has a fixed option list, plus data bars so
  // the counts update the moment data is typed into the Register — no macros required.
  const wantDash = !!opts.dashboard && isRegister && dashInfo && dashInfo.cols && dashInfo.cols.length;
  let dashSheet = null;
  if (wantDash) {
    const SH = 'Register';
    const firstCol = colLetter(1); // first register column = key column for the record count
    const dRows = [];
    const dMerges = [];
    const barCells = []; // B-column count cells that get a data bar
    let dr = 1;
    // Title
    dRows.push(`<row r="${dr}" ht="30" customHeight="1">${inlineCell('A', dr, 1, (title || 'Register') + ' — Dashboard')}${blankCell('B', dr, 1)}${blankCell('C', dr, 1)}${blankCell('D', dr, 1)}</row>`);
    dMerges.push(`A${dr}:D${dr}`); dr++;
    dRows.push(`<row r="${dr}" ht="18" customHeight="1">${inlineCell('A', dr, 5, 'Live summary — updates automatically as entries are added to the Register sheet.')}${blankCell('B', dr, 5)}${blankCell('C', dr, 5)}${blankCell('D', dr, 5)}</row>`);
    dMerges.push(`A${dr}:D${dr}`); dr++;
    dr++; // spacer
    // Running total of records
    dRows.push(`<row r="${dr}" ht="22" customHeight="1">${inlineCell('A', dr, 3, 'Total records entered')}${fCell('B', dr, 0, `COUNTA(${SH}!${firstCol}${dashInfo.firstData}:${firstCol}${dashInfo.lastData})`)}</row>`);
    dr++; dr++; // blank line after total
    // Per-option breakdown for every column that carries a fixed option list
    for (let ci = 0; ci < dashInfo.cols.length; ci++) {
      const col = dashInfo.cols[ci];
      const opts2 = Array.isArray(col.options) ? col.options.filter(o => o != null && String(o).trim() !== '') : [];
      if (!opts2.length) continue;
      const colL = colLetter(ci + 1);
      // Block header (column label + "Count")
      dRows.push(`<row r="${dr}" ht="20" customHeight="1">${inlineCell('A', dr, 6, String(col.label || ''))}${inlineCell('B', dr, 6, 'Count')}</row>`);
      dr++;
      for (const opt of opts2) {
        const ov = String(opt).replace(/"/g, '').trim();
        dRows.push(`<row r="${dr}" ht="18" customHeight="1">${inlineCell('A', dr, 7, ov)}${fCell('B', dr, 7, `COUNTIF(${SH}!${colL}${dashInfo.firstData}:${colL}${dashInfo.lastData},"${ov}")`)}</row>`);
        barCells.push('B' + dr);
        dr++;
      }
      dr++; // spacer between blocks
    }
    const dSheetData = dRows.join('');
    const dMergeXml = dMerges.length ? `<mergeCells count="${dMerges.length}">${dMerges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    const dCondFmt = barCells.length
      ? `<conditionalFormatting sqref="${barCells.join(' ')}"><cfRule type="dataBar" priority="1"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF1E3A5F"/></dataBar></cfRule></conditionalFormatting>`
      : '';
    const dCols = '<cols><col min="1" max="1" width="40" customWidth="1"/><col min="2" max="2" width="14" customWidth="1"/></cols>';
    dashSheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${dCols}
<sheetData>${dSheetData}</sheetData>${dMergeXml}${dCondFmt}</worksheet>`;
  }

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="5">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="16"/><color rgb="FF1E3A5F"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FF2A3042"/><name val="Calibri"/></font>
<font><i/><sz val="9"/><color rgb="FF8A90A2"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1E3A5F"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FF8A90A2"/></left><right style="thin"><color rgb="FF8A90A2"/></right><top style="thin"><color rgb="FF8A90A2"/></top><bottom style="thin"><color rgb="FF8A90A2"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="8">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>${logoImg ? `
<Default Extension="${logoImg.ext}" ContentType="${logoImg.mime}"/>
<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>` : ''}
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${dashSheet ? `
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` : ''}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${isRegister ? 'Register' : 'Form'}" sheetId="1" r:id="rId1"/>${dashSheet ? `<sheet name="Dashboard" sheetId="2" r:id="rId3"/>` : ''}</sheets>${dashSheet ? `
<calcPr fullCalcOnLoad="1"/>` : ''}
</workbook>`;
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${dashSheet ? `
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>` : ''}
</Relationships>`;

  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(contentTypes, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(rootRels, 'utf8'));
  zip.addFile('xl/workbook.xml', Buffer.from(workbook, 'utf8'));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(workbookRels, 'utf8'));
  zip.addFile('xl/styles.xml', Buffer.from(styles, 'utf8'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(sheet, 'utf8'));
  if (dashSheet) zip.addFile('xl/worksheets/sheet2.xml', Buffer.from(dashSheet, 'utf8'));

  // Company logo: worksheet drawing anchored at the top-left band (one-cell anchor, row 0, col 0).
  if (logoImg) {
    const sheetRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`;
    const drawing = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
<xdr:oneCellAnchor>
<xdr:from><xdr:col>0</xdr:col><xdr:colOff>45720</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>22860</xdr:rowOff></xdr:from>
<xdr:ext cx="${logoImg.cx}" cy="${logoImg.cy}"/>
<xdr:pic>
<xdr:nvPicPr><xdr:cNvPr id="1" name="Company Logo"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${logoImg.cx}" cy="${logoImg.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
</xdr:pic>
<xdr:clientData/>
</xdr:oneCellAnchor>
</xdr:wsDr>`;
    const drawingRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.${logoImg.ext}"/>
</Relationships>`;
    zip.addFile('xl/worksheets/_rels/sheet1.xml.rels', Buffer.from(sheetRels, 'utf8'));
    zip.addFile('xl/drawings/drawing1.xml', Buffer.from(drawing, 'utf8'));
    zip.addFile('xl/drawings/_rels/drawing1.xml.rels', Buffer.from(drawingRels, 'utf8'));
    zip.addFile('xl/media/image1.' + logoImg.ext, logoImg.buf);
  }
  return zip.toBuffer();
}

function buildDocx(title, sections, opts = {}) {
  const e = encodeXml;

  function r(text, rPr) {
    return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${e(text)}</w:t></w:r>`;
  }
  function p(content, pPr) {
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${content}</w:p>`;
  }
  const pageBreak = () => `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
  const empty     = () => `<w:p><w:pPr><w:spacing w:after="100"/></w:pPr></w:p>`;

  const BORDERS = `<w:tblBorders>
    <w:top    w:val="single" w:sz="4" w:space="0" w:color="D7DAE3"/>
    <w:left   w:val="single" w:sz="4" w:space="0" w:color="D7DAE3"/>
    <w:bottom w:val="single" w:sz="4" w:space="0" w:color="D7DAE3"/>
    <w:right  w:val="single" w:sz="4" w:space="0" w:color="D7DAE3"/>
    <w:insideH w:val="single" w:sz="4" w:space="0" w:color="D7DAE3"/>
    <w:insideV w:val="single" w:sz="4" w:space="0" w:color="D7DAE3"/>
  </w:tblBorders>`;

  // plain = reproduce a form/layout grid faithfully: no shaded/bold header row, no zebra striping —
  // every row is rendered identically (used by the "Form — exact copy" path so the output matches
  // the uploaded document instead of being restyled as a branded data table).
  function tbl(headers, rows, plain, colWOverride) {
    const cols = Math.max(1, (headers || []).length);
    const W = 9000;
    // Per-column widths from the header names: a Yes/No column stays narrow, a Comments/Notes column gets
    // the room; everything else shares the balance. Tables without those headers keep equal columns.
    const _hw = (headers || []).map(h => String(h || '').toLowerCase());
    const _isYesNo = t => /yes\s*\/?\s*no|^\s*y\s*\/\s*n\s*$|yes or no/.test(t);
    const _isComment = t => /comment|notes?\b|remark/.test(t);
    const _fixedW = _hw.map(t => _isYesNo(t) ? 1000 : /\bdate\b/.test(t) ? 1250 : null);
    const _weights = _hw.map((t, i) => _fixedW[i] != null ? 0 : (_isComment(t) ? 2 : 1));
    const _wSum = _weights.reduce((a, b) => a + b, 0) || 1;
    const _remain = Math.max(0, W - _fixedW.reduce((a, w) => a + (w || 0), 0));
    const colW = _hw.map((t, i) => _fixedW[i] != null ? _fixedW[i] : Math.max(700, Math.floor(_remain * _weights[i] / _wSum)));
    // Caller-supplied exact column widths (used by form tables: narrow tick column, wide value column).
    if (Array.isArray(colWOverride) && colWOverride.length === cols) for (let i = 0; i < cols; i++) colW[i] = colWOverride[i];
    // Columns whose header names a risk RATING — their bare 1–25 cells get matrix colours.
    const riskCols = (headers || []).map(h => isRiskRatingHeader(h));
    function tc(text, isHdr, opt, ci) {
      const styleHdr = isHdr && !plain;
      const cw = colW[ci] != null ? colW[ci] : Math.floor(W / cols);
      let fill = styleHdr ? `<w:shd w:val="clear" w:color="auto" w:fill="1E3A5F"/>` : '';
      let rPr  = styleHdr ? '<w:b/><w:color w:val="FFFFFF"/><w:sz w:val="18"/><w:szCs w:val="18"/>' : '<w:sz w:val="18"/><w:szCs w:val="18"/>';
      let jc = '';
      if (opt && opt.fill) {  // risk-rating cell — shade per band, bold, centred
        fill = `<w:shd w:val="clear" w:color="auto" w:fill="${opt.fill}"/>`;
        rPr  = `<w:b/><w:color w:val="${opt.text}"/><w:sz w:val="18"/><w:szCs w:val="18"/>`;
        jc = '<w:jc w:val="center"/>';
      }
      return `<w:tc><w:tcPr><w:tcW w:w="${cw}" w:type="dxa"/>${fill}
        <w:tcMar><w:top w:w="60" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar>
      </w:tcPr><w:p>${jc ? `<w:pPr>${jc}</w:pPr>` : ''}<w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${e(text)}</w:t></w:r></w:p></w:tc>`;
    }
    // A bare risk score 1–25 in a risk-rating column → band colour override.
    const riskOpt = (val, ci) => {
      if (!riskCols[ci]) return null;
      const m = String(val).trim().match(/^(\d{1,2})$/);
      if (!m) return null;
      const n = parseInt(m[1], 10);
      if (n < 1 || n > 25) return null;
      const b = riskBand(n);
      return { fill: b.fill, text: b.text };
    };
    // tblHeader => Word repeats this header row at the top of every page the table spans (styled tables only)
    // A plain form table whose headers are all blank skips the header row entirely (clean data-only grid).
    const _hasHeaderText = (headers || []).some(h => String(h || '').trim());
    const headerRow = (plain && !_hasHeaderText) ? ''
      : plain
      ? `<w:tr>${(headers || []).map((h, ci) => tc(h, false, null, ci)).join('')}</w:tr>`
      : `<w:tr><w:trPr><w:tblHeader/></w:trPr>${(headers || []).map((h, ci) => tc(h, true, null, ci)).join('')}</w:tr>`;
    const dataRows  = (rows || []).map((row, ri) => {
      const shade = (!plain && ri % 2 === 1) ? `<w:trPr><w:shd w:val="clear" w:color="auto" w:fill="F6F7FB"/></w:trPr>` : '';
      const cells = (headers || []).map((_, ci) => {
        const val = (row || [])[ci] || '';
        return tc(val, false, riskOpt(val, ci), ci);
      }).join('');
      return `<w:tr>${shade}${cells}</w:tr>`;
    }).join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="${W}" w:type="dxa"/>${BORDERS}</w:tblPr>${headerRow}${dataRows}</w:tbl>`;
  }

  // Small conditionally-formatted risk-assessment table. `risk` is one entry or an
  // array; each score cell is shaded per the AKARA Risk Rank Matrix (see riskBand).
  function riskTbl(risk) {
    const entries = normRisk(risk);
    if (!entries.length) return '';
    const showHazard   = entries.some(x => x.hazard);
    const showLike     = entries.some(x => x.likelihood);
    const showConseq   = entries.some(x => Number.isFinite(x.consequence));
    const showResidual = entries.some(x => Number.isFinite(x.residual));
    const cols = [
      ...(showHazard ? [{ key: 'hazard', label: 'Hazard', w: 3400 }] : []),
      ...(showLike ? [{ key: 'likelihood', label: 'Likelihood', w: 1700 }] : []),
      ...(showConseq ? [{ key: 'consequence', label: 'Consequence', w: 1700 }] : []),
      { key: 'score', label: 'Risk Rating', w: showResidual ? 1200 : 1500 },
      ...(showResidual ? [{ key: 'residual', label: 'Residual Risk', w: 1400 }] : []),
    ];
    const W = 9000;
    const MAR = `<w:tcMar><w:top w:w="50" w:type="dxa"/><w:left w:w="110" w:type="dxa"/><w:bottom w:w="50" w:type="dxa"/><w:right w:w="110" w:type="dxa"/></w:tcMar>`;
    const hdrCell = (c) => `<w:tc><w:tcPr><w:tcW w:w="${c.w}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="1E3A5F"/>${MAR}<w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr><w:t xml:space="preserve">${e(c.label)}</w:t></w:r></w:p></w:tc>`;
    const titleCell = `<w:tc><w:tcPr><w:tcW w:w="${W}" w:type="dxa"/><w:gridSpan w:val="${cols.length}"/><w:shd w:val="clear" w:color="auto" w:fill="1E3A5F"/>${MAR}</w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t xml:space="preserve">Risk Assessment</w:t></w:r></w:p></w:tc>`;
    const dataCell = (c, x) => {
      if (c.key === 'score' || c.key === 'residual') {
        const val = c.key === 'score' ? x.score : x.residual;
        if (!Number.isFinite(val)) return `<w:tc><w:tcPr><w:tcW w:w="${c.w}" w:type="dxa"/>${MAR}<w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t>—</w:t></w:r></w:p></w:tc>`;
        const b = riskBand(val);
        return `<w:tc><w:tcPr><w:tcW w:w="${c.w}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="${b.fill}"/>${MAR}<w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="${b.text}"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">${val}</w:t></w:r></w:p><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="${b.text}"/><w:sz w:val="13"/><w:szCs w:val="13"/></w:rPr><w:t xml:space="preserve">${e(b.level)}</w:t></w:r></w:p></w:tc>`;
      }
      let txt = '';
      if (c.key === 'hazard') txt = x.hazard || '';
      else if (c.key === 'likelihood') txt = x.likelihood ? `${x.likelihood}${RISK_LIKELIHOOD[x.likelihood] ? ' – ' + RISK_LIKELIHOOD[x.likelihood] : ''}` : '';
      else if (c.key === 'consequence') txt = Number.isFinite(x.consequence) ? `${x.consequence}${RISK_CONSEQUENCE[x.consequence] ? ' – ' + RISK_CONSEQUENCE[x.consequence] : ''}` : '';
      const jc = c.key === 'hazard' ? '' : '<w:jc w:val="center"/>';
      return `<w:tc><w:tcPr><w:tcW w:w="${c.w}" w:type="dxa"/>${MAR}<w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr>${jc}<w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:sz w:val="17"/><w:szCs w:val="17"/></w:rPr><w:t xml:space="preserve">${e(txt)}</w:t></w:r></w:p></w:tc>`;
    };
    const titleRow = `<w:tr>${titleCell}</w:tr>`;
    const headRow  = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cols.map(hdrCell).join('')}</w:tr>`;
    const bodyRows = entries.map(x => `<w:tr>${cols.map(c => dataCell(c, x)).join('')}</w:tr>`).join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="${W}" w:type="dxa"/>${BORDERS}</w:tblPr>${titleRow}${headRow}${bodyRows}</w:tbl>`;
  }

  // The fixed AKARA Risk Rank Matrix as a colour-coded OOXML table (Likelihood A–E × Consequence 1–5).
  function akaraMatrixTbl() {
    const W = 9000, c0 = 2400, cN = Math.floor((W - c0) / 5);
    const MAR = `<w:tcMar><w:top w:w="40" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tcMar>`;
    const cell = (w, fill, color, bold, text, span) =>
      `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${span ? `<w:gridSpan w:val="${span}"/>` : ''}${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` : ''}${MAR}<w:vAlign w:val="center"/></w:tcPr>`
      + `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr><w:r><w:rPr>${bold ? '<w:b/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}<w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t xml:space="preserve">${e(text)}</w:t></w:r></w:p></w:tc>`;
    const likelihood = ['A - Almost Certain', 'B - Likely', 'C - Possible', 'D - Unlikely', 'E - Rare'];
    const conseq = ['1 - Insignificant', '2 - Minor', '3 - Moderate', '4 - Major', '5 - Catastrophic'];
    const grid = [[11, 16, 20, 23, 25], [7, 12, 17, 21, 24], [4, 8, 13, 18, 22], [2, 5, 9, 14, 19], [1, 3, 6, 10, 15]];
    const titleRow = `<w:tr>${cell(W, '1E3A5F', 'FFFFFF', true, 'AKARA RISK RANK MATRIX', 6)}</w:tr>`;
    const headRow = `<w:tr>${cell(c0, '1E3A5F', 'FFFFFF', true, 'Likelihood')}${conseq.map(c => cell(cN, '1E3A5F', 'FFFFFF', true, c)).join('')}</w:tr>`;
    const dataRows = grid.map((row, i) =>
      `<w:tr>${cell(c0, 'E8EAF0', '1E3A5F', true, likelihood[i])}${row.map(n => { const b = riskBand(n); return cell(cN, b.fill, b.text, true, String(n)); }).join('')}</w:tr>`).join('');
    return `<w:tbl><w:tblPr><w:tblW w:w="${W}" w:type="dxa"/>${BORDERS}</w:tblPr>${titleRow}${headRow}${dataRows}</w:tbl>`;
  }

  function metaTbl(o = {}) {
    const m = o.meta || {};
    const status   = m.status || 'Draft';
    const tLang    = o.transLang || '';
    const statusRow = ['Draft', 'Under Review', 'Approved'].map(s => (s === status ? '☑' : '☐') + '  ' + s).join('     ');

    const W  = 9000;
    const cw = Math.floor(W / 4);   // 4 columns: label | name/title | signature | date
    const MAR = `<w:tcMar><w:top w:w="60" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar>`;
    const SMAR = `<w:tcMar><w:top w:w="40" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar>`;

    // Dark blue label cell (left column)
    function lblCell(text) {
      return `<w:tc><w:tcPr><w:tcW w:w="${cw}" w:type="dxa"/>
        <w:shd w:val="clear" w:color="auto" w:fill="1E3A5F"/>${MAR}
      </w:tcPr><w:p><w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>
        <w:t xml:space="preserve">${e(text)}</w:t></w:r></w:p></w:tc>`;
    }
    // Merged value cell spanning 3 remaining columns
    function spanCell(text) {
      return `<w:tc><w:tcPr><w:tcW w:w="${cw * 3}" w:type="dxa"/>
        <w:gridSpan w:val="3"/>${MAR}
      </w:tcPr><w:p><w:r><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>
        <w:t xml:space="preserve">${e(text)}</w:t></w:r></w:p></w:tc>`;
    }
    // Regular value cell (single column)
    function valCell(text, rPrExtra) {
      const rpr = `<w:sz w:val="18"/><w:szCs w:val="18"/>${rPrExtra || ''}`;
      return `<w:tc><w:tcPr><w:tcW w:w="${cw}" w:type="dxa"/>${MAR}
      </w:tcPr><w:p><w:r><w:rPr>${rpr}</w:rPr>
        <w:t xml:space="preserve">${e(text)}</w:t></w:r></w:p></w:tc>`;
    }
    // Sub-header cell for signature block
    function subHdrCell(text, isLbl) {
      const fill = isLbl ? '1E3A5F' : 'EEF1F7';
      const clr  = isLbl ? 'FFFFFF' : '5A6072';
      return `<w:tc><w:tcPr><w:tcW w:w="${cw}" w:type="dxa"/>
        <w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>${SMAR}
      </w:tcPr><w:p><w:r><w:rPr><w:b/><w:color w:val="${clr}"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr>
        <w:t xml:space="preserve">${e(text)}</w:t></w:r></w:p></w:tc>`;
    }

    const hdrRow = `<w:tr>
      ${lblCell('Field')}
      <w:tc><w:tcPr><w:tcW w:w="${cw}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="1E3A5F"/>${MAR}
      </w:tcPr><w:p><w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t>Name / Title</w:t></w:r></w:p></w:tc>
      <w:tc><w:tcPr><w:tcW w:w="${cw}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="1E3A5F"/>${MAR}
      </w:tcPr><w:p><w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t>Signature</w:t></w:r></w:p></w:tc>
      <w:tc><w:tcPr><w:tcW w:w="${cw}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="1E3A5F"/>${MAR}
      </w:tcPr><w:p><w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t>Date</w:t></w:r></w:p></w:tc>
    </w:tr>`;

    const transStatusLabel = m.transReviewStatus === 'Complete' ? '✅  Complete' : '🔄  Under Review';
    const infoRows = [
      `<w:tr>${lblCell('Document ID')}${spanCell(o.docNumber || '[Auto-generated by TrainingPro]')}</w:tr>`,
      `<w:tr>${lblCell('Version')}${spanCell(m.version || '1.0')}</w:tr>`,
      `<w:tr>${lblCell('Status')}${spanCell(statusRow)}</w:tr>`,
      ...(tLang ? [`<w:tr>${lblCell('Language')}${spanCell('English / ' + tLang)}</w:tr>`] : []),
      ...(tLang && m.transReviewStatus ? [`<w:tr>${lblCell(tLang + ' Translation')}${spanCell(transStatusLabel)}</w:tr>`] : []),
    ];

    const sigHdrRow = `<w:tr>
      ${subHdrCell('', true)}
      ${subHdrCell('NAME & TITLE', false)}
      ${subHdrCell('SIGNATURE', false)}
      ${subHdrCell('DATE', false)}
    </w:tr>`;

    const sigRows = [
      ['Prepared By',  m.preparedBy  || ''],
      ['Reviewed By',  m.reviewedBy  || ''],
      ['Approved By',  m.approvedBy  || ''],
    ].map(([role, name]) => `<w:tr>
      ${lblCell(role)}
      ${valCell(name)}
      ${valCell('___________________________', '<w:color w:val="9CA3AF"/>')}
      ${valCell('___________', '<w:color w:val="9CA3AF"/>')}
    </w:tr>`);

    return `<w:tbl><w:tblPr><w:tblW w:w="${W}" w:type="dxa"/>${BORDERS}</w:tblPr>
      ${hdrRow}
      ${infoRows.join('\n      ')}
      ${sigHdrRow}
      ${sigRows.join('\n      ')}
    </w:tbl>`;
  }

  function heading(text, level) {
    const [col, sz, before, after] = level === 1
      ? ['1E3A5F', '32', '280', '160']
      : level === 2
        ? ['23272F', '28', '200', '120']
        : ['5A6072', '24', '160', '80'];
    // outlineLvl (invisible) lets a Word Table-of-Contents field collect these headings via its \u switch
    // without needing named heading styles — the visual formatting is unchanged.
    const outline = (level >= 1 && level <= 3) ? `<w:outlineLvl w:val="${level - 1}"/>` : '';
    return p(r(text, `<w:b/><w:color w:val="${col}"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`),
      `<w:spacing w:before="${before}" w:after="${after}"/>${outline}`);
  }

  // A single bilingual heading paragraph — translation first, then English (e.g. "ไทย · English") — carrying
  // the outline level so the Table of Contents field collects ONE clean Thai-first · English entry per
  // section (used for translated Training Manuals). Full-width, above the side-by-side body.
  function bilingualHeading(en, tr, level) {
    const [col, sz, before, after] = level === 1 ? ['1E3A5F', '32', '280', '160']
      : level === 2 ? ['23272F', '28', '200', '120'] : ['5A6072', '24', '160', '80'];
    const outline = (level >= 1 && level <= 3) ? `<w:outlineLvl w:val="${level - 1}"/>` : '';
    const rpr = `<w:b/><w:color w:val="${col}"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`;
    // De-duplicate the section number: both the English ("4.1 Module 1") and the Thai ("4.1 โมดูล 1")
    // carry it, which would show "4.1" twice. Strip the leading number from both and print it ONCE.
    const numRe = /^\s*(\d+(?:[.\-]\d+)*)[.)]?\s+/;
    const enM = String(en || '').match(numRe);
    const trM = String(tr || '').match(numRe);
    const num = (enM && enM[1]) || (trM && trM[1]) || '';
    const enText = enM ? String(en).slice(enM[0].length) : (en || '');
    const trText = trM ? String(tr).slice(trM[0].length) : (tr || '');
    const numRun = num ? r(num + '  ', rpr) : '';
    const sepRpr = `<w:color w:val="8A94A6"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`;
    const runs = numRun + r(trText, rpr) + r('   ·   ', sepRpr) + r(enText, rpr);
    return p(runs, `<w:spacing w:before="${before}" w:after="${after}"/>${outline}`);
  }

  // Contents page — a native Word TOC field (collects the headings above by outline level). It shows a
  // prompt until the reader updates the field in Word; buildDocx also flags the doc to auto-update on open.
  function tocPage() {
    const title = p(r('Contents', '<w:b/><w:color w:val="1E3A5F"/><w:sz w:val="32"/><w:szCs w:val="32"/>'),
      '<w:spacing w:before="0" w:after="160"/><w:outlineLvl w:val="0"/>');
    const field = `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>`
      + `<w:r><w:fldChar w:fldCharType="begin"/></w:r>`
      + `<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>`
      + `<w:r><w:fldChar w:fldCharType="separate"/></w:r>`
      + `<w:r><w:rPr><w:i/><w:color w:val="5A6072"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">Right-click here and choose “Update Field” to build the table of contents (page numbers included).</w:t></w:r>`
      + `<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
    return title + field + pageBreak();
  }

  // Safety Prompts legend page — the DANGER / CAUTION / NOTE / ACTIVITY key, colour-coded. When the document
  // is translated, opts.safetyPromptsTrans supplies the translated intro/labels/descriptions and each is
  // shown below its English text (so the safety section is translated into the selected language too).
  function safetyPromptsPage() {
    const C = SAFETY_PROMPTS_CONTENT;
    const T = opts.safetyPromptsTrans || null;
    // Follow the selected translation DIRECTION: "Above" (or Side + Translation-first) puts the
    // translated language on TOP, otherwise English on top. The top line is the primary style,
    // the second line the secondary (grey) style.
    const transFirst = opts.transLayout === 'above' || (opts.transLayout === 'side' && opts.transSideOrder === 'lang-first');
    const h = heading('Safety Prompts', 1);

    // Intro
    let intro;
    if (T && T.intro) {
      const top = transFirst ? T.intro : C.intro, bot = transFirst ? C.intro : T.intro;
      intro = p(r(top, '<w:sz w:val="20"/><w:szCs w:val="20"/>'), '<w:spacing w:after="40"/>')
            + p(r(bot, '<w:color w:val="5A6072"/><w:sz w:val="20"/><w:szCs w:val="20"/>'), '<w:spacing w:after="160"/>');
    } else {
      intro = p(r(C.intro, '<w:sz w:val="20"/><w:szCs w:val="20"/>'), '<w:spacing w:after="160"/>');
    }

    const W = 9000, cwL = 2100, cwR = W - cwL;
    const MAR = `<w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="140" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="140" w:type="dxa"/></w:tcMar>`;
    const body = C.rows.map((row, i) => {
      const tr = (T && Array.isArray(T.rows)) ? T.rows[i] : null;
      const trL = tr && tr.label ? tr.label : '', trD = tr && tr.text ? tr.text : '';

      // Label cell (white bold on the row colour). Primary label on top, secondary below.
      const lTop = (transFirst && trL) ? trL : row.label;
      const lBot = trL ? (transFirst ? row.label : trL) : '';
      const lPrimary = `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t xml:space="preserve">${e(lTop)}</w:t></w:r></w:p>`;
      const lSecondary = lBot ? `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="20" w:after="0"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t xml:space="preserve">${e(lBot)}</w:t></w:r></w:p>` : '';
      const lcell = `<w:tc><w:tcPr><w:tcW w:w="${cwL}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="${row.color}"/><w:vAlign w:val="center"/>${MAR}</w:tcPr>${lPrimary}${lSecondary}</w:tc>`;

      // Description cell. Primary on top, secondary (grey) below.
      const dTop = (transFirst && trD) ? trD : row.text;
      const dBot = trD ? (transFirst ? row.text : trD) : '';
      const dPrimary = `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">${e(dTop)}</w:t></w:r></w:p>`;
      const dSecondary = dBot ? `<w:p><w:pPr><w:spacing w:before="20" w:after="0"/></w:pPr><w:r><w:rPr><w:color w:val="5A6072"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">${e(dBot)}</w:t></w:r></w:p>` : '';
      const rcell = `<w:tc><w:tcPr><w:tcW w:w="${cwR}" w:type="dxa"/><w:vAlign w:val="center"/>${MAR}</w:tcPr>${dPrimary}${dSecondary}</w:tc>`;

      return `<w:tr>${lcell}${rcell}</w:tr>`;
    }).join('');
    const table = `<w:tbl><w:tblPr><w:tblW w:w="${W}" w:type="dxa"/>${BORDERS}</w:tblPr>${body}</w:tbl>`;
    return h + intro + table + pageBreak();
  }

  function bodyPara(text) {
    return p(r(text, '<w:sz w:val="20"/><w:szCs w:val="20"/>'), '<w:spacing w:after="100"/>');
  }

  function bullet(text) {
    return p(
      r('•', '<w:sz w:val="20"/>') + `<w:r><w:tab/></w:r>` + r(text, '<w:sz w:val="20"/>'),
      '<w:ind w:left="600" w:hanging="300"/><w:spacing w:after="80"/>'
    );
  }

  function subBullet(text) {
    return p(
      r(text, '<w:sz w:val="20"/><w:szCs w:val="20"/>'),
      '<w:ind w:left="1080"/><w:spacing w:after="60"/>'
    );
  }

  function label(text) {
    return p(
      r(text, '<w:b/><w:color w:val="23272F"/><w:sz w:val="21"/><w:szCs w:val="21"/>'),
      '<w:spacing w:before="200" w:after="60"/>'
    );
  }

  function checkbox(text) {
    return p(
      r('☐  ' + text, '<w:sz w:val="20"/><w:szCs w:val="20"/>'),
      '<w:ind w:left="360"/><w:spacing w:after="80"/>'
    );
  }

  function callout(text) {
    return p(
      r(text, '<w:color w:val="92400E"/><w:sz w:val="20"/><w:szCs w:val="20"/>'),
      `<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="FBC02D"/></w:pBdr>` +
      `<w:shd w:val="clear" w:color="auto" w:fill="FFF7ED"/>` +
      `<w:ind w:left="360" w:right="360"/><w:spacing w:before="120" w:after="120"/>`
    );
  }

  // Colour-coded safety callout (DANGER / CAUTION / NOTE / ACTIVITY) — a bold coloured label line, then the
  // text, in a left-bordered shaded box. Matches the training-module prompt legend so source callouts are
  // reproduced in the correct place and style.
  const CALLOUT_STYLE = {
    DANGER:   { bar: 'C0392B', fill: 'FDEDEC', lbl: 'C0392B' },
    CAUTION:  { bar: 'E67E22', fill: 'FEF5EC', lbl: 'B9600F' },
    NOTE:     { bar: '1E3A5F', fill: 'EEF3F8', lbl: '1E3A5F' },
    ACTIVITY: { bar: '27AE60', fill: 'EAF7EF', lbl: '1E7A44' },
  };
  function calloutTyped(type, text) {
    const key = String(type || '').toUpperCase().trim();
    const st = CALLOUT_STYLE[key];
    if (!st) return callout(type ? `${type}: ${text}` : text); // unknown type → generic amber callout
    const pPr = `<w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="${st.bar}"/></w:pBdr>`
      + `<w:shd w:val="clear" w:color="auto" w:fill="${st.fill}"/>`
      + `<w:ind w:left="360" w:right="360"/><w:spacing w:before="120" w:after="40"/>`;
    const labelRun = `<w:r><w:rPr><w:b/><w:color w:val="${st.lbl}"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">${e(key)}</w:t></w:r>`;
    const textRun  = `<w:r><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve">${e(text || '')}</w:t></w:r>`;
    const labelPara = `<w:p><w:pPr>${pPr}</w:pPr>${labelRun}</w:p>`;
    const textPara  = `<w:p><w:pPr><w:pBdr><w:left w:val="single" w:sz="24" w:space="8" w:color="${st.bar}"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="${st.fill}"/><w:ind w:left="360" w:right="360"/><w:spacing w:before="0" w:after="120"/></w:pPr>${textRun}</w:p>`;
    return labelPara + textPara;
  }
  // Render a section's callouts: accepts a single string, {type,text}, or an array of either.
  function renderCallouts(cs) {
    if (!cs) return '';
    const list = Array.isArray(cs) ? cs : [cs];
    return list.map(c => {
      if (c == null) return '';
      if (typeof c === 'string') {
        const m = c.match(/^\s*(DANGER|CAUTION|NOTE|ACTIVITY)\s*[:\-—]\s*([\s\S]*)$/i);
        return m ? calloutTyped(m[1], m[2]) : callout(c);
      }
      return c.type ? calloutTyped(c.type, c.text || '') : callout(c.text || '');
    }).join('');
  }

  // Suggested-image placeholder: a dashed box naming the picture that would best explain this content,
  // so the author knows exactly what image to add (or generate) here. Rendered from [IMG-SUGGEST: …].
  function imgSuggestPara(text) {
    const bd = (side) => `<w:${side} w:val="dashed" w:sz="6" w:space="6" w:color="8A90A2"/>`;
    const pPr = `<w:pBdr>${bd('top')}${bd('left')}${bd('bottom')}${bd('right')}</w:pBdr>`
      + `<w:shd w:val="clear" w:color="auto" w:fill="F4F6FA"/>`
      + `<w:ind w:left="200" w:right="200"/><w:spacing w:before="120" w:after="120"/>`;
    const labelRun = `<w:r><w:rPr><w:b/><w:color w:val="1E3A5F"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t xml:space="preserve">SUGGESTED IMAGE — </w:t></w:r>`;
    const textRun  = `<w:r><w:rPr><w:i/><w:color w:val="2A3042"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t xml:space="preserve">${e(text || '')}</w:t></w:r>`;
    return `<w:p><w:pPr>${pPr}</w:pPr>${labelRun}${textRun}</w:p>`;
  }

  function rule() {
    return p('', `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="FBC02D"/></w:pBdr><w:spacing w:after="200"/>`);
  }

  // ── Build content ──────────────────────────────────────────────────
  const parts = [];

  // Detect translation language from any section that has a translation
  const transLang = (sections || []).reduce((l, s) => l || (s.translation && s.translation.lang) || null, null);

  // Form documents (exact copy of an uploaded document) carry no document-control metadata:
  // no subtitle / "Document: N" line and no document-control table — just the title, then the
  // reproduced body. The running header and footer (logo, company, page number) are still applied.
  const isFormDoc = opts.type === 'form-doc';

  parts.push(p(r(title || 'Document', '<w:b/><w:color w:val="1E3A5F"/><w:sz w:val="40"/><w:szCs w:val="40"/>'),
    '<w:spacing w:after="160"/>'));
  if (opts.subtitle && !isFormDoc) parts.push(p(r(opts.subtitle, '<w:color w:val="5A6072"/><w:sz w:val="24"/><w:szCs w:val="24"/>'), '<w:spacing w:after="80"/>'));
  if (opts.docNumber && !isFormDoc) parts.push(p(r('Document: ' + opts.docNumber, '<w:color w:val="5A6072"/><w:sz w:val="20"/><w:szCs w:val="20"/>'), '<w:spacing w:after="80"/>'));

  parts.push(rule());
  // Cover documents and form copies skip the signature / document-control table.
  if (!opts.cover && !isFormDoc) {
    parts.push(metaTbl({ ...opts, transLang }));
    parts.push(pageBreak());
    // After the document-control (metadata) page: a Contents page, then the Safety Prompts legend page.
    if (opts.includeToc) parts.push(tocPage());
    if (opts.includeSafetyPrompts) parts.push(safetyPromptsPage());
  }

  const _images = []; // { rId, filename, buf }

  // Build a DOCX drawing paragraph for an image, respecting its layout settings
  function buildImgPara(si, tr) {
    if (!si || !si.base64) return '';
    // When the image has callouts, embed the ANNOTATED copy — the same picture with the
    // markers burned in, exactly as positioned in the editor (always a PNG). On the
    // translated side, prefer the translated render (leader-callout text in the target
    // language). The original is kept on the section so the callouts stay editable.
    const marks = Array.isArray(si.callouts) ? si.callouts.filter(c => c && c.text) : [];
    const annImg = (tr && si.annotatedTr) ? si.annotatedTr : si.annotated;
    const useAnn = !!(marks.length && annImg);
    const raw  = (useAnn ? annImg : si.base64).replace(/^data:[^;]+;base64,/, '');
    const mime = useAnn ? 'image/png' : (si.mimeType || 'image/png');
    const ext  = { 'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp' }[mime] || 'png';
    const idx  = _images.length + 1;
    const rId  = `rImg${idx}`;
    _images.push({ rId, filename: `image${idx}.${ext}`, buf: Buffer.from(raw, 'base64') });

    const L    = si.layout || {};
    const wrap = L.wrapping || 'inline';
    // Size — use docWidth/docHeight (inches) if set, else natural px → inches at 96dpi
    const natW = si.width || 300, natH = si.height || 200;
    const wIn  = L.docWidth  || Math.min(6, natW / 96);
    const hIn  = L.docHeight || (wIn * natH / natW);
    const cx   = Math.round(wIn * 914400);
    const cy   = Math.round(hIn * 914400);

    const picXml = `<pic:pic>
      <pic:nvPicPr><pic:cNvPr id="${idx}" name="Image${idx}"/><pic:cNvPicPr/></pic:nvPicPr>
      <pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
      <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
    </pic:pic>`;
    const graphicXml = `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">${picXml}</a:graphicData></a:graphic>`;

    const capPara = si.caption
      ? p(r(si.caption, '<w:i/><w:color w:val="5A6072"/><w:sz w:val="18"/><w:szCs w:val="18"/>'), '<w:jc w:val="center"/><w:spacing w:after="80"/>')
      : '';

    // Numbered legend — ONLY for numbered callouts (leader callouts carry their text on the
    // image itself). By default the translation is indented beneath the English; when the image
    // opts into BILINGUAL, it is "translated · English" side by side (translated first).
    const numRpr = '<w:b/><w:color w:val="1E3A5F"/><w:sz w:val="18"/><w:szCs w:val="18"/>';
    const enRpr = '<w:sz w:val="18"/><w:szCs w:val="18"/>';
    const calPara = marks.filter(c => c.kind !== 'leader').map(c => {
      if (si.calBilingual && c.trans) {
        const run = r(`${c.n}.  `, numRpr) + r(String(c.trans), enRpr)
          + r('   ·   ', '<w:color w:val="9AA0AB"/><w:sz w:val="18"/><w:szCs w:val="18"/>')
          + r(String(c.text), '<w:color w:val="5A6072"/><w:sz w:val="18"/><w:szCs w:val="18"/>');
        return p(run, '<w:spacing w:after="20"/><w:ind w:left="360" w:hanging="200"/>');
      }
      const line = p(r(`${c.n}.  `, numRpr) + r(String(c.text), enRpr), '<w:spacing w:after="0"/><w:ind w:left="360" w:hanging="200"/>');
      const trLine = c.trans
        ? p(r(String(c.trans), '<w:i/><w:color w:val="1E3A5F"/><w:sz w:val="18"/><w:szCs w:val="18"/>'), '<w:spacing w:after="20"/><w:ind w:left="560"/>')
        : '';
      return line + trLine;
    }).join('');

    // The inline drawing (used for inline images, and for any captioned block image).
    const inlineDraw = `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${idx}" name="Image${idx}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>${graphicXml}</wp:inline>`;

    // CAPTION LOCKED TO PICTURE: for a block image (inline / top-and-bottom) with a caption,
    // put the picture and caption in one borderless table exactly the width of the picture.
    // The caption then sits DIRECTLY BELOW the picture, CENTRED on it (not the page), and the
    // two move together as a single block. cantSplit + keepNext keep them on the same page.
    if (si.caption && (wrap === 'inline' || wrap === 'topBottom')) {
      const wDxa = Math.max(200, Math.round(wIn * 1440));
      const blockJc = L.hAlign === 'right' ? 'right' : L.hAlign === 'center' ? 'center'
        : (wrap === 'topBottom' ? 'center' : (L.hAlign || 'left'));
      const capRun = r(si.caption, '<w:i/><w:color w:val="5A6072"/><w:sz w:val="18"/><w:szCs w:val="18"/>');
      const noBdr = `<w:tblBorders><w:top w:val="none"/><w:left w:val="none"/><w:bottom w:val="none"/><w:right w:val="none"/><w:insideH w:val="none"/><w:insideV w:val="none"/></w:tblBorders>`;
      const tcpr = `<w:tcPr><w:tcW w:w="${wDxa}" w:type="dxa"/><w:tcMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tcMar></w:tcPr>`;
      const imgP = `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/><w:keepNext/></w:pPr><w:r><w:drawing>${inlineDraw}</w:drawing></w:r></w:p>`;
      const capP = `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="40" w:after="40"/></w:pPr>${capRun}</w:p>`;
      const tbl = `<w:tbl><w:tblPr><w:tblW w:w="${wDxa}" w:type="dxa"/><w:jc w:val="${blockJc}"/>${noBdr}<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="${wDxa}"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc>${tcpr}${imgP}${capP}</w:tc></w:tr></w:tbl>`;
      return `${tbl}${calPara}<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>`;
    }

    if (wrap === 'inline') {
      const jc = L.hAlign === 'right' ? 'right' : L.hAlign === 'center' ? 'center' : 'left';
      return `<w:p><w:pPr><w:jc w:val="${jc}"/><w:spacing w:after="80"/></w:pPr><w:r><w:drawing>${inlineDraw}</w:drawing></w:r></w:p>${capPara}${calPara}`;
    }

    // Anchored image (square, tight, through, topBottom, behind, inFront)
    const dT = Math.round((L.distTop    || 0)    * 914400);
    const dB = Math.round((L.distBottom || 0)    * 914400);
    const dL = Math.round((L.distLeft   || 0.13) * 914400);
    const dR = Math.round((L.distRight  || 0.13) * 914400);
    const behind = wrap === 'behind' ? '1' : '0';

    let wrapXml;
    if      (wrap === 'square')   wrapXml = `<wp:wrapSquare wrapText="bothSides" distT="${dT}" distB="${dB}" distL="${dL}" distR="${dR}"/>`;
    else if (wrap === 'tight')    wrapXml = `<wp:wrapTight wrapText="bothSides" distL="${dL}" distR="${dR}"><wp:wrapPolygon edited="0"><wp:start x="0" y="0"/><wp:lineTo x="0" y="21600"/><wp:lineTo x="21600" y="21600"/><wp:lineTo x="21600" y="0"/><wp:lineTo x="0" y="0"/></wp:wrapPolygon></wp:wrapTight>`;
    else if (wrap === 'through')  wrapXml = `<wp:wrapThrough wrapText="bothSides" distL="${dL}" distR="${dR}"><wp:wrapPolygon edited="0"><wp:start x="0" y="0"/><wp:lineTo x="0" y="21600"/><wp:lineTo x="21600" y="21600"/><wp:lineTo x="21600" y="0"/><wp:lineTo x="0" y="0"/></wp:wrapPolygon></wp:wrapThrough>`;
    else if (wrap === 'topBottom') wrapXml = `<wp:wrapTopAndBottom distT="${dT}" distB="${dB}"/>`;
    else                           wrapXml = `<wp:wrapNone/>`; // behind / inFront

    const hAlign = L.hAlign || 'left';
    const hPosXml = L.hType === 'absolute'
      ? `<wp:posOffset>${Math.round((L.hAbsolute || 0) * 914400)}</wp:posOffset>`
      : `<wp:align>${hAlign}</wp:align>`;
    const vPosXml = L.vType === 'absolute'
      ? `<wp:posOffset>${Math.round((L.vAbsolute || 0.24) * 914400)}</wp:posOffset>`
      : `<wp:posOffset>228600</wp:posOffset>`;

    const draw = `<wp:anchor behindDoc="${behind}" distT="${dT}" distB="${dB}" distL="${dL}" distR="${dR}" simplePos="0" relativeHeight="251658240" locked="0" layoutInCell="1" allowOverlap="1">
      <wp:simplePos x="0" y="0"/>
      <wp:positionH relativeFrom="column">${hPosXml}</wp:positionH>
      <wp:positionV relativeFrom="paragraph">${vPosXml}</wp:positionV>
      <wp:extent cx="${cx}" cy="${cy}"/>
      <wp:effectExtent l="0" t="0" r="0" b="0"/>
      ${wrapXml}
      <wp:docPr id="${idx}" name="Image${idx}"/>
      <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
      ${graphicXml}
    </wp:anchor>`;
    return `<w:p><w:r><w:drawing>${draw}</w:drawing></w:r></w:p>${capPara}${calPara}`;
  }

  // A flow chart is drawn in the browser and arrives already rasterised (`png` for English,
  // `pngTr` for the translated copy). Word has no equivalent of the SVG, so the picture is
  // embedded; if rasterising failed, fall back to a readable numbered list of the steps so
  // the procedure is never silently lost.
  function buildFlowPara(fl, tr) {
    if (!fl) return '';
    const png = tr ? (fl.pngTr || fl.png) : fl.png;
    const pw = (tr && fl.pngTr) ? fl.pngTrW : fl.pngW;
    const ph = (tr && fl.pngTr) ? fl.pngTrH : fl.pngH;
    const title = (tr && fl.transTitle) ? fl.transTitle : (fl.title || '');
    const titlePara = title
      ? p(r(title, '<w:b/><w:color w:val="1E3A5F"/><w:sz w:val="22"/><w:szCs w:val="22"/>'), '<w:jc w:val="center"/><w:spacing w:before="120" w:after="60"/>')
      : '';
    if (png) {
      const raw = png.replace(/^data:[^;]+;base64,/, '');
      const idx = _images.length + 1;
      const rId = `rImg${idx}`;
      _images.push({ rId, filename: `image${idx}.png`, buf: Buffer.from(raw, 'base64') });
      // Fit the chart to the text column (max 6.2"), preserving aspect.
      const natW = pw || 1200, natH = ph || 900;
      const wIn = Math.min(6.2, natW / 192);          // rasterised at 2×, so 192dpi
      const cx = Math.round(wIn * 914400);
      const cy = Math.round(wIn * (natH / natW) * 914400);
      const draw = `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${idx}" name="FlowChart${idx}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${idx}" name="FlowChart${idx}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline>`;
      return titlePara + `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="140"/></w:pPr><w:r><w:drawing>${draw}</w:drawing></w:r></w:p>`;
    }
    // Text fallback — walk the spine, indenting each branch under its decision.
    const out = [];
    const walk = (list, depth) => (list || []).forEach(n => {
      const txt = (tr && n.trans) ? n.trans : (n.text || '');
      if (!txt) return;
      const tag = n.type === 'decision' ? 'Decision: ' : (n.type === 'start' || n.type === 'end') ? '● ' : '– ';
      out.push(p(r(tag + txt, '<w:sz w:val="20"/><w:szCs w:val="20"/>'), `<w:spacing w:after="0"/><w:ind w:left="${360 + depth * 260}"/>`));
      if (n.type === 'decision' && (n.branch || []).length) {
        const lbl = (tr && n.transBranchLabel) ? n.transBranchLabel : (n.branchLabel || '');
        if (lbl) out.push(p(r(`If ${lbl}:`, '<w:i/><w:color w:val="5A6072"/><w:sz w:val="20"/><w:szCs w:val="20"/>'), `<w:spacing w:after="0"/><w:ind w:left="${360 + (depth + 1) * 260}"/>`));
        walk(n.branch, depth + 1);
      }
    });
    walk(fl.nodes, 0);
    return titlePara + out.join('');
  }

  function processBody(bodyStr, imgMap, flowMap, tr) {
    if (!bodyStr) return;
    // Split on image markers [IMG:uid], flow-chart markers [FLOW:uid], AND inline safety-callout
    // markers [!DANGER: …] / CAUTION / NOTE / ACTIVITY, so each lands at its exact position.
    const tokens = String(bodyStr).split(/(\[IMG:[a-z0-9]+\]|\[FLOW:[a-z0-9]+\]|\[IMG-SUGGEST:[\s\S]*?\]|\[!(?:DANGER|CAUTION|NOTE|ACTIVITY):[\s\S]*?\])/gi);
    for (const token of tokens) {
      if (!token) continue;
      const m = token.match(/^\[IMG:([a-z0-9]+)\]$/);
      const fm = token.match(/^\[FLOW:([a-z0-9]+)\]$/i);
      const sm = token.match(/^\[IMG-SUGGEST:\s*([\s\S]*?)\]$/i);
      const cm = token.match(/^\[!(DANGER|CAUTION|NOTE|ACTIVITY):\s*([\s\S]*?)\]$/i);
      if (m) {
        const si = imgMap[m[1]];
        if (si) parts.push(buildImgPara(si, tr));
      } else if (fm) {
        const fl = (flowMap || {})[fm[1]];
        if (fl) parts.push(buildFlowPara(fl, tr));
      } else if (sm) {
        parts.push(imgSuggestPara(sm[1].trim()));
      } else if (cm) {
        parts.push(calloutTyped(cm[1], cm[2].trim()));
      } else {
        for (const line of token.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          if (t.startsWith('- ') || t.startsWith('• ')) parts.push(bullet(t.slice(2).trim()));
          else if (/^[a-z]\.\s/.test(t)) parts.push(subBullet(t));
          else if (t.endsWith(':') && !/^[-•]/.test(t)) parts.push(label(t));
          else parts.push(bodyPara(t));
        }
      }
    }
  }

  const transLayout = opts.transLayout || 'below';
  const transSideOrder = opts.transSideOrder === 'lang-first' ? 'lang-first' : 'en-first';
  // Side-by-side: two borderless columns. Column order follows transSideOrder — English|translation
  // ('en-first', default) or translation|English ('lang-first').
  function sideBySide(enArr, trArr) {
    const W = 9360, cw = Math.floor(W / 2);
    const cell = (arr) => `<w:tc><w:tcPr><w:tcW w:w="${cw}" w:type="dxa"/>` +
      `<w:tcMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar>` +
      `</w:tcPr>${arr.join('')}<w:p/></w:tc>`;
    const first = transSideOrder === 'lang-first' ? trArr : enArr;
    const second = transSideOrder === 'lang-first' ? enArr : trArr;
    const BDR = `<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="D7DAE3"/></w:tblBorders>`;
    return `<w:tbl><w:tblPr><w:tblW w:w="${W}" w:type="dxa"/>${BDR}` +
      `<w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>` +
      `<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>` +
      `<w:tblGrid><w:gridCol w:w="${cw}"/><w:gridCol w:w="${cw}"/></w:tblGrid><w:tr>${cell(first)}${cell(second)}</w:tr></w:tbl>`;
  }

  // ── Per-section page orientation (landscape) via section breaks ──────────────
  function sectPrInner(orient, withTitlePg) {
    const pg = orient === 'landscape'
      ? '<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
      : '<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>';
    return '<w:headerReference w:type="default" r:id="rId1"/>' +
      (withTitlePg ? '<w:headerReference w:type="first" r:id="rId3"/>' : '') +
      '<w:footerReference w:type="default" r:id="rId2"/>' +
      (withTitlePg ? '<w:footerReference w:type="first" r:id="rId2"/>' : '') +
      (withTitlePg ? '<w:titlePg/>' : '') + pg;
  }
  // A paragraph carrying a sectPr ends the section BEFORE it (with the given orientation)
  const sectBreakPara = (orient, withTitlePg) =>
    `<w:p><w:pPr><w:spacing w:after="0" w:line="20" w:lineRule="exact"/><w:sectPr>${sectPrInner(orient, withTitlePg)}</w:sectPr></w:pPr></w:p>`;

  // ── Flowchart: native Word table — shaded stage boxes joined by → arrows, with a
  // list of sub-items under each stage, plus optional notes. Renders on a landscape page.
  function flowchartTbl(fc, landscape) {
    if (!fc || !Array.isArray(fc.stages) || !fc.stages.length) return '';
    const stages = fc.stages, n = stages.length;
    const TOTAL = landscape ? 12700 : 9000;
    const arrowW = 260;
    const stageW = Math.max(700, Math.floor((TOTAL - arrowW * (n - 1)) / n));
    const titleP = (t) => `<w:p><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="1E3A5F"/><w:jc w:val="center"/><w:spacing w:before="20" w:after="40"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="FFFFFF"/><w:sz w:val="15"/><w:szCs w:val="15"/></w:rPr><w:t xml:space="preserve">${e(t || '')}</w:t></w:r></w:p>`;
    const itemP = (t) => `<w:p><w:pPr><w:spacing w:after="10"/></w:pPr><w:r><w:rPr><w:sz w:val="13"/><w:szCs w:val="13"/></w:rPr><w:t xml:space="preserve">${e(String(t))}</w:t></w:r></w:p>`;
    const STAGE_BDR = '<w:tcBorders><w:top w:val="single" w:sz="4" w:color="1E3A5F"/><w:left w:val="single" w:sz="4" w:color="1E3A5F"/><w:bottom w:val="single" w:sz="4" w:color="1E3A5F"/><w:right w:val="single" w:sz="4" w:color="1E3A5F"/></w:tcBorders>';
    const stageCell = (st) => {
      const items = (Array.isArray(st.items) ? st.items : []).map(itemP).join('') || '<w:p/>';
      return `<w:tc><w:tcPr><w:tcW w:w="${stageW}" w:type="dxa"/>${STAGE_BDR}<w:tcMar><w:top w:w="0" w:type="dxa"/><w:left w:w="70" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="70" w:type="dxa"/></w:tcMar><w:vAlign w:val="top"/></w:tcPr>${titleP(st.title)}${items}</w:tc>`;
    };
    const arrowCell = `<w:tc><w:tcPr><w:tcW w:w="${arrowW}" w:type="dxa"/><w:tcBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/></w:tcBorders><w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="FBC02D"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><w:t>→</w:t></w:r></w:p></w:tc>`;
    let cells = '', gridCols = '';
    stages.forEach((st, i) => { cells += stageCell(st); gridCols += `<w:gridCol w:w="${stageW}"/>`; if (i < n - 1) { cells += arrowCell; gridCols += `<w:gridCol w:w="${arrowW}"/>`; } });
    const totalW = stageW * n + arrowW * (n - 1);
    const NO_BDR = '<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>';
    let out = '';
    if (fc.title) out += p(r(fc.title, '<w:b/><w:color w:val="1E3A5F"/><w:sz w:val="22"/><w:szCs w:val="22"/>'), '<w:jc w:val="center"/><w:spacing w:before="120" w:after="120"/>');
    out += `<w:tbl><w:tblPr><w:tblW w:w="${totalW}" w:type="dxa"/>${NO_BDR}<w:tblCellMar><w:left w:w="40" w:type="dxa"/><w:right w:w="40" w:type="dxa"/></w:tblCellMar><w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr><w:tblGrid>${gridCols}</w:tblGrid><w:tr>${cells}</w:tr></w:tbl>`;
    out += empty();
    if (Array.isArray(fc.notes) && fc.notes.length) for (const note of fc.notes) out += callout(String(note));
    out += empty();
    return out;
  }

  // docOrient='landscape' makes the WHOLE document landscape (e.g. certificates)
  let curOrient = opts.docOrient === 'landscape' ? 'landscape' : 'portrait';
  let firstBreakDone = false;   // the first section break carries the cover's titlePg

  for (const s of (sections || [])) {
    // Open a landscape (or back-to-portrait) section before this section's content
    const wantOrient = s.landscape ? 'landscape' : 'portrait';
    if (wantOrient !== curOrient) {
      parts.push(sectBreakPara(curOrient, !firstBreakDone));
      firstBreakDone = true;
      curOrient = wantOrient;
    } else if (s.pageBreak && parts.length) {
      // Start this section on a NEW PAGE (an orientation change already breaks the page,
      // so only add an explicit break when the orientation is unchanged).
      parts.push(pageBreak());
    }
    const lvl = s.level || 1;
    // Translated Training Manual: render ONE full-width Thai-first · English heading (above the side-by-side
    // body) so the Table of Contents shows a single clean "Thai · English" entry per section.
    const tmBilingualHead = opts.type === 'training-manual' && s.heading && s.translation && s.translation.heading;
    if (tmBilingualHead) parts.push(bilingualHeading(s.heading, s.translation.heading, lvl));
    const enStart = parts.length;
    if (s.heading && !tmBilingualHead) parts.push(heading(s.heading, lvl));
    if (s.callout) parts.push(callout(s.callout));
    // Colour-coded DANGER/CAUTION/NOTE/ACTIVITY callouts captured from the source, in reading order.
    if (s.callouts) parts.push(renderCallouts(s.callouts));

    // Build uid → image map for marker-based placement
    const allImgs = Array.isArray(s.images) ? s.images : (s.image && s.image.base64 ? [s.image] : []);
    const imgMap  = {};
    for (const si of allImgs) if (si && si.uid) imgMap[si.uid] = si;

    const flowMap = {};
    for (const fl of (Array.isArray(s.flows) ? s.flows : [])) if (fl && fl.uid) flowMap[fl.uid] = fl;

    // When the section is translated, the images move to the TRANSLATED side (not the English position) —
    // so render the English body WITHOUT images here; they're placed with the translation block below.
    // Flow charts follow the same rule, so the chart sits with the language it is drawn in.
    const hasTr = !!s.translation;
    processBody(s.body, hasTr ? {} : imgMap, hasTr ? {} : flowMap, false);

    if (s.flowchart) parts.push(flowchartTbl(s.flowchart, s.landscape));

    if (s.table && Array.isArray(s.table.headers) && Array.isArray(s.table.rows)) {
      parts.push(empty());
      parts.push(tbl(s.table.headers, s.table.rows, s.table.plain, s.table.colW));
      parts.push(empty());
    }

    // Conditionally-formatted risk-assessment table (scores are language-neutral, so
    // it is rendered once on the English side even when the section is translated).
    if (s.risk && normRisk(s.risk).length) {
      parts.push(empty());
      parts.push(riskTbl(s.risk));
      parts.push(empty());
    }

    if (Array.isArray(s.checklist)) {
      for (const item of s.checklist) parts.push(checkbox(String(item)));
    }

    // Legacy / unmarked images — emit at end of section in a grid (English side ONLY when not translated;
    // when translated, ALL images are emitted on the translation side below instead).
    const unmarked = allImgs.filter(si => si && si.base64 && (!si.uid || !(String(s.body||'')).includes(`[IMG:${si.uid}]`)));
    if (!hasTr && unmarked.length) {
      parts.push(empty());
      const TBL_W = 9000;
      const COLS  = Math.min(unmarked.length, 3);
      const cellW = Math.floor(TBL_W / COLS);
      const imgW  = Math.floor(5040000 / COLS);
      const NO_BDR = `<w:tblBorders><w:top w:val="none"/><w:left w:val="none"/><w:bottom w:val="none"/><w:right w:val="none"/><w:insideH w:val="none"/><w:insideV w:val="none"/></w:tblBorders>`;
      const tcp = (w) => `<w:tcPr><w:tcW w:w="${w}" w:type="dxa"/><w:tcMar><w:top w:w="60" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar></w:tcPr>`;
      for (let rs = 0; rs < unmarked.length; rs += COLS) {
        const row = unmarked.slice(rs, rs + COLS);
        while (row.length < COLS) row.push(null);
        const cells = row.map(si => {
          if (!si) return `<w:tc>${tcp(cellW)}<w:p/></w:tc>`;
          // Same rule as buildImgPara: with callouts, embed the annotated copy (markers burned in).
          const marks = Array.isArray(si.callouts) ? si.callouts.filter(c => c && c.text) : [];
          const useAnn = !!(marks.length && si.annotated);
          const raw = (useAnn ? si.annotated : si.base64).replace(/^data:[^;]+;base64,/, '');
          const mime = useAnn ? 'image/png' : (si.mimeType || 'image/png');
          const ext  = { 'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp' }[mime] || 'png';
          const idx  = _images.length + 1;
          const rId  = `rImg${idx}`;
          const ratio = (si.width && si.height) ? si.height / si.width : 0.75;
          const cx = imgW, cy = Math.round(imgW * ratio);
          _images.push({ rId, filename: `image${idx}.${ext}`, buf: Buffer.from(raw, 'base64') });
          const draw = `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${idx}" name="Image${idx}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${idx}" name="Image${idx}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
          const cap = si.caption ? p(r(si.caption, '<w:i/><w:color w:val="5A6072"/><w:sz w:val="18"/><w:szCs w:val="18"/>'), '<w:jc w:val="center"/><w:spacing w:after="80"/>') : '<w:p/>';
          const cal = marks.map(c =>
            p(r(`${c.n}.  `, '<w:b/><w:color w:val="1E3A5F"/><w:sz w:val="16"/><w:szCs w:val="16"/>')
              + r(String(c.text), '<w:sz w:val="16"/><w:szCs w:val="16"/>'), '<w:spacing w:after="0"/>')
            + (c.trans ? p(r(String(c.trans), '<w:i/><w:color w:val="1E3A5F"/><w:sz w:val="16"/><w:szCs w:val="16"/>'), '<w:spacing w:after="20"/><w:ind w:left="200"/>') : '')
          ).join('');
          return `<w:tc>${tcp(cellW)}${draw}${cap}${cal}</w:tc>`;
        }).join('');
        parts.push(`<w:tbl><w:tblPr><w:tblW w:w="${TBL_W}" w:type="dxa"/>${NO_BDR}</w:tblPr><w:tr>${cells}</w:tr></w:tbl>`);
      }
      parts.push(empty());
    }

    // Capture the English content built above so the translation can be repositioned
    const enParts = parts.splice(enStart);
    const trParts = [];
    // Bilingual translation block
    if (s.translation) {
      const t = s.translation;
      const trStart = parts.length;
      const langLabel = t.lang || 'Translation';
      parts.push(p(r(`── ${langLabel} ──`, '<w:i/><w:color w:val="5A6072"/><w:sz w:val="18"/><w:szCs w:val="18"/>'),
        `<w:pBdr><w:bottom w:val="dashed" w:sz="4" w:space="1" w:color="AAAAAA"/></w:pBdr><w:spacing w:before="160" w:after="80"/>`));
      if (t.heading && !tmBilingualHead) parts.push(heading(t.heading, lvl)); // TM bilingual heading already shown above
      if (t.callout) parts.push(callout(t.callout));
      // Images belong on the TRANSLATED side: place any whose [IMG:uid] marker survived translation, then
      // append the rest (unmarked, or marker lost in translation) so every picture appears here, not on English.
      processBody(t.body, imgMap, flowMap, true);
      for (const si of allImgs) {
        if (!si || !si.base64) continue;
        if (si.uid && String(t.body || '').includes(`[IMG:${si.uid}]`)) continue; // already placed at its marker
        parts.push(buildImgPara(si, true));
      }
      // Same safety net for charts whose [FLOW:uid] marker did not survive translation.
      for (const fl of (Array.isArray(s.flows) ? s.flows : [])) {
        if (!fl || !fl.uid) continue;
        if (String(t.body || '').includes(`[FLOW:${fl.uid}]`)) continue;
        parts.push(buildFlowPara(fl, true));
      }
      if (t.flowchart) parts.push(flowchartTbl(t.flowchart, s.landscape));
      if (t.table && Array.isArray(t.table.headers) && Array.isArray(t.table.rows)) {
        parts.push(empty());
        parts.push(tbl(t.table.headers, t.table.rows, t.table.plain, t.table.colW));
        parts.push(empty());
      }
      if (Array.isArray(t.checklist)) for (const item of t.checklist) parts.push(checkbox(String(item)));
      trParts.push(...parts.splice(trStart));
    }
    // Emit English + translation in the chosen position (above | below | side).
    // Training Manuals: keep side-by-side ONLY in the Table of Contents (via the bilingual heading above) —
    // the main body is STACKED (never two-column), so switch a 'side' request to 'below' for the body here.
    const emitLayout = (opts.type === 'training-manual' && transLayout === 'side') ? 'below' : transLayout;
    if (trParts.length && emitLayout === 'side') {
      parts.push(sideBySide(enParts, trParts));
    } else if (trParts.length && emitLayout === 'above') {
      parts.push(...trParts, ...enParts);
    } else {
      parts.push(...enParts, ...trParts);
    }
  }
  // Append the fixed AKARA Risk Rank Matrix as a colour-coded reference table when requested
  // (e.g. a risk-assessment record form generated with the "Add risk matrix" option).
  if (opts.includeRiskMatrix) {
    parts.push(empty());
    parts.push(akaraMatrixTbl());
    parts.push(empty());
  }
  parts.push('<w:p/>'); // ensure the body ends with a paragraph (after any side-by-side table)

  // ── Assemble DOCX zip ─────────────────────────────────────────────
  const now        = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  // Full document title in the footer — the left footer cell (below) wraps long titles within its
  // column, so we keep the whole title rather than truncating it (previously capped at 60 chars).
  const shortTitle = (title || 'Document');
  const docNum     = opts.docNumber || '';
  const docType    = opts.type || 'Document';
  const companyName = opts.companyName || '';
  const brandLabel  = companyName || 'TrainingPro';

  // Parse company logo if provided
  let logoFile = null; // { buf, ext, mime, rId, dims }
  if (opts.companyLogo) {
    const m = opts.companyLogo.match(/^data:([^;]+);base64,(.+)$/);
    if (m) {
      const mime = m[1];
      const ext  = { 'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp' }[mime] || 'png';
      const buf  = Buffer.from(m[2], 'base64');
      logoFile   = { buf, ext, mime, rId: 'rLogoHdr', filename: `company_logo.${ext}`,
                     dims: getImageDimensions(buf, mime) };
    }
  }

  // Cover topbar: logo (left) | "Company: DocNum" (right), faint bottom rule — matches the HTML preview
  if (logoFile || opts.companyName) {
    const BODY_LOGO_H = 640080; // ~0.7 inches (larger cover logo)
    const BODY_LOGO_W = logoFile && logoFile.dims
      ? Math.min(2286000, Math.round(BODY_LOGO_H * logoFile.dims.width / logoFile.dims.height))
      : 914400; // 1 inch default if dims unknown
    const logoPart = logoFile ? `<w:r><w:drawing>
      <wp:inline distT="0" distB="0" distL="0" distR="0">
        <wp:extent cx="${BODY_LOGO_W}" cy="${BODY_LOGO_H}"/>
        <wp:effectExtent l="0" t="0" r="0" b="0"/>
        <wp:docPr id="100" name="CompanyLogoTitle"/>
        <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:pic>
            <pic:nvPicPr><pic:cNvPr id="100" name="CompanyLogoTitle"/><pic:cNvPicPr/></pic:nvPicPr>
            <pic:blipFill><a:blip r:embed="rLogoBody"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
            <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${BODY_LOGO_W}" cy="${BODY_LOGO_H}"/></a:xfrm>
              <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
          </pic:pic>
        </a:graphicData></a:graphic>
      </wp:inline>
    </w:drawing></w:r>` : '';
    const leftCell = logoPart || r(opts.companyName || '', '<w:b/><w:color w:val="1E3A5F"/><w:sz w:val="22"/><w:szCs w:val="22"/>');
    const refRuns = (opts.companyName
        ? r(opts.companyName + ':', '<w:b/><w:color w:val="1E3A5F"/><w:sz w:val="18"/><w:szCs w:val="18"/>') + r('   ', '<w:sz w:val="18"/>')
        : '')
      + (docNum ? r(docNum, '<w:color w:val="5A6072"/><w:sz w:val="16"/><w:szCs w:val="16"/>') : '');
    const CMAR = '<w:tcMar><w:top w:w="40" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tcMar>';
    const topbar = `<w:tbl>
      <w:tblPr>
        <w:tblW w:w="9360" w:type="dxa"/>
        <w:tblBorders>
          <w:top w:val="nil"/><w:left w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/>
          <w:bottom w:val="single" w:sz="4" w:space="0" w:color="D7DAE3"/>
        </w:tblBorders>
        <w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>
        <w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>
      </w:tblPr>
      <w:tblGrid><w:gridCol w:w="5000"/><w:gridCol w:w="4360"/></w:tblGrid>
      <w:tr>
        <w:tc><w:tcPr><w:tcW w:w="5000" w:type="dxa"/>${CMAR}<w:vAlign w:val="center"/></w:tcPr><w:p>${leftCell}</w:p></w:tc>
        <w:tc><w:tcPr><w:tcW w:w="4360" w:type="dxa"/>${CMAR}<w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:jc w:val="right"/></w:pPr>${refRuns}</w:p></w:tc>
      </w:tr>
    </w:tbl>`;
    parts.unshift(topbar);
  }

  // Header: company logo (if any) + brand name left | doc number right
  const HDR_NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
    xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
    xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;
  // Running header mirrors the cover topbar: same 0.7in logo (left) + "Company:  DocNum" (right)
  const HDR_H = 640080; // 0.7 inches — matches the cover logo size
  const HDR_W = logoFile && logoFile.dims
    ? Math.min(2286000, Math.round(HDR_H * logoFile.dims.width / logoFile.dims.height))
    : 914400; // ~1 inch fallback
  const logoDraw = logoFile ? `<w:r><w:drawing>
    <wp:inline distT="0" distB="0" distL="0" distR="0">
      <wp:extent cx="${HDR_W}" cy="${HDR_H}"/>
      <wp:effectExtent l="0" t="0" r="0" b="0"/>
      <wp:docPr id="99" name="CompanyLogo"/>
      <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
        <pic:pic>
          <pic:nvPicPr><pic:cNvPr id="99" name="CompanyLogo"/><pic:cNvPicPr/></pic:nvPicPr>
          <pic:blipFill><a:blip r:embed="${logoFile.rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
          <pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${HDR_W}" cy="${HDR_H}"/></a:xfrm>
            <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>
        </pic:pic>
      </a:graphicData></a:graphic>
    </wp:inline>
  </w:drawing></w:r>` : '';
  const hdrLeftCell = logoDraw || r(brandLabel, '<w:b/><w:color w:val="1E3A5F"/><w:sz w:val="22"/><w:szCs w:val="22"/>');
  const hdrRefRuns = (brandLabel
      ? r(brandLabel + ':', '<w:b/><w:color w:val="1E3A5F"/><w:sz w:val="18"/><w:szCs w:val="18"/>') + r('   ', '<w:sz w:val="18"/>')
      : '')
    + (docNum ? r(docNum, '<w:color w:val="5A6072"/><w:sz w:val="16"/><w:szCs w:val="16"/>') : '');
  const HCMAR = '<w:tcMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tcMar>';
  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${HDR_NS}>
  <w:tbl>
    <w:tblPr>
      <w:tblW w:w="9360" w:type="dxa"/>
      <w:tblBorders>
        <w:top w:val="nil"/><w:left w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/>
        <w:bottom w:val="single" w:sz="4" w:space="0" w:color="D7DAE3"/>
      </w:tblBorders>
      <w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>
      <w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>
    </w:tblPr>
    <w:tblGrid><w:gridCol w:w="5000"/><w:gridCol w:w="4360"/></w:tblGrid>
    <w:tr>
      <w:tc><w:tcPr><w:tcW w:w="5000" w:type="dxa"/>${HCMAR}<w:vAlign w:val="center"/></w:tcPr><w:p>${hdrLeftCell}</w:p></w:tc>
      <w:tc><w:tcPr><w:tcW w:w="4360" w:type="dxa"/>${HCMAR}<w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:jc w:val="right"/></w:pPr>${hdrRefRuns}</w:p></w:tc>
    </w:tr>
  </w:tbl>
  <w:p><w:pPr><w:spacing w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p>
</w:hdr>`;

  // Blank first-page header — paired with <w:titlePg/> so the cover page shows
  // ONLY the body cover logo/title (no running header → no duplicate logo).
  const header2Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p/></w:hdr>`;

  // Footer: three-zone layout — left: company · title | center: docNum · status · bilingual | right: Page X of Y
  const fldRpr = '<w:rPr><w:color w:val="9CA3AF"/><w:sz w:val="14"/><w:szCs w:val="14"/></w:rPr>';
  function pgField(instr) {
    return `<w:r>${fldRpr}<w:fldChar w:fldCharType="begin"/></w:r>` +
           `<w:r>${fldRpr}<w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r>` +
           `<w:r>${fldRpr}<w:fldChar w:fldCharType="separate"/></w:r>` +
           `<w:r>${fldRpr}<w:t>1</w:t></w:r>` +
           `<w:r>${fldRpr}<w:fldChar w:fldCharType="end"/></w:r>`;
  }
  const ftrCreated = new Date().toLocaleDateString('en-GB'); // DD/MM/YYYY
  const ftrLeft   = [brandLabel, shortTitle].filter(Boolean).join(' · ');
  const ftrCenter = [docNum, opts.meta && opts.meta.status ? opts.meta.status : 'Draft', transLang ? 'Bilingual: ' + transLang : '', opts.type === 'record-form' ? 'Created: ' + ftrCreated : ''].filter(Boolean).join('  |  ');
  const ftrTxt = (t) => `<w:r>${fldRpr}<w:t xml:space="preserve">${e(t)}</w:t></w:r>`;
  function ftrCell(w, jc, inner) {
    return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>` +
      `<w:tcMar><w:top w:w="40" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tcMar>` +
      `<w:vAlign w:val="top"/></w:tcPr><w:p><w:pPr><w:jc w:val="${jc}"/></w:pPr>${inner}</w:p></w:tc>`;
  }
  // Borderless 3-column table footer (robust — long titles wrap within their cell
  // instead of overrunning a tab stop and colliding with the next column).
  const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:tbl>
    <w:tblPr>
      <w:tblW w:w="9360" w:type="dxa"/>
      <w:tblBorders>
        <w:top w:val="single" w:sz="4" w:space="0" w:color="D7DAE3"/>
        <w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/>
        <w:insideH w:val="nil"/><w:insideV w:val="nil"/>
      </w:tblBorders>
      <w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>
      <w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/>
    </w:tblPr>
    <w:tblGrid><w:gridCol w:w="3700"/><w:gridCol w:w="3700"/><w:gridCol w:w="1960"/></w:tblGrid>
    <w:tr>
      ${ftrCell(3700, 'left',   ftrTxt(ftrLeft))}
      ${ftrCell(3700, 'center', ftrTxt(ftrCenter))}
      ${ftrCell(1960, 'right',  ftrTxt('Page ') + pgField('PAGE') + ftrTxt(' / ') + pgField('NUMPAGES'))}
    </w:tr>
  </w:tbl>
  <w:p><w:pPr><w:spacing w:after="0" w:line="20" w:lineRule="exact"/></w:pPr></w:p>
</w:ftr>`;

  // Standard Office core properties (readable by Word, SharePoint, Windows Explorer)
  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties
  xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${e(title || 'Document')}</dc:title>
  <dc:description>Generated by ${e(brandLabel)} AI Content Studio. Status: Draft. Version: 1.0. ${docNum ? 'Doc: ' + docNum + '.' : ''}</dc:description>
  <dc:creator>${e(brandLabel)} AI Content Studio</dc:creator>
  <cp:lastModifiedBy>${e(brandLabel)}</cp:lastModifiedBy>
  <cp:revision>1</cp:revision>
  <cp:contentStatus>Draft</cp:contentStatus>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;

  // TrainingPro custom properties — machine-readable without opening the file
  const customXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties
  xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"
  xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="TP_Status"><vt:lpwstr>Draft</vt:lpwstr></property>
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="TP_Version"><vt:lpwstr>1.0</vt:lpwstr></property>
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="4" name="TP_DocNumber"><vt:lpwstr>${e(docNum || 'AUTO')}</vt:lpwstr></property>
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="5" name="TP_DocumentType"><vt:lpwstr>${e(docType)}</vt:lpwstr></property>
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="6" name="TP_GeneratedBy"><vt:lpwstr>TrainingPro AI Content Studio</vt:lpwstr></property>
  <property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="7" name="TP_GeneratedDate"><vt:lpwstr>${now.slice(0,10)}</vt:lpwstr></property>
</Properties>`;

  // Build image extension → MIME map for content types
  const imgExts = new Set(_images.map(i => i.filename.split('.').pop()));
  if (logoFile) imgExts.add(logoFile.ext);
  const IMG_MIME = { png:'image/png', jpg:'image/jpeg', gif:'image/gif', webp:'image/webp' };
  const imgCtLines = [...imgExts].map(x => `  <Default Extension="${x}" ContentType="${IMG_MIME[x] || 'image/png'}"/>`).join('\n');

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml"  ContentType="application/xml"/>
${imgCtLines}
  <Override PartName="/word/document.xml"   ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
${opts.includeToc ? '  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' : ''}
  <Override PartName="/word/header1.xml"    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/header2.xml"    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
  <Override PartName="/word/footer1.xml"    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
  <Override PartName="/docProps/core.xml"   ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml"/>
</Types>`;

  const pkgRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"    Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties"  Target="docProps/custom.xml"/>
</Relationships>`;

  const imgRelLines = _images.map(i =>
    `  <Relationship Id="${i.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${i.filename}"/>`
  ).join('\n');
  const logoBodyRel = logoFile
    ? `  <Relationship Id="rLogoBody" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${logoFile.filename}"/>`
    : '';
  const wordRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header2.xml"/>
${opts.includeToc ? '  <Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' : ''}
${imgRelLines}
${logoBodyRel}
</Relationships>`;

  // Header .rels — needed when the header itself embeds an image (company logo)
  const hdrRels = logoFile ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="${logoFile.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${logoFile.filename}"/>
</Relationships>` : null;

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
            xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
  <w:body>
    ${parts.join('\n    ')}
    <w:sectPr>${sectPrInner(curOrient, !firstBreakDone)}</w:sectPr>
  </w:body>
</w:document>`;

  const z = new AdmZip();
  z.addFile('[Content_Types].xml',          Buffer.from(contentTypes, 'utf8'));
  z.addFile('_rels/.rels',                  Buffer.from(pkgRels, 'utf8'));
  z.addFile('docProps/core.xml',            Buffer.from(coreXml, 'utf8'));
  z.addFile('docProps/custom.xml',          Buffer.from(customXml, 'utf8'));
  z.addFile('word/_rels/document.xml.rels', Buffer.from(wordRels, 'utf8'));
  z.addFile('word/document.xml',            Buffer.from(docXml, 'utf8'));
  if (opts.includeToc) {
    // updateFields=true → Word offers to update the TOC field automatically when the document is opened.
    const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:updateFields w:val="true"/></w:settings>`;
    z.addFile('word/settings.xml', Buffer.from(settingsXml, 'utf8'));
  }
  z.addFile('word/header1.xml',             Buffer.from(headerXml, 'utf8'));
  z.addFile('word/header2.xml',             Buffer.from(header2Xml, 'utf8'));
  z.addFile('word/footer1.xml',             Buffer.from(footerXml, 'utf8'));
  if (hdrRels) z.addFile('word/_rels/header1.xml.rels', Buffer.from(hdrRels, 'utf8'));
  for (const img of _images) z.addFile(`word/media/${img.filename}`, img.buf);
  if (logoFile) z.addFile(`word/media/${logoFile.filename}`, logoFile.buf);
  return z.toBuffer();
}

// ── AI Prompts ─────────────────────────────────────────────────────────────────
const PROMPTS = {
  exam: `Return ONLY JSON:
{"testName":"...","passScore":80,"timeLimit":null,"questions":[{"type":"single|multi|truefalse","question":"...","options":[{"text":"...","correct":true}]}]}
Rules: 6-12 questions unless asked otherwise; single=exactly one correct; multi=2+ correct; truefalse=options ["True","False"] with one correct. No markdown.`,

  form: `Return ONLY JSON:
{"name":"...","passMark":80,"fields":[{"type":"section|text|textarea|checkbox|competency|signature|date|number|yesno|rating","label":"...","options":["..."]}]}
Rules: Use "section" for headings, "competency" for assessed (competent/not competent) items, "checkbox" needs an options array, "signature" for sign-offs. Start with a section heading. No markdown.`,

  'akara-leadership': `Return ONLY valid JSON (no markdown, no fences). Build a structured DOCUMENT from the content below (same rich document format as a Standard — headings, tables, checklists):
{"title":"LEADERSHIP EXPECTATIONS AGREEMENT — Supervisors and Contractor Teams (Surface Operations)","subtitle":"Leadership Expectations · Surface Operations · Version 1.0","docNumber":"LEAD-001","sections":[
{"heading":"1. Personal Details","level":1,"body":"To be completed by the supervisor or contractor leader.","table":{"headers":["Field","Details"],"rows":[["Name",""],["Position",""],["Company (if contractor)",""],["Department / Area",""],["Supervisor / Manager",""],["Date",""]]}},
{"heading":"2. Leadership Expectations Acknowledgement","level":1,"body":"Acknowledge each leadership expectation below. Tick every commitment to confirm understanding and acceptance."},
{"heading":"Safety Leadership","level":2,"checklist":["Demonstrate visible safety leadership every shift","Stop work if conditions are unsafe","Ensure compliance with critical controls","Actively report and investigate incidents"]},
{"heading":"Production Discipline","level":2,"checklist":["Deliver the plan safely and consistently","Manage shift performance against targets","Identify and act on delays early","Coordinate with other teams effectively"]},
{"heading":"Equipment and Asset Care","level":2,"checklist":["Ensure inspections are completed","Enforce correct operating practices","Report defects promptly","Support maintenance reliability"]},
{"heading":"Contractor Management","level":2,"checklist":["Ensure contractors follow site standards","Clearly define work scope and responsibilities","Monitor contractor performance daily","Address non-compliance immediately"]},
{"heading":"Workforce Leadership","level":2,"checklist":["Lead by example at all times","Hold personnel accountable fairly and consistently","Coach and develop team members","Actively manage fatigue and behaviour"]},
{"heading":"Communication and Shift Control","level":2,"checklist":["Conduct structured pre-starts and handovers","Communicate risks and priorities clearly","Ensure instructions are understood","Escalate issues early"]},
{"heading":"Compliance and Standards","level":2,"checklist":["Follow all procedures, permits, and site rules","Ensure documentation is accurate and complete","Maintain housekeeping standards"]},
{"heading":"Continuous Improvement","level":2,"checklist":["Identify inefficiencies and improvement opportunities","Support operational improvements","Learn from incidents and delays","Contribute to system improvements"]},
{"heading":"3. Daily Leadership Commitment","level":1,"checklist":["Be visible in the field","Reinforce safe work practices","Control the shift against plan","Hold people accountable","Communicate clearly and early"]},
{"heading":"4. Agreement and Accountability","level":1,"body":"I acknowledge these expectations apply equally to employees and contractors.\\nI understand safety is never compromised for production.\\nI accept accountability for safety, people, equipment, and performance under my control.\\nI understand failure to meet these expectations may result in corrective action.","callout":"Safety is never compromised for production."},
{"heading":"5. Sign-Off","level":1,"body":"Signed by both parties to confirm acceptance of these expectations.","table":{"headers":["Role","Name","Signature","Date"],"rows":[["Supervisor or Contractor Leader","","",""],["Site Representative or Manager","","",""]]}}
]}
Rules: keep this structure and content; adapt company/department references to the site if provided in the task or knowledge base; the company name is applied automatically — do not invent a different organisation. No markdown fences.`,

  course: `Return ONLY JSON:
{"title":"...","sections":[{"heading":"...","body":"..."}]}
Rules: Include Learning Objectives, several content sections, and a Summary. body is plain text (use \\n for new lines / bullets). No markdown fences.`,

  sop: `Return ONLY JSON:
{"title":"...","sections":[{"heading":"Purpose","body":"..."},{"heading":"Scope","body":"..."},{"heading":"Responsibilities","body":"..."},{"heading":"Hazards & Controls","body":"..."},{"heading":"Procedure","body":"..."},{"heading":"References","body":"..."}]}
Rules: body is plain text (use \\n for steps/bullets). Keep it operational and specific. No markdown fences.`,

  'training-plan': `Return ONLY valid JSON (no markdown, no fences):
{"title":"[Descriptive title — Training Plan]","subtitle":"Training Plan · [Department] · [Site]","docNumber":"TP-[DEPT]-001","sections":[
{"heading":"1. Training Overview","level":1,"body":"[Purpose of the plan, scope, and what it delivers. Use \\n for structure.]"},
{"heading":"2. Target Audience","level":1,"body":"[Who the training is for — roles, experience level, prerequisites.]"},
{"heading":"3. Learning Objectives","level":1,"body":"On completion learners will be able to:\\n- [Specific, measurable objective]\\n- [Specific, measurable objective]\\n- [Specific, measurable objective]"},
{"heading":"4. Module Breakdown","level":1,"table":{"headers":["Module","Topics Covered","Delivery Method","Duration"],"rows":[["Module 1 — [Topic]","[Key topics]","[Classroom / Online / On-the-job]","[e.g. 2 hrs]"],["Module 2 — [Topic]","[Key topics]","[Method]","[Duration]"],["Module 3 — [Topic]","[Key topics]","[Method]","[Duration]"]]}},
{"heading":"5. Assessment Method","level":1,"table":{"headers":["Module","Assessment Type","Pass Criteria","Assessor"],"rows":[["Module 1","[Written / Practical / Observation]","[e.g. 80% / Competent]","[Trainer / Supervisor]"],["Module 2","[Type]","[Criteria]","[Assessor]"]]}},
{"heading":"6. Resources Required","level":1,"table":{"headers":["Resource","Type","Responsible","Notes"],"rows":[["[Resource]","[Equipment / Facility / Material / Personnel]","[Owner]","[Notes]"],["[Resource]","[Type]","[Owner]","[Notes]"]]}},
{"heading":"7. Schedule / Timeline","level":1,"table":{"headers":["Phase / Week","Activity","Delivery Method","Responsible"],"rows":[["Week 1","[Activity]","[Method]","[Owner]"],["Week 2","[Activity]","[Method]","[Owner]"],["Week 3","[Activity]","[Method]","[Owner]"]]}},
{"heading":"8. Roles and Responsibilities","level":1,"table":{"headers":["Role","Responsibility"],"rows":[["Trainer / Assessor","[Responsibility]"],["Supervisor","[Responsibility]"],["Trainee","[Responsibility]"]]}},
{"heading":"9. Records and Evaluation","level":1,"body":"[How completion is recorded, how competency is signed off, and how the training is evaluated and reviewed.]"}
]}
Rules: Use the "table" objects shown above for the Module Breakdown, Assessment Method, Resources Required, Schedule/Timeline and Roles & Responsibilities so the plan is clear, structured and easy to read in the Word document. Fill every table with real, specific content — NO placeholder text — and give each table at least 3 data rows where the content allows. Use \\n for line breaks inside body strings. When source/reference document(s) are provided, base the modules, topics, durations, assessments, resources and schedule on their content. No markdown fences.`,

  induction: `Return ONLY JSON:
{"title":"...","sections":[{"heading":"Welcome","body":"..."},{"heading":"Site Rules & Safety","body":"..."},{"heading":"Emergency Procedures","body":"..."},{"heading":"PPE Requirements","body":"..."},{"heading":"Reporting Structure","body":"..."},{"heading":"Key Contacts","body":"..."},{"heading":"Induction Checklist","body":"..."}]}
Rules: body is plain text (use \\n for checklist items). Include practical site-specific guidance. No markdown fences.`,

  'operational-guidelines': `Return ONLY valid JSON (no markdown, no fences):
{"title":"[Descriptive title — Operational Guidelines]","subtitle":"Operational Guidelines · [Department / Area] · [Site]","docNumber":"OG-[DEPT]-001","sections":[
{"heading":"1. Purpose","level":1,"body":"[Why these guidelines exist and what they aim to achieve.]"},
{"heading":"2. Scope","level":1,"body":"[What activities, areas, equipment and roles these guidelines apply to.]"},
{"heading":"3. Definitions","level":1,"table":{"headers":["Term","Definition"],"rows":[["[Term]","[Clear definition]"],["[Term]","[Clear definition]"]]}},
{"heading":"4. Roles and Responsibilities","level":1,"table":{"headers":["Role","Responsibility"],"rows":[["Manager / Superintendent","[Responsibility]"],["Supervisor","[Responsibility]"],["Operator / Worker","[Responsibility]"]]}},
{"heading":"5. General Operating Guidelines","level":1,"body":"[Core guidance on how the operation is to be conducted. Use \\n and '- ' bullets for key points.]"},
{"heading":"6. Operational Practices","level":1,"table":{"headers":["Activity / Task","Guideline / Standard","Responsible","Reference"],"rows":[["[Activity]","[Guideline or standard to follow]","[Owner]","[Related SOP / standard]"],["[Activity]","[Guideline]","[Owner]","[Reference]"]]}},
{"heading":"7. Safety, Health and Environmental Requirements","level":1,"body":"[Key safety, health and environmental requirements and controls. Use '- ' bullets.]"},
{"heading":"8. Compliance and Monitoring","level":1,"body":"[How compliance is monitored, measured and enforced — checks, KPIs, audits, record-keeping.]"},
{"heading":"9. Review and Continuous Improvement","level":1,"body":"[How and when these guidelines are reviewed and updated.]"},
{"heading":"10. References and Related Documents","level":1,"body":"[Relevant legislation, standards, SOPs and related documents. Use \\n between items.]"}
]}
Rules: Use the "table" objects shown for Definitions, Roles & Responsibilities and Operational Practices so the document is structured and easy to read in the Word document. Fill every section and table with real, specific, operational content — NO placeholder text; give each table at least 3 data rows where the content allows. Use \\n for line breaks inside body strings. When source/reference document(s) are provided, base the guidelines on their content. No markdown fences.`,

  'training-manual': `Return ONLY valid JSON (no markdown, no fences):
{"title":"[Descriptive title — Training Manual]","subtitle":"Training Manual · [Department] · [Site]","docNumber":"TM-[DEPT]-001","sections":[
{"heading":"1. Purpose and Overview","level":1,"body":"[Purpose statement, target audience, prerequisites. Use \\n for line breaks.]"},
{"heading":"1.1 Target Audience","level":2,"body":"[Who must complete this training. Specify roles, experience level, prerequisites.]"},
{"heading":"2. Learning Outcomes","level":1,"body":"On completion the learner will be able to:\\n- [Specific, measurable outcome 1]\\n- [Specific, measurable outcome 2]\\n- [Specific, measurable outcome 3]"},
{"heading":"3. Background and Context","level":1,"body":"[Regulatory context, risk profile, equipment and process overview.]"},
{"heading":"4.1 Module 1 — [Topic]","level":2,"body":"[Detailed knowledge content for module 1. Use \\n for paragraphs and bullet points.]"},
{"heading":"4.2 Module 2 — [Topic]","level":2,"body":"[Detailed knowledge content for module 2.]"},
{"heading":"4.3 Module 3 — [Topic]","level":2,"body":"[Detailed knowledge content for module 3.]"},
{"heading":"5. Safety Requirements","level":1,"table":{"headers":["PPE Item","Standard/Grade","Mandatory","Inspection Frequency"],"rows":[["Hard Hat","AS/NZS 1801 Type 1","Yes","Pre-shift"],["Safety Glasses","AS/NZS 1337.1","Yes","Pre-shift"],["High-Vis Vest","AS/NZS 4602","Yes","Daily"],["Safety Boots","AS/NZS 2210.3","Yes","Pre-shift"],["Gloves","AS/NZS 2161","Task dependent","Pre-use"]]}},
{"heading":"6. Practical Skills and Procedures","level":1,"body":"[Step-by-step practical guidance.]"},
{"heading":"7. Knowledge Check","level":1,"body":"1. [Assessment question]?\\nA. [Option]\\nB. [Option — correct]\\nC. [Option]\\n\\n2. [Assessment question]?\\nA. [Option — correct]\\nB. [Option]\\nC. [Option]"},
{"heading":"8. Glossary","level":1,"table":{"headers":["Term","Definition"],"rows":[["[Term 1]","[Clear definition]"],["[Term 2]","[Clear definition]"],["[Term 3]","[Clear definition]"]]}},
{"heading":"9. References and Standards","level":1,"body":"[List relevant legislation, standards, codes of practice. Use \\n between items.]"}
]}
Rules: minimum 8 detailed sections; tables must have at least 4 data rows; use real specific content — no placeholder text; use \\n for line breaks inside body strings.`,

  swp: `Return ONLY valid JSON (no markdown, no fences):
{"title":"SAFE WORK PROCEDURE — [TASK NAME IN CAPS]","subtitle":"SWP-[DEPT]-001 · Risk Level: HIGH","docNumber":"SWP-[DEPT]-001","sections":[
{"heading":"1. Purpose","level":1,"body":"[Why this SWP exists and what it governs.]"},
{"heading":"2. Scope","level":1,"body":"[Who and what this SWP applies to. Specify locations, equipment, activities, roles.]"},
{"heading":"3. Responsibilities","level":1,"table":{"headers":["Role","Responsibility"],"rows":[["Operator","[Specific responsibility]"],["Supervisor","[Specific responsibility]"],["HSE Representative","[Specific responsibility]"],["Maintenance","[Specific responsibility]"]]}},
{"heading":"4. PPE Requirements","level":1,"table":{"headers":["PPE Item","Standard/Grade","Mandatory","Inspection Frequency"],"rows":[["Hard Hat","AS/NZS 1801 Type 1","Yes","Pre-shift"],["Safety Glasses","AS/NZS 1337.1","Yes","Pre-shift"],["High-Vis Vest","AS/NZS 4602","Yes","Daily"],["Safety Boots","AS/NZS 2210.3","Yes","Pre-shift"],["Gloves","AS/NZS 2161","Task specific","Pre-use"],["[Task-specific PPE]","[Standard]","Yes","[Frequency]"]]}},
{"heading":"5. Hazard Identification and Risk Controls","level":1,"callout":"Apply controls in order of the Hierarchy of Control: Eliminate > Substitute > Isolate > Engineer > Administrative > PPE.","table":{"headers":["Hazard","Initial Risk","Control Measures","Residual Risk","Responsible"],"rows":[["[Hazard 1]","High","[Specific controls applied in hierarchy order]","Low","Supervisor"],["[Hazard 2]","High","[Controls]","Medium","Operator"],["[Hazard 3]","Medium","[Controls]","Low","All"],["[Hazard 4]","High","[Controls]","Low","Supervisor"]]}},
{"heading":"5.1 Environmental and Weather Restrictions","level":2,"body":"[When must work stop? Specify weather, visibility, ground conditions, etc.]"},
{"heading":"6. Step-by-Step Procedure","level":1,"table":{"headers":["Step","Phase","Action Required","Hazard","Control","✓"],"rows":[["1","Pre-task","[First action]","[Hazard]","[Control]","☐"],["2","Pre-task","[Action]","[Hazard]","[Control]","☐"],["3","Task","[Action]","[Hazard]","[Control]","☐"],["4","Task","[Action]","[Hazard]","[Control]","☐"],["5","Task","[Action]","[Hazard]","[Control]","☐"],["6","Task","[Action]","[Hazard]","[Control]","☐"],["7","Post-task","[Action]","[Hazard]","[Control]","☐"],["8","Post-task","[Action]","[Hazard]","[Control]","☐"]]}},
{"heading":"7. Emergency Procedures","level":1,"body":"[What to do if something goes wrong. Include immediate response, contacts, muster point.]"},
{"heading":"8. Related Documents","level":1,"body":"[List linked SOPs, permits, JSAs, emergency plans. Use \\n between items.]"},
{"heading":"9. Sign-Off","level":1,"table":{"headers":["Name","Role","Signature","Date"],"rows":[["","Operator","___________",""],["","Operator","___________",""],["","Supervisor","___________",""]]}}
]}
Rules: all tables minimum 4 data rows; steps table minimum 8 rows; content specific to stated task — no placeholders; use \\n for line breaks in body strings.`,

  jsa: `Return ONLY valid JSON (no markdown, no fences):
{"title":"JOB SAFETY ANALYSIS — [TASK NAME IN CAPS]","subtitle":"JSA-[SITE]-001","docNumber":"JSA-[SITE]-001","sections":[
{"heading":"Task Information","level":1,"table":{"headers":["Field","Detail"],"rows":[["Job / Task Description","[Specific task]"],["Work Location","[Area, pit, level, or site reference]"],["Supervisor / Leading Hand","[Name]"],["Date","[DD/MM/YYYY]"],["Permit Required","☐ Yes — Type: _______________   ☐ No"],["Weather / Ground Conditions","[Expected conditions and restrictions]"],["Estimated Duration","[Hours or shifts]"]]}},
{"heading":"Regulatory and Permit Requirements","level":1,"table":{"headers":["Requirement","Regulation / Reference","Required?"],"rows":[["High-Risk Work Licence","State WHS Regulation","☐ Yes  ☐ No"],["Confined Space Entry Permit","WHS Reg 2017 Part 4.3","☐ Yes  ☐ No"],["Hot Work Permit","Site Safety Standard","☐ Yes  ☐ No"],["Isolation Certificate / LOTO","Site Isolation Procedure","☐ Yes  ☐ No"],["Elevated Work Permit","WHS Reg 2017 Part 4.4","☐ Yes  ☐ No"]]}},
{"heading":"Job Steps and Hazard Analysis","level":1,"callout":"Complete BEFORE starting work. Review with all crew members. If any residual risk is CRITICAL — stop and escalate.","table":{"headers":["Step","Job Step Description","Hazards Identified","Risk Rating","Control Measures","✓"],"rows":[["1","[First sequential step of the task]","[All hazards for this step]","High","[Specific controls — hierarchy of control order]","☐"],["2","[Second step]","[Hazards]","Medium","[Controls]","☐"],["3","[Third step]","[Hazards]","High","[Controls]","☐"],["4","[Fourth step]","[Hazards]","Medium","[Controls]","☐"],["5","[Fifth step]","[Hazards]","Low","[Controls]","☐"],["6","[Sixth step]","[Hazards]","High","[Controls]","☐"],["7","[Seventh step]","[Hazards]","Medium","[Controls]","☐"],["8","[Eighth step — post-task]","[Hazards]","Low","[Controls]","☐"]]}},
{"heading":"Residual Risk Summary","level":1,"body":"Overall residual risk rating after controls applied: [LOW / MEDIUM / HIGH]\\n[Brief justification for rating]","callout":"If any residual risk is HIGH or CRITICAL — STOP WORK and consult management before proceeding."},
{"heading":"Emergency Response Summary","level":1,"table":{"headers":["Scenario","Immediate Action","Contact Number"],"rows":[["Injury / Medical Emergency","STOP. Apply first aid. Call supervisor immediately.","000 / Site: [#]"],["Fire / Explosion","Evacuate area. Alert traffic control. Activate alarm.","000 / Emergency: [#]"],["Spill / Chemical Release","Contain and isolate source. Evacuate downwind.","Site Emergency: [#]"],["Equipment Failure","Shut down safely. Isolate. Do not attempt repairs alone.","Maintenance: [#]"]]}},
{"heading":"Team Briefing and Sign-Off","level":1,"callout":"All personnel listed below confirm they have read, understood, and will comply with this JSA.","table":{"headers":["Printed Name","Role","Signature","Date","Time"],"rows":[["","","___________","",""],["","","___________","",""],["","","___________","",""],["","","___________","",""]]}}
]}
Rules: Job Steps table minimum 8 rows; include specific, realistic hazards and controls; no markdown fences.`,

  'training-deck': `Return ONLY valid JSON (no markdown, no fences):
{"title":"[TOPIC] — TRAINING PROGRAM","subtitle":"[Department] · [Site]","docNumber":"TD-[DEPT]-001","sections":[
{"heading":"SLIDE GROUP 1 — Opening","level":1,"body":""},
{"heading":"Slide 1: Title","level":2,"body":"[Training title]\\n[Department] · [Site] · [Date]\\nPresented by: [Trainer Name / Role]\\nSpeaker note: Welcome participants. Introduce yourself. State the agenda and expected duration."},
{"heading":"Slide 2: Learning Objectives","level":2,"body":"By the end of this session you will be able to:\\n- [Specific, measurable objective 1]\\n- [Specific, measurable objective 2]\\n- [Specific, measurable objective 3]\\nSpeaker note: Read objectives aloud. Ask what participants already know to baseline the group."},
{"heading":"SLIDE GROUP 2 — Why This Matters","level":1,"body":""},
{"heading":"Slide 3: Industry Context","level":2,"body":"[Relevant industry statistic or sanitised incident reference]\\nKey fact: [Compelling data point]\\nSpeaker note: Use real numbers if available. Make it personal — connect to the team's experience."},
{"heading":"Slide 4: Regulatory Requirements","level":2,"body":"Legislation: [Act / Regulation name]\\nKey obligation: [Specific duty]\\nConsequence of non-compliance: [Fine / prosecution / shutdown]\\nSpeaker note: Keep brief. Workers care about consequences, not citation numbers."},
{"heading":"SLIDE GROUP 3 — Core Knowledge","level":1,"body":""},
{"heading":"Slide 5: [Key Concept 1]","level":2,"body":"[3-5 concise bullet points]\\nSpeaker note: [Example or analogy for the presenter]"},
{"heading":"Slide 6: [Key Concept 2]","level":2,"body":"[3-5 concise bullet points]\\nSpeaker note: [Presenter guidance]"},
{"heading":"Slide 7: [Key Concept 3]","level":2,"body":"[3-5 concise bullet points]\\nSpeaker note: [Presenter guidance]"},
{"heading":"SLIDE GROUP 4 — Procedure","level":1,"body":""},
{"heading":"Slide 8: Step-by-Step Procedure","level":2,"body":"Pre-task:\\n1. [Step]\\n2. [Step]\\nDuring task:\\n3. [Step]\\n4. [Step]\\nPost-task:\\n5. [Step]\\nSpeaker note: Walk through each step. Ask: what could go wrong here?"},
{"heading":"SLIDE GROUP 5 — Hazards and Controls","level":1,"body":""},
{"heading":"Slide 9: Top Hazards and Controls","level":2,"body":"[Hazard 1]: [Control]\\n[Hazard 2]: [Control]\\n[Hazard 3]: [Control]\\nSpeaker note: Ask participants to identify hazards before revealing controls."},
{"heading":"SLIDE GROUP 6 — Knowledge Check","level":1,"body":""},
{"heading":"Slide 10: Quiz — Question 1","level":2,"body":"Q: [Quiz question relevant to key content]?\\nA. [Incorrect]\\nB. [Incorrect]\\nC. [Correct answer]\\nD. [Incorrect]\\nAnswer: C\\nSpeaker note: Allow 30 seconds, then reveal and explain."},
{"heading":"Slide 11: Quiz — Question 2","level":2,"body":"Q: [Second quiz question]?\\nA. [Correct answer]\\nB. [Incorrect]\\nC. [Incorrect]\\nAnswer: A\\nSpeaker note: Discuss why the wrong answers are wrong."},
{"heading":"SLIDE GROUP 7 — Close","level":1,"body":""},
{"heading":"Slide 12: Summary and Next Steps","level":2,"body":"Key takeaways:\\n- [Message 1]\\n- [Message 2]\\n- [Message 3]\\nNext steps: Complete the written assessment. Sign the attendance sheet.\\nSpeaker note: Leave time for questions. Thank participants."}
]}
Rules: minimum 12 slides across at least 6 groups; practical speaker notes on every slide; content specific to the prompt topic; no markdown fences.`,

  'training-handout': `Return ONLY valid JSON (no markdown, no fences):
{"title":"[TOPIC] — QUICK REFERENCE HANDOUT","subtitle":"[Role] · [Department] · Version 1.0","docNumber":"HO-[DEPT]-001","sections":[
{"heading":"Key Learning Points","level":1,"checklist":["[Key point 1 — specific and actionable]","[Key point 2]","[Key point 3]","[Key point 4]","[Key point 5]","[Key point 6]"]},
{"heading":"Procedure Summary","level":1,"body":"1. [First step — specific action]\\n2. [Second step]\\n3. [Third step]\\n4. [Fourth step]\\n5. [Fifth step]"},
{"heading":"Hazard Quick Reference","level":1,"table":{"headers":["Hazard","Control Measure","Risk Level"],"rows":[["[Hazard 1]","[Control]","High"],["[Hazard 2]","[Control]","Medium"],["[Hazard 3]","[Control]","Medium"],["[Hazard 4]","[Control]","Low"]]}},
{"heading":"PPE Required","level":1,"table":{"headers":["PPE Item","Standard","Mandatory"],"rows":[["Hard Hat","AS/NZS 1801","Yes"],["Safety Glasses","AS/NZS 1337.1","Yes"],["High-Vis Vest","AS/NZS 4602","Yes"],["Safety Boots","AS/NZS 2210.3","Yes"],["[Task-specific item]","[Standard]","Yes"]]}},
{"heading":"Emergency — STOP · CALL · RESPOND","level":1,"callout":"1. STOP — Cease work immediately.\\n2. CALL — Emergency: 000  /  Site control: [Number]\\n3. RESPOND — First aid at [location]  /  Muster point: [location]"},
{"heading":"Key Contacts","level":1,"table":{"headers":["Role","Contact"],"rows":[["Emergency Services","000"],["Site Emergency Controller","[Number]"],["Direct Supervisor","[Number]"],["HSE Officer","[Number]"],["First Aider","[Number / Name]"]]}}
]}
Rules: checklist minimum 6 items; hazard table minimum 4 rows; plain language for frontline workers; no markdown fences.`,

  'safety-alert': `Return ONLY valid JSON (no markdown, no fences):
{"title":"⚠️ SAFETY ALERT — [INCIDENT TYPE IN CAPS]","subtitle":"Alert No: SA-[SITE]-001 · Severity: HIGH · Date: [DD/MM/YYYY]","docNumber":"SA-[SITE]-001","sections":[
{"heading":"What Happened","level":1,"body":"[Factual, anonymous description — where, when, what was happening, who was involved by role only.]","callout":"This alert is issued to ALL personnel at [Site / Department]. Read and discuss at your next pre-start meeting."},
{"heading":"Why It Happened","level":1,"body":"Contributing factors:\\n- [Contributing factor 1]\\n- [Contributing factor 2]\\n- [Contributing factor 3]"},
{"heading":"What Could Have Happened","level":1,"body":"[Describe the worst credible outcome if circumstances were slightly different.]","callout":"Potential Severity: CRITICAL — This event could have resulted in a fatality or permanent disabling injury."},
{"heading":"Immediate Actions Taken","level":1,"checklist":["[Immediate action 1 already completed]","[Immediate action 2]","[Immediate action 3]","[Immediate action 4]"]},
{"heading":"Actions Required — Your Team","level":1,"callout":"ALL actions must be completed by the due date. Supervisors are accountable.","table":{"headers":["#","Action Required","Responsible","Complete By"],"rows":[["1","[Specific, measurable action]","All Supervisors","[Date]"],["2","[Specific action]","All Operators","[Date]"],["3","[Action]","HSE Team","[Date]"],["4","[Action]","Training Department","[Date]"],["5","[Action]","Department Manager","[Date]"]]}},
{"heading":"Lessons Learned","level":1,"body":"[1-3 key lessons that apply to all workers. Plain language. Actionable.]"},
{"heading":"Pre-Start Discussion Record","level":1,"callout":"Supervisors: Sign below once you have discussed this alert at a pre-start meeting.","table":{"headers":["Supervisor Name","Crew / Shift","Signature","Date Discussed"],"rows":[["","","___________",""],["","","___________",""],["","","___________",""]]}}
]}
Rules: actions table minimum 5 rows; body text factual and anonymous; language direct and urgent; no markdown fences.`,

  'toolbox-talk': `Return ONLY valid JSON (no markdown, no fences):
{"title":"TOOLBOX TALK — [TOPIC IN CAPS]","subtitle":"[Department] · [Site] · Date: [DD/MM/YYYY]","docNumber":"TBT-[DEPT]-001","sections":[
{"heading":"1. Talk Details","level":1,"table":{"headers":["Field","Detail"],"rows":[["Topic","[Topic]"],["Date","[DD/MM/YYYY]"],["Start Time","[  :  ]"],["Location / Work Area","[Location]"],["Presenter / Facilitator","[Name]"],["Department / Crew","[Department]"],["Duration","[XX minutes]"]]}},
{"heading":"2. Purpose","level":1,"body":"[1-2 sentences: why this toolbox talk matters and what the crew should do differently afterwards.]"},
{"heading":"3. Key Discussion Points","level":1,"body":"[The main teaching points for the topic as short, practical numbered points the facilitator talks through. Use \\n and - bullets. Be specific to the task and its hazards — no generic filler.]"},
{"heading":"4. Hazards and Controls","level":1,"table":{"headers":["Hazard","Control Measure","Responsible"],"rows":[["[Hazard 1]","[Specific control]","[Role]"],["[Hazard 2]","[Control]","[Role]"],["[Hazard 3]","[Control]","[Role]"],["[Hazard 4]","[Control]","[Role]"]]}},
{"heading":"5. Safe Work Reminders","level":1,"checklist":["[Specific, observable reminder 1]","[Reminder 2]","[Reminder 3]","[Reminder 4]","[Reminder 5]"]},
{"heading":"6. Questions, Concerns and Feedback","level":1,"body":"Record any questions, concerns, near misses or suggestions raised by the crew:\\n\\n_______________________________________________\\n_______________________________________________\\n_______________________________________________"},
{"heading":"7. Actions Arising","level":1,"table":{"headers":["Action","Assigned To","Due Date","Done"],"rows":[["","","","☐"],["","","","☐"],["","","","☐"]]}},
{"heading":"8. Attendance and Sign-Off","level":1,"callout":"Everyone who attended must PRINT their name and SIGN to confirm they attended and understood this toolbox talk.","table":{"headers":["#","Name (print)","Signature","Date"],"rows":[["1","","",""],["2","","",""],["3","","",""],["4","","",""],["5","","",""],["6","","",""],["7","","",""],["8","","",""],["9","","",""],["10","","",""],["11","","",""],["12","","",""]]}},
{"heading":"9. Facilitator Confirmation","level":1,"table":{"headers":["Role","Name","Signature","Date"],"rows":[["Facilitator / Presenter","","___________",""],["Supervisor","","___________",""]]}}
]}
Rules: KEEP IT SHORT, PLAIN and DIRECT — a toolbox talk is a 5–10 minute pre-start chat, NOT a training manual or lesson. Purpose = 1–2 short sentences. Key Discussion Points = 4–6 one-line bullets (no paragraphs, no theory, no background). Hazards/Controls = 3–5 rows with short practical controls. Safe Work Reminders = 4–6 short reminders. adapt ALL content specifically to the requested topic (never generic); include the attendance table with at least 12 blank numbered rows and the facilitator sign-off; no long explanations or filler; no markdown fences.`,

  'training-request': `Return ONLY valid JSON (no markdown, no fences):
{"name":"Training Request Form — [Course/Program Name]","passMark":0,"description":"Training request and approval form. Submitting this form initiates the approval workflow.","fields":[
{"type":"section","label":"1. Requestor Information"},
{"type":"text","label":"Requestor Full Name"},
{"type":"text","label":"Job Title"},
{"type":"text","label":"Department"},
{"type":"text","label":"Email Address"},
{"type":"text","label":"Phone / Radio Number"},
{"type":"section","label":"2. Employee(s) to be Trained"},
{"type":"text","label":"Employee Name(s)"},
{"type":"text","label":"Employee ID Number(s)"},
{"type":"text","label":"Current Job Title"},
{"type":"text","label":"Work Location / Crew"},
{"type":"number","label":"Number of Employees"},
{"type":"section","label":"3. Training Details"},
{"type":"text","label":"Training Course / Program Name"},
{"type":"select","label":"Training Type","options":["Internal — delivered by company trainer","External — accredited provider","Online / eLearning","On-the-Job (supervised)","Mentoring / Coaching"]},
{"type":"text","label":"Training Provider / Facilitator"},
{"type":"text","label":"Qualification or Competency Achieved"},
{"type":"date","label":"Proposed Start Date"},
{"type":"date","label":"Proposed End Date"},
{"type":"text","label":"Duration (hours / days / weeks)"},
{"type":"text","label":"Training Location / Venue"},
{"type":"section","label":"4. Business Justification"},
{"type":"select","label":"Primary Reason for Training","options":["Regulatory / Legal compliance","Skills gap — identified in competency framework","New role / promotion preparation","New equipment or process","Career development plan","Incident or near-miss follow-up","Refresher — qualification approaching expiry"]},
{"type":"textarea","label":"Detailed Business Justification (describe the need and expected outcome)"},
{"type":"section","label":"5. Cost Estimate"},
{"type":"text","label":"Course / Registration Fee ($)"},
{"type":"text","label":"Travel and Accommodation ($)"},
{"type":"text","label":"Backfill / Relief Labour Cost ($)"},
{"type":"text","label":"Total Estimated Cost ($)"},
{"type":"text","label":"Budget Code / Cost Centre"},
{"type":"section","label":"6. Operational Impact"},
{"type":"textarea","label":"Impact on operations during training period"},
{"type":"section","label":"7. Approval Signatures"},
{"type":"signature","label":"Requesting Supervisor"},
{"type":"signature","label":"Department Manager"},
{"type":"signature","label":"Training / HR Department"}
]}
Rules: adapt the form name and field labels to the specific course or program requested; include all approval sections; no markdown fences.`,

  'transfer-to-training': `Return ONLY valid JSON (no markdown, no fences):
{"title":"EMPLOYEE TRANSFER TO TRAINING","subtitle":"Training Transition Authority and Plan · [Department] · [Site]","docNumber":"TT-[DEPT]-001","sections":[
{"heading":"1. Employee and Training Program Details","level":1,"table":{"headers":["Field","Detail"],"rows":[["Employee Full Name","[Full Name]"],["Employee ID","[ID]"],["Current Job Title","[Title]"],["Department / Crew","[Department]"],["Direct Supervisor","[Name]"],["Training Program","[Full program name]"],["Training Provider","[Provider name]"],["Training Location","[Location]"],["Start Date","[DD/MM/YYYY]"],["Expected End Date","[DD/MM/YYYY]"],["Duration","[Weeks / Months]"],["Qualification / Certificate Target","[Cert name]"]]}},
{"heading":"2. Reason for Transfer","level":1,"checklist":["Identified skills gap — [specify gap]","Career development and succession plan","Regulatory compliance requirement","Preparation for a new role","New equipment or process introduced","Refresher — qualification approaching expiry","Incident or near-miss follow-up — mandatory training"]},
{"heading":"3. Justification","level":1,"body":"[Explain why this employee was selected for training. Link to workforce development strategy or specific operational need.]"},
{"heading":"4. Competency Baseline (Pre-Training)","level":1,"table":{"headers":["Competency / Skill","Current Level","Target Level","Gap"],"rows":[["[Skill 1]","Not assessed","Competent","Yes"],["[Skill 2]","Developing","Competent","Yes"],["[Skill 3]","Competent","Advanced","Yes"],["[Skill 4]","Not assessed","Competent","Yes"]]}},
{"heading":"5. Operational Handover Checklist","level":1,"callout":"Supervisor must confirm all items are completed before the employee departs for training.","checklist":["Brief replacement worker on all ongoing tasks, priorities, and in-progress work orders","Return all site equipment, tools, keys, and access cards to the supervisor","Complete any outstanding work orders, permit closures, or shift handover documentation","Update the shift handover log and leave written notes for the relief crew","Confirm training schedule, location, and logistics with the training contact","Advise team of absence duration and provide emergency contact method","Remove name from operating rosters and notify scheduling / dispatch"]},
{"heading":"6. Training Expectations and Ground Rules","level":1,"body":"Attendance: 100% mandatory — written approval required for any absence.\\nPass standard: [X%] written assessment AND demonstrated practical competency sign-off.\\nWeekly reporting: Progress update email to direct supervisor every Friday.\\nReturn trigger: Training complete AND competency signed off AND clearance issued."},
{"heading":"7. Communication Plan","level":1,"table":{"headers":["Communication","From → To","Frequency","Responsibility"],"rows":[["Progress update email","Employee → Supervisor","Weekly (Friday)","Employee"],["Attendance and assessment report","Trainer → Training Dept","Fortnightly","Trainer / Provider"],["Operational updates","Supervisor → Employee","As required","Supervisor"],["Completion notification","Training Dept → Manager & HR","On completion","Training Dept"]]}},
{"heading":"8. Authorisation","level":1,"table":{"headers":["Role","Printed Name","Signature","Date"],"rows":[["Employee","","___________",""],["Direct Supervisor","","___________",""],["Department Manager","","___________",""],["Training Manager","","___________",""],["HR Representative","","___________",""]]}}
]}
Rules: all tables complete; checklist minimum 7 items; body text professional and specific; no markdown fences.`,

  'training-standards': `Return ONLY valid JSON (no markdown, no fences):
{"title":"[TOPIC] TRAINING STANDARD","subtitle":"Training Standard · [Dept] · Version 1.0","docNumber":"TS-[DEPT]-001","sections":[
{"heading":"1. Purpose","level":1,"body":"[State why this training standard exists, what it governs, and what outcomes it mandates.]"},
{"heading":"2. Scope","level":1,"body":"[Define who this standard applies to — roles, departments, operations, and locations covered.]"},
{"heading":"3. Regulatory Framework","level":1,"body":"[List applicable legislation, codes of practice, and standards this training standard is aligned to. Use \\n between items.]"},
{"heading":"4. Training Requirements","level":1,"table":{"headers":["Training Component","Target Role(s)","Delivery Method","Duration","Frequency / Renewal"],"rows":[["[Module 1]","[Roles]","Classroom / Online / On-the-job","[Hours/Days]","Initial + [x] yearly"],["[Module 2]","[Roles]","[Method]","[Duration]","[Frequency]"],["[Module 3]","[Roles]","[Method]","[Duration]","[Frequency]"],["[Module 4]","[Roles]","[Method]","[Duration]","[Frequency]"]]}},
{"heading":"5. Competency Standards","level":1,"body":"[Define the minimum competency level required on completion. Measurable criteria.]","table":{"headers":["Competency Element","Assessment Method","Pass Standard","Assessor Qualification"],"rows":[["[Element 1]","Written exam","≥ [X]%","Qualified trainer"],["[Element 2]","Practical demonstration","Satisfactory","Qualified assessor"],["[Element 3]","Observation","Satisfactory","Supervisor"],["[Element 4]","Written exam","≥ [X]%","Qualified trainer"]]}},
{"heading":"6. Pre-Training Requirements","level":1,"checklist":["[Prerequisite 1 — qualification or experience required before commencing]","[Prerequisite 2]","[Prerequisite 3]","[Medical or fitness requirement if applicable]","[PPE or equipment required for practical components]"]},
{"heading":"7. Responsibilities","level":1,"table":{"headers":["Role","Responsibility"],"rows":[["Training Manager","Maintain this standard; schedule approved training; update on regulatory change"],["Supervisor","Ensure all direct reports are trained; sign off competency assessments"],["Employee","Complete all required training; maintain currency; report training needs"],["HR Department","Maintain training records; issue expiry reminders; report on compliance"]]}},
{"heading":"8. Records and Compliance","level":1,"body":"[Specify what records must be kept, where, for how long, and who is responsible. Include audit requirements.]"},
{"heading":"9. Non-Compliance","level":1,"body":"[State consequences of non-compliance. Include who manages breaches and escalation pathway.]","callout":"Employees who do not hold current certification for this standard must not perform the associated tasks until compliance is restored."},
{"heading":"10. Review Schedule","level":1,"table":{"headers":["Review Trigger","Action Required","Responsible"],"rows":[["Annual review","Full review against current legislation","Training Manager"],["Regulatory change","Immediate update and re-communication","Training Manager"],["Incident / near-miss","Review relevance and effectiveness","HSE Manager"],["Major process change","Update scope and requirements","Department Manager"]]}}
]}
Rules: training requirements table minimum 4 rows; competency table minimum 4 rows; content specific to topic; no markdown fences.`,

  policy: `Return ONLY valid JSON (no markdown, no fences):
{"title":"[TOPIC] POLICY","subtitle":"[Department] Policy · [Organisation] · Version 1.0","docNumber":"POL-[DEPT]-001","sections":[
{"heading":"Policy Statement","level":1,"body":"[A clear, authoritative statement of the organisation's position on this topic. 2-4 paragraphs.]","callout":"This policy applies to all employees, contractors, and visitors at [Site/Organisation]. Compliance is mandatory."},
{"heading":"Purpose","level":1,"body":"[Why this policy exists. Link to the organisation's values, legal obligations, or operational requirements.]"},
{"heading":"Scope","level":1,"body":"[Who and what this policy covers. Include specific exclusions if applicable.]"},
{"heading":"Definitions","level":1,"table":{"headers":["Term","Definition"],"rows":[["[Key term 1]","[Plain language definition]"],["[Key term 2]","[Definition]"],["[Key term 3]","[Definition]"],["[Key term 4]","[Definition]"]]}},
{"heading":"Policy Requirements","level":1,"body":"[The specific requirements, rules, or obligations this policy imposes. Use \\n for numbered requirements.]"},
{"heading":"Responsibilities","level":1,"table":{"headers":["Role","Policy Responsibility"],"rows":[["Chief Executive / Site Manager","[Specific accountability at executive level]"],["Department Manager","[Specific accountability]"],["Supervisor / Leading Hand","[Specific accountability]"],["All Employees","[Specific obligation for every employee]"],["HR / Training Department","[Support and monitoring role]"]]}},
{"heading":"Procedure","level":1,"body":"[Step-by-step process for implementing this policy in day-to-day operations. Use \\n for steps.]"},
{"heading":"Consequences of Non-Compliance","level":1,"body":"[State disciplinary consequences. Reference the relevant disciplinary procedure.]","callout":"Serious or repeated breaches of this policy may result in disciplinary action up to and including termination of employment."},
{"heading":"Related Documents","level":1,"body":"[List related policies, procedures, standards, and legislation. Use \\n between items.]"},
{"heading":"Review","level":1,"table":{"headers":["Review Date","Reviewed By","Changes Made","Next Review"],"rows":[["[Date]","[Name / Role]","Initial version","[Date + 1 year]"],["","","",""],["","","",""]]}}
]}
Rules: all tables minimum 4 rows; policy statement authoritative and specific; no placeholder text; no markdown fences.`,

  standard: `Return ONLY valid JSON (no markdown, no fences):
{"title":"[TOPIC] STANDARD","subtitle":"Operational Standard · [Site] · Version 1.0","docNumber":"STD-[DEPT]-001","sections":[
{"heading":"1. Purpose and Authority","level":1,"body":"[State the purpose of this standard and its authority — which regulation, policy, or management decision mandates it.]"},
{"heading":"2. Scope and Application","level":1,"body":"[Define what operations, equipment, tasks, or locations this standard applies to. State any exclusions.]"},
{"heading":"3. Definitions","level":1,"table":{"headers":["Term / Abbreviation","Definition"],"rows":[["[Term 1]","[Definition]"],["[Term 2]","[Definition]"],["[Term 3]","[Definition]"],["[Term 4]","[Definition]"]]}},
{"heading":"4. Standard Requirements","level":1,"body":"[Core mandatory requirements. Use specific, measurable language — quantities, tolerances, frequencies, thresholds. Use \\n for numbered requirements.]"},
{"heading":"5. Minimum Requirements Table","level":1,"table":{"headers":["Requirement","Specification / Limit","Measurement Method","Frequency","Responsible"],"rows":[["[Requirement 1]","[Specific value or limit]","[How measured]","[Frequency]","[Role]"],["[Requirement 2]","[Specification]","[Method]","[Frequency]","[Role]"],["[Requirement 3]","[Specification]","[Method]","[Frequency]","[Role]"],["[Requirement 4]","[Specification]","[Method]","[Frequency]","[Role]"],["[Requirement 5]","[Specification]","[Method]","[Frequency]","[Role]"]]}},
{"heading":"6. Implementation Requirements","level":1,"body":"[How this standard must be implemented. Include planning, resource, and documentation requirements.]"},
{"heading":"7. Monitoring and Verification","level":1,"table":{"headers":["Activity","Frequency","Method","Conducted By","Record Required"],"rows":[["[Monitoring activity 1]","[Frequency]","[Method]","[Role]","Yes"],["[Activity 2]","[Frequency]","[Method]","[Role]","Yes"],["[Activity 3]","[Frequency]","[Method]","[Role]","Yes"]]}},
{"heading":"8. Non-Conformance","level":1,"body":"[What to do when this standard is not met. Include immediate actions, investigation, and reporting requirements.]","callout":"Any non-conformance with this standard must be reported to the relevant supervisor immediately and logged in the incident management system."},
{"heading":"9. Related Standards and References","level":1,"body":"[List related standards, legislation, and references. Use \\n between items.]"}
]}
Rules: requirements table minimum 5 rows; use specific measurable values not vague descriptions; no markdown fences.`,

  plan: `Return ONLY valid JSON (no markdown, no fences):
{"title":"[TOPIC] PLAN","subtitle":"[Department] · [Site] · [Year]","docNumber":"PLAN-[DEPT]-001","sections":[
{"heading":"1. Executive Summary","level":1,"body":"[Brief overview — purpose, key objectives, timeframe, and primary stakeholders. 2-3 paragraphs.]"},
{"heading":"2. Background and Context","level":1,"body":"[Why this plan is needed. Current state assessment, drivers, regulatory context, or strategic alignment.]"},
{"heading":"3. Objectives and Success Criteria","level":1,"table":{"headers":["Objective","Success Measure","Target","Timeline"],"rows":[["[Objective 1]","[How measured]","[Specific target]","[Date/Period]"],["[Objective 2]","[Measure]","[Target]","[Date/Period]"],["[Objective 3]","[Measure]","[Target]","[Date/Period]"],["[Objective 4]","[Measure]","[Target]","[Date/Period]"]]}},
{"heading":"4. Scope","level":1,"body":"[What this plan covers. Include inclusions and exclusions. State departments, locations, operations, or people in scope.]"},
{"heading":"5. Stakeholders and Responsibilities","level":1,"table":{"headers":["Stakeholder / Role","Responsibility","Authority Level","Accountability"],"rows":[["[Role 1]","[Specific responsibilities]","Decision-maker","High"],["[Role 2]","[Responsibilities]","Approver","High"],["[Role 3]","[Responsibilities]","Implementer","Medium"],["[Role 4]","[Responsibilities]","Contributor","Low"]]}},
{"heading":"6. Action Plan","level":1,"table":{"headers":["#","Action / Activity","Responsible","Resources Required","Start Date","Due Date","Status"],"rows":[["1","[Specific action]","[Role]","[Resources]","[Date]","[Date]","Not started"],["2","[Action]","[Role]","[Resources]","[Date]","[Date]","Not started"],["3","[Action]","[Role]","[Resources]","[Date]","[Date]","Not started"],["4","[Action]","[Role]","[Resources]","[Date]","[Date]","Not started"],["5","[Action]","[Role]","[Resources]","[Date]","[Date]","Not started"],["6","[Action]","[Role]","[Resources]","[Date]","[Date]","Not started"]]}},
{"heading":"7. Resource Requirements","level":1,"table":{"headers":["Resource","Quantity / Detail","Cost Estimate","Source / Provider","Required By"],"rows":[["[Resource 1]","[Detail]","$[Amount]","[Source]","[Date]"],["[Resource 2]","[Detail]","$[Amount]","[Source]","[Date]"],["[Resource 3]","[Detail]","$[Amount]","[Source]","[Date]"]]}},
{"heading":"8. Risks and Mitigations","level":1,"table":{"headers":["Risk","Likelihood","Impact","Mitigation Strategy","Owner"],"rows":[["[Risk 1]","High","High","[Specific mitigation]","[Role]"],["[Risk 2]","Medium","High","[Mitigation]","[Role]"],["[Risk 3]","Low","Medium","[Mitigation]","[Role]"],["[Risk 4]","Medium","Medium","[Mitigation]","[Role]"]]}},
{"heading":"9. Monitoring and Reporting","level":1,"body":"[How progress will be tracked and reported. Include reporting frequency, format, audience, and escalation triggers.]"},
{"heading":"10. Review and Update","level":1,"body":"[When and how this plan will be reviewed. Next scheduled review: [Date].]"}
]}
Rules: action plan table minimum 6 rows; objectives table minimum 4 rows; use specific dates and metrics; no markdown fences.`,

  'management-plan': `Return ONLY valid JSON (no markdown, no fences):
{"title":"[TOPIC] MANAGEMENT PLAN","subtitle":"[Department] · [Site] · Version 1.0","docNumber":"MP-[DEPT]-001","sections":[
{"heading":"1. Executive Summary","level":1,"body":"[Brief overview — what is being managed, why, the key objectives and the timeframe. 2-3 short paragraphs.]"},
{"heading":"2. Purpose and Objectives","level":1,"body":"[Why this management plan exists and what it sets out to achieve. List the key objectives.]"},
{"heading":"3. Scope","level":1,"body":"[What this plan covers — areas, operations, people, assets. State inclusions and exclusions.]"},
{"heading":"4. Roles and Responsibilities","level":1,"table":{"headers":["Role","Responsibility","Authority Level","Accountability"],"rows":[["[Role 1]","[Responsibilities]","Decision-maker","High"],["[Role 2]","[Responsibilities]","Approver","High"],["[Role 3]","[Responsibilities]","Implementer","Medium"],["[Role 4]","[Responsibilities]","Contributor","Low"]]}},
{"heading":"5. Management Approach","level":1,"body":"[How the subject will be managed — the methods, systems, standards and controls applied. Use \\n for structure.]"},
{"heading":"6. Key Activities and Controls","level":1,"table":{"headers":["#","Activity / Control","Responsible","Frequency","Target / Standard"],"rows":[["1","[Activity]","[Role]","[Frequency]","[Target]"],["2","[Activity]","[Role]","[Frequency]","[Target]"],["3","[Activity]","[Role]","[Frequency]","[Target]"],["4","[Activity]","[Role]","[Frequency]","[Target]"],["5","[Activity]","[Role]","[Frequency]","[Target]"]]}},
{"heading":"7. Resources","level":1,"table":{"headers":["Resource","Detail","Source / Provider","Required By"],"rows":[["[Resource 1]","[Detail]","[Source]","[Date]"],["[Resource 2]","[Detail]","[Source]","[Date]"],["[Resource 3]","[Detail]","[Source]","[Date]"]]}},
{"heading":"8. Risk Management","level":1,"table":{"headers":["Risk","Likelihood","Impact","Mitigation / Control","Owner"],"rows":[["[Risk 1]","High","High","[Mitigation]","[Role]"],["[Risk 2]","Medium","High","[Mitigation]","[Role]"],["[Risk 3]","Low","Medium","[Mitigation]","[Role]"],["[Risk 4]","Medium","Medium","[Mitigation]","[Role]"]]}},
{"heading":"9. Monitoring, Measurement and Reporting","level":1,"table":{"headers":["Measure / KPI","Target","Monitoring Method","Frequency","Reported To"],"rows":[["[KPI 1]","[Target]","[Method]","[Frequency]","[Role]"],["[KPI 2]","[Target]","[Method]","[Frequency]","[Role]"],["[KPI 3]","[Target]","[Method]","[Frequency]","[Role]"]]}},
{"heading":"10. Review and Continuous Improvement","level":1,"body":"[How and when this plan is reviewed and improved. Next scheduled review: [Date].]"},
{"heading":"11. Approval","level":1,"table":{"headers":["Role","Name","Signature","Date"],"rows":[["Prepared By","","",""],["Reviewed By","","",""],["Approved By","","",""]]}}
]}
Rules: key activities table minimum 5 rows; roles and risk tables minimum 4 rows; use specific, measurable targets and dates; adapt ALL content to the requested management subject and any uploaded/knowledge-base material; no markdown fences.`,

  'strategy-plan': `Return ONLY valid JSON (no markdown, no fences):
{"title":"[TOPIC] STRATEGY","subtitle":"[Organisation / Department] · Strategic Plan · [Period, e.g. 2026-2028]","docNumber":"STR-[DEPT]-001","sections":[
{"heading":"1. Executive Summary","level":1,"body":"[Brief overview of the strategy — the ambition, the key goals and the period it covers. 2-3 short paragraphs.]"},
{"heading":"2. Vision, Mission and Values","level":1,"body":"Vision: [aspirational future state]\\nMission: [what we do and for whom]\\nValues: [core values]"},
{"heading":"3. Strategic Context","level":1,"body":"[Current situation, market/operational drivers, and why this strategy is needed now.]"},
{"heading":"4. SWOT Analysis","level":1,"table":{"headers":["Strengths","Weaknesses","Opportunities","Threats"],"rows":[["[Strength]","[Weakness]","[Opportunity]","[Threat]"],["[Strength]","[Weakness]","[Opportunity]","[Threat]"],["[Strength]","[Weakness]","[Opportunity]","[Threat]"]]}},
{"heading":"5. Strategic Objectives","level":1,"table":{"headers":["Strategic Objective","Success Measure","Target","Timeframe"],"rows":[["[Objective 1]","[Measure]","[Target]","[Period]"],["[Objective 2]","[Measure]","[Target]","[Period]"],["[Objective 3]","[Measure]","[Target]","[Period]"],["[Objective 4]","[Measure]","[Target]","[Period]"]]}},
{"heading":"6. Strategic Initiatives","level":1,"table":{"headers":["#","Initiative","Linked Objective","Owner","Priority","Timeline"],"rows":[["1","[Initiative]","[Objective]","[Role]","High","[Period]"],["2","[Initiative]","[Objective]","[Role]","High","[Period]"],["3","[Initiative]","[Objective]","[Role]","Medium","[Period]"],["4","[Initiative]","[Objective]","[Role]","Medium","[Period]"],["5","[Initiative]","[Objective]","[Role]","Low","[Period]"]]}},
{"heading":"7. Implementation Roadmap","level":1,"body":"[Phased roadmap of how the initiatives roll out over the period. Use \\n for phases and milestones with dates.]"},
{"heading":"8. Resources and Budget","level":1,"table":{"headers":["Resource / Investment","Detail","Estimated Cost","Funding Source"],"rows":[["[Item 1]","[Detail]","$[Amount]","[Source]"],["[Item 2]","[Detail]","$[Amount]","[Source]"],["[Item 3]","[Detail]","$[Amount]","[Source]"]]}},
{"heading":"9. Key Performance Indicators","level":1,"table":{"headers":["KPI","Baseline","Target","Review Frequency","Owner"],"rows":[["[KPI 1]","[Baseline]","[Target]","[Frequency]","[Role]"],["[KPI 2]","[Baseline]","[Target]","[Frequency]","[Role]"],["[KPI 3]","[Baseline]","[Target]","[Frequency]","[Role]"]]}},
{"heading":"10. Risks and Mitigations","level":1,"table":{"headers":["Strategic Risk","Likelihood","Impact","Mitigation","Owner"],"rows":[["[Risk 1]","Medium","High","[Mitigation]","[Role]"],["[Risk 2]","Low","High","[Mitigation]","[Role]"],["[Risk 3]","Medium","Medium","[Mitigation]","[Role]"]]}},
{"heading":"11. Governance and Review","level":1,"body":"[How the strategy is governed, tracked and reviewed. Review cadence and next review date: [Date].]"},
{"heading":"12. Approval","level":1,"table":{"headers":["Role","Name","Signature","Date"],"rows":[["Prepared By","","",""],["Endorsed By","","",""],["Approved By","","",""]]}}
]}
Rules: SWOT and strategic objectives tables minimum 3-4 rows; initiatives table minimum 5 rows; link each initiative to an objective; use specific measures, targets and timeframes; adapt ALL content to the requested organisation/topic and any uploaded/knowledge-base material; no markdown fences.`,

  process: `Return ONLY valid JSON (no markdown, no fences):
{"title":"[PROCESS NAME] — PROCESS DOCUMENT","subtitle":"[Department] · Process Workflow · Version 1.0","docNumber":"PRC-[DEPT]-001","sections":[
{"heading":"1. Purpose","level":1,"body":"[Why this process exists. What problem it solves. What outcome it delivers. 1-2 paragraphs.]"},
{"heading":"2. Scope","level":1,"body":"[Where this process applies — locations, departments, operations, roles. Include inclusions and exclusions.]"},
{"heading":"3. Process Owner and Stakeholders","level":1,"table":{"headers":["Role","Responsibility","Authority"],"rows":[["Process Owner","[End-to-end accountability for this process]","Approver"],["Process Manager","[Day-to-day operation and improvement]","Decision-maker"],["[Operational role]","[Specific task responsibilities]","Implementer"],["[Support role]","[Supporting role]","Contributor"]]}},
{"heading":"4. Inputs and Outputs","level":1,"table":{"headers":["Type","Item","Source / Destination","Acceptance Criteria"],"rows":[["Input","[Input 1]","[Where it comes from]","[Quality / format required]"],["Input","[Input 2]","[Source]","[Criteria]"],["Output","[Output 1]","[Who receives it]","[Quality standard]"],["Output","[Output 2]","[Destination]","[Standard]"]]}},
{"heading":"5. Process Flow","level":1,"landscape":true,"flowchart":{"title":"[Process Name] — End-to-End Flow","stages":[{"title":"Trigger / Initiation","items":["[What starts the process]","[Initial input]"]},{"title":"Step 1 — [Action]","items":["[Sub-step 1.1]","[Sub-step 1.2]"]},{"title":"Step 2 — [Action]","items":["[Sub-step 2.1]","[Sub-step 2.2]"]},{"title":"Step 3 — [Action]","items":["[Sub-step 3.1]","[Sub-step 3.2]"]},{"title":"Closure / Output","items":["[Final deliverable]","[Sign-off / handover]"]}],"notes":["Decision points should be raised to the Process Owner.","All steps must be recorded in the process log."]},"body":"[Brief narrative of the flow above — what triggers the process, the key decision points, and the close-out criteria.]"},
{"heading":"6. Detailed Procedure","level":1,"table":{"headers":["Step","Action","Responsible Role","Tool / System","Record Created","Timing"],"rows":[["1","[Specific action]","[Role]","[System/tool]","[Record/output]","[Duration or trigger]"],["2","[Action]","[Role]","[Tool]","[Record]","[Timing]"],["3","[Action]","[Role]","[Tool]","[Record]","[Timing]"],["4","[Action]","[Role]","[Tool]","[Record]","[Timing]"],["5","[Action]","[Role]","[Tool]","[Record]","[Timing]"],["6","[Action]","[Role]","[Tool]","[Record]","[Timing]"]]}},
{"heading":"7. Decision Points and Exceptions","level":1,"body":"[List the key decision points in the flow above. For each: who decides, the criteria used, what happens if approved, what happens if rejected, and how exceptions are escalated.]"},
{"heading":"8. Performance Measures (KPIs)","level":1,"table":{"headers":["Metric","Definition","Target","Frequency","Owner"],"rows":[["[Cycle time]","[Time from trigger to closure]","[Target value]","Weekly","Process Manager"],["[Quality rate]","[% of outputs meeting acceptance criteria]","[Target %]","Monthly","Process Owner"],["[Rework rate]","[% of steps requiring rework]","[Target %]","Monthly","Process Manager"],["[Compliance rate]","[% of runs following the documented flow]","100%","Quarterly","Process Owner"]]}},
{"heading":"9. Records and Documentation","level":1,"table":{"headers":["Record","Retention Period","Storage Location","Access"],"rows":[["[Record 1]","[Period]","[System]","[Roles allowed]"],["[Record 2]","[Period]","[System]","[Roles]"],["[Record 3]","[Period]","[System]","[Roles]"]]}},
{"heading":"10. Related Documents","level":1,"body":"[List linked SOPs, work instructions, policies, standards, and forms. Include document numbers.]"},
{"heading":"11. Review and Continuous Improvement","level":1,"body":"[Review frequency, triggers for ad-hoc review (e.g. incident, KPI breach), and how improvements are captured and approved.]"}
]}
Rules: minimum 11 sections; include exactly ONE flowchart section with landscape:true; detailed procedure table minimum 6 rows; KPI table minimum 4 rows; use specific, measurable values not placeholder text; no markdown fences.`,

  'trainer-assessor-guide': `Return ONLY valid JSON (no markdown, no fences). Follow the EXACT structure and section order of the supplied template (an "Equipment Trainer and Assessor Guide" as used by Performance Training Pty Limited / Pertrain — see https://www.pertrain.com.au). Adapt every section to the requested equipment / unit of competency, but DO NOT remove or re-order sections.

{"title":"[EQUIPMENT] TRAINER AND ASSESSOR GUIDE","subtitle":"Equipment Trainer and Assessor Guide · [Unit of Competency] · [Site/RTO] · Version 1.0","docNumber":"TAG-[DEPT]-001","sections":[

{"heading":"Introduction","level":1,"body":"The purpose of this Equipment Trainer and Assessor Guide is to familiarise trainers and assessors with this training resource for [equipment]. The training resource comprises the following sections:\\n• Statutory and Regulatory Information\\n• Learner Reference Material\\n• PowerPoint Presentation\\n• Training and Assessment Record\\n• Logbook.\\n\\n[Brief paragraph on competency-based training context, target industry (e.g. resources and infrastructure), and how this guide fits into the wider training resource.]"},

{"heading":"Statutory and Regulatory Requirements","level":1,"body":"[Open with a 'Quality Assurance' paragraph: training must improve performance and encourage ongoing professional development; the resource must be evaluated and findings fed back to course designers; the RTO must reflect changes in mapping documentation. Then introduce the registers below.]"},
{"heading":"Quality Assurance","level":2,"body":"In order to set up a training and assessment program successfully, learning must be viewed as a means to an end, not the end itself. The goal is to improve the performance of the learner and encourage ongoing professional development.\\n\\nThis training resource should be evaluated, and findings used to upgrade the resource in a cycle of continuous improvement. Trainers, assessors and the RTO must communicate critique and candidate feedback to the course designers for review and incorporation.\\n\\nThe following are maintained to keep this resource current:\\n• Supporting Documentation Register\\n• Amendment Register\\n• Assessment Validation/Moderation Register\\n• Map of resource and assessment against the Unit of Competency."},
{"heading":"Supporting Documentation Register","level":2,"body":"This training resource is NOT a stand-alone instructional / assessment resource until it is properly contextualised to the work environment. The RTO must identify and maintain a record of site-specific information (site safety issues, SOPs, Work Instructions, OEM Manuals, Bulletins) to ensure compliance with AQTF Standards.","table":{"headers":["Document Name","Document Description","Where it is incorporated into this program"],"rows":[["[Site SOP — e.g. Excavator Pre-Start]","[Brief description]","[Section / Module of this resource]"],["[OEM Operator Manual]","[Brief description]","[Section / Module]"],["[Site Hazard Register]","[Brief description]","[Section / Module]"],["[Permit-to-Work procedure]","[Brief description]","[Section / Module]"]]}},
{"heading":"Amendment Register","level":2,"body":"An Amendment Register ensures this training program remains current with existing work practices and records continuous improvement. If procedures, policies or production techniques change, the RTO must reflect those changes in this resource as soon as possible.","table":{"headers":["Date","Section #","Page #","Recommended Change","Recommended By","RTO Approval / Responsible Person","Date Approved"],"rows":[["[YYYY-MM-DD]","[§]","[#]","[Change]","[Name / Role]","[Name]","[YYYY-MM-DD]"],["","","","","","",""],["","","","","","",""]]}},
{"heading":"Assessment Validation / Moderation Register","level":2,"body":"AQTF requires assessment tools to be validated and moderated at least annually, or more frequently if the assessment tool or methodology changes. Validation and moderation are normally conducted as a workshop with the RTO and experienced assessors. The RTO presents completed assessment material; the team discusses approaches and evidence collection with the goal of improving practice.","table":{"headers":["Date","Moderation / Validation Team (members & titles)","Description of Modifications to the Assessment","Approved By (Responsible Person)","Date Approved"],"rows":[["[YYYY-MM-DD]","[Names + titles]","[Description]","[Name]","[YYYY-MM-DD]"],["","","","",""],["","","","",""]]}},

{"heading":"Reference Material","level":1,"body":"The reference material is organised into three sections:\\n• Operator Responsibilities — generic, applied regardless of equipment make/model\\n• Equipment Module — specific to make/model; interchangeable within the resource\\n• Production Techniques — generic, applied regardless of equipment make/model.\\n\\nTo comply with the Training Package, the Operator Responsibilities and Production Techniques sections MUST be delivered and assessed in conjunction with one of the Equipment Modules. It is recommended the three be delivered and assessed in the order shown.\\n\\nA candidate already deemed competent on one equipment module is only required to complete the additional Equipment Module(s) to operate other makes/models within the same equipment type."},

{"heading":"PowerPoint Presentation","level":1,"body":"The PowerPoint presentations follow the sequence of the reference material and provide a suggested structure for training delivery. Trainers should personalise the slides to suit their delivery style and contextualise content to the work environment the learner will be operating in. Slides incorporate graphics and other illustrations alongside 'Trainer Key Points'.","table":{"headers":["Key Point","Description"],"rows":[["Trainer / Facilitator Instructions","Content and demonstration prompts to ensure topic coverage."],["Learning Outcomes","Provide a lesson guide."],["Facilitator Extension","Lessons learned through practical and historic experience, related as examples, scenarios and stories."],["Suggested Activities","Practical actions that may be completed by learners to reinforce the learning."],["Assessment","Identifies when an assessment activity is built into the slide flow."]]}},
{"heading":"Training and Assessment Flow","level":2,"landscape":true,"flowchart":{"title":"Training and Assessment Flow","stages":[{"title":"Operator Responsibilities","items":["Generic operator content","Site rules and HSE","Communication and documentation"]},{"title":"Equipment Module","items":["Make / model specifics","Controls and instrumentation","Pre-start and shutdown"]},{"title":"Production Techniques","items":["Generic production tasks","Efficiency and quality","Hazard control during production"]},{"title":"Log Book","items":["Cumulative operational hours","Range of conditions experienced","Supervisor sign-offs"]},{"title":"Training Records","items":["TAR completed","Summative assessment","Statement of Attainment"]}],"notes":["Operator Responsibilities → Equipment Module → Production Techniques must be delivered in this sequence to comply with the Training Package."]},"body":"The diagram above shows the order in which the three reference sections (Operator Responsibilities, Equipment Module, Production Techniques) are delivered, supported by the Log Book and culminating in the Training Records."},

{"heading":"Training and Assessment Record","level":1,"body":"A Training and Assessment Record (TAR) accompanies this resource. The columns relating to training must be completed by both the learner and the trainer as training is completed. The learner may undertake the assessment after the learning component has been satisfactorily completed. Assessors must adhere to the instructions on the front of the TAR."},
{"heading":"Log Book","level":1,"body":"To meet the requirements of the Training Package and the Unit of Competency, learners must demonstrate their employability skills and the application of their knowledge and skills in varying work environments over time. A log book is provided to assist the assessor with the collection of evidence. Maintaining the log book will help:\\n• the trainer check the learner has been exposed to the full combination of operational and equipment types required before the summative assessment\\n• assessors to make a judgement of competent / not yet competent\\n• a detailed analysis of the training undertaken, which could prove critical in an incident investigation.\\n\\nWhen training is successfully completed the Log Book is placed in the learner's personal file. The Logbook may be photocopied if the learner wishes to retain a copy."},
{"heading":"Licensing Requirements","level":1,"body":"An operator license is required to operate some equipment items under Occupational Health and Safety legislation. Where this is applicable, all relevant assessments for the licensing competency unit AND the OH&S assessments must be completed successfully. [State the licensing requirements that apply to this specific equipment, including the relevant jurisdiction.]"},

{"heading":"Using This Training Resource","level":1,"body":"[State that the resource is designed to align with Australian Qualifications Framework (AQF) guidelines, that it includes the underpinning knowledge and skill requirements required to meet the competency standard, and that skill will largely be developed through practical operational experience gained over time. Note that learners can be enrolled through the RTO that has this Unit of Competency on their scope of registration, and the RTO will issue the learner with a Certificate or Statement of Attainment on successful completion.]"},
{"heading":"Occupational Health and Safety","level":2,"body":"Trainers and assessors are responsible for learners' awareness of HSE issues particular to the site and the equipment being used. Learners must develop and demonstrate safe work practices at all stages of the program, and demonstrate the knowledge and skill necessary to work safely as a competent operator.\\n\\nWhere hazardous conditions or specific risks exist during delivery, the trainer/assessor must identify them and take appropriate action to mitigate the risk. This program REINFORCES safety information already provided in induction and other training programs — it does not duplicate them. Knowledge and skill assessment may therefore apply to prerequisite competencies as well as the equipment/operational-specific competencies required of an operator."},

{"heading":"Requirements for Delivery of Nationally Recognised Qualifications","level":1,"body":"The human and physical resources detailed below are the minimum that must be available for program delivery."},
{"heading":"Human Resources","level":2,"body":"The National Quality Council policy in relation to trainer and assessor competencies applies.\\n\\nTrainers must:\\n  i) hold the TAE40110 Certificate IV in Training and Assessment from the TAE10 Training and Education Training Package; or\\n  ii) be able to demonstrate equivalent competencies; or\\n  iii) work under the direct supervision of a person who has the competencies specified in (i) or (ii), and be able to demonstrate vocational competencies at least to the level of those being delivered.\\n\\nAssessors must:\\n  i) hold the following three competencies from the TAE10 Training and Education Training Package: TAEASS401A Plan assessment activities and processes; TAEASS402A Assess competence; TAEASS403A Participate in assessment validation; or\\n  ii) be able to demonstrate equivalent competencies to all three units listed in (i).\\n\\nIf a person has the assessment competencies in (i) or (ii) but not the relevant vocational competencies (or vice versa), they may work together with another person who holds the missing competencies to conduct the assessment."},
{"heading":"Vocational Competency","level":2,"body":"Vocational competency is defined as broad industry knowledge and experience, usually combined with a relevant industry qualification. A person with vocational competency will be familiar with the content of the industry and have relevant current experience. Vocational competency must be considered on an industry-by-industry basis and with reference to the Assessment Guidelines of the relevant Training Package. Training Packages may include advice on relevant industry qualifications and experience required for assessing, plus acceptable forms of evidence for maintaining currency."},
{"heading":"Physical Resources","level":2,"body":"This program requires the following resources to support the training and assessment strategy:\\n• Appropriately equipped training venue with suitable instructional aids\\n• PowerPoint presentation and projector\\n• Learner handout material and Training and Assessment Record\\n• Access to an appropriate item of [equipment] for practical purposes\\n• A suitable practical training area away from production traffic.\\n\\nWhile this program is designed to be self-supporting, the trainer or learner may require additional support material — typically sourced from manufacturer literature, alternate training programs, or appropriate standards. The trainer must ensure additional material is congruent with this training program."},
{"heading":"Text Reference","level":2,"body":"Trainers and assessors must have a copy of the current documentation identified by the RTO, including but not limited to:\\n• The equipment manufacturer's operator manual for the [equipment] the learner is being trained to operate\\n• Site operating procedures\\n• The Unit of Competency.\\n\\nTrainers and assessors must be familiar with the Unit of Competency. Although this program has been designed to conform to the unit specifications, it is a requirement of a trainer/assessor to ensure that the training and assessment provided complies with all aspects of the standards described in the Training Package."},

{"heading":"Training Strategy","level":1,"body":"The responsible RTO will provide a documented training strategy for this training program. Trainers must ensure the strategy aligns with the AQTF standard and fulfils the requirements of the Unit of Competency and Training Package."},

{"heading":"Assessment Strategy","level":1,"body":"The responsible RTO will provide a documented assessment strategy for this training program. Assessors must ensure the strategy aligns with the AQTF standard and fulfils the requirements of the Unit of Competency and Training Package."},
{"heading":"Assessment Guidelines","level":2,"body":"Evidence of competence may be gathered either directly or indirectly. Direct evidence is gathered through direct observation of performance on the job and asking questions to determine essential and underpinning knowledge.\\n\\nIndirect evidence may supplement direct evidence and generally consists of examination of performance: company records, references, achievement of productivity targets, documents such as licences, certificates, time sheets, log books, incident reports, and other credible sources of evidence. Regardless of where evidence is obtained, it should comply with the Principles of Assessment and Rules of Evidence.","table":{"headers":["Principles of Assessment","Description"],"rows":[["Validity","The assessment is valid in terms of the requirements of the competency standard."],["Reliability","The assessment gives a good indication of future competency."],["Fairness","The assessment is fair in terms of the range of candidates and the range of assessors."],["Flexibility","The assessment can cater for the characteristics and support needs of the range of candidates."]]}},
{"heading":"Rules of Evidence","level":2,"table":{"headers":["Rules of Evidence","Description"],"rows":[["Validity","The evidence must be valid in terms of the competency being assessed."],["Currency","The evidence indicates competency that is current at the present time. Assessors must exercise judgement about the age of evidence."],["Sufficiency","Enough information is available to substantiate the judgement of competent."],["Authenticity","The evidence can be directly attributed to the candidate."]]},"body":"When conducting an assessment at a particular site, ensure the demonstration of competency is performed under TYPICAL working conditions and using the equipment and procedures normally used on the site."},
{"heading":"Assessment Record","level":2,"body":"In any competency-based training program, prior learning must be recognised, no matter how it was acquired. Trainers and assessors should advise learners that they may be eligible to apply for Recognition of Prior Learning (RPL) and advise them of the process. The initial process is to produce evidence of competency or to follow an assessment-only pathway.\\n\\nThe Training and Assessment Record has been designed to be compliant with the Unit of Competency and may be used for:\\n• Recognition of prior learning or current competence\\n• Verification of competence\\n• Summative assessment\\n• Familiarisation with new or specific equipment."},
{"heading":"Summative Assessment","level":2,"body":"Before candidates can be deemed competent they must have a proven record of safe and efficient operational experience on the job, which may involve direct or indirect supervision over a period of time."},
{"heading":"Appeals","level":2,"body":"Candidates are entitled to appeal against any assessment decision and should be advised of the appropriate channels. The RTO must deal with appeals in a non-confrontational manner. [State the site/RTO's specific appeals contact and procedure.]"},

{"heading":"Security of this Training Resource","level":1,"body":"[Site/RTO] grants permission to use this training program for in-house training and assessment purposes only. Intellectual Property and copyright of text and graphics provided by the original course designer remain vested with the designer.\\n\\nThe purchaser is NOT granted the right to deconstruct this training program or its parts to develop other training resources, nor to sell work produced to a third party, nor to allow a third party to use any component for the third party's own benefit.\\n\\nThe resource must not be distributed (electronically or in hard copy) outside the purchaser's organisation without written permission from the course designer."}
]}

Rules:
• Mirror the section order above EXACTLY — do not collapse subsections into the parent.
• Sub-headings (Quality Assurance, Supporting Documentation Register, Amendment Register, Validation/Moderation Register, Occupational Health and Safety, Human Resources, Vocational Competency, Physical Resources, Text Reference, Assessment Guidelines, Rules of Evidence, Assessment Record, Summative Assessment, Appeals) use level:2; main headings use level:1.
• Include exactly ONE flowchart section with landscape:true for the Training and Assessment Flow (Operator Responsibilities → Equipment Module → Production Techniques → Log Book → Training Records).
• Replace bracketed placeholders with concrete content based on the requested equipment / unit of competency / site — but keep all four registers (Supporting Documentation, Amendment, Validation/Moderation, plus the PowerPoint Key Points table and the two assessment tables) populated with realistic example rows where the user has not provided specifics.
• No markdown fences, no commentary, JSON only.`,

  'statutory-regulatory': `Return ONLY valid JSON (no markdown, no fences). Follow the EXACT structure and section order of the supplied template (a "Statutory and Regulatory Requirements" booklet as used by Performance Training Pty Limited / Pertrain — see https://www.pertrain.com.au). Adapt every section to the requested competency unit / equipment / site, but DO NOT remove or re-order sections.

{"title":"STATUTORY AND REGULATORY REQUIREMENTS","subtitle":"[Competency Unit Code + Title] · [Site / RTO] · Version 1.0","docNumber":"SRR-[DEPT]-001","sections":[

{"heading":"Contents","level":1,"body":"This Statutory and Regulatory Requirements booklet contains:\\n• Supporting Documentation Register\\n• Amendment Register\\n• Assessment Validation / Moderation Register\\n• Map of Training Program Against the Competency Unit\\n• Map Against Evidence Requirements of the Competency Unit\\n• Legislation and Licensing Requirements\\n• Legislation and Standards Information\\n• Compliance with Australian Standards.\\n\\nThis booklet must be maintained by the RTO (or agreed Representative) for the life of the training program."},

{"heading":"Supporting Documentation Register","level":1,"body":"This register should be completed and maintained by the RTO or agreed Representative. Examples of supporting documentation used in this training program are Standard Operating Procedures (SOPs), Work Instructions, OEM Manuals, Safety Alerts and Bulletins.","table":{"headers":["Document Name","Document Description","Where it is to be incorporated into this program"],"rows":[["[Site SOP — e.g. Excavator Pre-Start]","[Brief description of the SOP]","[Section / Module of this program]"],["[OEM Operator Manual — make/model]","[Manufacturer's operating manual for the equipment]","[Section / Module]"],["[Site Hazard Register]","[Description]","[Section / Module]"],["[Permit-to-Work procedure]","[Description]","[Section / Module]"],["[Safety Alert / Bulletin]","[Description]","[Section / Module]"]]}},

{"heading":"Amendment Register","level":1,"body":"This Amendment Register must be completed by the RTO or agreed Representative when amendments to the training program are identified. Examples of amendments include changes to company procedures, policy or production techniques.","table":{"headers":["Date","Section #","Page #","Recommended Change","Recommended By","RTO Approval","Changes Incorporated and Stakeholders Notified — Responsible Person","Date Notified"],"rows":[["[YYYY-MM-DD]","[§]","[#]","[Change description]","[Name / Role]","[Name]","[Name]","[YYYY-MM-DD]"],["","","","","","","",""],["","","","","","","",""],["","","","","","","",""]]}},

{"heading":"Assessment Validation / Moderation Register","level":1,"body":"This register must be completed and maintained by the RTO or agreed Representative. Validation and moderation must be undertaken at least annually, or more frequently if changes are made to the assessment tool or methodology.","table":{"headers":["Date","Moderation & Validation Team Members and Titles","Description of Modifications to the Assessment","Approved By","Changes Incorporated and Stakeholders Notified — Responsible Person","Date Notified"],"rows":[["[YYYY-MM-DD]","[Names + titles]","[Description]","[Name]","[Name]","[YYYY-MM-DD]"],["","","","","",""],["","","","","",""]]}},

{"heading":"Map of Training Program Against Competency Unit [UNIT CODE] [Unit Title]","level":1,"body":"This map demonstrates how every Element and Performance Criterion of the Unit of Competency is addressed by the training resource. Reference each Performance Criterion to the Section of the Learner Reference Material that covers it and the corresponding Task in the Training and Assessment Record (TAR).","table":{"headers":["Element / Performance Criterion","Section","Task"],"rows":[["[UNIT/01 — Element 1 title]","",""],["1.1 [Performance criterion 1.1]","[Section #]","[A]"],["1.2 [Performance criterion 1.2]","[Section #]","[A]"],["1.3 [Performance criterion 1.3]","[Section #]","[A]"],["1.4 [Performance criterion 1.4]","[Section #]","[A]"],["1.5 [Performance criterion 1.5]","[Section #]","[A]"],["1.6 [Performance criterion 1.6]","[Section #]","[A]"],["1.7 [Performance criterion 1.7]","[Section #]","[A]"],["[UNIT/02 — Element 2 title]","",""],["2.1 [Performance criterion 2.1]","[Section #]","[B]"],["2.2 [Performance criterion 2.2]","[Section #]","[B]"],["2.3 [Performance criterion 2.3]","[Section #]","[B]"],["2.4 [Performance criterion 2.4]","[Section #]","[B]"],["2.5 [Performance criterion 2.5]","[Section #]","[B]"],["2.6 [Performance criterion 2.6]","[Section #]","[B]"],["[UNIT/03 — Element 3 title]","",""],["3.1 [Performance criterion 3.1]","[Section #]","[D]"],["3.2 [Performance criterion 3.2]","[Section #]","[D]"],["3.3 [Performance criterion 3.3]","[Section #]","[D]"]]}},

{"heading":"Map Against Evidence Requirements of Competency Unit [UNIT CODE] [Unit Title]","level":1,"body":"This map demonstrates how the Required Knowledge, Required Skills, and Critical Evidence of the Unit of Competency are addressed by the training resource and assessment."},
{"heading":"Required Knowledge","level":2,"table":{"headers":["Required Knowledge","Section","Task"],"rows":[["Site hazard identification and response procedures","[#]","[A, C]"],["Site risk control procedures","[#]","[A]"],["Site and equipment health and safety procedures","[#]","[A]"],["Site environmental requirements and constraints","[#]","[A]"],["Site quality requirements","[#]","[A]"],["Site communication procedures","[#]","[A]"],["Site product characteristics","[#]","[A]"],["Site geological and survey data","[#]","[A]"],["Site operational procedures","[#]","[A]"],["[Equipment] pre-start, start-up, operating and shutdown procedures and techniques","[#]","[B]"],["[Equipment] characteristics, technical capability and limitations","[#]","[A, B]"],["Site record keeping requirements","[#]","[D]"],["Site personal protective equipment requirements","[#]","[A]"]]}},
{"heading":"Required Skills","level":2,"table":{"headers":["Required Skill","Section","Task"],"rows":[["Apply legislative, organisation and site requirements and procedures","[#]","[A]"],["Apply operational safety requirements","[#]","[A]"],["Access, interpret and apply technical information","[#]","[A]"],["Apply equipment records maintenance requirements","[#]","[D]"],["Apply diagnostic techniques","[#]","[B, D]"],["Use relevant hand tools","[#]","[D]"],["Apply procedures for disposal of environmentally sensitive fluids and materials","[#]","[D]"],["Apply chemical and fuel safety measures","[#]","[D]"],["Work wearing personal protective equipment","[#]","[B]"]]}},
{"heading":"Critical Evidence Required to Demonstrate Competency","level":2,"table":{"headers":["Critical Evidence","Section","Task"],"rows":[["Knowledge of the requirements, procedures and instructions for conducting [equipment] operations","[#]","[A]"],["Implementation of requirements, procedures and techniques for the safe, effective and efficient completion of [equipment] operations","[#]","[B]"],["Working with others to undertake and complete [equipment] operations that meet all of the required outcomes","[#]","[A, B, C, D]"],["Consistent timely completion of [equipment] operations that safely, effectively and efficiently meets the required outcomes","[#]","[B, D]"]]}},

{"heading":"Legislation and Licensing Requirements","level":1,"body":"State / Territory legislation may require an appropriate licence to be obtained before any work is performed under this competency unit. The trainer / assessor has a duty of care to inform the candidate of the applicable licensing requirements. Operators must also hold a current, nationally recognised driver's licence for the class of vehicle they will be operating.\\n\\n[Specify the licensing requirements that apply to this competency unit in the relevant jurisdiction.]"},
{"heading":"Legislation and Standards Information","level":2,"body":"The table below provides web addresses for Acts and Regulations that may be relevant to the type of work performed under this competency unit. RTO must keep this list current.","table":{"headers":["Web Address","Department","Example Act or Regulation"],"rows":[["http://www.dpi.nsw.gov.au/minerals/safety","Primary Industries Minerals and Petroleum (NSW)","Occupational Health and Safety Act 2000 | Coal Mine Health and Safety Act 2002 | Mine Health and Safety Act 2004 | Explosives Act 2003"],["http://www.legislation.nsw.gov.au","Legislation, New South Wales","Occupational Health and Safety Act 2000"],["http://www.worksafe.vic.gov.au","WorkSafe, Victoria","Occupational Health and Safety Act 2004 | Mines Act 1958"],["http://www.legislation.sa.gov.au","Attorney-General's Department, South Australia","Occupational Health, Safety and Welfare Act 1986 | OHSW Regulations 2010 | Mining Act 1971"],["http://www.maqohsc.sa.gov.au","Mining and Quarrying OH&S Committee (SA)","SA Occupational Health, Safety and Welfare Act, 1986"],["http://www.slp.wa.gov.au","State Law Publisher, Western Australia","Occupational Safety and Health Act 1984 | Occupational Safety and Health Regulations 1996"],["http://www.dmp.wa.gov.au","Department of Mines and Petroleum (WA)","Mines Safety and Inspection Act 1994 (WA)"],["http://www.wst.tas.gov.au","Workplace Standards, Tasmania","Workplace Health and Safety Act 1995 | Workplace Health and Safety (Mine Safety) Amendment Act 2010"],["http://www.worksafe.nt.gov.au","WorkSafe, Northern Territory","Workplace Health and Safety Act | Workplace Health and Safety Regulations"],["http://www.deir.qld.gov.au","Department of Justice and Attorney-General, Queensland","Workplace Health and Safety Act 1995 | Health and Safety Regulation 2008"],["http://www.dme.qld.gov.au","Department of Mines and Energy (QLD)","Coal Mining Safety and Health Act 1999 | Mining and Quarrying Safety and Health Act 1999"]]}},

{"heading":"Compliance with Australian Standards","level":1,"body":"Standards are published documents setting out specifications and procedures designed to ensure products, services and systems are safe, reliable and consistently perform as intended. They establish a common language that defines quality and safety criteria.\\n\\nStandards used as guidance documents can include:\\n• Australian Standards®\\n• International Standards and Joint Standards\\n• Codes\\n• Specifications\\n• Handbooks\\n• Guidelines.\\n\\nThese documents are practical and do not set impossible goals. They are based on sound industrial, scientific and consumer experience and are constantly reviewed to ensure they keep pace with new technologies. They cover all industry types including consumer products and services, construction, engineering, business, information technology, human services, energy and water utilities, and the environment.\\n\\nThe following table includes, but is not limited to, the relevant Australian Standards.","table":{"headers":["Identification Code","Subject"],"rows":[["AS 1216—2006 (Incorporating Amendment No.1)","Class labels for dangerous goods"],["AS 1470-1986","Health and safety at work — Principles and practices"],["AS/NZS ISO 31000:2009","Risk management — Principles and guidelines"],["AS 1319-1994","Safety signs for the occupational environment"],["AS/NZS ISO 14001:2004","Environmental management systems — Requirements with guidance for use"],["AS/NZS 4501:2008","Occupational protective clothing"],["[Additional AS code relevant to the equipment]","[Subject]"],["[Additional AS code relevant to the equipment]","[Subject]"]]}}
]}

Rules:
• Mirror the section order above EXACTLY (Contents → Supporting Documentation Register → Amendment Register → Validation / Moderation Register → Map of Training Program → Map Against Evidence Requirements (with three level-2 sub-tables: Required Knowledge / Required Skills / Critical Evidence) → Legislation and Licensing Requirements → Legislation and Standards Information → Compliance with Australian Standards).
• Replace [UNIT CODE] and [Unit Title] with the real Unit of Competency the user describes (e.g. RIIMPO301B Conduct Hydraulic Excavator Operations). If the user names an equipment, use it to populate [equipment] placeholders.
• Build the Map of Training Program from the ACTUAL Elements and Performance Criteria of the requested Unit — use 3 Elements with their full set of Performance Criteria (typically 6–10 PCs per Element). Do NOT leave placeholder text in the Performance Criterion column when a real unit code is supplied.
• Keep all four registers (Supporting Documentation, Amendment, Validation/Moderation, Legislation and Standards Information, Australian Standards) populated with realistic example rows even if the user did not provide specifics.
• Required Knowledge / Required Skills / Critical Evidence tables must each have at least 4 rows; the legislation table at least 8 rows; the AS standards table at least 6 rows.
• No markdown fences, no commentary, JSON only.`,

  'record-form': `Return ONLY valid JSON (no markdown, no fences):
{"name":"[TOPIC] Record Form","passMark":0,"description":"Use this form to record [topic] data. All mandatory fields must be completed at the time of the event.","fields":[
{"type":"section","label":"1. Record Details"},
{"type":"date","label":"Date of Record"},
{"type":"text","label":"Record Reference Number"},
{"type":"text","label":"Location / Area"},
{"type":"text","label":"Recorded By (Name)"},
{"type":"text","label":"Position / Role"},
{"type":"section","label":"2. [Relevant Section 1 — adapt to topic]"},
{"type":"text","label":"[Key field 1 — specific to topic]"},
{"type":"text","label":"[Key field 2]"},
{"type":"select","label":"[Classification field]","options":["[Option 1]","[Option 2]","[Option 3]","[Option 4]"]},
{"type":"textarea","label":"[Description or detail field]"},
{"type":"section","label":"3. [Relevant Section 2]"},
{"type":"yesno","label":"[Yes/No question 1 relevant to topic]"},
{"type":"yesno","label":"[Yes/No question 2]"},
{"type":"yesno","label":"[Yes/No question 3]"},
{"type":"textarea","label":"Observations / Notes"},
{"type":"section","label":"4. Actions Required"},
{"type":"checkbox","label":"Action Type","options":["No action required","Corrective action required","Escalation required","Follow-up inspection required"]},
{"type":"textarea","label":"Action Details / Instructions"},
{"type":"date","label":"Action Due Date"},
{"type":"text","label":"Action Assigned To"},
{"type":"section","label":"5. Sign-Off"},
{"type":"signature","label":"Recorded By"},
{"type":"signature","label":"Supervisor / Verifier"}
]}
Rules: adapt ALL field labels and options specifically to the record type requested; minimum 15 fields across at least 4 sections; include sign-off section; no markdown fences.
CRITICAL — EVERY answerable item MUST be a FILLABLE FIELD, never a "section". Use "type":"section" ONLY for a NUMBERED grouping heading ("1. …", "2. …") that has NO answer of its own. Any item the user fills in or chooses — a level, tier, class, type, category, authority, status, rating, date, name, value, Yes/No — MUST be a field (text / textarea / date / number / select / radio / yesno / checkbox / rating / signature), NOT a section. In particular: "Risk Level" / "Initial Risk Level" / "Residual Risk Level" → {"type":"select","options":["Low","Moderate","High","Critical"]}; "Change Type", "Tier", "Classification", "Approval Authority", "Category" → {"type":"select", with the relevant options}. Where actions are tracked, include "Action", "Assigned To" (text) and "Due Date" (date) fields. Do NOT emit a choice item as a bare section header.`,

  'excel-form': `Return ONLY valid JSON (no markdown, no fences) for an Excel spreadsheet. CHOOSE THE RIGHT LAYOUT:

▶ REGISTER / LOG / TRACKER / MATRIX (use when the user wants to RECORD MANY ENTRIES over time — e.g. a "register", "log", "tracker", "matrix", "schedule", or a "spreadsheet" to manage/track items such as a Management of Change (MOC) register, risk register, action tracker, training matrix, equipment list, incident log). Return a TABLE: column headers across the top, with blank rows to log each entry. Format:
{"name":"[Topic] Register","layout":"register","description":"[one-line purpose / how to use]","rowsToProvide":25,"columns":[
{"label":"[Column 1]"},{"label":"[Column 2]"},{"label":"[Column with fixed choices]","options":["[Opt1]","[Opt2]"]}, …
]}
EXAMPLE — a Management of Change (MOC) register's columns (adapt to the site, keep this lifecycle coverage): "MOC No.", "Date Raised", "Change Title", "Requested By", "Department / Area", "Change Owner", "Equipment / Process Affected", "Change Type" (options: Permanent / Temporary / Emergency), "MOC Tier" (options: Tier 1 / Tier 2 / Tier 3), "Critical Control Affected?" (Yes/No), "Regulatory / Permit Impact?" (Yes/No), "Initial Risk Level" (options: Low / Moderate / High / Critical), "Residual Risk Level" (options: Low / Moderate / High / Critical), "Approval Authority", "Status" (options: Draft / Under Review / Approved / Implemented / Closed / Rejected), "Date Approved", "Target Implementation Date", "Actual Implementation Date", "Pre-Startup Review (PSSR) Done?" (Yes/No), "Temporary Change Expiry Date", "Close-Out Date", "Remarks / Comments". Provide 18–24 columns for a MOC register.
Rules (register): columns must cover the item's full lifecycle; give "options" for any column with a fixed set of values; rowsToProvide 20–30; adapt every label to the requested topic/site; no markdown fences.

▶ SINGLE-RECORD FILLABLE FORM (use when the user wants a form to fill in ONE record at a time). Format:
{"name":"[TOPIC] Form","description":"Use this spreadsheet to record [topic].","fields":[
{"type":"section","label":"1. Details"},
{"type":"date","label":"Date"},
{"type":"text","label":"Reference Number"},
{"type":"text","label":"Location / Area"},
{"type":"text","label":"Completed By (Name)"},
{"type":"text","label":"Position / Role"},
{"type":"section","label":"2. [Relevant Section — adapt to topic]"},
{"type":"text","label":"[Key field 1 — specific to topic]"},
{"type":"number","label":"[Numeric reading/value field]"},
{"type":"select","label":"[Classification field]","options":["[Option 1]","[Option 2]","[Option 3]"]},
{"type":"yesno","label":"[Yes/No check 1]"},
{"type":"yesno","label":"[Yes/No check 2]"},
{"type":"textarea","label":"Comments / Notes"},
{"type":"section","label":"3. Sign-Off"},
{"type":"signature","label":"Authorised By"}
]}
Rules (single-record form): each field is a labelled row with a fill-in cell — favour concise field labels, numeric fields for readings/values, yesno for checks, and select (with options) for classifications. Adapt ALL labels/options to the requested topic; minimum 12 fields across at least 3 sections; include a sign-off section; no markdown fences.

Pick REGISTER when the request is about managing/tracking/logging multiple items (this includes a "Management of Change spreadsheet" → a MOC register); pick the single-record form only for a one-off record. Return ONLY the one chosen JSON object.`,

  checklist: `Return ONLY valid JSON (no markdown, no fences):
{"title":"[TOPIC] CHECKLIST","subtitle":"[Role] · [Department] · Version 1.0","docNumber":"CL-[DEPT]-001","sections":[
{"heading":"Instructions","level":1,"body":"[Brief instructions — when to use this checklist, who completes it, and what to do after completion.]","callout":"Complete ALL items. Mark ✓ for satisfactory, ✗ for unsatisfactory, or N/A if not applicable. Unsatisfactory items require immediate corrective action before proceeding."},
{"heading":"[Section 1 — e.g. Pre-Task / Pre-Shift]","level":1,"checklist":["[Specific, observable item 1]","[Item 2]","[Item 3]","[Item 4]","[Item 5]","[Item 6]","[Item 7]"]},
{"heading":"[Section 2 — e.g. Equipment / Environment]","level":1,"checklist":["[Item 1]","[Item 2]","[Item 3]","[Item 4]","[Item 5]","[Item 6]"]},
{"heading":"[Section 3 — e.g. Procedures / Compliance]","level":1,"checklist":["[Item 1]","[Item 2]","[Item 3]","[Item 4]","[Item 5]"]},
{"heading":"[Section 4 — e.g. Post-Task / Close-Out]","level":1,"checklist":["[Item 1]","[Item 2]","[Item 3]","[Item 4]"]},
{"heading":"Issues and Actions","level":1,"table":{"headers":["Item Ref","Issue Identified","Action Required","Assigned To","Due Date","Resolved ✓"],"rows":[["","","","","",""],["","","","","",""],["","","","","",""]]}},
{"heading":"Completion and Sign-Off","level":1,"body":"Completed By: ___________________________\\nPosition: ___________________________\\nSignature: ___________________________\\nDate: ___________\\n\\nVerified By (Supervisor): ___________________________\\nSignature: ___________________________\\nDate: ___________"}
]}
Rules: minimum 22 checklist items across at least 4 sections; items must be specific and observable — not vague; include issues table and sign-off; no markdown fences.`,

  'return-to-ops': `Return ONLY valid JSON (no markdown, no fences):
{"title":"RETURN TO OPERATIONS — COMPETENCY CLEARANCE","subtitle":"Training Return and Clearance Authority · [Department] · [Site]","docNumber":"ROT-[DEPT]-001","sections":[
{"heading":"1. Employee and Training Summary","level":1,"table":{"headers":["Field","Detail"],"rows":[["Employee Full Name","[Full Name]"],["Employee ID","[ID]"],["Returning to Role","[Job Title]"],["Department / Crew","[Department]"],["Training Program Completed","[Program Name]"],["Training Provider","[Provider]"],["Date Training Completed","[DD/MM/YYYY]"],["Certificate / Qualification Achieved","[Title] — Issued: [Date] — Expiry: [Date]"],["Final Assessment Result","☐  Pass     ☐  Fail     ☐  Reassessment Required"],["Assessment Score","[X%]  (Pass mark: [Y%])"],["Assessor Name and Qualification","[Name] — [Qualification / Licence]"]]}},
{"heading":"2. Competency Confirmation","level":1,"table":{"headers":["Competency / Skill","Pre-Training Level","Post-Training Level","Gap Closed?","Assessed By"],"rows":[["[Skill 1]","Not assessed","Competent","Yes ✓","[Assessor]"],["[Skill 2]","Developing","Competent","Yes ✓","[Assessor]"],["[Skill 3]","Not assessed","Competent","Yes ✓","[Assessor]"],["[Skill 4 — if gap remains]","Developing","Developing","No — supervised practice required","[Assessor]"]]}},
{"heading":"3. Return Conditions","level":1,"body":"Select the applicable clearance option:\\n\\n☐  OPTION A — FULL CLEARANCE\\nEmployee has met all required standards. Returns to full unrestricted duties immediately.\\n\\n☐  OPTION B — CONDITIONAL CLEARANCE\\nEmployee returns with the following supervision requirements:\\nConditions: [Specify conditions clearly]\\nDuration: [X weeks]\\nReview Date: [DD/MM/YYYY]\\n\\n☐  OPTION C — DECLINED — RETURN TO TRAINING\\nEmployee has not met the required standard.\\nReason: [Specify gaps]\\nNew Training Plan Reference: TT-[YYYY]-[###]","callout":"Conditional clearance conditions must be formally reviewed and signed off before full unrestricted duties are restored."},
{"heading":"4. Site Re-Induction Requirements","level":1,"callout":"Complete all items below before the employee commences their first shift back on site.","checklist":["Site safety induction update (required if absent more than [X] weeks)","Attend pre-start meeting on first shift back","Briefing on any procedure, equipment, or regulatory changes during the absence","Re-issue of access passes, site keys, and PPE — inspect all items","Introduction to any new team members, supervisors, or visitors","Emergency procedure briefing — confirm changes to muster points or contacts","Review all safety alerts issued during absence — confirm employee has read and signed each"]},
{"heading":"5. First Shift Supervisor Check","level":1,"table":{"headers":["Check Item","Completed ✓","Supervisor Notes"],"rows":[["Employee briefed on all changes during absence","☐",""],["Employee shown new or modified equipment / procedures","☐",""],["Employee understands return conditions (if Option B)","☐",""],["Pre-start meeting attended on first shift","☐",""],["PPE inspected and serviceable","☐",""],["Employee fit, alert, and ready for duty","☐",""]]}},
{"heading":"6. 30-Day Post-Return Review","level":1,"body":"Scheduled Review Date (30 days from return): [DD/MM/YYYY]\\nConducted By: [Supervisor name and title]\\n\\nReview Outcome:\\n☐  All conditions met — Full unrestricted clearance granted\\n☐  Conditions extended — New review date: ___________\\n☐  Performance concern — Referred to HR\\n\\nSupervisor notes: [Observations on performance and competency since return]"},
{"heading":"7. Training Record Actions","level":1,"checklist":["Update employee training record in TrainingPro — add completion date and result","Upload certificate or qualification to employee document file","Set expiry date and renewal reminder in TrainingPro","Close the associated Training Request Form as completed","Archive the Transfer to Training document","Notify HR and Department Manager of qualification achieved","Update Competency Framework records if this changes the employee's job profile"]},
{"heading":"8. Final Authorisation","level":1,"callout":"This document must be signed by all parties before the employee commences their first shift back on site.","table":{"headers":["Role","Printed Name","Signature","Date"],"rows":[["Returning Employee","","___________",""],["Direct Supervisor","","___________",""],["Training Manager","","___________",""],["Department Manager","","___________",""],["HR Representative","","___________",""]]}}
]}
Rules: all tables complete; checklists minimum 6 items; return conditions must include all three options; no markdown fences.`
};

// ── Generate content via Claude ────────────────────────────────────────────────
// ── Destination template section catalog (for semantic source→template mapping) ──
// Machine-readable target sections per document type. `req` marks a mandatory section:
// if the source has no matching content, mapping flags it "INFORMATION REQUIRED" (never
// fabricated). Types absent here fall back to normal generation (no mapping step offered).
const TEMPLATE_SECTIONS = {
  'sop': [
    { t: 'Purpose', req: true }, { t: 'Scope', req: true }, { t: 'Definitions' },
    { t: 'Responsibilities', req: true }, { t: 'PPE & Equipment', req: true },
    { t: 'Hazards & Controls', req: true }, { t: 'Procedure (step-by-step)', req: true },
    { t: 'Emergency & Abnormal Situations', req: true }, { t: 'References' }, { t: 'Records' },
  ],
  'swp': [
    { t: 'Task / Purpose', req: true }, { t: 'Scope' }, { t: 'Required PPE', req: true },
    { t: 'Tools & Equipment' }, { t: 'Hazards & Risk Controls (hierarchy of control)', req: true },
    { t: 'Step-by-Step Procedure', req: true }, { t: 'Emergency Response', req: true }, { t: 'Sign-off' },
  ],
  'jsa': [
    { t: 'Job / Task Details', req: true }, { t: 'PPE Required', req: true },
    { t: 'Job Steps (with hazards, risk rating & controls)', req: true },
    { t: 'Emergency Procedures', req: true }, { t: 'Team Sign-off' },
  ],
  'process': [
    { t: 'Purpose', req: true }, { t: 'Scope' }, { t: 'Roles & Responsibilities', req: true },
    { t: 'Process Overview', req: true }, { t: 'Process Flow (flowchart)' }, { t: 'Detailed Steps', req: true },
    { t: 'Inputs & Outputs' }, { t: 'KPIs & Measures' }, { t: 'Exceptions & Escalation' }, { t: 'References' },
  ],
  'course': [
    { t: 'Course Overview', req: true }, { t: 'Learning Objectives', req: true }, { t: 'Target Audience' },
    { t: 'Prerequisites' }, { t: 'Course Content (modules)', req: true }, { t: 'Activities' },
    { t: 'Assessment', req: true }, { t: 'Summary' }, { t: 'Resources' },
  ],
  'induction': [
    { t: 'Welcome & Introduction', req: true }, { t: 'Company / Site Overview' },
    { t: 'Site Rules & Conduct', req: true }, { t: 'Emergency Procedures', req: true },
    { t: 'Hazards & PPE', req: true }, { t: 'Reporting & Escalation', req: true },
    { t: 'Key Contacts' }, { t: 'Acknowledgement Checklist', req: true },
  ],
  'training-manual': [
    { t: 'Introduction', req: true }, { t: 'Safety & PPE', req: true }, { t: 'Equipment / System Overview', req: true },
    { t: 'Pre-Operational Checks', req: true }, { t: 'Operating Procedures', req: true },
    { t: 'Shutdown / Parking' }, { t: 'Maintenance & Fault-finding' }, { t: 'Glossary' }, { t: 'Knowledge Check', req: true },
  ],
  'policy': [
    { t: 'Policy Statement', req: true }, { t: 'Purpose', req: true }, { t: 'Scope', req: true },
    { t: 'Definitions' }, { t: 'Policy Requirements', req: true }, { t: 'Responsibilities', req: true },
    { t: 'Consequences of Non-Compliance', req: true }, { t: 'Review' },
  ],
  'standard': [
    { t: 'Purpose', req: true }, { t: 'Scope', req: true }, { t: 'Definitions' },
    { t: 'Requirements (measurable)', req: true }, { t: 'Roles & Responsibilities', req: true },
    { t: 'Compliance & Verification', req: true }, { t: 'Non-Conformance' }, { t: 'References' },
  ],
  'training-standards': [
    { t: 'Purpose & Scope', req: true }, { t: 'Competency Requirements', req: true },
    { t: 'Training Requirements', req: true }, { t: 'Assessment Requirements', req: true },
    { t: 'Trainer / Assessor Requirements' }, { t: 'Records & Verification', req: true },
    { t: 'Progression Pathway' }, { t: 'References' },
  ],
  'training-plan': [
    { t: 'Overview', req: true }, { t: 'Target Audience' }, { t: 'Learning Objectives', req: true },
    { t: 'Training Modules', req: true }, { t: 'Delivery Method' }, { t: 'Assessment', req: true },
    { t: 'Resources' }, { t: 'Schedule' },
  ],
};

// Semantic map of an uploaded SOURCE into a destination template's sections. Returns
// { mappings, unmapped, missingRequired } with confidence — the basis of the mapping-preview
// UI and the unmapped-content queue. Never invents content; flags gaps for human review.
async function mapSourceToTemplate(sourceText, type) {
  const targets = TEMPLATE_SECTIONS[type];
  if (!targets || !sourceText || !String(sourceText).trim()) return null;
  const targetList = targets.map((s, i) => `${i + 1}. ${s.t}${s.req ? '  [REQUIRED]' : ''}`).join('\n');
  const sys = `You are a training-document mapping analyst. You are given the plain text of an UPLOADED SOURCE document and the list of SECTIONS of a destination template. Map the source's content into the destination sections BY MEANING — recognise that differently-titled source content belongs in a template section (e.g. source "Before Operating" → template "Pre-Operational Checks"). Judge by meaning, safety purpose, task and sequence, NOT by matching heading words.\n\n`
    + `Return ONLY valid JSON (no markdown, no commentary) shaped exactly:\n`
    + `{"mappings":[{"source":"<source heading/topic>","target":"<EXACT destination section title from the list>","confidence":"high|medium|low","reason":"<short why>"}],`
    + `"unmapped":[{"source":"<source heading/topic>","excerpt":"<≤160 chars of the source content>","suggestedTarget":"<best-guess destination title or empty>","confidence":"low|medium","reason":"<why it did not clearly fit>"}],`
    + `"missingRequired":[{"target":"<REQUIRED destination title with no source content>","reason":"<what information is needed>"}]}\n\n`
    + `Rules: (1) "target" MUST be copied verbatim from the destination list. (2) Put source content that does not clearly belong in any destination section into "unmapped" — NEVER drop it silently. (3) For a [REQUIRED] destination section with no matching source content, add it to "missingRequired" (do NOT invent facts). (4) Be conservative with confidence: only "high" when the meaning clearly matches.`;
  const user = `DESTINATION TEMPLATE SECTIONS:\n${targetList}\n\nUPLOADED SOURCE DOCUMENT (plain text):\n"""${String(sourceText).slice(0, 24000)}"""`;
  const msg = await aiGateway.complete({
    provider: 'anthropic', agent: 'AI-DOC-001', operation: 'map_sections',
    model: 'claude-sonnet-4-6', max_tokens: 8000, system: sys,
    messages: [{ role: 'user', content: user }],
  });
  const raw = ((msg.content.find(b => b.type === 'text') || {}).text || '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let j;
  try { j = JSON.parse(raw); }
  catch { try { j = JSON.parse(repairJson(raw)); } catch { const m = raw.match(/\{[\s\S]*\}/); j = m ? JSON.parse(repairJson(m[0])) : null; } }
  if (!j) return { mappings: [], unmapped: [], missingRequired: [], targets: targets.map(s => s.t) };
  return {
    mappings: Array.isArray(j.mappings) ? j.mappings : [],
    unmapped: Array.isArray(j.unmapped) ? j.unmapped : [],
    missingRequired: Array.isArray(j.missingRequired) ? j.missingRequired : [],
    targets: targets.map(s => ({ title: s.t, required: !!s.req })),
  };
}

// ── Audience adaptation (Learning Profile × Technical Depth) ────────────────────
// Two INDEPENDENT dials that change HOW content is written — never WHAT facts it
// contains. Literacy changes language; technical depth changes how much detail.
// Safety-critical facts, numbers, limits and warnings are preserved verbatim.
const LEARNING_PROFILES = {
  'L1': { label: 'Level 1 — Operator (plain language)', guidance: 'Write for a reader with lower reading literacy. Use plain everyday language, short sentences (aim ≤ 15 words), simple common words, and the active voice. Give ONE instruction per step, in numbered order. Avoid jargon; where a technical term is unavoidable, define it in plain words right there. Make warnings short, direct and prominent. BE CONCISE — include only what the operator needs to DO the task safely; cut long background, history, theory and elaboration. Prefer short numbered steps and bullet points over long paragraphs. Keep ALL safety-critical facts and numbers — just say them simply and briefly.' },
  'L2': { label: 'Level 2 — Standard workforce', guidance: 'Write in normal, clear workplace language for an experienced employee. Concise and direct, standard industry terminology, brief clarification only where a term is unusual. No unnecessary complexity.' },
  'L3': { label: 'Level 3 — Supervisor / Leadership', guidance: 'Write for a supervisor/leader. Use standard clear language and ADD emphasis on decision-making, accountability, supervision, risk management, escalation pathways, verification/sign-off, coaching requirements and performance expectations. Add short supervisory notes or callouts where they add value.' },
  'L4': { label: 'Level 4 — Technical / Advanced', guidance: 'Write for a technical/advanced reader. Use precise technical language and include, where relevant, engineering rationale, specifications, tolerances, systems relationships, troubleshooting/diagnostics and root-cause principles.' },
};
const TECH_DEPTHS = {
  'basic':    { label: 'Basic',    guidance: 'Include ONLY the essential technical detail needed to perform the task correctly and safely. Keep sections short. Do NOT add engineering theory, derivations, extended background, or specifications the task does not require.' },
  'standard': { label: 'Standard', guidance: 'Include the normal level of operational technical detail expected in this document type.' },
  'advanced': { label: 'Advanced', guidance: 'Include detailed technical specifications, component/system relationships and troubleshooting guidance where relevant.' },
  'expert':   { label: 'Expert',   guidance: 'Include full technical depth where relevant: calculations, tolerances, diagnostics, engineering principles and root-cause analysis.' },
};
// Build the audience-adaptation prompt block (empty string when neither dial is set to a
// non-default value, so default generations are byte-for-byte unchanged).
function buildLearningCap(learningProfile, techDepth) {
  const p = LEARNING_PROFILES[learningProfile];
  const d = TECH_DEPTHS[techDepth];
  if (!p && !d) return '';
  return `\n\n━━━ AUDIENCE ADAPTATION ━━━\nAdapt HOW this document is written to the intended audience. There are TWO INDEPENDENT dials — apply BOTH:\n`
    + (p ? `\n• READING / LITERACY LEVEL — ${p.label}: ${p.guidance}\n` : '')
    + (d ? `\n• TECHNICAL DEPTH — ${d.label}: ${d.guidance}\n` : '')
    + ((learningProfile === 'L1' && techDepth === 'basic')
        ? `\n• ABBREVIATIONS (Level 1 Operator + Basic): write EVERY abbreviation, acronym and initialism IN FULL. Give the full words, with the short form in brackets only on first use, e.g. "Personal Protective Equipment (PPE)", "Job Safety Analysis (JSA)", "Standard Operating Procedure (SOP)", "Management of Change (MOC)". Prefer the full words over the short form throughout. NEVER use a bare abbreviation on its own that the operator may not understand.\n`
        : '')
    + `\nThe two dials are INDEPENDENT: literacy controls the LANGUAGE (sentence length, vocabulary, clarity); technical depth controls HOW MUCH technical detail is included. A low-literacy + high-depth request means include the deeper technical content but explain it in very plain, simple language.\n`
    + `\nPRECEDENCE: this audience setting OVERRIDES the template's default verbosity. Where the document template below suggests longer prose, more elaboration, or a higher reading level than this audience needs, FAVOUR THIS SETTING — keep each section brief and focused for the chosen level. Still include every REQUIRED section and every safety-critical fact, but do NOT pad them with background or detail beyond what this audience needs. Any minimum row/section counts in the template are a floor for COMPLETENESS, never a licence to add unnecessary detail.\n`
    + `\nABSOLUTE RULE — meaning is never changed, only wording: NEVER remove, weaken, round or paraphrase away any safety-critical or technical FACT — speed / pressure / temperature / distance / load limits, PPE, isolation steps, emergency actions, legislative requirements, and every number and unit. These stay EXACTLY as in the source / standard. Do not lower competency or assessment rigour for a lower-literacy audience — only the language becomes simpler.\n━━━ END AUDIENCE ADAPTATION ━━━`;
}

// Build the user-confirmed section-mapping directive for generation (empty when no mapping given).
function buildMappingCap(mapping) {
  if (!mapping || typeof mapping !== 'object') return '';
  const maps = Array.isArray(mapping.mappings) ? mapping.mappings.filter(m => m && m.source && m.target) : [];
  const placements = Array.isArray(mapping.unmappedPlacements) ? mapping.unmappedPlacements : [];
  const missing = Array.isArray(mapping.missingRequired) ? mapping.missingRequired.filter(m => m && m.target) : [];
  if (!maps.length && !placements.length && !missing.length) return '';
  const kept = placements.filter(p => p && p.target && p.target !== '__exclude__');
  const excluded = placements.filter(p => p && p.target === '__exclude__');
  let s = `\n\n━━━ SECTION MAPPING — USER-CONFIRMED — FOLLOW EXACTLY ━━━\nOrganise the SOURCE content into the destination template using this reviewer-approved mapping. Place each source topic under the destination section shown:\n`;
  if (maps.length) s += maps.map(m => `• "${m.source}"  →  ${m.target}`).join('\n') + '\n';
  if (kept.length) s += `\nAlso INCLUDE this source content (never drop it) in the destination section shown (use an "Additional Information" section where the target is "__additional__"):\n`
    + kept.map(p => `• "${p.source || p.excerpt || ''}"  →  ${p.target === '__additional__' ? 'Additional Information' : p.target}`).join('\n') + '\n';
  if (excluded.length) s += `\nThe reviewer chose to EXCLUDE this source content — do NOT include it:\n`
    + excluded.map(p => `• "${p.source || p.excerpt || ''}"`).join('\n') + '\n';
  if (missing.length) s += `\nThese REQUIRED destination sections have insufficient source information. INCLUDE the section with its heading, and set its body to a single visible line exactly: [INFORMATION REQUIRED: <what is needed>]. DO NOT invent facts, values, or safety information:\n`
    + missing.map(m => `• ${m.target}${m.reason ? ' — ' + m.reason : ''}`).join('\n') + '\n';
  s += `━━━ END SECTION MAPPING ━━━`;
  return s;
}

// Assessment style per learning profile (brief §20). Adapts QUESTION FORMAT/STYLE to the
// audience — NOT the competency standard or pass criteria, which stay constant. Difficulty and
// language complexity are different concerns: a low-literacy version is written in plain language
// but tests the same competencies to the same rigour.
const ASSESSMENT_STYLE = {
  'L1': 'Use mostly single-answer multiple-choice and true/false questions. Write short, plain-language question stems — one idea per question. Prefer concrete, practical, real-task scenarios over abstract theory. Keep answer options short and clearly distinct. Avoid double negatives, multi-part questions and trick wording. Picture-based / correct-vs-incorrect style questions suit this audience where relevant.',
  'L2': 'Use a standard mix of single-choice, multiple-choice and short practical questions in clear workplace language.',
  'L3': 'Emphasise scenario-based questions covering supervisory judgement: risk decisions, escalation, accountability, verification and leadership responses ("as the supervisor, what should you do when…").',
  'L4': 'Emphasise technical questions: diagnostics, troubleshooting, calculations, tolerances, interpretation of technical information/specifications, and advanced scenarios.',
};
function buildAssessmentCap(learningProfile) {
  const g = ASSESSMENT_STYLE[learningProfile];
  const p = LEARNING_PROFILES[learningProfile];
  if (!g) return '';
  return `\n\n━━━ ASSESSMENT STYLE — ${p ? p.label : learningProfile} ━━━\n`
    + `Tailor the QUESTION STYLE and FORMAT to this audience:\n• ${g}\n`
    + `\nCRITICAL — competency rigour is NON-NEGOTIABLE: do NOT make the assessment easier, reduce topic coverage, or lower the pass standard for a lower-literacy audience. Test the SAME competencies to the SAME rigour — only the wording and question format adapt. Every correct answer and all safety-critical facts must remain accurate.\n━━━ END ASSESSMENT STYLE ━━━`;
}

async function generate(type, prompt, opts = {}) {
  const isHSE =['swp','jsa','safety-alert','toolbox-talk','transfer-to-training','return-to-ops','training-manual','training-standards','policy','standard','plan','management-plan','strategy-plan','process','trainer-assessor-guide','statutory-regulatory','operational-guidelines'].includes(type);
  const learningProfile = LEARNING_PROFILES[opts.learningProfile] ? opts.learningProfile : null;
  const techDepth = TECH_DEPTHS[opts.techDepth] ? opts.techDepth : null;
  const LEARNING_CAP = buildLearningCap(learningProfile, techDepth);
  // Assessment types additionally adapt QUESTION style to the profile (rigour stays constant).
  const ASSESSMENT_CAP = (['exam', 'form'].includes(type) && learningProfile) ? buildAssessmentCap(learningProfile) : '';
  // User-confirmed semantic mapping (from the mapping-preview step) guides how source content is placed.
  const MAPPING_CAP = buildMappingCap(opts.mapping);
  const sys = isHSE
    ? `You are a senior HSE professional, instructional designer, and document architect for mining and industrial operations. You produce audit-ready, compliance-grade documents. Return ONLY valid JSON — no preamble, no markdown, no commentary.`
    : `You are a senior training & competency content developer for mining / industrial operations.`;
  const mode = opts.sourceMode || 'reference';
  // Additional REFERENCE documents (the user may upload several) — extra material the AI builds from.
  const refDocs = Array.isArray(opts.referenceDocs) ? opts.referenceDocs.filter(d => d && d.text && String(d.text).trim()) : [];
  const hasSource = !!(opts.sourceText || opts.sourceBlock || refDocs.length);
  const kbCtx = opts.kbContext
    ? `\n\n━━━ ORGANISATION KNOWLEDGE BASE — YOU MUST USE THIS (MANDATORY) ━━━\nThe user has explicitly SELECTED the following Knowledge Base article(s) to be included in this document. Because the user chose them ON PURPOSE, they are ALWAYS relevant and are REQUIRED source material — not optional background. Every selected article's content MUST visibly appear in the finished document. You MUST actively incorporate ALL of them:\n• Weave the relevant facts, policies, PROCEDURES, steps, thresholds, terms and wording from these articles into the appropriate sections of the document. The content of each article has to end up in the output.\n• ALSO add, for each selected article, a clearly-labelled reference/background subsection or section — titled after that article (e.g. "Reference Information — <article title>") — so the article's material is unmistakably present even when an uploaded source document is large or on a slightly different topic. Never rely on the source document alone; the KB content is in ADDITION to it.\n• When an article defines a policy or process relevant to this document — e.g. an HR disciplinary progression, a legal restriction, a safety rule, equipment specifications — reproduce its specific steps, levels, timeframes, specs and terminology FAITHFULLY as written. Do NOT paraphrase the detail away, summarise it into one line, or invent an alternative process.\n• Use the exact site-specific values (speeds, heights, distances, equipment specs, official names) verbatim — never invent values that are defined here.\n• EQUIPMENT / MODEL NUMBERS — THE KB IS AUTHORITATIVE: If the uploaded SOURCE document refers to the SAME equipment or subject by a DIFFERENT model number, code or name than the selected KB article (for example the source says a "740" truck but the selected KB article is the "745"), the KB article's designation WINS. Use the KB's exact model number / name EVERYWHERE in the document — in headings, body, tables and captions — and correct every conflicting value from the source so it matches the KB. NEVER downgrade, round or alter the KB's model number (e.g. do NOT write 740 when the selected KB says 745). When in doubt about a model number, defer to the KB article's title and body.\n• NEVER silently omit a selected article. Even if its subject differs from the uploaded source, include its material in its own clearly-labelled reference section. A large or unrelated source document is NOT a reason to drop KB content.\n\n${opts.kbContext}\n━━━ END KNOWLEDGE BASE ━━━`
    : '';
  // Training manuals rebuilt from a source need the WHOLE document (every page kept), so allow much more
  // source text for that type; other reference builds keep the lighter cap.
  const _srcCap = (type === 'training-manual') ? 60000 : 20000;
  const textCtx = opts.sourceText
    ? (mode === 'transform'
        ? `\n\nSOURCE DOCUMENT TO TRANSFORM:\n"""${opts.sourceText.slice(0, 14000)}"""`
        : `\n\nReference this source document when building content:\n"""${opts.sourceText.slice(0, _srcCap)}"""`)
    : '';
  const blockCtx = opts.sourceBlock
    ? (mode === 'transform'
        ? `\n\nSOURCE DOCUMENT TO TRANSFORM: see the attached file.`
        : `\n\nUse the attached document as reference material.`)
    : '';
  // Several uploaded reference documents — the AI must draw on ALL of them to build the new document.
  const refDocsCtx = refDocs.length
    ? `\n\n━━━ REFERENCE DOCUMENTS (${refDocs.length}) — USE ALL OF THEM ━━━\nThe user uploaded the following document(s) for you to build this document from. ANALYSE every one and draw the relevant content, facts, structure, values and detail from ALL of them (in addition to any other source and the Knowledge Base). Combine their information — do not ignore any document.\n`
      + refDocs.map((d, i) => `\n----- REFERENCE DOCUMENT ${i + 1}: ${String(d.name || ('Document ' + (i + 1))).slice(0, 140)} -----\n"""${String(d.text).slice(0, Math.max(6000, Math.floor(72000 / refDocs.length)))}"""`).join('\n')
      + `\n━━━ END REFERENCE DOCUMENTS ━━━`
    : '';
  // Document 2 — updated-content source. When present, Document 1 provides the LAYOUT and
  // Document 2 provides the authoritative CONTENT (see updateDirective below).
  const hasUpdate = !!(opts.updateText || opts.updateBlock);
  const updateTextCtx = opts.updateText
    ? `\n\n━━━ DOCUMENT 2 — UPDATED INFORMATION (authoritative content) ━━━\n"""${opts.updateText.slice(0, 45000)}"""\n━━━ END DOCUMENT 2 ━━━`
    : '';
  const updateBlockCtx = opts.updateBlock
    ? `\n\nDOCUMENT 2 (the updated / OEM information) is also attached as a file — treat it as the authoritative content source.`
    : '';
  const taskPrefix = (hasSource && mode === 'transform')
    ? `Transform the provided source document into the ${type.toUpperCase().replace(/-/g, ' ')} format requested. Restructure, improve clarity, and reformat it — retaining all key information. Additional instructions: ${prompt}`
    : `Task: ${prompt}\n\nProduce ${type.toUpperCase().replace(/-/g, ' ')} content.`;
  // Always brand with company name when set; additionally replace foreign names when source doc is present
  const companyCtx = opts.companyName
    ? `\n\nCOMPANY BRANDING:\n` +
      `• This document is produced for "${opts.companyName}". Use "${opts.companyName}" wherever the organisation or company name appears in headers, footers, document control fields, and body text.\n` +
      (hasSource
        ? `• The source material may reference other company, organisation, or client names. Identify every such name and replace it with "${opts.companyName}" throughout all generated output. Do not retain any third-party organisation names from the source.`
        : `• Do not reference any other organisation or company name.`)
    : '';
  // Section-based doc types can use landscape pages and native flowcharts
  const sectionBased = isHSE || ['course', 'sop', 'induction', 'training-plan'].includes(type);
  const FLOWCHART_CAP = sectionBased ? `

SPECIAL SECTION CAPABILITIES — use ONLY when the topic genuinely calls for it:
• LANDSCAPE PAGE: any section may include "landscape": true to print that section on a wide landscape page. Use for wide tables or flowcharts.
• FLOWCHART: for staged training pathways, competency progressions, or process flows, a section may include a "flowchart" object (alongside or instead of "body"):
  "flowchart": { "title": "[Name] Flowchart", "stages": [ {"title":"Start / Basic Operations","items":["short step","short step"]}, {"title":"Stage 1 / Level 1","items":["1.1 ...","1.2 ..."]}, {"title":"Stage 2 / Level 2","items":["2.1 ..."]}, {"title":"Deemed Competent","items":["Final assessment"]} ], "notes": ["short note","Pre-requisite: ..."] }
  Stages render left→right joined by arrows. Keep stage titles short and 2–6 concise items each. ALWAYS set "landscape": true on any section that contains a flowchart.
${hasSource ? '• REPRODUCE SOURCE FLOWCHARTS: if the attached source document (its text, pages, or attached images) contains a flowchart, process diagram, training pathway, or staged competency chart, FAITHFULLY recreate it as a "flowchart" object. Read every stage / level box left-to-right and capture each box title and its sub-items in order, preserving any numbering (1.1, 1.2 …) and side notes exactly. Do not summarise or invent stages — mirror what the diagram shows. Place it in the most relevant section with "landscape": true.' : ''}
${type === 'training-standards' ? '• For an equipment-operation or competency-based training standard, INCLUDE exactly ONE flowchart section showing the trainee progression: induction → levels/stages → deemed competent.' : ''}` : '';
  // RISK CAPABILITY — when a source document carries a risk-assessment score, capture it
  // as a structured "risk" object so it renders as a small conditionally-formatted table
  // (score cell shaded per the AKARA Risk Rank Matrix: 1–5 green, 6–10 blue, 11–17 yellow,
  // 18–25 red). Applies to any build type that reads an uploaded source.
  const RISK_CAP = hasSource ? `

RISK ASSESSMENT SCORES — read ONLY from the uploaded source, never invented:
• If the source document states a risk-assessment rating for a hazard/task — a risk rank number (1–25), or a Likelihood (A–E) × Consequence (1–5) rating, or an initial/residual risk score — attach a "risk" object to the section where that hazard is discussed:
  "risk": { "hazard": "<short hazard/task name, optional>", "likelihood": "A"–"E" (optional), "consequence": 1–5 (optional), "score": <initial risk number 1–25>, "residual": <residual risk number after controls, optional>, "controls": "<optional>" }
• A section may carry an ARRAY of risk objects if the source lists several: "risk": [ {…}, {…} ].
• If the source presents its risk assessment as a TABLE (e.g. a JSA/SWMS/risk register with a "Risk Rating" / "Risk Score" / "Residual Risk" column), reproduce it as a normal "table" and name that column header with the word "Risk" (e.g. "Risk Rating", "Residual Risk") — every bare 1–25 number in a Risk-titled column is automatically shaded with the matrix colours. You do NOT need to add colours yourself.
• Use the EXACT numbers from the source. Do NOT fabricate a score if the source has none, and do NOT add a risk object to sections that have no assessed risk. The score is rendered with matrix colour-coding automatically — you only supply the numbers.` : '';
  const glossaryRef = opts.glossary
    ? `\n\n━━━ APPROVED TERMINOLOGY GLOSSARY ━━━\nIf your output renders any of these source terms in the indicated language (e.g. a bilingual document or a translated label/term), use the EXACT approved translation below — do not substitute synonyms. Apply ONLY where relevant to the topic:\n\n${opts.glossary.slice(0, 4000)}\n━━━ END TERMINOLOGY ━━━`
    : '';
  // English-only guardrail: generation must NOT volunteer translations/other-language text.
  // Translation into other languages is a separate, explicit step (see translateSection).
  const langGuard = `\n\n━━━ LANGUAGE ━━━\nWrite ALL output in ENGLISH ONLY. Do NOT add translations, parenthetical non-English equivalents, or any non-English text — including local-language (e.g. Thai) department, agency, place, or role names in any non-Latin script — UNLESS the task instructions above explicitly request another language. Even if reference/Knowledge Base material mentions providing local-language names, ignore that here: keep generation English-only. Translating documents is handled by a separate dedicated step, never during generation.\n━━━ END LANGUAGE ━━━`;
  // TRAINING MANUAL from an uploaded source: follow the source EXACTLY (structure, content, every safety
  // callout, and picture positions), and use the Knowledge Base only to fill genuine gaps / enforce correct
  // operator behaviours. This overrides the generic section template's fixed structure.
  const nSrcImgs = Array.isArray(opts.sourceImages) ? opts.sourceImages.length : 0;
  // SOURCE PICTURES — for any section-based type other than training-manual (which covers this in its
  // own directive), tell the model to place [IMG:n] markers so the uploaded document's pictures are
  // carried into the recreated document at the right spot.
  const SOURCE_IMG_CAP = (nSrcImgs && type !== 'training-manual')
    ? `\n\n━━━ SOURCE PICTURES — CARRY THEM INTO THE DOCUMENT ━━━\n${nSrcImgs} picture(s) were extracted from the uploaded source document, numbered 1..${nSrcImgs} in order of appearance. For each picture that illustrates this document's content, place a marker [IMG:1], [IMG:2] … on its OWN LINE inside the "body" of the most relevant section (match each picture to the topic/step it shows). Use each number at most once. Do NOT describe the picture in words — just place its [IMG:n] marker. Only omit a picture if it is purely decorative (e.g. a company logo).\n━━━ END SOURCE PICTURES ━━━`
    : '';
  // Training Manual — for each content section, suggest the image that would best EXPLAIN that section's
  // content, placed at the exact point it belongs, as an [IMG-SUGGEST: …] marker. These render as clear
  // "suggested image" placeholders the author can then fill in or generate.
  // Image style (region/ethnicity, gender mix, visual style) baked into every suggested image prompt.
  const _isBits = [];
  const _ir = String(opts.imgRegion || '').trim(), _ig = String(opts.imgGender || '').trim(), _isStyle = String(opts.imgStyle || '').trim();
  if (_ir) _isBits.push(`the people depicted must look like workers from ${_ir} (correct ethnicity, clothing and work setting)`);
  if (/both/i.test(_ig)) _isBits.push('include both male and female workers');
  else if (_ig) _isBits.push(`depict ${_ig.toLowerCase()} workers`);
  if (_isStyle) _isBits.push(`render in a ${_isStyle}`);
  // Company uniform + logo — ALWAYS applied so people in the images are on-brand.
  _isBits.push(`the workers MUST wear the company uniform: a high-visibility YELLOW long-sleeve work shirt with navy-blue lower sleeves and collar and silver-grey reflective stripes, navy-blue work trousers, a white hard hat, clear safety glasses and work gloves — with the "AKARA RESOURCES" company logo (a blue stylised letter "X" with a yellow triangle) on the left chest of the shirt and on the front of the white hard hat`);
  const _styleClause = _isBits.length ? ` Apply this style to EVERY image prompt: ${_isBits.join('; ')}.` : '';
  // Per-section image suggestions apply to ALL generated document types (not the form/exam/spreadsheet
  // builders or the exact-copy form, which don't generate section content). Default on; turned off when
  // opts.imageSuggest === false.
  const _imgSuggestDoc = !['exam', 'form', 'training-request', 'record-form', 'excel-form', 'form-doc'].includes(type);
  const IMG_SUGGEST_CAP = (_imgSuggestDoc && opts.imageSuggest !== false)
    ? (type === 'toolbox-talk'
        ? `\n\n━━━ SUGGESTED IMAGE — AT MOST ONE ━━━\nIf (and only if) a single picture would genuinely help the crew understand the task or a key hazard, add ONE image suggestion on its own line inside the "Key Discussion Points" body, as: [IMG-SUGGEST: <a short, ready-to-paste image prompt for ChatGPT / DALL·E — the scene and key elements, 16:9, no text in the image>].${_styleClause} One image maximum for the whole toolbox talk. Do not add images to any other section.\n━━━ END SUGGESTED IMAGE ━━━`
        : `\n\n━━━ SUGGESTED IMAGES — ONE PER CONTENT SECTION ━━━\nFor EACH substantive content section (modules, background, practical skills, safety requirements), add an IMAGE SUGGESTION placed on its OWN LINE inside that section's "body", at the exact point the image should appear, as: [IMG-SUGGEST: <a COMPLETE, ready-to-paste image-generation prompt for ChatGPT / DALL·E that creates the picture that best explains this content — describe the scene and the key elements/labels, 16:9 aspect, no text baked into the image>].${_styleClause} Be specific to the topic (e.g. a labelled view of the haul-truck isolation points). Add ONE suggestion per content section (two only if genuinely needed). Do NOT add suggestions to the title/overview, glossary, references, knowledge-check or sign-off sections. Do not invent an image file or a [IMG:n] number.\n━━━ END SUGGESTED IMAGES ━━━`)
    : '';
  // Toolbox talk is a SHORT pre-start safety chat — NOT a training manual, course or lesson. Force tight,
  // plain, direct content so it never reads like a manual.
  const TBT_BREVITY_CAP = type === 'toolbox-talk'
    ? `\n\n━━━ KEEP IT SHORT — TOOLBOX TALK, NOT A MANUAL ━━━\nThis is a 5–10 minute pre-start toolbox talk delivered to a crew on the job — NOT a training manual, course, SOP or lesson.\nSOURCE: Base the talk on the UPLOADED DOCUMENT and the USER'S BRIEF above — COMBINE them. Pull the real topic, steps, hazards, controls and key points from that material; do not invent generic content and do not ignore what was provided. Your job is to CONDENSE their information into a short talk, not to pad it out.\nSTYLE — write TIGHT, PLAIN and DIRECT:\n- Purpose: 1–2 short sentences only.\n- Key Discussion Points: 4–6 one-line bullets in plain crew language (what to do / what to watch for) — drawn from the source, no paragraphs, no theory, no background, no "learning objectives".\n- Hazards and Controls: 3–5 rows taken from the source; each control a short, practical instruction.\n- Safe Work Reminders: 4–6 short, observable reminders (a few words each).\nNO long explanations, NO references/legislation quotes, NO filler, NO manual-style prose. Every line must be something a supervisor can say out loud in seconds. When in doubt, make it shorter — but keep the real, specific details from the source.\n━━━ END KEEP IT SHORT ━━━`
    : '';
  // RECORD FORM options: copy an uploaded document's layout; strip training-specific fields for a
  // non-training record. (The colour risk matrix + HTML export are handled at render/export time.)
  const recordOpts = (type === 'record-form' && opts.recordOpts) ? opts.recordOpts : {};
  // One specific item (form or procedure) was picked from a multi-item document — build ONLY that one.
  const selection = (opts.selection && opts.selection.title) ? opts.selection
    : (recordOpts.formSelection && recordOpts.formSelection.title) ? recordOpts.formSelection : null;
  const formSel = (type === 'record-form') ? selection : null;
  // Several forms chosen to COMBINE into one record form.
  const formCombine = (type === 'record-form' && Array.isArray(opts.selections) && opts.selections.length > 1)
    ? opts.selections.filter(s => s && s.title) : null;
  const RECORD_CAP = type === 'record-form'
    ? ((formCombine
        ? `\n\n━━━ COMBINE SEVERAL FORMS INTO ONE RECORD FORM ━━━\nThe uploaded document contains MULTIPLE forms. Build ONE combined record form that COMBINES these forms, in this order:\n${formCombine.map((s, i) => `${i + 1}. "${s.title}"${s.description ? ` — ${s.description}` : ''}`).join('\n')}\nReproduce EACH selected form faithfully as its own part: start each with a "section" heading named after that form's title, then every fillable field of that form (as the matching field "type"). Keep each form's own fields together, in the order above. Do NOT merge different forms' fields together, and IGNORE any forms in the document that are not in the list. Give the combined form a sensible "name" (e.g. the common subject + "Combined Record Form").\n━━━ END ━━━`
        : formSel
        ? `\n\n━━━ BUILD ONE SPECIFIC FORM FROM THE UPLOADED DOCUMENT ━━━\nThe uploaded document contains MULTIPLE forms. Build ONLY the form titled: "${formSel.title}"${formSel.description ? ` (${formSel.description})` : ''}.\nReproduce THAT form exactly — its title, its section order, and every fillable field it contains (as the matching field "type"). IGNORE all other forms in the document; do NOT merge fields from the other forms. Name the output ("name") after this form's title.\n━━━ END ━━━`
        : '')
      + ((recordOpts.copyLayout || formSel || formCombine) && hasSource
        ? `\n\n━━━ COPY THE UPLOADED LAYOUT ━━━\nBase this record form on the attached/uploaded document: mirror its section order, its field/label names and its overall structure. Reproduce every fillable field it contains (as the matching field "type": text, textarea, checkbox, yesno, competency, rating, date, number, signature, or a "section" heading). Do not impose a different template — follow the source's layout.\n━━━ END ━━━`
        : '')
      + (recordOpts.removeTraining
        ? `\n\n━━━ GENERAL RECORD — NOT TRAINING MATERIAL ━━━\nThis is a GENERAL record form, NOT a training/competency record. STRICTLY EXCLUDE every training-related field, label and section. In particular, DO NOT include any field whose label mentions or implies: Trainer, Assessor, Instructor, Facilitator, Coach, Supervisor-as-trainer; Trainer Name, Trainer Signature, Assessor Name/Signature; Competency, Competent / Not Yet Competent, Unit of Competency, Course, Module, Lesson, Assessment, Exam, Score, Pass/Fail, Training completion, Deemed Competent, Attendance for training, Re-training, CPD. Do NOT add a "Trainer sign-off" or "Assessor sign-off" row.\nA single GENERAL authorising signature line is acceptable (label it "Authorised By" or "Supervisor" or "Signature" — never "Trainer" or "Assessor"). Include ONLY general record-keeping fields relevant to the form's purpose: identification, dates, details, readings/values, checks (Yes/No), responsible person, comments, and that one general authorising signature. If the uploaded source or topic is training-related, convert it to its non-training equivalent rather than copying the training fields.\n━━━ END ━━━`
        : ''))
    : '';
  const _adaptLang = !!(learningProfile || techDepth); // the user set a reading level and/or technical depth
  const manualDirective = (type === 'training-manual' && hasSource)
    ? `\n\n━━━ TRAINING MANUAL — ANALYSE & REBUILD THE UPLOADED DOCUMENT ━━━\nThe attached document is the MASTER SOURCE. First ANALYSE its content, then rebuild this Training Manual from it:\n`
      + `1. STRUCTURE & CONTEXT: KEEP the source's sections, their order, heading text, numbering, tables and overall layout EXACTLY, and KEEP the meaning/context of every section and page. Do NOT reorder, merge, drop, add or summarise sections. The generic template below is only for JSON field shapes — take the real STRUCTURE from the source.\n`
      + (hasUpdate
          ? `2. CONTENT — COMBINE BOTH DOCUMENTS: Document 1 and Document 2 are BOTH source material. ANALYSE BOTH and COMBINE their information into one comprehensive manual — see COMBINE MODE below. Use Document 1's structure/order as the organising framework, and MERGE in the information from Document 2 throughout. For each topic bring together what BOTH documents say — every specification, value, measurement, numbered step, warning, definition and note from each. Where both cover the same thing, reconcile into ONE complete, non-duplicated treatment; where each has unique information, include it. ADD sections for topics only Document 2 covers. Reproduce the tables from BOTH documents as "table" objects (headers + rows) so tabular data stays in clean tables, never flattened into prose. Do NOT ignore either document — the manual must reflect the combined content of both.\n`
          : _adaptLang
            ? `2. CONTENT — ADAPT THE LANGUAGE ONLY: Reproduce the FULL content of every section, but REWRITE the wording to the SELECTED reading/literacy level and technical depth (see the ADAPT instructions below). Keep every fact, instruction, numbered step, value, limit, definition and requirement — change ONLY the sentence complexity, vocabulary and the amount of jargon, never the meaning, the detail, the structure, or any safety/competency content. A lower reading level means simpler words and shorter sentences, NOT less information. Reproduce source tables as "table" objects (you may simplify the WORDING inside cells to the level, but keep all rows, columns and values).\n`
            : `2. CONTENT: Copy ALL content from the source into the matching sections — every paragraph, list, numbered step, table and definition, verbatim. Do not shorten or paraphrase away detail. Reproduce source tables as "table" objects.\n`)
      + `3. SAFETY CALLOUTS: The source uses DANGER, CAUTION, NOTE and ACTIVITY prompts. Capture EVERY one at the exact point it appears, as an inline marker on its own line inside "body": [!DANGER: <text>], [!CAUTION: <text>], [!NOTE: <text>], [!ACTIVITY: <text>]. Omit none; keep the exact meaning and any values${_adaptLang ? ' — you may simplify only the wording to the selected level' : ' — do not change the wording'}.\n`
      + (nSrcImgs
          ? `4. PICTURES: ${nSrcImgs} picture(s) were extracted from the source, numbered 1..${nSrcImgs} in order of appearance. Place a marker [IMG:1], [IMG:2] … on its own line inside "body" at the exact position each corresponding picture appears in the source, in that order. Use each number once.\n`
          : `4. PICTURES: Where the source shows a figure/photo/diagram, note its position with a marker [IMG:1], [IMG:2] … (numbered in order of appearance) on its own line inside "body" at the exact spot it appears.\n`)
      + `5. KNOWLEDGE BASE — ADD AS REFERENCE: Incorporate the selected Knowledge Base article(s) as REFERENCE information: add a clearly-labelled reference/background subsection within the most relevant section (or a short "Reference Information" section) so the KB material genuinely appears in the manual, AND weave the KB's specific site values, policies and procedures into the sections they apply to. Use the KB's exact site-specific values and terminology faithfully; do not invent values the KB defines. ${_adaptLang ? 'Write this KB reference content at the SAME selected reading/literacy level and technical depth as the rest of the manual.' : ''} This is in addition to the source content, not a replacement for it.\n━━━ END ━━━`
    : '';
  // COMBINE MODE — two documents are MERGED: the AI analyses BOTH and combines their information into
  // one document (Document 1 gives a sensible structure). Applies to ANY build type. Placed last so it
  // governs how the two sources are used.
  const updateDirective = hasUpdate
    ? `\n\n━━━ COMBINE TWO DOCUMENTS — MERGE THEIR INFORMATION ━━━\nYou are building ONE document by COMBINING the information from TWO uploaded documents. Treat BOTH as source material to ANALYSE and MERGE — NOT one overriding the other:\n`
      + `• DOCUMENT 1 (the reference source above) provides a sensible LAYOUT and STRUCTURE to organise the result, plus its own information.\n`
      + `• DOCUMENT 2 provides further / complementary information. COMBINE it with Document 1 across the WHOLE document.\n`
      + `• ANALYSE both documents and MERGE their content topic by topic: for each section bring together everything BOTH documents say on that topic — specifications, values, procedures, part/component names, warnings and figures. Include the unique information from EACH; do not drop content from either, and never produce a document that ignores one of them.\n`
      + `• WHERE THEY OVERLAP: reconcile into ONE clear, complete, non-duplicated treatment — merge the two into a single coherent passage rather than repeating the same point twice. If they genuinely CONFLICT on the SAME current fact (e.g. one equipment's spec value), prefer the more recent / more specific document and state one clean result — never print two contradictory values side by side as if both are current.\n`
      + `• TABLES — KEEP TABULAR DATA IN TABLES: Reproduce the tables from BOTH documents as structured "table" objects — a "headers" array plus one row per record in "rows" — so the finished document is clean and readable. NEVER flatten a table into a paragraph or a run-on list. When both documents tabulate the same thing, MERGE them into one combined table.\n`
      + `• ADD sections for topics only ONE document covers, and organise everything coherently.\n`
      + `• FIGURES: pictures from BOTH documents may be placed at the [IMG:n] positions where they best fit the merged content.\n`
      + `• Use the Knowledge Base for site-specific facts as instructed above.\n━━━ END COMBINE ━━━`
    : '';
  // Build ONE specific procedure/item from a multi-item source (section-based types, e.g. SOP / SWP).
  // record-form handles its own selection via RECORD_CAP above, so this covers the other types.
  const SELECTION_CAP = (selection && sectionBased && type !== 'record-form' && hasSource)
    ? `\n\n━━━ BUILD ONE SPECIFIC PROCEDURE FROM THE UPLOADED DOCUMENT ━━━\nThe uploaded document contains or lists MULTIPLE procedures. Build ONLY the procedure titled: "${selection.title}"${selection.description ? ` (${selection.description})` : ''}.\nReproduce THAT procedure from the source: its exact task name/title, its purpose and scope, and its full sequence of steps, with every safety requirement, warning, PPE, isolation/permit and tool it specifies. Follow the source's step order and detail — do not summarise it away. IGNORE the other procedures in the document; do NOT merge steps from them. Name the document ("title") after this procedure. If the source only NAMES this procedure without full steps, develop the complete procedure for that task using the Knowledge Base and sound practice.\n━━━ END ━━━`
    : '';
  const textPart = `${taskPrefix}${textCtx}${blockCtx}${refDocsCtx}${updateTextCtx}${updateBlockCtx}${kbCtx}${companyCtx}${glossaryRef}${manualDirective}${updateDirective}${langGuard}\n\n${PROMPTS[type]}${FLOWCHART_CAP}${RISK_CAP}${LEARNING_CAP}${ASSESSMENT_CAP}${SOURCE_IMG_CAP}${IMG_SUGGEST_CAP}${TBT_BREVITY_CAP}${RECORD_CAP}${SELECTION_CAP}${MAPPING_CAP}`;
  // Source attachments: a single block (pdf/image) and/or several blocks (e.g. images
  // pulled from a DOCX) so the model can SEE diagrams/flowcharts in the uploaded document.
  // Includes Document 2's attachment/images when an update source is supplied.
  const srcBlocks = [
    ...(opts.sourceBlock ? [opts.sourceBlock] : []), ...(Array.isArray(opts.sourceBlocks) ? opts.sourceBlocks : []),
    ...(opts.updateBlock ? [opts.updateBlock] : []), ...(Array.isArray(opts.updateBlocks) ? opts.updateBlocks : []),
  ];
  const content = srcBlocks.length ? [...srcBlocks, { type: 'text', text: textPart }] : textPart;
  // Kick off the flowchart vision pass CONCURRENTLY with the main generation (both read the same source
  // blocks and are independent), so it overlaps the long main write instead of adding to the total time.
  const fcPromise = (sectionBased && srcBlocks.length)
    ? extractFlowchartFromSource(srcBlocks).catch(() => null)
    : Promise.resolve(null);
  // Also read any PROCESS / DECISION flowchart (boxes + diamonds + branches, e.g. an MOC workflow)
  // as the richer node-tree flow model, concurrently with the main write.
  const pfPromise = (sectionBased && srcBlocks.length)
    ? extractProcessFlow(srcBlocks).catch(() => null)
    : Promise.resolve(null);
  const msg = await aiGateway.complete({
    provider: 'anthropic',
    agent: 'AI-DOC-001',
    operation: 'generate_content',
    model: 'claude-sonnet-4-6',
    max_tokens: 64000, // model max — fits even a very large multi-section SOP/standard in one pass (~20 min of
                       // streaming). If a document still overflows this, _salvageTruncatedSections recovers it.
    system: sys,
    messages: [{ role: 'user', content }]
  });
  const raw = (msg.content.find(b => b.type === 'text') || {}).text || '';
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    try { data = JSON.parse(repairJson(cleaned)); } catch {}
    if (!data) {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { data = JSON.parse(repairJson(m[0])); } catch {} }
    }
    // Very large document hit the token cap and truncated mid-JSON — salvage the completed sections.
    if (!data) data = _salvageTruncatedSections(cleaned);
    if (!data) throw new Error('The AI returned an unexpected format. Try refining your prompt.');
  }

  // Guarantee the source flowchart is captured: the focused vision passes (kicked off above, in
  // parallel) read the diagram — inject it as a section if the main generation didn't already include
  // one. A PROCESS / DECISION flowchart (boxes + diamonds + branches) is recreated as the node-tree
  // flow model; a simple linear progression falls back to the staged pathway.
  if (Array.isArray(data.sections)) {
    let flowInjected = false;
    try {
      const pf = await pfPromise;
      const hasDecision = (list) => Array.isArray(list) && list.some(n => n && (n.type === 'decision' || hasDecision(n.branch)));
      const alreadyFlows = data.sections.some(s => Array.isArray(s.flows) && s.flows.length);
      if (pf && pf.nodes.length && (hasDecision(pf.nodes) || pf.nodes.length >= 3) && !alreadyFlows) {
        const uid = 'pf' + Math.random().toString(36).slice(2, 8);
        const flow = { uid, title: pf.title || 'Process Flowchart', mode: 'flow', nodes: pf.nodes };
        const sec = { heading: pf.title || 'Process Flowchart', level: 1, flows: [flow],
          body: `The process flow below is reproduced from the source document.\n\n[FLOW:${uid}]` };
        data.sections.splice(Math.min(1, data.sections.length), 0, sec);
        flowInjected = true;
      }
    } catch { /* non-fatal — keep the generated document */ }
    try {
      const fc = await fcPromise;
      if (fc && !flowInjected && !data.sections.some(s => s && s.flowchart)) {
        const sec = { heading: fc.title || 'Training Flowchart', level: 1, landscape: true, flowchart: fc,
          body: 'The staged training pathway below is reproduced from the source document.' };
        data.sections.splice(Math.min(1, data.sections.length), 0, sec);
      }
    } catch { /* non-fatal — keep the generated document */ }
  }

  // Source pictures: the model emitted [IMG:1], [IMG:2] … markers at each picture's position. Embed the
  // matching extracted picture where we have it; otherwise leave a VISIBLE placeholder so the position is
  // clear and the user can drop the picture in (in the Content Studio editor) at exactly that spot.
  if (Array.isArray(data.sections) && (data.sections.some(s => s && typeof s.body === 'string' && /\[IMG:\d+\]/.test(s.body)))) {
    const imgs = Array.isArray(opts.sourceImages) ? opts.sourceImages : [];
    for (const sec of data.sections) {
      if (!sec || typeof sec.body !== 'string' || !/\[IMG:\d+\]/.test(sec.body)) continue;
      const usedIdx = [];
      sec.body = sec.body.replace(/\[IMG:(\d+)\]/g, (mm, num) => {
        const idx = parseInt(num, 10) - 1;
        const im = imgs[idx];
        if (im) { if (!usedIdx.includes(idx)) usedIdx.push(idx); return `[IMG:src${idx + 1}]`; }
        return `[ Picture ${num} — from source document; add the image here ]`; // visible position marker
      });
      if (usedIdx.length) {
        sec.images = Array.isArray(sec.images) ? sec.images : [];
        for (const idx of usedIdx) {
          const im = imgs[idx];
          sec.images.push({
            uid: 'src' + (idx + 1), base64: im.data, mimeType: im.mimeType,
            width: im.width || 0, height: im.height || 0,
            layout: { docWidth: 4.5, wrapping: 'topBottom', hAlign: 'center' }
          });
        }
      }
    }
  }
  // Record the audience dials used, so they persist with the document and can drive
  // derived-version generation later. Non-destructive: only set when chosen.
  if ((learningProfile || techDepth) && data && typeof data === 'object') {
    data.meta = data.meta || {};
    if (learningProfile) data.meta.learningProfile = learningProfile;
    if (techDepth) data.meta.techDepth = techDepth;
  }
  // Record-form options persist with the generated data so the saver can emit a proper Word
  // document (with the colour risk matrix, and without Form-Builder training scaffolding) rather
  // than routing a non-training record through the Form Builder.
  if (type === 'record-form' && data && typeof data === 'object') {
    if (recordOpts.addRiskMatrix) data.includeRiskMatrix = true;
    if (recordOpts.removeTraining) data.removedTraining = true;
    if (recordOpts.copyLayout) data.copiedLayout = true;
  }
  // Document control (ANY build type): the end user chose to include version-control / document-control
  // functions. Form-like output (fields) gets them as a Document Control field block; section-based
  // documents get a Document Control table + optional Revision History (version log) section. (Documents
  // also carry the standard control/metadata page from buildDocx; this adds the explicitly chosen items.)
  const dcSpec = (opts.docControl != null) ? opts.docControl
    : (type === 'record-form' && recordOpts.docControl != null) ? recordOpts.docControl : null;
  if (dcSpec && data && typeof data === 'object') {
    if (Array.isArray(data.fields)) {
      const dc = buildDocControlFields(dcSpec);
      const hasDC = data.fields.some(f => f && f.type === 'section' && /document control/i.test(f.label || ''));
      if (dc.length && !hasDC) { data.fields = [...dc, ...data.fields]; data.hasDocControl = true; }
    } else if (Array.isArray(data.sections)) {
      const dcs = buildDocControlSection(dcSpec);
      const hasDC = data.sections.some(s => s && /^document control$/i.test(String(s.heading || '').trim()));
      if (dcs.length && !hasDC) { data.sections = [...dcs, ...data.sections]; data.hasDocControl = true; }
    }
  }
  return data;
}

// Resolve which document-control functions are selected. `spec` is `true` (all defaults), an object
// of {key:bool}, or an array of selected keys. Returns a {key:bool} map.
function _docControlSel(spec) {
  const all = { number: true, version: true, effective: true, review: true, owner: true, approved: true, revhist: false };
  if (spec && typeof spec === 'object' && !Array.isArray(spec)) return { ...all, ...spec };
  if (Array.isArray(spec)) { const s = { number: false, version: false, effective: false, review: false, owner: false, approved: false, revhist: false }; for (const k of spec) if (k in s) s[k] = true; return s; }
  return all;
}
// Standard document-control FIELDS (a section heading + its fields) for a form-like output.
function buildDocControlFields(spec) {
  const sel = _docControlSel(spec);
  const fields = [];
  if (sel.number)    fields.push({ type: 'text', label: 'Document Number' });
  if (sel.version)   fields.push({ type: 'text', label: 'Version / Revision' });
  if (sel.effective) fields.push({ type: 'date', label: 'Effective Date' });
  if (sel.review)    fields.push({ type: 'date', label: 'Next Review Date' });
  if (sel.owner)     fields.push({ type: 'text', label: 'Document Owner' });
  if (sel.approved)  fields.push({ type: 'text', label: 'Approved By' });
  if (sel.revhist)   fields.push({ type: 'textarea', label: 'Revision History (Rev / Date / Description / By)' });
  return fields.length ? [{ type: 'section', label: 'Document Control' }, ...fields] : [];
}
// Standard document-control SECTIONS (a Document Control table + optional Revision History log) for a
// section-based document (buildDocx). Returns an array of section objects ready to prepend.
function buildDocControlSection(spec) {
  const sel = _docControlSel(spec);
  const rows = [];
  if (sel.number)    rows.push(['Document Number', '']);
  if (sel.version)   rows.push(['Version / Revision', '']);
  if (sel.effective) rows.push(['Effective Date', '']);
  if (sel.review)    rows.push(['Next Review Date', '']);
  if (sel.owner)     rows.push(['Document Owner', '']);
  if (sel.approved)  rows.push(['Approved By', '']);
  const out = [];
  if (rows.length) out.push({ heading: 'Document Control', level: 1, table: { headers: ['Item', 'Detail'], rows } });
  if (sel.revhist) out.push({ heading: 'Revision History', level: 1,
    table: { headers: ['Rev', 'Date', 'Description of Change', 'Author'], rows: [['', '', '', ''], ['', '', '', ''], ['', '', '', '']] } });
  return out;
}

// Focused vision pass: read ONLY the flowchart/diagram from the uploaded source and
// return it as a structured flowchart object (or null). More reliable than hoping the
// big content-generation prompt reproduces the diagram on its own.
async function extractFlowchartFromSource(srcBlocks) {
  if (!srcBlocks || !srcBlocks.length) return null;
  const instr = `Examine the attached document image(s)/page(s). If they contain a FLOWCHART, process diagram, training pathway, or staged competency chart, reproduce it EXACTLY.
Read each stage/level box LEFT-TO-RIGHT. Capture each box's heading and its sub-items in order, preserving numbering (1.1, 1.2 …). Put any "Important Notes" / side-note boxes into "notes". Do NOT summarise, merge, or invent stages — mirror exactly what the diagram shows.
Return ONLY JSON (no markdown, no commentary):
{"flowchart": {"title":"<chart title>","stages":[{"title":"<box title e.g. Stage 1 / Level 1>","items":["1.1 ...","1.2 ..."]}],"notes":["..."]}}
If there is NO flowchart or diagram, return exactly {"flowchart": null}.`;
  const msg = await aiGateway.complete({
    provider: 'anthropic',
    agent: 'AI-DOC-001',
    operation: 'extract_flowchart',
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: [...srcBlocks, { type: 'text', text: instr }] }]
  });
  const raw = (msg.content.find(b => b.type === 'text') || {}).text || '';
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  let j;
  try { j = JSON.parse(cleaned); } catch { try { j = JSON.parse((cleaned.match(/\{[\s\S]*\}/) || [''])[0]); } catch { return null; } }
  const fc = j && j.flowchart;
  return (fc && Array.isArray(fc.stages) && fc.stages.length) ? fc : null;
}

// Validate/normalise an AI-extracted decision-flow node tree into the exact schema the Content
// Studio flow renderer (csDfcSvg) uses: { id, type, text, (decision:) mainLabel, branchLabel,
// branchDir, branch[] }. Recurses into decision branches; caps depth and width defensively.
function _normFlowNodes(nodes, ctr, depth) {
  ctr = ctr || { i: 0 }; depth = depth || 0;
  if (!Array.isArray(nodes) || depth > 6) return [];
  const out = [];
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const type = ['start', 'process', 'decision', 'end'].includes(n.type) ? n.type : 'process';
    const text = String(n.text || '').trim().slice(0, 240);
    if (!text) continue;
    const node = { id: 'n' + (++ctr.i), type, text };
    if (type === 'decision') {
      node.mainLabel = String(n.mainLabel || '').trim().slice(0, 36);
      node.branchLabel = String(n.branchLabel || '').trim().slice(0, 36);
      node.branchDir = n.branchDir === 'left' ? 'left' : 'right';
      node.branch = _normFlowNodes(n.branch, ctr, depth + 1);
    }
    out.push(node);
    if (out.length >= 40) break;
  }
  return out;
}

// Focused vision pass: read a PROCESS / DECISION flowchart (boxes + decision diamonds + arrows,
// e.g. an approval or management-of-change workflow) from the uploaded source and return it as the
// node-tree flow model the Studio draws (and rasterises to PNG for Word). Returns null when the
// source has no such flowchart (or only a simple linear left-to-right progression → use stages).
async function extractProcessFlow(srcBlocks) {
  if (!srcBlocks || !srcBlocks.length) return null;
  const instr = `Examine the attached document image(s)/page(s). If they contain a PROCESS FLOWCHART / workflow / decision flow (action boxes, decision DIAMONDS, and arrows — for example an approval workflow or a Management of Change process), reproduce it EXACTLY as a vertical node tree. Read TOP-TO-BOTTOM.
Model it as a main spine of nodes, with side branches at each decision:
• "start" / "end": a terminator (rounded box) — the first/last node of a path, or where a path ends (e.g. "Cancel MOC", "END").
• "process": one action/step box. Keep the box text SHORT — the step title only (include its number if the diagram shows one, e.g. "1. Complete RFC Section").
• "decision": a diamond with TWO outcomes. The outcome that CONTINUES DOWN the main flow is "mainLabel"; the OTHER outcome LEAVES to the side as "branchLabel" with "branchDir" ("right" or "left") and "branch" = the node(s) on that side. If a side outcome just ends (reject/cancel), make its branch a single "end" node. If a side outcome LOOPS BACK to an earlier step, represent it as a "process" node describing it (e.g. "Return to Step 1 for revision") — do not try to draw the loop.
Preserve the exact step wording and the exact decision/branch labels (e.g. "RFC Approved for Impact Assessment", "RFC Rejected", "RFC Returned for Revision"). Do NOT invent steps or summarise them away.
Return ONLY JSON (no markdown, no commentary):
{"flow":{"title":"<chart title>","nodes":[{"type":"start","text":"..."},{"type":"process","text":"1. ..."},{"type":"decision","text":"2. Supervisor Review","mainLabel":"Approved","branchLabel":"Rejected","branchDir":"right","branch":[{"type":"end","text":"RFC Rejected — Cancel MOC"}]}, ... {"type":"end","text":"END"}]}}
If there is NO process/decision flowchart (or only a simple linear left-to-right competency progression), return exactly {"flow": null}.`;
  let msg;
  try {
    msg = await aiGateway.complete({
      provider: 'anthropic',
      agent: 'AI-DOC-001',
      operation: 'extract_process_flow',
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{ role: 'user', content: [...srcBlocks, { type: 'text', text: instr }] }]
    });
  } catch { return null; }
  const raw = (msg.content.find(b => b.type === 'text') || {}).text || '';
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  let j;
  try { j = JSON.parse(cleaned); } catch { try { j = JSON.parse((cleaned.match(/\{[\s\S]*\}/) || [''])[0]); } catch { return null; } }
  const fl = j && j.flow;
  if (!fl || !Array.isArray(fl.nodes)) return null;
  const nodes = _normFlowNodes(fl.nodes, { i: 0 }, 0);
  if (!nodes.length) return null;
  return { title: String(fl.title || '').trim().slice(0, 120), nodes };
}

// Scan an uploaded document for the DISTINCT items it contains/lists, so the user can pick which one
// to build. `src.kind` = 'form' (fillable forms — e.g. an MOC pack with a Request Form, Risk
// Assessment Form and Close-Out Form) or 'procedure' (operational/maintenance tasks that each become
// their own SOP/SWP — e.g. a standard that lists several procedures). Returns an array of
// { title, description } (empty if the document is a single item or none). `src` = { text?, blocks? }
// (blocks for a PDF/image so the model can SEE items it can't read as text).
async function detectForms(src = {}) {
  const kind = src.kind === 'procedure' ? 'procedure' : 'form';
  const text = (src.text || '').slice(0, 60000);
  const blocks = Array.isArray(src.blocks) ? src.blocks : [];
  if (!text.trim() && !blocks.length) return [];
  const cfg = kind === 'procedure'
    ? { noun: 'PROCEDURE', key: 'procedures', op: 'detect_procedures',
        what: `a discrete operational or maintenance TASK that should become its own Standard Operating Procedure (SOP) or Safe Work Procedure (SWP) — it has a clear task name and its own sequence of steps (e.g. "Isolate and lock out the conveyor", "Change a haul truck tyre", "Start up the crusher plant"). A whole manual, a policy, a form, or a reference table is NOT itself a procedure, but it may LIST or CONTAIN several procedures (e.g. in a contents list, a standard, or a task register).` }
    : { noun: 'FILLABLE FORM', key: 'forms', op: 'detect_forms',
        what: `a self-contained template someone fills in — it has a title and its own set of fields/sections (e.g. "MOC Request Form", "Risk Assessment Form", "Close-Out / Verification Form", "Inspection Checklist"). A register/log table, a policy, a procedure narrative, or a matrix is NOT a form.` };
  const instr = `You are analysing an uploaded document to find every DISTINCT ${cfg.noun} it contains or lists.
A "${kind}" is ${cfg.what}
List ONLY genuinely separate ${kind}s. If the document is really one single ${kind}, return just that one. If it contains none, return an empty list.
Return ONLY JSON (no markdown, no commentary):
{"${cfg.key}":[{"title":"<the ${kind}'s exact name/title as it appears>","description":"<one short line: its purpose / scope>"}]}
${text.trim() ? `\n\nDOCUMENT TEXT:\n${text}` : ''}`;
  const content = blocks.length ? [...blocks, { type: 'text', text: instr }] : instr;
  let msg;
  try {
    msg = await aiGateway.complete({
      provider: 'anthropic',
      agent: 'AI-DOC-001',
      operation: cfg.op,
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content }]
    });
  } catch { return []; }
  const raw = (msg.content.find(b => b.type === 'text') || {}).text || '';
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  let j;
  try { j = JSON.parse(cleaned); } catch { try { j = JSON.parse((cleaned.match(/\{[\s\S]*\}/) || [''])[0]); } catch { return []; } }
  // Accept the kind-specific key, or any of the common keys, as the list.
  const items = (j && (Array.isArray(j[cfg.key]) ? j[cfg.key]
    : Array.isArray(j.forms) ? j.forms : Array.isArray(j.procedures) ? j.procedures : Array.isArray(j.items) ? j.items : [])) || [];
  // Normalise + de-dupe by title; cap to a sane number.
  const seen = new Set();
  const out = [];
  for (const f of items) {
    const title = String((f && f.title) || '').trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, description: String((f && f.description) || '').trim() });
    if (out.length >= 30) break;
  }
  return out;
}

// ── Savers ────────────────────────────────────────────────────────────────────
async function saveExam(d, user) {
  const t = await dbRun(`INSERT INTO tblTest (TestName,PassScore,TimeLimit,Instructions,Randomize,ShowAnswers) VALUES (?,?,?,?,1,1)`,
    [d.testName || 'AI-generated exam', d.passScore || 80, d.timeLimit || null, d.instructions || null]);
  const letters = ['A','B','C','D','E','F','G','H'];
  let order = 0;
  for (const q of (d.questions || [])) {
    const type = /multi/.test(q.type) ? 'multi' : /true/.test(q.type) ? 'truefalse' : 'single';
    const opts = type === 'truefalse'
      ? [{ text: 'True', correct: !!(q.options || []).find(o => /true/i.test(o.text) && o.correct) }, { text: 'False', correct: !((q.options || []).find(o => /true/i.test(o.text) && o.correct)) }]
      : (q.options || []);
    const r = await dbRun(`INSERT INTO tblQ (TestID,Question,QuestionType,Mandatory,"Order",NumAns) VALUES (?,?,?,0,?,?)`,
      [t.lastID, q.question || '', type, ++order, opts.length]);
    for (let i = 0; i < opts.length; i++) {
      await dbRun(`INSERT INTO tblQA (QID,Answer,Points,IsCorrect,AnswerLetter) VALUES (?,?,?,?,?)`,
        [r.lastID, opts[i].text || '', opts[i].correct ? 1 : 0, opts[i].correct ? 1 : 0, letters[i]]);
    }
  }
  return { id: t.lastID, name: d.testName || 'AI-generated exam', page: 'exam-builder' };
}

// formCategory: 'assessment' (competency assessment — shows Trainee/Trainer + signatures in the Field
// Assessment view), 'template-form' (a general record/template form — no training scaffolding), or 'hr'.
async function saveForm(d, user, formCategory = 'assessment') {
  const cat = ['assessment', 'template-form', 'hr'].includes(formCategory) ? formCategory : 'assessment';
  const t = await dbRun(`INSERT INTO tblFormTemplate (Name,Description,PassMark,Status,CreatedBy,FormCategory) VALUES (?,?,?,'Active',?,?)`,
    [d.name || 'AI-generated form', d.description || 'Generated by AI Content Studio', d.passMark || 0, user, cat]);
  let order = 0;
  const VALID = ['section','text','textarea','checkbox','competency','yesno','rating','signature','date','number','select','radio'];
  for (const f of (d.fields || [])) {
    const type = VALID.includes(f.type) ? f.type : 'text';
    await dbRun(`INSERT INTO tblFormField (TemplateID,OrderNum,FieldType,Label,Options,Required,Points,HelpText) VALUES (?,?,?,?,?,0,?,?)`,
      [t.lastID, order++, type, f.label || '', f.options ? JSON.stringify(f.options) : null, f.points || 0, f.help || null]);
  }
  return { id: t.lastID, name: d.name || 'AI-generated form', page: 'forms' };
}

// Master → derived adaptation. Rewrites ONLY prose (heading / body / callout) to a target
// audience (Learning Profile × Technical Depth), leaving tables, numbers, checklists, images,
// flows and risk data completely untouched — the strongest possible guarantee that no value or
// safety-critical fact is altered. Returns a deep copy of `data` with adapted prose + stamped meta.
async function adaptDocument(data, learningProfile, techDepth) {
  const p = LEARNING_PROFILES[learningProfile];
  const d = TECH_DEPTHS[techDepth];
  if (!p && !d) return data; // nothing to do
  const clone = JSON.parse(JSON.stringify(data || {}));
  const secs = Array.isArray(clone.sections) ? clone.sections : [];
  // Slim payload: only the prose fields, indexed, so the model can't touch structure/values.
  const payload = secs.map((s, i) => ({ i, heading: s.heading || '', body: s.body || '', callout: s.callout || '' }));
  if (!payload.length) return clone;
  const guide = (p ? `READING / LITERACY LEVEL — ${p.label}: ${p.guidance}\n` : '')
              + (d ? `TECHNICAL DEPTH — ${d.label}: ${d.guidance}\n` : '');
  const sys = `You adapt existing training-document prose for a specific audience. You are given a JSON array of {i, heading, body, callout}. Rewrite ONLY the wording to match the audience below, and return a JSON array of the SAME length with the SAME "i" values and the same keys.\n\n${guide}\n`
    + `ABSOLUTE RULES: (1) Return ONLY valid JSON — no markdown, no commentary. (2) Keep the exact same number of items and the same "i" index on each. (3) Preserve EVERY number, unit, measurement, limit, tolerance, model/part number, PPE item, isolation step, emergency action and legislative reference EXACTLY — you may change surrounding words but never a value or its meaning. (4) Preserve any inline markers verbatim: [IMG:...], [FLOW:...], [!DANGER: ...], [!CAUTION: ...], [!NOTE: ...], [!ACTIVITY: ...], and \\n newlines. (5) Do not add, drop, merge or reorder items. (6) Keep headings meaning the same. Only the LANGUAGE changes; the meaning never does.`;
  const msg = await aiGateway.complete({
    provider: 'anthropic', agent: 'AI-DOC-001', operation: 'adapt_document',
    model: 'claude-sonnet-4-6', max_tokens: Math.min(64000, Math.max(8000, (JSON.stringify(payload).length / 2) | 0)),
    system: sys,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  });
  const raw = ((msg.content.find(b => b.type === 'text') || {}).text || '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let adapted;
  try { adapted = JSON.parse(raw); }
  catch { try { adapted = JSON.parse(repairJson(raw)); } catch { const m = raw.match(/\[[\s\S]*\]/); adapted = m ? JSON.parse(repairJson(m[0])) : null; } }
  if (Array.isArray(adapted)) {
    const byIdx = new Map(adapted.filter(a => a && typeof a.i === 'number').map(a => [a.i, a]));
    secs.forEach((s, i) => {
      const a = byIdx.get(i);
      if (!a) return; // leave prose unchanged if the model dropped this index
      if (typeof a.heading === 'string' && s.heading) s.heading = a.heading;
      if (typeof a.body === 'string') s.body = a.body;
      if (typeof a.callout === 'string' && s.callout) s.callout = a.callout;
    });
  }
  clone.meta = clone.meta || {};
  if (learningProfile) clone.meta.learningProfile = learningProfile;
  if (techDepth) clone.meta.techDepth = techDepth;
  return clone;
}

async function translateSection(sectionData, targetLang, glossary = [], kbContext = '', opts = {}) {
  // Approved terminology glossary — force the model to use the organisation's exact terms
  const glossaryBlock = (Array.isArray(glossary) && glossary.length)
    ? ` (5) TERMINOLOGY GLOSSARY — you MUST use these EXACT approved ${targetLang} translations wherever the source term appears (match case-insensitively; keep the surrounding grammar natural). Do not substitute synonyms:\n`
      + glossary.slice(0, 300).map(g => `• "${g.SourceTerm}" => "${g.TargetTerm}"`).join('\n')
    : '';
  // Knowledge Base reference — use site-specific facts/approved names where relevant to the topic
  const kbBlock = (kbContext && kbContext.trim())
    ? ` (6) SITE REFERENCE (Knowledge Base) — use the following organisation facts for correct site-specific names and ${targetLang} terminology where relevant to the content (e.g. official department names, approved local-language terms). Do NOT inject unrelated facts:\n${String(kbContext).slice(0, 8000)}`
    : '';
  const msg = await aiGateway.complete({
    provider: 'anthropic',
    agent: 'AI-DOC-001',
    operation: 'translate_section',
    model: 'claude-sonnet-4-6',
    // Default 32k; a retry can request the model's full 64k so a large section can't truncate to invalid JSON.
    max_tokens: Math.min(64000, Math.max(8000, opts.maxTokens || 32000)),
    system: `You are a professional translator. Translate ALL string values in the JSON to ${targetLang}. RULES: (1) Return ONLY valid JSON — no preamble, no markdown fences, no commentary. (2) Identical structure — same keys, same nesting, same arrays. (3) Preserve \\n newlines inside strings exactly. (4) null stays null.${glossaryBlock}${kbBlock}`,
    messages: [
      { role: 'user', content: JSON.stringify(sectionData) }
    ]
  });
  const raw = (msg.content[0].text || '').trim()
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(raw);
  } catch {
    try { return JSON.parse(repairJson(raw)); } catch {}
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(repairJson(m[0])); } catch {} }
    // WP-08 L4 — structured, metadata-only (raw AI output content is never logged).
    try { require('./logger').error('TRANSLATION_ERROR', { message: 'Translation failed', operation: 'content-translate', stopReason: msg.stop_reason || null, responseLength: raw.length }); } catch {}
    throw new Error('Translator returned an unexpected format. Try again.');
  }
}

// AI ASSIST for a single section/page: fill blank table cells and write additional body
// content. Existing content is never overwritten — only blanks and genuine gaps are filled.
// Optionally examines an attached IMAGE and/or REFERENCE FILE and MATCHES information between
// them (e.g. numbered items on a dashboard image ↔ their names listed in the file), guided by
// the user's own instruction. Returns { table, bodyAddition }.
async function assistSection(sectionData, opts = {}) {
  const sd = sectionData || {};
  const kb = (opts.kbContext && opts.kbContext.trim())
    ? `\n\nSITE REFERENCE (Knowledge Base) — use these organisation facts/values where relevant to fill cells or content:\n${String(opts.kbContext).slice(0, 8000)}`
    : '';
  const hasTable = !!(sd.table && Array.isArray(sd.table.headers) && sd.table.headers.length);
  const tableJson = hasTable ? JSON.stringify(sd.table) : 'null';

  // Attachments: an image to analyse and/or a reference file (as extracted text or a block).
  const blocks = [];
  if (opts.imageBlock) blocks.push(opts.imageBlock);
  if (opts.refBlock) blocks.push(opts.refBlock);
  const refTextCtx = (opts.refText && opts.refText.trim())
    ? `\n\nREFERENCE FILE (extracted text):\n"""${String(opts.refText).slice(0, 20000)}"""`
    : '';
  const haveImg = !!opts.imageBlock, haveRef = !!(opts.refBlock || (opts.refText && opts.refText.trim()));
  const attachNote = (haveImg || haveRef)
    ? `\n\nATTACHMENTS: ${[haveImg ? 'an IMAGE to analyse' : '', haveRef ? 'a REFERENCE FILE' : ''].filter(Boolean).join(' and ')} ${haveImg && haveRef ? 'are' : 'is'} attached. Examine ${haveImg && haveRef ? 'them' : 'it'} carefully. The user may want you to MATCH information across them — for example, the image shows NUMBERED items (such as a dashboard/instrument panel with numbered indicators or a diagram with numbered callouts), and the reference file LISTS what each number/item is called or does. Work out the correct correspondence (number ↔ name/description) and use it to fill the table or write the content. Be precise about which number maps to which item.`
    : '';
  const userInstr = (opts.userPrompt && opts.userPrompt.trim())
    ? `\n\nUSER INSTRUCTION (follow this precisely — it takes priority):\n"""${String(opts.userPrompt).slice(0, 3000)}"""`
    : '';

  // Mode + row scope for table editing.
  const tr = Array.isArray(opts.targetRows) ? opts.targetRows.filter(n => Number.isInteger(n)) : [];
  const modeUpdate = opts.updateMode === 'update';
  const modeInstr = modeUpdate
    ? `MODE = UPDATE: For rows IN SCOPE, correct and update the cell values with the best, newest, most accurate information — you MAY overwrite existing text where it is wrong, outdated or incomplete. For rows NOT in scope, leave every cell exactly as-is.`
    : `MODE = FILL BLANKS: Only fill cells that are currently blank (""). NEVER change a cell that already has text.`;
  const scopeInstr = tr.length
    ? `ROW SCOPE: only these 0-based row indices are in scope: [${tr.join(', ')}]. Leave all other existing rows exactly as-is.`
    : `ROW SCOPE: all rows are in scope.`;

  const textPart =
    `DOCUMENT: ${opts.docTitle || '(untitled)'}\nSECTION HEADING: ${sd.heading || '(none)'}\n` +
    `CURRENT BODY:\n"""${String(sd.body || '').slice(0, 6000)}"""\n\n` +
    `CURRENT TABLE (JSON — rows are 0-indexed; blank cells are ""):\n${tableJson}${kb}${refTextCtx}${attachNote}${userInstr}\n\n` +
    `Complete this section:\n` +
    `1. TABLE (if present): ${modeInstr} ${scopeInstr}\n` +
    `   Identify each row by its IDENTIFICATION column — the first column naming the component / item / step / number. Use that identity + the MEANING of each column header (e.g. Location, Function, Operation, Purpose, Specification, Name) + the ATTACHMENTS + the user instruction to determine each value. For a value you cannot determine, give an accurate DESCRIPTION rather than inventing a false specific.\n` +
    `   ADD ROWS: If the attachments or instruction reveal MORE items than there are rows (e.g. the image/file lists additional items), ADD new rows at the END and fill their cells. NEVER delete or reorder existing rows. Keep the EXACT same headers and the SAME number of columns.\n` +
    `2. ADDITIONAL CONTENT: If the body is thin or the user asked for content, write concise, accurate paragraph(s) (plain text; "- " for bullets). Do NOT repeat text already present. If nothing is needed, return "".\n` +
    `3. CONVERT THE LAYOUT TO A TABLE (only when the user asks to change the layout, present the content as a table, tabulate it, or use a "table view"): BUILD a clean, well-structured table FROM the section's body content. Choose concise, meaningful column headers that suit the content (for example, for control/console items: "Control", "Location", "Function"; for a procedure: "Step", "Action", "Detail"; for specifications: "Item", "Specification"), and put ONE row per item. Capture ALL the information from the body — do not lose any detail. Return the new table in "table", and set "bodyReplace" to a SHORT one-line intro (or "") so the prose that moved into the table is removed and not duplicated. Keep to a sensible number of columns (2–5).\n\n` +
    `Return ONLY JSON: {"table": <the table — the EXISTING one updated/filled keeping the same headers & row order, OR a NEW table you built when the user asked to convert the layout to a table — or null if no table applies>, "bodyAddition": "<extra content to append to the body, or an empty string>", "bodyReplace": <a string to REPLACE the whole body with (use ONLY when you converted the body into a table — a short intro or ""), or null to leave the body unchanged>}`;

  const content = blocks.length ? [...blocks, { type: 'text', text: textPart }] : textPart;
  const msg = await aiGateway.complete({
    provider: 'anthropic', agent: 'AI-DOC-001', operation: 'assist_section',
    model: 'claude-sonnet-4-6', max_tokens: 8000,
    system: 'You are a senior mining / industrial training technical writer completing a section of a training document. You produce accurate, audit-appropriate content. When an image and reference file are provided you match information across them precisely. Return ONLY valid JSON — no preamble, no markdown, no commentary.',
    messages: [{ role: 'user', content }]
  });
  const raw = ((msg.content.find(b => b.type === 'text') || {}).text || '').trim();
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  let out;
  try { out = JSON.parse(cleaned); }
  catch {
    try { out = JSON.parse(repairJson(cleaned)); } catch {}
    if (!out) { const m = cleaned.match(/\{[\s\S]*\}/); if (m) { try { out = JSON.parse(repairJson(m[0])); } catch {} } }
  }
  if (!out) throw new Error('AI assist returned an unexpected format. Try again.');
  return {
    table: out.table || null,
    bodyAddition: typeof out.bodyAddition === 'string' ? out.bodyAddition : '',
    bodyReplace: typeof out.bodyReplace === 'string' ? out.bodyReplace : null,
  };
}

// AI cover illustration: Claude returns a single self-contained SVG (no image-gen API needed)
async function generateCoverImageSvg(prompt) {
  async function attempt() {
    const msg = await aiGateway.complete({
      provider: 'anthropic',
      agent: 'AI-DOC-001',
      operation: 'generate_cover_svg',
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: 'You are a vector illustrator. You output ONLY one complete, self-contained <svg>…</svg> element — no prose, no markdown, nothing else.',
      messages: [{ role: 'user', content: `Draw a clean, modern FLAT-STYLE vector illustration of: ${prompt}. Context: a mining / industrial training cover page.
Requirements:
- Return ONLY one COMPLETE <svg>…</svg> element (it MUST include the closing </svg> tag). No markdown, no commentary, no <image> tags or external/raster references.
- Keep it reasonably simple so it fits in one response.
- Include viewBox="0 0 800 500" and width="100%" height="100%".
- Palette: mainly navy #1E3A5F and yellow #FBC02D with greys/white; clean bold shapes.
- No text labels. Light or transparent background.` }]
    });
    const t = ((msg.content.find(b => b.type === 'text') || {}).text || '').replace(/```svg|```xml|```/gi, '').trim();
    const m = t.match(/<svg[\s\S]*<\/svg>/i);
    return m ? m[0] : null;
  }
  let svg = await attempt();
  if (!svg) svg = await attempt(); // one retry — the model occasionally adds prose or truncates
  if (!svg) { const e = new Error('The illustration could not be generated. Try a simpler description (e.g. "haul truck" or "excavator").'); e.userError = true; throw e; }
  return svg;
}

// Photorealistic cover image via OpenAI gpt-image-1 (returns a PNG → embeds in print AND .docx)
// WP-10 A6.5 — the OpenAI fetch now lives in the gateway's openai provider adapter.
// This wrapper preserves the (prompt, apiKey) signature and return value exactly;
// endpoint/headers/body/parsing/error/userError behaviour is unchanged.
async function generateCoverImagePhoto(prompt, apiKey) {
  return aiGateway.generateImage({
    provider: 'openai',
    agent: 'AI-DOC-001',
    operation: 'generate_cover_image',
    apiKey,
    prompt,
    model: 'gpt-image-1',
    size: '1536x1024',
    quality: 'medium',
    n: 1,
  });
}

module.exports = { CONTENT_TYPES, SAFETY_PROMPTS_CONTENT, LEARNING_PROFILES, TECH_DEPTHS, ASSESSMENT_STYLE, TEMPLATE_SECTIONS, mapSourceToTemplate, buildLearningCap, buildAssessmentCap, buildMappingCap, buildRecordFormHtml, recordFormToDocx, akaraMatrixHtml, buildExcelForm, buildExamHtml, detectForms, extractProcessFlow, assistSection, adaptDocument, extractDocxText, extractPdfText, extractDocxImages, extractPdfImages, extractPptxText, parseDocxToSections, cloneDocxAsForm, extractDocxFormBody, renderDocxBodyHtml, buildFormDocHtml, aiSmartForm, buildSmartFormHtml, smartFormToDocx, debrandSections, getImageDimensions, generate, saveExam, saveForm, buildDocx, translateSection, generateCoverImageSvg, generateCoverImagePhoto };
