// WP-07 · C11 — PowerPoint generation (offline, no AI, no network).
// Exercises the pptxgenjs generation stack the app relies on and asserts a valid
// PPTX (Open XML ZIP) structure. No route/AI is involved.
require('../helpers/network-guard');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const AdmZip = require('adm-zip');
const PptxGenJS = require('pptxgenjs');

// 4/5. Generated PPTX is a valid ZIP containing the expected PowerPoint parts.
test('4/5. pptx generation yields a valid Open XML package', async () => {
  const pptx = new PptxGenJS();
  const slide = pptx.addSlide();
  slide.addText('C11 Synthetic Slide', { x: 1, y: 1, fontSize: 18 });
  const buf = await pptx.write({ outputType: 'nodebuffer' });

  assert.ok(Buffer.isBuffer(buf) && buf.length > 0, 'returns a non-empty buffer');
  // Valid ZIP → readable by AdmZip
  const zip = new AdmZip(buf);
  const names = zip.getEntries().map((e) => e.entryName);
  assert.ok(names.includes('[Content_Types].xml'), 'has [Content_Types].xml');
  assert.ok(names.some((n) => /^ppt\/presentation\.xml$/.test(n)), 'has ppt/presentation.xml');
  assert.ok(names.some((n) => /^ppt\/slides\/slide1\.xml$/.test(n)), 'has ppt/slides/slide1.xml');
  // The slide text is present in the slide part.
  const slideXml = zip.readAsText('ppt/slides/slide1.xml');
  assert.ok(slideXml.includes('C11 Synthetic Slide'), 'slide text embedded');
});
