// WP-07 · C12 — Performance baseline recorder (NON-GATING).
// Records elapsed timings for key operations into tests/.tmp/performance-baseline.json.
// It NEVER enforces timing budgets — assertions only check that measurements exist,
// are finite, and are >= 0. Isolated harness + network guard + AI stub; synthetic
// data only; temporary DB + session storage; no production code touched.
require('../helpers/network-guard');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { startTestApp, TMP_DIR } = require('../helpers/app');
const { freshDb, cleanupAll, initReady } = require('../helpers/db');

const ROOT = path.join(__dirname, '..', '..');
const AI_PATH = require.resolve(path.join(ROOT, 'lib', 'ai.js'));
const TRANSLATE_PATH = require.resolve(path.join(ROOT, 'lib', 'translate.js'));
const OUT_FILE = path.join(TMP_DIR, 'performance-baseline.json');
const FONTS = ['C:/Windows/Fonts/tahoma.ttf', 'C:/Windows/Fonts/leelawui.ttf', 'C:/Windows/Fonts/arialuni.ttf'];

async function timed(fn) { const t = performance.now(); await fn(); return performance.now() - t; }

// A separate, stubbed translate module instance (does not affect the running app).
function loadStubbedTranslate() {
  require.cache[AI_PATH] = {
    id: AI_PATH, filename: AI_PATH, loaded: true,
    exports: {
      getClient: async () => ({
        messages: {
          create: async (args) => {
            const arr = JSON.parse(args.messages[0].content.match(/Array:\n([\s\S]*)$/)[1]);
            return { content: [{ type: 'text', text: JSON.stringify(arr.map((s) => '«' + s + '»')) }] };
          },
        },
      }),
      resetClient: () => {},
    },
  };
  delete require.cache[TRANSLATE_PATH];
  return require(TRANSLATE_PATH);
}

let app;
let empId;
let testId;
let attemptQ;
before(async () => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  app = await startTestApp();
  // Synthetic setup (not timed): a staff record + a one-question exam.
  empId = (await app.request('POST', '/api/staff', { LastName: 'Perf', FirstName: 'User', Status: 'Active', FileNum: 'C12-1' })).json().StaffID;
  testId = (await app.request('POST', '/api/exams/tests', { TestName: 'C12 Exam', PassScore: 50 })).json().TestID;
  await app.request('POST', `/api/exams/tests/${testId}/questions`, {
    QuestionType: 'single', Question: 'Q?', Mandatory: true,
    answers: [{ Answer: 'right', correct: true }, { Answer: 'wrong', correct: false }],
  });
  attemptQ = (await app.request('GET', `/api/exams/tests/${testId}/attempt-questions?empId=${empId}`)).json().questions[0];
});
after(async () => { if (app) await app.close(); await cleanupAll(); });

test('records a non-gating performance baseline', async () => {
  const results = {};

  // 1. initDb() — measured on its own throwaway database.
  const { mod } = freshDb();
  results.initDbMs = await timed(() => mod.initDb());

  // 2. Admin login.
  results.loginMs = await timed(() => app.rawRequest(app.baseUrl, 'POST', '/api/auth/login', { username: 'admin', password: 'admin123' }));

  // 3. GET /api/staff.
  results.staffListMs = await timed(() => app.request('GET', '/api/staff'));

  // 4. GET /api/reports/matrix.
  results.matrixMs = await timed(() => app.request('GET', '/api/reports/matrix'));

  // 5. POST exam submission (correct answer).
  const correctId = attemptQ.answers.find((a) => a.IsCorrect).QAID;
  results.examSubmitMs = await timed(() => app.request('POST', '/api/exams/submit', { testId, empId, answers: { [attemptQ.QID]: [correctId] } }));

  // 6. Simple translation using the AI stub.
  const T = loadStubbedTranslate();
  results.translateMs = await timed(() => T.translateSegments(['Hello', 'Safety first', 'Zone A'], 'Thai', {}));

  // 7. PDF generation (guarded by font availability; null when unavailable).
  const hasFont = FONTS.some((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (hasFont) {
    const { buildPdfFromSegments } = require(path.join(ROOT, 'lib', 'pdfout.js'));
    results.pdfMs = await timed(() => buildPdfFromSegments([{ source: 'Hello', target: 'สวัสดี' }], true, 'C12'));
  } else {
    results.pdfMs = null;
  }

  const baseline = {
    timestamp: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    results,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(baseline, null, 2)); // overwrite each run, tests/.tmp only

  // ---- Non-gating assertions: existence + finite + >= 0 only ----
  assert.ok(fs.existsSync(OUT_FILE), 'baseline file written');
  const written = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
  assert.equal(typeof written.timestamp, 'string');
  assert.equal(typeof written.environment.node, 'string');

  const keys = ['initDbMs', 'loginMs', 'staffListMs', 'matrixMs', 'examSubmitMs', 'translateMs', 'pdfMs'];
  for (const k of keys) {
    assert.ok(k in written.results, `measurement ${k} recorded`);
    const v = written.results[k];
    assert.ok(v === null || (Number.isFinite(v) && v >= 0), `${k} is null or a finite value >= 0`);
  }
  // At least the always-available measurements must be finite numbers.
  for (const k of ['initDbMs', 'loginMs', 'staffListMs', 'matrixMs', 'examSubmitMs', 'translateMs']) {
    assert.ok(Number.isFinite(written.results[k]) && written.results[k] >= 0, `${k} finite >= 0`);
  }
});
