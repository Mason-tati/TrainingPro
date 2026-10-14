// WP-07 · C9 — Exam API tests (build → attempt → score → lock).
// Isolated harness; temporary DB + session storage; synthetic data only.
// No AI, no SMTP (fresh DB has no workflows configured → exam_passed/failed fire
// finds nothing and sends nothing).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('../helpers/app');

let app;
let empId;
before(async () => {
  app = await startTestApp();
  const s = await app.request('POST', '/api/staff', { LastName: 'Exam', FirstName: 'Taker', Status: 'Active', FileNum: 'C9-EX' });
  empId = s.json().StaffID;
});
after(async () => { if (app) await app.close(); });

// 11. Unauthenticated access → 401.
test('11. unauthenticated /api/exams/tests returns 401', async () => {
  assert.equal((await app.request('GET', '/api/exams/tests', null, null)).status, 401);
});

// Helper: build a one-question exam (PassScore 50) with one correct + one wrong answer.
async function buildExam() {
  const ex = await app.request('POST', '/api/exams/tests', { TestName: 'C9 Exam', PassScore: 50 });
  const testId = ex.json().TestID;
  const q = await app.request('POST', `/api/exams/tests/${testId}/questions`, {
    QuestionType: 'single', Question: 'Is the sky blue?', Mandatory: true,
    answers: [{ Answer: 'Yes', correct: true }, { Answer: 'No', correct: false }],
  });
  return { testId, qid: q.json().QID };
}

// 1. Exam + question setup persists.
test('1. exam and question setup can be created', async () => {
  const { testId, qid } = await buildExam();
  assert.ok(testId > 0 && qid > 0);
  const full = await app.request('GET', `/api/exams/tests/${testId}`);
  assert.equal(full.status, 200);
  const body = full.json();
  assert.equal(body.questions.length, 1, 'one question persisted');
  assert.equal(body.questions[0].answers.length, 2, 'two answers persisted');
});

// 2/3. Correct-answer submission scores 100% and passes.
test('2/3. correct answers score 100% and pass', async () => {
  const { testId } = await buildExam();
  const att = await app.request('GET', `/api/exams/tests/${testId}/attempt-questions?empId=${empId}`);
  const q = att.json().questions[0];
  const correctId = q.answers.find((a) => a.IsCorrect).QAID;
  const sub = await app.request('POST', '/api/exams/submit', { testId, empId, answers: { [q.QID]: [correctId] } });
  assert.equal(sub.status, 200);
  assert.equal(sub.json().score, 100);
  assert.equal(sub.json().passed, true);
});

// 4. Wrong-answer submission fails.
test('4. wrong answers fail with a low score', async () => {
  const { testId } = await buildExam();
  const att = await app.request('GET', `/api/exams/tests/${testId}/attempt-questions?empId=${empId}`);
  const q = att.json().questions[0];
  const wrongId = q.answers.find((a) => !a.IsCorrect).QAID;
  const sub = await app.request('POST', '/api/exams/submit', { testId, empId, answers: { [q.QID]: [wrongId] } });
  assert.equal(sub.status, 200);
  assert.equal(sub.json().passed, false);
  assert.ok(sub.json().score < sub.json().passScore, 'score below pass threshold');
});

// 5. Lock behaviour.
test('5. exam lock is applied', async () => {
  const { testId } = await buildExam();
  const lock = await app.request('PUT', `/api/exams/tests/${testId}/lock`, { locked: true });
  assert.equal(lock.status, 200);
  assert.equal(lock.json().success, true);
  assert.equal(lock.json().locked, 1, 'lock flag persisted as 1');
});
