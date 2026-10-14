// ─────────────────────────────────────────────────────────────────────────────
// Caption overlay for generated images.
//
// The image model is never asked to draw text. Instead the caption is shaped here
// with fontkit (which applies the font's real GSUB/GPOS layout, so Thai vowels and
// tone marks sit correctly) and converted to SVG *paths*. Because the glyphs become
// paths, rendering does not depend on the system having the font installed — it is
// pixel-identical everywhere. Sharp then composites that SVG onto the artwork.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const fontkit = require('@pdf-lib/fontkit');
const sharp = require('sharp');

const _fontCache = new Map();

// First existing path wins (bundled font → system font fallback).
function loadFont(candidates) {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  for (const p of list) {
    if (!p) continue;
    if (_fontCache.has(p)) return _fontCache.get(p);
    try {
      if (fs.existsSync(p)) {
        const f = fontkit.create(fs.readFileSync(p));
        _fontCache.set(p, f);
        return f;
      }
    } catch { /* try next */ }
  }
  throw new Error('No usable font found. Tried: ' + list.join(', '));
}

const escXml = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Shape one line into SVG glyph paths (font units, y-up) + its natural width.
function shapeLine(font, text) {
  const run = font.layout(String(text == null ? '' : text));
  let pen = 0, d = '';
  const glyphs = run.glyphs || [];
  const positions = run.positions || [];
  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    const pos = positions[i] || { xAdvance: 0, xOffset: 0, yOffset: 0 };
    let svg = '';
    try { svg = (g && g.path && typeof g.path.toSVG === 'function') ? g.path.toSVG() : ''; } catch { svg = ''; }
    if (svg) {
      const dx = pen + (pos.xOffset || 0), dy = (pos.yOffset || 0);
      d += (dx || dy) ? `<path d="${svg}" transform="translate(${dx},${dy})"/>` : `<path d="${svg}"/>`;
    }
    pen += (pos.xAdvance || 0);
  }
  return { glyphSvg: d, widthUnits: pen };
}

/**
 * Build the caption SVG for an image of W×H.
 * caption = { lines:[{text, locale, size, bold}], color, align, lineGap, box:{xPct,yPct,widthPct} }
 * fontsFor(localeCode, bold) must return an array of candidate font paths.
 */
function buildCaptionSvg(W, H, caption, fontsFor) {
  const cap = caption || {};
  const lines = (cap.lines || []).filter(l => l && String(l.text || '').trim());
  if (!lines.length) return null;

  const box = cap.box || {};
  const xPct = box.xPct != null ? box.xPct : 50;
  const yPct = box.yPct != null ? box.yPct : 15;
  const widthPct = box.widthPct != null ? box.widthPct : 80;
  const maxW = W * (widthPct / 100);
  const cx = W * (xPct / 100);
  const gap = cap.lineGap != null ? cap.lineGap : 12;
  const color = cap.color || '#1E3A5F';
  const align = cap.align || 'center';

  // Measure every line, shrinking any that would overflow the caption box.
  const measured = lines.map(l => {
    const font = loadFont(fontsFor(l.locale, l.bold !== false));
    const { glyphSvg, widthUnits } = shapeLine(font, l.text);
    let size = Math.max(8, Number(l.size) || 36);
    const upm = font.unitsPerEm || 1000;
    let scale = size / upm;
    let wPx = widthUnits * scale;
    if (wPx > maxW && wPx > 0) { scale *= maxW / wPx; size = scale * upm; wPx = maxW; }
    const ascent = (font.ascent || upm * 0.8) * scale;
    const descent = Math.abs(font.descent || upm * 0.2) * scale;
    return { glyphSvg, scale, wPx, ascent, descent, lineH: ascent + descent };
  });

  const totalH = measured.reduce((a, m) => a + m.lineH, 0) + gap * (measured.length - 1);
  let y = H * (yPct / 100) - totalH / 2;   // yPct = vertical CENTRE of the caption block

  let body = '';
  for (const m of measured) {
    const baseline = y + m.ascent;
    const x = align === 'left' ? (cx - maxW / 2)
      : align === 'right' ? (cx + maxW / 2 - m.wPx)
        : (cx - m.wPx / 2);
    // scale(s,-s) flips the font's y-up outlines into SVG's y-down space at the baseline.
    body += `<g transform="translate(${x.toFixed(2)},${baseline.toFixed(2)}) scale(${m.scale.toFixed(6)},${(-m.scale).toFixed(6)})">${m.glyphSvg}</g>`;
    y += m.lineH + gap;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<g fill="${escXml(color)}">${body}</g></svg>`;
}

/**
 * Look at the artwork and find the biggest EMPTY rectangle (the inside of the speech
 * bubble, or clear sky), so the caption is never printed over faces, hard hats or
 * equipment. Returns { yPct, topPct, bottomPct, heightPct, xPct, widthPct } or null.
 *
 * A pixel counts as "clear" when it is BRIGHT and NEUTRAL — that is what separates the
 * white bubble interior from tan ground, blue sky or yellow PPE, and it works whatever
 * the page background happens to be. The search is for the tallest run of rows that each
 * contain a wide enough horizontal clear run; the bubble does NOT span the full image
 * width, so testing full-width rows (the old behaviour) found nothing on mine scenes.
 */
async function findClearBand(artworkBuffer, { minRunPct = 38, searchTopPct = 0, searchBottomPct = 62 } = {}) {
  try {
    const SW = 200;                                   // small analysis copy
    const { data, info } = await sharp(artworkBuffer)
      .removeAlpha().resize(SW, null, { fit: 'inside' })
      .raw().toBuffer({ resolveWithObject: true });
    const w = info.width, h = info.height, ch = info.channels || 3;
    const yA = Math.max(0, Math.round(h * searchTopPct / 100));
    const yB = Math.min(h, Math.round(h * searchBottomPct / 100));

    const isClear = (x, y) => {
      const i = (y * w + x) * ch, r = data[i], g = data[i + 1], b = data[i + 2];
      const mn = Math.min(r, g, b), mx = Math.max(r, g, b);
      return mn > 196 && (mx - mn) < 28;              // bright + neutral (white / cream)
    };

    // Widest horizontal clear run in each row.
    const rows = [];
    for (let y = yA; y < yB; y++) {
      let best = { s: 0, len: 0 }, cur = -1;
      for (let x = 0; x <= w; x++) {
        if (x < w && isClear(x, y)) { if (cur < 0) cur = x; }
        else if (cur >= 0) { const len = x - cur; if (len > best.len) best = { s: cur, len }; cur = -1; }
      }
      rows.push(best);
    }

    // Tallest vertical span of rows whose run is wide enough. Relax the width requirement
    // rather than give up, so a narrow bubble still beats "no placement information".
    let span = null, minRun = 0;
    for (const pct of [minRunPct, minRunPct * 0.7, minRunPct * 0.5]) {
      minRun = Math.max(12, Math.round(w * pct / 100));
      let best = { start: -1, len: 0 }, cur = -1;
      for (let i = 0; i <= rows.length; i++) {
        if (i < rows.length && rows[i].len >= minRun) { if (cur < 0) cur = i; }
        else if (cur >= 0) { const len = i - cur; if (len > best.len) best = { start: cur, len }; cur = -1; }
      }
      if (best.len >= Math.max(4, Math.round(h * 0.04))) { span = best; break; }
    }
    if (!span) return null;

    // Horizontal extent = intersection of the runs across the rows the caption will
    // actually occupy (the central part of the span). Intersecting the whole span would
    // be dragged narrow by its tapered top and bottom rows — e.g. a rounded bubble.
    const inset = Math.floor(span.len * 0.15);
    const iA = span.start + inset, iB = Math.max(iA + 1, span.start + span.len - inset);
    let L = 0, R = w;
    for (let i = iA; i < iB; i++) {
      L = Math.max(L, rows[i].s); R = Math.min(R, rows[i].s + rows[i].len);
    }
    if (R - L < minRun * 0.6) { L = 0; R = w; }        // degenerate intersection → full width

    // Report the inset rows as the band, so the width guarantee holds for every row the
    // caption can occupy.
    const topPct = ((yA + iA) / h) * 100;
    const bottomPct = ((yA + iB) / h) * 100;
    return {
      yPct: (topPct + bottomPct) / 2, topPct, bottomPct, heightPct: bottomPct - topPct,
      xPct: ((L + R) / 2 / w) * 100,
      widthPct: Math.max(25, ((R - L) / w) * 100),
    };
  } catch { return null; }
}

/** Composite the caption onto artwork. Returns a PNG buffer. */
async function overlayCaption(artworkBuffer, caption, fontsFor) {
  const base = sharp(artworkBuffer);
  const meta = await base.metadata();
  const W = meta.width || 1024, H = meta.height || 1024;

  // Auto-place the caption into the real empty area unless the user pinned a position.
  const cap = JSON.parse(JSON.stringify(caption || {}));
  cap.box = cap.box || {};
  if (cap.autoPlace !== false) {
    const band = await findClearBand(artworkBuffer);
    if (band) {
      // Confine the caption BLOCK strictly inside the empty area so it can never print
      // over faces, hard hats, equipment or the bubble outline.
      const bandTop = (band.topPct / 100) * H, bandBot = (band.bottomPct / 100) * H;
      const pad = Math.max(6, (bandBot - bandTop) * 0.08);      // breathing room off the edges
      const avail = Math.max(20, (bandBot - bandTop) - pad * 2);
      const gap = cap.lineGap != null ? cap.lineGap : 12;
      const lines = (cap.lines || []).filter(l => l && String(l.text || '').trim());
      let blockH = lines.reduce((a, l) => a + (Number(l.size) || 36) * 1.30, 0) + gap * Math.max(0, lines.length - 1);
      // Scale the type to the space: shrink when it would overflow, grow (up to 1.8×) when
      // the bubble is roomy, so the caption fills it the way the reference posters do.
      if (blockH > 0 && (blockH > avail || blockH < avail * 0.82)) {
        const k = Math.min(1.8, avail / blockH);
        lines.forEach(l => { l.size = Math.max(12, Math.round((Number(l.size) || 36) * k)); });
        cap.lineGap = Math.max(4, Math.round(gap * k));
        blockH = Math.min(avail, blockH * k);
      }
      // Centre it in the empty area, then clamp so top and bottom stay inside.
      const half = blockH / 2;
      const centre = Math.min(Math.max((band.yPct / 100) * H, bandTop + pad + half), bandBot - pad - half);
      cap.box.yPct = (centre / H) * 100;
      // Horizontal: sit inside the empty area too (the bubble is rarely centred exactly),
      // insetting a little so long lines don't touch the outline.
      cap.box.xPct = band.xPct;
      cap.box.widthPct = Math.max(20, Math.min(cap.box.widthPct || 80, band.widthPct * 0.88));
    }
  }

  const svg = buildCaptionSvg(W, H, cap, fontsFor);
  if (!svg) return await base.png().toBuffer();          // no caption → artwork unchanged
  return await base
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

/**
 * Composite the REAL company logo (from the app's settings) onto the image, so branding
 * is always the genuine mark rather than the image model's garbled imitation.
 * position: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
 */
async function overlayLogo(imageBuffer, logoDataUrl, { position = 'bottom-right', widthPct = 16, marginPct = 3 } = {}) {
  if (!logoDataUrl) return imageBuffer;
  try {
    const m = String(logoDataUrl).match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
    if (!m) return imageBuffer;
    const base = sharp(imageBuffer);
    const meta = await base.metadata();
    const W = meta.width || 1024, H = meta.height || 1024;
    const targetW = Math.max(48, Math.round(W * widthPct / 100));
    const logo = await sharp(Buffer.from(m[1], 'base64')).resize({ width: targetW }).png().toBuffer();
    const lm = await sharp(logo).metadata();
    const mx = Math.round(W * marginPct / 100), my = Math.round(H * marginPct / 100);
    const left = position.endsWith('left') ? mx : W - (lm.width || targetW) - mx;
    const top = position.startsWith('top') ? my : H - (lm.height || targetW) - my;
    return await base.composite([{ input: logo, left: Math.max(0, left), top: Math.max(0, top) }]).png().toBuffer();
  } catch { return imageBuffer; }   // branding must never break the image
}

module.exports = { overlayCaption, overlayLogo, buildCaptionSvg, findClearBand, loadFont };
