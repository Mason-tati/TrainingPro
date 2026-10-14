// Audience adaptation, assessment style, and section-mapping prompt builders (lib/content.js).
const { test } = require('node:test');
const assert = require('node:assert');
const {
  LEARNING_PROFILES, TECH_DEPTHS, ASSESSMENT_STYLE, TEMPLATE_SECTIONS,
  buildLearningCap, buildAssessmentCap, buildMappingCap,
} = require('../../lib/content');

test('learning profiles and tech depths have the expected keys', () => {
  assert.deepEqual(Object.keys(LEARNING_PROFILES), ['L1', 'L2', 'L3', 'L4']);
  assert.deepEqual(Object.keys(TECH_DEPTHS), ['basic', 'standard', 'advanced', 'expert']);
});

test('buildLearningCap is empty with no dials, populated otherwise', () => {
  assert.equal(buildLearningCap(null, null), '');
  const cap = buildLearningCap('L1', 'expert');
  assert.match(cap, /READING \/ LITERACY LEVEL/);
  assert.match(cap, /TECHNICAL DEPTH/);
  assert.match(cap, /Level 1/);
  assert.match(cap, /Expert/);
  // Safety guarantee must be present
  assert.match(cap, /NEVER remove, weaken, round or paraphrase away any safety-critical/i);
});

test('buildLearningCap dials are independent (only one set)', () => {
  const onlyLit = buildLearningCap('L1', null);
  assert.match(onlyLit, /READING \/ LITERACY LEVEL/);
  assert.ok(!/TECHNICAL DEPTH —/.test(onlyLit));
});

test('assessment style covers all profiles and keeps rigour', () => {
  assert.deepEqual(Object.keys(ASSESSMENT_STYLE), ['L1', 'L2', 'L3', 'L4']);
  const cap = buildAssessmentCap('L1');
  assert.match(cap, /ASSESSMENT STYLE/);
  assert.match(cap, /true\/false/i);
  assert.match(cap, /competency rigour is NON-NEGOTIABLE/i);
  assert.equal(buildAssessmentCap('nope'), '');
});

test('template section catalog is well-formed', () => {
  for (const [type, secs] of Object.entries(TEMPLATE_SECTIONS)) {
    assert.ok(Array.isArray(secs) && secs.length >= 4, `${type} has sections`);
    for (const s of secs) assert.ok(typeof s.t === 'string' && s.t, `${type} section has a title`);
    assert.ok(secs.some((s) => s.req), `${type} has at least one required section`);
  }
  assert.ok(TEMPLATE_SECTIONS.sop, 'sop template exists');
});

test('buildMappingCap places mapped, keeps unmapped, excludes, and flags missing-required', () => {
  const cap = buildMappingCap({
    mappings: [{ source: 'What you need', target: 'PPE & Equipment' }],
    unmappedPlacements: [
      { source: 'Extra tips', target: '__additional__' },
      { source: 'Vendor gossip', target: '__exclude__' },
    ],
    missingRequired: [{ target: 'Scope', reason: 'no scope in source' }],
  });
  assert.match(cap, /What you need["\s]*→\s*PPE & Equipment/);
  assert.match(cap, /Additional Information/);          // kept unmapped → additional section
  assert.match(cap, /EXCLUDE[\s\S]*Vendor gossip/i);    // excluded content named
  assert.match(cap, /\[INFORMATION REQUIRED/);          // missing-required marker instruction
  assert.match(cap, /Scope/);
  assert.match(cap, /DO NOT invent/i);
});

test('buildMappingCap is empty when nothing to map', () => {
  assert.equal(buildMappingCap(null), '');
  assert.equal(buildMappingCap({ mappings: [], unmappedPlacements: [], missingRequired: [] }), '');
});
