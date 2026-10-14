// ─────────────────────────────────────────────────────────────────────────────
// Brand marks on PPE.
//
// Image models cannot draw a logo legibly at hard-hat scale — they produce a garbled
// imitation of the wordmark. So the artwork is generated with COMPLETELY PLAIN hard
// hats and shirts, and the REAL company logo is composited on here.
//
// The hard part is knowing WHERE, because every generation poses the workers
// differently. Two things are combined, because neither is sufficient alone:
//
//  1. WHERE ROUGHLY — Claude's vision. It identifies PPE reliably, but its raw pixel
//     coordinates are only approximate (they put the first hard-hat marks in mid-air).
//     So the image is sent with a LABELLED GRID drawn over it and the model answers in
//     cell references. It then reads printed labels instead of estimating numbers,
//     which is far more accurate.
//  2. WHERE EXACTLY — a local colour check. The uniform is specified by the house
//     style (intense hi-vis yellow shirt, white hard hat), so the answer is nudged onto
//     the nearby patch that actually looks like the garment, and dropped if none does.
//     This is only ever a LOCAL test, never a whole-image segmentation: sunlit sand and
//     a cream sky read as "yellow" and "white" globally, so global masks are unusable.
//
// Branding must never break an image: every failure path returns the image unchanged.
// ─────────────────────────────────────────────────────────────────────────────
const sharp = require('sharp');
const { complete } = require('./ai-gateway');

const VISION_MODEL = 'claude-sonnet-4-6';
const COLS = 16, ROWS = 16;                    // grid granularity — one cell ≈ 6% of the image
const COL_LABELS = 'ABCDEFGHIJKLMNOP';
const AW = 256;                                // analysis raster width for the colour check

// Intense hi-vis yellow. Deliberately tight: sunlit sand sits near b≈135 and would
// otherwise pass. Measured hi-vis on generated artwork is around rgb(235,173,7).
const isHiVis = (r, g, b) => r > 180 && g > 130 && b < 100 && (r - b) > 140 && (g - b) > 90;
// Bright and neutral — a white hard hat (also a cream sky, hence local use only).
const isWhite = (r, g, b) => Math.min(r, g, b) > 190 && (Math.max(r, g, b) - Math.min(r, g, b)) < 32;

const PROMPT = `The image has a labelled grid drawn over it: columns ${COL_LABELS[0]}-${COL_LABELS[COLS - 1]} left to right, rows 1-${ROWS} top to bottom. Each cell is labelled in its top-left corner.

Find every WORKER'S HARD HAT and give the panel a logo decal would be printed on: the
LOWER FRONT FACE of the hat — above the brim, below the crown ridge.

Rules:
 • One panel per person, only when the hat faces the viewer. Skip anyone turned away,
   cropped, far away in the background, or whose hat is obscured.
 • Give the panel the decal must fit INSIDE — not the whole hat. Do not include the
   brim, the crown ridge, or any of the background above the hat.
 • Answer with the grid cells that panel covers: "from" is its top-left cell, "to" its
   bottom-right cell. Read the printed labels; do not estimate.

Reply with JSON only, no prose, no code fences:
{"marks":[{"kind":"hardhat","from":"D4","to":"E4"}]}
If there is no suitable hard hat, reply {"marks":[]}.`;

const textOf = msg => (((msg || {}).content) || []).filter(b => b && b.type === 'text').map(b => b.text).join('');

/** Draw the labelled grid the vision model reads its answer off. */
function gridSvg(W, H) {
  const cw = W / COLS, chh = H / ROWS;
  let g = '';
  for (let c = 1; c < COLS; c++) g += `<line x1="${(c * cw).toFixed(1)}" y1="0" x2="${(c * cw).toFixed(1)}" y2="${H}"/>`;
  for (let r = 1; r < ROWS; r++) g += `<line x1="0" y1="${(r * chh).toFixed(1)}" x2="${W}" y2="${(r * chh).toFixed(1)}"/>`;
  const fs = Math.max(9, Math.round(Math.min(cw, chh) * 0.26));
  let labels = '';
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      labels += `<text x="${(c * cw + 3).toFixed(1)}" y="${(r * chh + fs + 1).toFixed(1)}">${COL_LABELS[c]}${r + 1}</text>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
    + `<g stroke="#FF00A0" stroke-width="1" opacity="0.55">${g}</g>`
    + `<g fill="#FF00A0" font-family="Arial, sans-serif" font-size="${fs}" font-weight="bold" opacity="0.9">${labels}</g></svg>`;
}

// "D4" → {c:3, r:3}
const CELL_RE = new RegExp(`^([${COL_LABELS}${COL_LABELS.toLowerCase()}])\\s*(\\d{1,2})$`);
function parseCell(s) {
  const m = CELL_RE.exec(String(s || '').trim());
  if (!m) return null;
  const c = COL_LABELS.indexOf(m[1].toUpperCase()), r = parseInt(m[2], 10) - 1;
  if (c < 0 || r < 0 || r >= ROWS) return null;
  return { c, r };
}

/**
 * Nudge a candidate box onto the patch that really looks like the garment.
 * Tries the box and its immediate neighbours (a third of a cell at a time) and keeps the
 * position where the most pixels match. Returns null when nothing nearby matches, so a
 * misread never prints a logo onto a face or the sky.
 */
function refine(box, kind, raster, opts = {}) {
  const { data, w, h, ch } = raster;
  const match = kind === 'hardhat' ? isWhite : isHiVis;
  // Probe the CENTRE of the box, not all of it: a chest badge legitimately sits near the
  // zip and the reflective band, so sampling the full footprint would reject good spots.
  const probe = opts.probe || 1;
  const minFrac = opts.minFrac != null ? opts.minFrac : 0.55;
  const span = opts.span || 1;                    // how many steps out to search
  const pw = box.widthPct * probe, ph = box.heightPct * probe;
  const fracOf = (xPct, yPct) => {
    const x0 = Math.max(0, Math.round(w * (xPct - pw / 2) / 100));
    const x1 = Math.min(w, Math.round(w * (xPct + pw / 2) / 100));
    const y0 = Math.max(0, Math.round(h * (yPct - ph / 2) / 100));
    const y1 = Math.min(h, Math.round(h * (yPct + ph / 2) / 100));
    let hit = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const j = (y * w + x) * ch; n++;
        if (match(data[j], data[j + 1], data[j + 2])) hit++;
      }
    }
    return n ? hit / n : 0;
  };
  const stepX = opts.stepPct || (100 / COLS) / 3, stepY = opts.stepPct || (100 / ROWS) / 3;
  let best = { x: box.xPct, y: box.yPct, f: fracOf(box.xPct, box.yPct) };
  for (let dx = -span; dx <= span; dx++) {
    for (let dy = -span; dy <= span; dy++) {
      if (!dx && !dy) continue;
      const x = box.xPct + dx * stepX, y = box.yPct + dy * stepY;
      const f = fracOf(x, y);
      if (f > best.f) best = { x, y, f };
    }
  }
  if (best.f < minFrac) return null;              // not actually on the garment → drop it
  return Object.assign({}, box, { xPct: best.x, yPct: best.y });
}

/**
 * Derive the chest badge from the hard hat above it, rather than asking the vision model
 * for it separately — a chest is ALWAYS below a hat, and the model tends to report only
 * some of the shirts in a group, which left workers unbranded.
 *
 * Scans straight down from the hat through the face until it meets the first sustained
 * band of hi-vis fabric: that is the top of the shirt.
 */
function chestBelow(hat, raster) {
  const { data, w, h, ch } = raster;
  const bandW = Math.max(4, Math.round(w * hat.widthPct / 100));
  const cx = Math.round(w * hat.xPct / 100);
  const x0 = Math.max(0, cx - (bandW >> 1)), x1 = Math.min(w, cx + (bandW >> 1));
  if (x1 - x0 < 3) return null;

  const need = Math.max(3, Math.round(h * 0.03));               // a real garment, not a stray highlight
  let top = -1, run = 0;
  for (let y = Math.round(h * hat.yPct / 100); y < h; y++) {
    let hit = 0, n = 0;
    for (let x = x0; x < x1; x++) {
      const j = (y * w + x) * ch; n++;
      if (isHiVis(data[j], data[j + 1], data[j + 2])) hit++;
    }
    if (n && hit / n > 0.45) { if (top < 0) top = y; if (++run >= need) break; }
    else { top = -1; run = 0; }
  }
  if (top < 0) return null;

  // A breast badge, sized off the hard-hat decal, sitting just below the shoulder line
  // and offset to the wearer's left so it does not straddle the centre zip.
  const widthPct = hat.widthPct * 0.9;
  const heightPct = widthPct * (w / h);
  const box = {
    kind: 'shirt',
    xPct: hat.xPct + (hat.widthPct * 0.5),
    yPct: (top / h) * 100 + heightPct * 0.8,
    widthPct, heightPct,
  };
  const probe = { probe: 0.62, minFrac: 0.5, span: 2, stepPct: widthPct * 0.3 };
  // Prefer the wearer's left breast; fall back to the other side if that one is covered
  // by an arm, a raised hand or the reflective band.
  return refine(box, 'shirt', raster, probe)
    || refine(Object.assign({}, box, { xPct: hat.xPct - hat.widthPct * 0.5 }), 'shirt', raster, probe);
}

/**
 * Locate the flat panels the logo can be printed on.
 * Returns [{ kind:'hardhat'|'shirt', xPct, yPct, widthPct, heightPct }] — the panel
 * CENTRE and size as percentages, so they are resolution-independent.
 */
async function findPpeTargets(artworkBuffer, { maxMarks = 10 } = {}) {
  try {
    const VW = 768;
    const flat = await sharp(artworkBuffer).removeAlpha().resize(VW, VW, { fit: 'inside' }).png().toBuffer();
    const fm = await sharp(flat).metadata();
    const gridded = await sharp(flat)
      .composite([{ input: Buffer.from(gridSvg(fm.width, fm.height)), top: 0, left: 0 }])
      .jpeg({ quality: 88 }).toBuffer();

    const msg = await complete({
      model: VISION_MODEL, max_tokens: 900,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: gridded.toString('base64') } },
          { type: 'text', text: PROMPT },
        ],
      }],
    });
    const raw = textOf(msg).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    const jm = raw.match(/\{[\s\S]*\}/);
    if (!jm) return [];

    const rasterBuf = await sharp(artworkBuffer).removeAlpha().resize(AW, AW, { fit: 'inside' })
      .raw().toBuffer({ resolveWithObject: true });
    const raster = { data: rasterBuf.data, w: rasterBuf.info.width, h: rasterBuf.info.height, ch: rasterBuf.info.channels || 3 };

    const out = [];
    for (const t of (JSON.parse(jm[0]).marks || [])) {
      if (!t) continue;
      const a = parseCell(t.from), b = parseCell(t.to) || parseCell(t.from);
      if (!a || !b) continue;
      const c0 = Math.min(a.c, b.c), c1 = Math.max(a.c, b.c);
      const r0 = Math.min(a.r, b.r), r1 = Math.max(a.r, b.r);
      if (c1 - c0 > 4 || r1 - r0 > 4) continue;                   // an implausibly large "panel"
      const box = {
        kind: 'hardhat',
        xPct: ((c0 + c1 + 1) / 2 / COLS) * 100,
        yPct: ((r0 + r1 + 1) / 2 / ROWS) * 100,
        widthPct: ((c1 - c0 + 1) / COLS) * 100 * 0.80,            // inset off the panel edges
        heightPct: ((r1 - r0 + 1) / ROWS) * 100 * 0.80,
      };
      const hat = refine(box, 'hardhat', raster);
      if (!hat) continue;
      out.push(hat);
      const chest = chestBelow(hat, raster);
      if (chest) out.push(chest);
    }
    return out.slice(0, maxMarks);
  } catch { return []; }
}

/** Scale a logo's alpha channel so it reads as printed on fabric rather than pasted on. */
async function withOpacity(logoBuf, opacity) {
  if (!(opacity < 1)) return logoBuf;
  const a = Math.max(0, Math.min(255, Math.round(255 * opacity)));
  return await sharp(logoBuf)
    .composite([{ input: Buffer.from([255, 255, 255, a]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }])
    .png().toBuffer();
}

/**
 * Composite the real logo onto each located panel.
 * The logo is fitted INSIDE the panel (`fit: 'inside'`), so a tall stacked logo on a
 * short hard-hat panel is limited by the panel's height and never runs over the brim.
 */
async function applyPpeMarks(imageBuffer, logoDataUrl, targets, opts = {}) {
  if (!logoDataUrl || !targets || !targets.length) return imageBuffer;
  try {
    const m = String(logoDataUrl).match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
    if (!m) return imageBuffer;
    const logoSrc = Buffer.from(m[1], 'base64');

    const base = sharp(imageBuffer);
    const meta = await base.metadata();
    const W = meta.width || 1024, H = meta.height || 1024;
    const perKind = {
      hardhat: Object.assign({ widthScale: 1, heightScale: 1, opacity: 0.96 }, opts.hardHat || {}),
      shirt: Object.assign({ widthScale: 1, heightScale: 1, opacity: 0.96 }, opts.shirt || {}),
    };

    const layers = [];
    for (const t of targets) {
      const k = perKind[t.kind] || perKind.shirt;
      const boxW = Math.round(W * (t.widthPct / 100) * k.widthScale);
      const boxH = Math.round(H * (t.heightPct / 100) * k.heightScale);
      if (boxW < 10 || boxH < 10) continue;                       // would be an illegible smudge
      let logo = await sharp(logoSrc).resize({ width: boxW, height: boxH, fit: 'inside' }).png().toBuffer();
      logo = await withOpacity(logo, k.opacity);
      const lm = await sharp(logo).metadata();
      const left = Math.round(W * (t.xPct / 100) - (lm.width || boxW) / 2);
      const top = Math.round(H * (t.yPct / 100) - (lm.height || boxH) / 2);
      if (left < 0 || top < 0 || left + (lm.width || 0) > W || top + (lm.height || 0) > H) continue;  // off-frame
      layers.push({ input: logo, left, top });
    }
    if (!layers.length) return imageBuffer;
    return await base.composite(layers).png().toBuffer();
  } catch { return imageBuffer; }                                  // branding must never break the image
}

/** Locate + apply in one step. Returns { buffer, marks }. */
async function brandPpe(imageBuffer, logoDataUrl, opts = {}) {
  if (!logoDataUrl || opts.onPpe === false) return { buffer: imageBuffer, marks: [] };
  const marks = await findPpeTargets(imageBuffer, { maxMarks: opts.maxMarks || 10 });
  const buffer = await applyPpeMarks(imageBuffer, logoDataUrl, marks, opts);
  return { buffer, marks };
}

module.exports = { brandPpe, findPpeTargets, applyPpeMarks, gridSvg };
