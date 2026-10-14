// Translated-PDF composer: builds a clean, paginated PDF from translated segments
// using an embedded Unicode font (Tahoma — covers Thai and most operational languages).
// Note: this reproduces the document's text content and reading order with clean
// formatting; pixel-faithful cloning of arbitrary source PDFs is not attempted.
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

const FONT_CANDIDATES = [
  'C:/Windows/Fonts/tahoma.ttf',        // Thai + Latin + Cyrillic + Arabic (Windows)
  'C:/Windows/Fonts/leelawui.ttf',      // Leelawadee UI (Thai)
  'C:/Windows/Fonts/arialuni.ttf'
];
function loadFontBytes() {
  for (const p of FONT_CANDIDATES) if (fs.existsSync(p)) return fs.readFileSync(p);
  throw new Error('No Unicode-capable font found on this system (looked for Tahoma / Leelawadee).');
}

// Greedy word-wrap that falls back to character wrapping for scripts without spaces (e.g. Thai).
function wrapText(text, font, size, maxWidth) {
  const lines = [];
  for (const raw of String(text).split('\n')) {
    let line = '';
    const tokens = raw.includes(' ') ? raw.split(' ') : [...raw];
    const joiner = raw.includes(' ') ? ' ' : '';
    for (const tok of tokens) {
      const tryLine = line ? line + joiner + tok : tok;
      let w; try { w = font.widthOfTextAtSize(tryLine, size); } catch { w = tryLine.length * size * 0.55; }
      if (w <= maxWidth || !line) line = tryLine;
      else { lines.push(line); line = tok; }
    }
    lines.push(line);
  }
  return lines;
}

// segments: [{ source, target }] — bilingual=true prints the source line above each translation.
async function buildPdfFromSegments(segments, bilingual, title) {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(loadFontBytes(), { subset: true });

  const A4 = [595.28, 841.89], MARGIN = 50, SIZE = 11, SRC_SIZE = 9, LEAD = 1.45;
  let page = doc.addPage(A4);
  let y = A4[1] - MARGIN;
  const maxW = A4[0] - MARGIN * 2;
  const ensure = (need) => { if (y - need < MARGIN) { page = doc.addPage(A4); y = A4[1] - MARGIN; } };
  const drawLines = (lines, size, color) => {
    for (const ln of lines) {
      ensure(size * LEAD);
      if (ln.trim()) { try { page.drawText(ln, { x: MARGIN, y, size, font, color }); } catch { /* unsupported glyph run */ } }
      y -= size * LEAD;
    }
  };

  if (title) { drawLines(wrapText(title, font, 15, maxW), 15, rgb(0.1, 0.1, 0.15)); y -= 8; }
  for (const s of segments) {
    if (bilingual && s.source) drawLines(wrapText(s.source, font, SRC_SIZE, maxW), SRC_SIZE, rgb(0.45, 0.45, 0.5));
    drawLines(wrapText(s.target || '', font, SIZE, maxW), SIZE, rgb(0, 0, 0));
    y -= 4;
  }
  return Buffer.from(await doc.save());
}

module.exports = { buildPdfFromSegments };
// Additive export for unit testing the pure word-wrap helper (WP-07 C5).
// No runtime behaviour change — same function used internally.
module.exports.wrapText = wrapText;
