// ─────────────────────────────────────────────────────────────────────────────
// "Generate Image from Page Content" — EDITABLE CONFIG
// Everything a non-developer is likely to tune lives in this one file.
// ─────────────────────────────────────────────────────────────────────────────
const path = require('path');

// Bundled fonts live here (drop Noto Sans Thai / Sarabun .ttf files in to use them
// instead of the system fonts listed below — the first path that exists wins).
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');

// ── House style ──────────────────────────────────────────────────────────────
// Prepended to EVERY scene prompt. Tuned to the Akara reference safety posters.
// The PPE/uniform description is deliberately precise — it is what keeps every
// generated image on-brand and consistent.
const AKARA_UNIFORM =
  'Every worker wears the Akara Resources uniform EXACTLY: a PLAIN WHITE hard hat (completely blank — no logo, badge, ' +
  'sticker or lettering of any kind), clear wrap-around safety glasses, and a high-visibility work shirt whose ENTIRE ' +
  'body, chest, back and shoulders are BRIGHT YELLOW — the yellow must cover the whole torso down to the waist, with ' +
  'navy-blue ONLY on the collar and the lower sleeves/cuffs. Grey/silver reflective bands across the chest and arms. ' +
  'The shirt is COMPLETELY PLAIN — absolutely no logo, badge, printing or lettering on it. ' +
  'Grey work gloves on the hands. ' +
  'NAVY-BLUE work trousers with reflective bands above the knee, a black belt, and brown leather safety boots. ' +
  'Never make the shirt half navy — the torso is yellow.';

const HOUSE_STYLE =
  'Bold, clean CARTOON illustration in a modern comic / vector-poster style: crisp dark outlines, flat vibrant colour fills, ' +
  'soft simple shading, high detail and well-proportioned anatomy. Friendly, positive, professional characters. ' +
  AKARA_UNIFORM + ' ' +
  'Plain pure-WHITE background unless the scene specifically calls for a mine-site setting. Equipment is Caterpillar-yellow ' +
  'with black detailing. Do not caricature or distort faces; keep them appealing and realistic in proportion.';

// Style presets — the user picks one in the UI (matches the range in the reference set).
const STYLE_PRESETS = [
  { key: 'cartoon',   label: 'Bold cartoon (default)', style: HOUSE_STYLE },
  { key: 'photoreal', label: 'Photorealistic',
    style: 'Photorealistic, high-detail photograph of a real mine site, natural daylight, shallow depth of field, ' +
           'sharp focus on the workers. ' + AKARA_UNIFORM +
           ' Realistic skin, fabric and equipment textures. Documentary/corporate photography look.' },
];

// ── Locales ──────────────────────────────────────────────────────────────────
// Add a locale by copying an entry. `peopleDescriptor` is injected into the scene
// prompt (never hard-coded elsewhere). `fonts` are tried in order; first existing wins.
const LOCALES = [
  {
    code: 'en',
    label: 'English',
    peopleDescriptor: 'an adult mine-site worker',
    fonts: {
      regular: [path.join(FONT_DIR, 'NotoSans-Regular.ttf'), 'C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'],
      bold:    [path.join(FONT_DIR, 'NotoSans-Bold.ttf'),    'C:/Windows/Fonts/arialbd.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
    },
    sampleCaption: "HERE'S TO A SAFE DAY'S WORK!",
  },
  {
    code: 'th',
    label: 'Thai (ภาษาไทย)',
    peopleDescriptor: 'a Thai / Southeast Asian mine-site worker with Thai facial features and black hair',
    fonts: {
      regular: [path.join(FONT_DIR, 'NotoSansThai-Regular.ttf'), path.join(FONT_DIR, 'Sarabun-Regular.ttf'), 'C:/Windows/Fonts/leelawad.ttf', 'C:/Windows/Fonts/tahoma.ttf'],
      bold:    [path.join(FONT_DIR, 'NotoSansThai-Bold.ttf'),    path.join(FONT_DIR, 'Sarabun-Bold.ttf'),    'C:/Windows/Fonts/leelawdb.ttf', 'C:/Windows/Fonts/tahomabd.ttf'],
    },
    sampleCaption: 'ขอให้ทุกคนทำงานอย่างปลอดภัยในวันนี้!',
  },
];

// ── Default caption ──────────────────────────────────────────────────────────
// Bilingual, Thai stacked ABOVE English (matches the reference safety poster).
// Users can edit text / size / colour / position per page in the UI.
const DEFAULT_CAPTION = {
  lines: [
    { text: 'ขอให้ทุกคนทำงานอย่างปลอดภัยในวันนี้!', locale: 'th', size: 44, bold: true },
    { text: "HERE'S TO A SAFE DAY'S WORK!",         locale: 'en', size: 38, bold: true },
  ],
  color: '#1E3A5F',   // dark navy
  align: 'center',
  lineGap: 14,
  // Speech-bubble / banner area, as a percentage of the image (so it scales with size).
  box: { xPct: 50, yPct: 15, widthPct: 80 },
};

// ── Generation settings ──────────────────────────────────────────────────────
// engine:
//   'auto' (DEFAULT) — use gpt-image-1 when an OpenAI key is configured (env OPENAI_API_KEY
//                      or tblConfig 'openai_api_key'); otherwise fall back automatically to
//                      Claude vector illustration on the Anthropic key this app already uses.
//   'claude-svg'     — force Claude vector illustration (no OpenAI usage/cost).
//   'openai'         — force gpt-image-1 (errors clearly if no key is configured).
const IMAGE = {
  engine: 'auto',
  width: 1024,
  height: 1024,
  // used only when engine === 'openai'
  model: 'gpt-image-1',
  size: '1024x1024',      // gpt-image-1: 1024x1024 | 1536x1024 | 1024x1536
  background: 'opaque',
};

// Scene generations per user per day. Caption-only overlays do NOT count.
const DAILY_SCENE_LIMIT = 20;

// ── Scene composition ────────────────────────────────────────────────────────
// The reference safety posters are a SINGLE worker, framed large and close. One clearly
// framed worker is what makes everything downstream work: the logo lands reliably on the
// one hard hat and the one chest, and there is a clean empty band at the top for the
// caption. A group drawn small (the old behaviour) gave no clean caption area — the text
// collided with a hard hat — and the branding pass could only find some of the people.
// Change `people` if a scene genuinely needs a small team.
const SCENE = {
  people: 'ONE single worker — a solo hero portrait facing the viewer — unless the training content clearly requires a small team of 2–3.',
  framing: 'Frame the worker LARGE and close, from the waist or mid-thigh up, centred in the lower part of the image, with the hard hat, face and both hands fully visible. Leave a clear empty band of plain background above the head for the caption.',
};

// Instruction appended so the model leaves a clean caption area and renders NO text.
// No speech bubble is drawn: the caption is composited into a plain empty top band, which
// the model produces far more reliably than a perfectly-framed bubble (the old bubble kept
// coming out cropped, and the caption then clashed with a hard hat).
const NO_TEXT_RULE =
  'CRITICAL — TEXT RULE: render NO text, NO letters, NO words, NO numbers, NO labels, NO logos, NO badges and NO signage ' +
  'ANYWHERE in the image — including on hard hats, shirts, vehicles and signs. Hard hats and shirts must be completely ' +
  'blank. (The real company logo is added afterwards by the system.)\n' +
  'CRITICAL — BACKGROUND RULE: the background MUST be a single FLAT, SOLID, PURE WHITE (#FFFFFF) fill behind the whole ' +
  'scene. Absolutely NO gradient, NO vignette, NO dark or coloured corners, NO glow, NO dramatic or coloured lighting, ' +
  'NO scenery or sky. Flat even lighting only. The hard hat must be BRIGHT WHITE, not tinted or shaded grey/tan.\n' +
  'CRITICAL — COMPOSITION RULE (follow exactly):\n' +
  '• The ENTIRE top 30% of the image must be EMPTY solid-white background — a clean banner area with NO people, ' +
  'NO equipment, NO hard hats, NO hands and NO detail. A caption is composited into that empty band afterwards.\n' +
  '• Do NOT draw a speech bubble, banner, box, ribbon, sign or any shape in that top area — just clean empty white.\n' +
  '• Place the worker in the LOWER TWO-THIRDS, facing the viewer, framed LARGE (waist-up / mid-thigh-up portrait). ' +
  'The TOP of the hard hat must start BELOW the top 30% of the frame — leave a clear tall gap of empty white above ' +
  'the hard hat. Do NOT let the hard hat touch or approach the top edge.\n' +
  '• Do NOT crop the hard hat, the face or the hands. Keep the composition simple and uncluttered with generous clean space.';

// ── Brand logo overlay ───────────────────────────────────────────────────────
// The REAL company logo (Admin → Settings → company logo) is composited onto every
// generated image, so branding is always the genuine mark — image models cannot
// reproduce a logo accurately, so they are told to draw none at all.
const LOGO = {
  position: 'bottom-right',   // bottom-right | bottom-left | top-right | top-left
  widthPct: 16,               // % of image width
  marginPct: 3,

  // Print the real logo on the workers' PPE too. The artwork is drawn with plain hats
  // and shirts; Claude's vision finds the flat panel on each hard hat and chest, and the
  // genuine logo is composited there. Set false for a corner mark only.
  onPpe: true,
  maxMarks: 10,               // safety cap on how many marks may be placed
  // Fine-tuning: fraction of the located panel the logo fills, and how solid it prints.
  // A hard-hat decal fills most of its panel; a breast logo is a small badge.
  hardHat: { widthScale: 0.9, heightScale: 0.9, opacity: 0.96 },
  shirt:   { widthScale: 0.62, heightScale: 0.62, opacity: 0.96 },
};

module.exports = { HOUSE_STYLE, AKARA_UNIFORM, STYLE_PRESETS, LOCALES, DEFAULT_CAPTION, IMAGE, LOGO, DAILY_SCENE_LIMIT, SCENE, NO_TEXT_RULE, FONT_DIR };
