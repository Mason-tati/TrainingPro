// WP-07 · C11 — Document translation round-trip (offline, stubbed AI, no network).
// Builds synthetic DOCX/PPTX/XLSX in memory and runs them through translate.js in
// target and bilingual modes. The Anthropic client is stubbed via the require
// cache before translate.js binds it; the C10 network guard is active.
require('../helpers/network-guard');
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const AdmZip = require('adm-zip');

const ROOT = path.join(__dirname, '..', '..');
const TRANSLATE_PATH = require.resolve(path.join(ROOT, 'lib', 'translate.js'));

delete process.env.ANTHROPIC_API_KEY; // no key needed — AI is stubbed

// WP-10 A6.1 — translate.js calls the AI Gateway; stub at the provider registry
// seam so document round-trips flow through the real gateway to a deterministic
// fake provider (no real Anthropic/OpenAI/network).
const registry = require(path.join(ROOT, 'lib', 'ai', 'providers', 'registry.js'));
const logger = require(path.join(ROOT, 'lib', 'logger.js'));
const T = require(TRANSLATE_PATH);

let aiCalls = [];
function bracketProvider(req) {
  aiCalls.push(req);
  const prompt = req.messages[0].content;
  const arr = JSON.parse(prompt.match(/Array:\n([\s\S]*)$/)[1]);
  return { content: [{ type: 'text', text: JSON.stringify(arr.map((s) => '«' + s + '»')) }], usage: { input_tokens: 1, output_tokens: 1 } };
}

// Synthetic Office document builders.
function docx(lines) {
  const z = new AdmZip();
  z.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  z.addFile('_rels/.rels', Buffer.from('<R/>'));
  z.addFile('word/document.xml', Buffer.from(
    '<w:document xmlns:w="x"><w:body>' +
    lines.map((l) => `<w:p><w:r><w:t>${l}</w:t></w:r></w:p>`).join('') +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'));
  return z.toBuffer();
}
function pptx(text) {
  const z = new AdmZip();
  z.addFile('[Content_Types].xml', Buffer.from('<x/>'));
  z.addFile('ppt/slides/slide1.xml', Buffer.from(`<s><a:t>${text}</a:t></s>`));
  return z.toBuffer();
}
function xlsx(text) {
  const z = new AdmZip();
  z.addFile('[Content_Types].xml', Buffer.from('<x/>'));
  z.addFile('xl/sharedStrings.xml', Buffer.from(`<sst><si><t>${text}</t></si></sst>`));
  return z.toBuffer();
}

let restoreLevel;
beforeEach(() => {
  aiCalls = [];
  registry.__setProvider('anthropic', { complete: async (req) => bracketProvider(req) });
  restoreLevel = logger.__setLevel('silent'); // AI_CALL audit must not pollute TAP output
});
afterEach(() => { registry.__reset(); logger.__setLevel(restoreLevel); });

// 6 + 9. DOCX target mode: text replaced, structure (table) preserved.
test('6/9. DOCX target round-trip replaces text and keeps structure', async () => {
  const r = await T.translateDocument(docx(['Hello world', 'Safety first']), 'docx', 'Thai', 'target', {});
  assert.equal(r.outExt, 'docx');
  const xml = new AdmZip(r.buffer).readAsText('word/document.xml');
  assert.ok(xml.includes('«Hello world»') && xml.includes('«Safety first»'), 'text translated');
  assert.equal((xml.match(/<w:tbl>/g) || []).length, 1, 'table structure intact');
  assert.ok(aiCalls.length >= 1, 'stubbed AI used'); // 12
});

// 10. DOCX bilingual mode keeps the original and appends the translation.
test('10. DOCX bilingual round-trip keeps original + adds translation', async () => {
  const r = await T.translateDocument(docx(['Hello world']), 'docx', 'Thai', 'bilingual', {});
  const xml = new AdmZip(r.buffer).readAsText('word/document.xml');
  assert.ok(xml.includes('Hello world'), 'original kept');
  assert.ok(xml.includes('«Hello world»'), 'translation added');
  // balanced paragraph tags (no structural corruption)
  const open = (xml.match(/<w:p\b[^>]*>/g) || []).filter((t) => !t.endsWith('/>')).length;
  const close = (xml.match(/<\/w:p>/g) || []).length;
  assert.equal(open, close, 'paragraph tags balanced');
});

// 7. PPTX round-trip (target + bilingual).
test('7. PPTX round-trip translates slide text', async () => {
  const tgt = await T.translateDocument(pptx('Hi'), 'pptx', 'Thai', 'target', {});
  assert.ok(new AdmZip(tgt.buffer).readAsText('ppt/slides/slide1.xml').includes('«Hi»'));
  const bil = await T.translateDocument(pptx('Hi'), 'pptx', 'Thai', 'bilingual', {});
  assert.ok(new AdmZip(bil.buffer).readAsText('ppt/slides/slide1.xml').includes('Hi / «Hi»'), 'bilingual inline');
});

// 8. XLSX round-trip.
test('8. XLSX round-trip translates shared strings', async () => {
  const r = await T.translateDocument(xlsx('Cell'), 'xlsx', 'Thai', 'target', {});
  assert.ok(new AdmZip(r.buffer).readAsText('xl/sharedStrings.xml').includes('«Cell»'));
});

// 11 + 12. Translation-memory reuse is deterministic and bypasses AI.
test('11/12. TM reuse is deterministic and does not call AI', async () => {
  const r = await T.translateDocument(docx(['Known phrase']), 'docx', 'Thai', 'target', { tmMap: { 'Known phrase': 'MEM', cell: 'CELLMEM' } });
  const xml = new AdmZip(r.buffer).readAsText('word/document.xml');
  assert.ok(xml.includes('MEM'), 'TM value used');
  assert.equal(aiCalls.length, 0, 'no AI call when every segment is in TM');
  assert.ok(r.tmHits >= 1, 'tmHits recorded');
});

// 13. Network guard is active for this process.
test('13. outbound network guard is active', () => {
  assert.equal(globalThis.__NETWORK_GUARD_ACTIVE__, true);
});

// 14. Invalid / unsupported input fails safely.
test('14. invalid or unsupported input fails safely', async () => {
  // A minimal DOCX whose only text is non-translatable (numbers), no table.
  const bareNumericDocx = () => {
    const z = new AdmZip();
    z.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
    z.addFile('_rels/.rels', Buffer.from('<R/>'));
    z.addFile('word/document.xml', Buffer.from(
      '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>123</w:t></w:r></w:p><w:p><w:r><w:t>45.6</w:t></w:r></w:p></w:body></w:document>'));
    return z.toBuffer();
  };
  await assert.rejects(() => T.translateDocument(docx(['x']), 'txt', 'Thai', 'target', {}), /Unsupported format/);
  await assert.rejects(() => T.translateDocument(bareNumericDocx(), 'docx', 'Thai', 'target', {}), /No translatable text/);
  await assert.rejects(() => T.translateDocument(Buffer.from('not a zip file'), 'docx', 'Thai', 'target', {}));
});
