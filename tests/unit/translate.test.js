// WP-07 · C4 — Translation engine unit tests (deterministic, offline)
// Covers lib/translate.js pure helpers + translateSegments with a STUBBED AI
// client. No real Anthropic/OpenAI/network/SMTP/DB calls; no API key required.
//
// AI safety seam: we seed a stub `./ai` module in the require cache BEFORE
// translate.js is (re)required, because translate.js binds `getClient` at load.
// The stub's messages.create is fully deterministic and records every call, so
// tests can prove AI is (or is not) invoked.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const TRANSLATE_PATH = require.resolve(path.join(ROOT, 'lib', 'translate.js'));

// Prove no API key is needed — remove it for this process entirely.
delete process.env.ANTHROPIC_API_KEY;

// WP-10 A6.1 — translate.js now calls the AI Gateway. We stub at the PROVIDER
// registry seam so calls flow through the REAL gateway (emitting the AI_CALL
// audit) into a deterministic fake provider — no real Anthropic/OpenAI/network.
const registry = require(path.join(ROOT, 'lib', 'ai', 'providers', 'registry.js'));
const logger = require(path.join(ROOT, 'lib', 'logger.js'));
const T = require(TRANSLATE_PATH);

// Recorded AI calls + the active response handler (swappable per test).
let aiCalls = [];
let aiHandler = null;

// Default deterministic "translator": wraps each source string in « ».
function bracketHandler(req) {
  const prompt = req.messages[0].content; // translateSegments sends a string prompt
  const arr = JSON.parse(prompt.match(/Array:\n([\s\S]*)$/)[1]);
  return { content: [{ type: 'text', text: JSON.stringify(arr.map((s) => '«' + s + '»')) }], usage: { input_tokens: 1, output_tokens: 1 } };
}

let restoreLevel;
beforeEach(() => {
  aiCalls = [];
  aiHandler = bracketHandler;
  registry.__setProvider('anthropic', { complete: async (req) => { aiCalls.push(req); return aiHandler(req); } });
  restoreLevel = logger.__setLevel('silent'); // AI_CALL audit must not pollute TAP output
});
afterEach(() => {
  registry.__reset();
  logger.__setLevel(restoreLevel);
});

// 1. LANGUAGES exists and includes the supported set.
test('1. LANGUAGES is the supported set (14, unique codes, well-formed)', () => {
  assert.ok(Array.isArray(T.LANGUAGES));
  assert.equal(T.LANGUAGES.length, 14);
  for (const l of T.LANGUAGES) {
    assert.equal(typeof l.code, 'string');
    assert.equal(typeof l.name, 'string');
    assert.ok(l.code.length >= 2 && l.name.length > 0);
  }
  const names = T.LANGUAGES.map((l) => l.name);
  for (const expected of ['Thai', 'French', 'Spanish', 'Arabic', 'Chinese (Simplified)']) {
    assert.ok(names.includes(expected), `includes ${expected}`);
  }
  const codes = T.LANGUAGES.map((l) => l.code);
  assert.equal(new Set(codes).size, codes.length, 'language codes are unique');
});

// 2. Thai is first/preferred (current behaviour).
test('2. Thai is the first/preferred language', () => {
  assert.equal(T.LANGUAGES[0].code, 'th');
  assert.equal(T.LANGUAGES[0].name, 'Thai');
});

// 3. XML encode/decode helpers.
test('3. encodeXml / decodeXml behave correctly', () => {
  assert.equal(T.encodeXml('a & b < c > d'), 'a &amp; b &lt; c &gt; d');
  // encode escapes &,<,> (not quotes); decode is the inverse for those + quotes/apos
  assert.equal(T.decodeXml('a &amp; b &lt; c &gt; d'), 'a & b < c > d');
  assert.equal(T.decodeXml('&quot;q&quot; &#39;a&#39; &apos;b&apos;'), '"q" \'a\' \'b\'');
  const round = 'Torque & <Load> > 5';
  assert.equal(T.decodeXml(T.encodeXml(round)), round, 'decode(encode(x)) round-trips for & < >');
});

// 4. Translatable segment detection.
test('4. isTranslatable detects real words vs non-words', () => {
  for (const yes of ['Hello', 'Safety first', 'café', 'Zone A', 'PC2000 truck']) {
    assert.equal(T.isTranslatable(yes), true, `translatable: ${JSON.stringify(yes)}`);
  }
});

// 5. Empty / whitespace / numeric / punctuation-only are skipped.
test('5. non-translatable values are skipped', () => {
  for (const no of ['', '   ', '\n\t ', '123', '45.6', '-', '!!!', '  ,. ', '###', null, undefined]) {
    assert.equal(!!T.isTranslatable(no), false, `not translatable: ${JSON.stringify(no)}`);
  }
});

// 6. Translation memory reuse works (deterministic).
test('6. translateSegments reuses translation memory', async () => {
  const r = await T.translateSegments(['A', 'B'], 'Thai', { tmMap: { A: 'tA', B: 'tB' } });
  assert.deepEqual(r.map, { A: 'tA', B: 'tB' });
  assert.equal(r.tmHits, 2);
  assert.equal(r.aiCount, 0);
});

// 7. TM reuse bypasses AI entirely.
test('7. full TM reuse never calls the AI client', async () => {
  await T.translateSegments(['A', 'B'], 'Thai', { tmMap: { A: 'tA', B: 'tB' } });
  assert.equal(aiCalls.length, 0, 'messages.create was not called');
});

// 8. Glossary + language-code resolution are deterministic.
test('8. glossary is injected into the prompt; langCodeFromName resolves', async () => {
  await T.translateSegments(['Torque check'], 'Thai', {
    glossary: [{ SourceTerm: 'torque', TargetTerm: 'แรงบิด' }],
  });
  assert.equal(aiCalls.length, 1);
  const prompt = aiCalls[0].messages[0].content;
  assert.ok(prompt.includes('"torque" => "แรงบิด"'), 'glossary term injected into prompt');

  assert.equal(T.langCodeFromName('Thai'), 'th');
  assert.equal(T.langCodeFromName('Mandarin Chinese'), 'zh'); // alias
  assert.equal(T.langCodeFromName('Tagalog'), 'tl');          // alias
  assert.equal(T.langCodeFromName('Fren'), 'fr');             // prefix match
  assert.equal(T.langCodeFromName(''), null);
  assert.equal(T.langCodeFromName('Klingon'), null);
  assert.ok(T.LANGUAGE_ALIAS && T.LANGUAGE_ALIAS['chinese'] === 'zh');
});

// 9. translateSegments works with a stubbed AI translator (mixed TM + AI) + progress.
test('9. translateSegments uses stubbed AI for non-TM segments and reports progress', async () => {
  const progress = [];
  const r = await T.translateSegments(['Hello', 'Known'], 'Thai', {
    tmMap: { Known: 'MEM' },
    onProgress: (done, total) => progress.push([done, total]),
  });
  assert.equal(r.map.Known, 'MEM');
  assert.equal(r.map.Hello, '«Hello»');
  assert.equal(r.tmHits, 1);
  assert.equal(r.aiCount, 1);
  assert.equal(aiCalls.length, 1, 'exactly one AI batch for the single non-TM segment');
  assert.deepEqual(progress[progress.length - 1], [1, 1], 'progress reported to completion');
});

// 10. Error paths are handled safely (no throws) + batching is correct.
test('10a. invalid AI JSON is handled without throwing', async () => {
  aiHandler = () => ({ content: [{ type: 'text', text: 'not-json at all' }] });
  const r = await T.translateSegments(['Hello'], 'Thai', {});
  assert.deepEqual(r.map, {}, 'unparseable response yields no mappings');
  assert.equal(r.aiCount, 0);
  assert.equal(r.tmHits, 0);
});

test('10b. null entries in the AI array are skipped', async () => {
  aiHandler = () => ({ content: [{ type: 'text', text: JSON.stringify(['«Hello»', null]) }] });
  const r = await T.translateSegments(['Hello', 'World'], 'Thai', {});
  assert.equal(r.map.Hello, '«Hello»');
  assert.ok(!('World' in r.map), 'null translation skipped');
  assert.equal(r.aiCount, 1);
});

test('10c. empty segment list makes no AI call', async () => {
  const r = await T.translateSegments([], 'Thai', {});
  assert.deepEqual(r.map, {});
  assert.equal(r.tmHits, 0);
  assert.equal(r.aiCount, 0);
  assert.equal(aiCalls.length, 0);
});

test('10d. batching splits >40 segments into multiple AI calls', async () => {
  const segments = Array.from({ length: 41 }, (_, i) => `Seg${i}`);
  const r = await T.translateSegments(segments, 'Thai', {});
  assert.equal(aiCalls.length, 2, '41 segments → 2 batches of ≤40');
  assert.equal(r.aiCount, 41);
  assert.equal(r.map.Seg40, '«Seg40»');
});

// ── WP-10 A6.1 — gateway integration verification ──────────────────────────
// A6.1-4. The gateway emits AI_CALL only when AI is actually used (not on TM reuse).
test('A6.1: AI_CALL emitted only when AI is used (TM reuse emits none)', async () => {
  const captured = [];
  const restore = logger.__setSink((r) => captured.push(r));
  logger.__setLevel('debug');
  // All-TM: no AI, no AI_CALL.
  await T.translateSegments(['Known'], 'Thai', { tmMap: { Known: 'MEM' } });
  assert.equal(captured.filter((r) => r.event === 'AI_CALL').length, 0, 'no AI_CALL on full TM reuse');
  // Real translation: one AI batch → one AI_CALL with agent/operation stamped.
  await T.translateSegments(['Hello world'], 'Thai', {});
  logger.__setSink(restore); logger.__setLevel('silent');
  const calls = captured.filter((r) => r.event === 'AI_CALL');
  assert.equal(calls.length, 1, 'one AI_CALL for one batch');
  assert.equal(calls[0].module, 'AI');
  assert.equal(calls[0].metadata.provider, 'anthropic');
  assert.equal(calls[0].metadata.agent, 'AI-DOC-002');
  assert.equal(calls[0].metadata.operation, 'translate_segments');
});

// A6.1-5. No prompt/system/messages/document text appears in the AI_CALL audit.
test('A6.1: no prompt/segment content appears in AI_CALL logs', async () => {
  const captured = [];
  const restore = logger.__setSink((r) => captured.push(r));
  logger.__setLevel('debug');
  await T.translateSegments(['A6-SENTINEL-SEGMENT-TEXT'], 'Thai', {});
  logger.__setSink(restore); logger.__setLevel('silent');
  const s = JSON.stringify(captured.filter((r) => r.event === 'AI_CALL'));
  assert.ok(!s.includes('A6-SENTINEL-SEGMENT-TEXT'), 'segment text absent from audit');
  assert.ok(!s.includes('professional translator'), 'prompt text absent from audit');
});
