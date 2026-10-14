const express = require('express');
const router = express.Router();
const multer  = require('multer');
// WP-10 A6.4 — AI calls go through the central AI Gateway (audit + policy +
// provider registry). Prompts/models/max_tokens/messages/streaming/parsing are
// byte-identical.
const aiGateway = require('../lib/ai-gateway');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');
const { recordLegacyAudit } = require('../lib/governance/audit-adapter'); // WP-16 M5 — sanitizing audit (medium-risk; AI content dropped, identifiers masked/capped)
const { fireWorkflow } = require('../lib/workflow');

router.use(requireAuth);

// ---------- Image upload for questions ----------
const IMG_DIR = path.join(__dirname, '..', 'uploads', 'exam');
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });
const imgStore = multer.diskStorage({
  destination: (_, __, cb) => cb(null, IMG_DIR),
  filename: (_, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(f.originalname))
});
const uploadImg = multer({ storage: imgStore, limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_, f, cb) => /image\/(jpeg|png|gif|webp|bmp)/.test(f.mimetype) ? cb(null, true) : cb(new Error('Images only')) });

router.post('/questions/upload-image', uploadImg.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  res.json({ url: '/api/exams/question-image/' + req.file.filename });
});
router.get('/question-image/:name', (req, res) => {
  const f = path.join(IMG_DIR, path.basename(req.params.name));
  if (!fs.existsSync(f)) return res.status(404).send('Not found');
  res.sendFile(f);
});

// ---------- Tests (exam definitions) ----------
router.get('/tests', async (req, res) => {
  try {
    res.json(await dbAll(`SELECT t.*, c.CertName,
      (SELECT COUNT(*) FROM tblQ q WHERE q.TestID=t.TestID) as QuestionCount
      FROM tblTest t LEFT JOIN tblCerts c ON t.CertID=c.CertID
      WHERE (t.TenantID=? OR t.TenantID IS NULL) ORDER BY t.TestName`, [tenantOf(req)]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/tests/:id', async (req, res) => {
  try {
    const test = await dbGet('SELECT * FROM tblTest WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!test) return res.status(404).json({ error: 'Not found' });
    const questions = await dbAll(`SELECT * FROM tblQ WHERE TestID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY "Order",QID`, [req.params.id, tenantOf(req)]);
    for (const q of questions) q.answers = await dbAll('SELECT * FROM tblQA WHERE QID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY QAID', [q.QID, tenantOf(req)]);
    res.json({ ...test, questions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Printable, Word-style exam paper (HTML the browser prints / saves as PDF). Letterhead + trainee/
// trainer details + numbered questions. ?answers=1 shows the correct answers (ANSWER KEY) — but ONLY
// for administrators; any other user always gets the blank questions-only paper. ?course=... overrides
// the course title shown in the header (defaults to the linked qualification, else the exam name).
router.get('/tests/:id/print', async (req, res) => {
  try {
    const { buildExamHtml } = require('../lib/content');
    const test = await dbGet('SELECT * FROM tblTest WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!test) return res.status(404).send('Exam not found');
    const questions = await dbAll(`SELECT * FROM tblQ WHERE TestID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY "Order",QID`, [req.params.id, tenantOf(req)]);
    for (const q of questions) q.answers = await dbAll('SELECT * FROM tblQA WHERE QID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY QAID', [q.QID, tenantOf(req)]);
    // Answers are visible only to an administrator; everyone else always prints the blank paper.
    const showAnswers = req.query.answers === '1' && !!(req.session.user && req.session.user.admin);
    const [nameCfg, logoCfg] = await Promise.all([
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, [])
    ]);
    const companyName = (nameCfg && nameCfg.cvalue) ? nameCfg.cvalue.trim() : '';
    const companyLogo = (logoCfg && logoCfg.cvalue) ? logoCfg.cvalue : '';
    let courseTitle = (req.query.course || '').toString().trim();
    if (!courseTitle && test.CertID) {
      try { const c = await dbGet('SELECT CertName FROM tblCerts WHERE CertID=?', [test.CertID]); if (c && c.CertName) courseTitle = c.CertName.trim(); } catch {}
    }
    if (!courseTitle) courseTitle = test.TestName || 'Assessment';
    const html = buildExamHtml(
      { title: courseTitle, examName: test.TestName, passScore: test.PassScore, instructions: test.Instructions, questions },
      { showAnswers, companyName, companyLogo, courseTitle });
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch (e) { res.status(500).send('Print failed: ' + e.message); }
});

// Translate an exam's questions + answers into a target language (bilingual, in place).
// Uses the approved terminology glossary, like the Content Studio translate function.
router.put('/tests/:id/translate', async (req, res) => {
  try {
    if (!req.session.user.admin) return res.status(403).json({ error: 'Admin only' });
    const targetLang = (req.body.targetLang || '').trim();
    if (!targetLang) return res.status(400).json({ error: 'Choose a target language.' });
    const { translateSection } = require('../lib/content');
    const { langCodeFromName } = require('../lib/translate');
    const code = langCodeFromName(targetLang);
    let glossary = [];
    if (code) glossary = await dbAll('SELECT SourceTerm, TargetTerm FROM tblTerminology WHERE LangCode=?', [code]);

    // KB context — like Content Studio: caller passes kbArticleIds of published KB articles to use as site reference
    let kbContext = '';
    const kbArticleIds = Array.isArray(req.body.kbArticleIds) ? req.body.kbArticleIds.map(n => parseInt(n, 10)).filter(Boolean) : [];
    if (kbArticleIds.length) {
      const ph = kbArticleIds.map(() => '?').join(',');
      const kbRows = await dbAll(`SELECT Title, Body FROM tblKBArticle WHERE ArticleID IN (${ph}) AND Status='Published'`, kbArticleIds);
      if (kbRows.length) kbContext = kbRows.map(r => `[${r.Title}]\n${r.Body}`).join('\n\n---\n\n');
    }

    const questions = await dbAll(`SELECT * FROM tblQ WHERE TestID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY "Order",QID`, [req.params.id, tenantOf(req)]);
    if (!questions.length) return res.status(400).json({ error: 'This exam has no questions to translate.' });
    for (const q of questions) q.answers = await dbAll('SELECT * FROM tblQA WHERE QID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY QAID', [q.QID, tenantOf(req)]);
    const marker = `[${targetLang}]`;

    // Build a compact JSON payload of just the source strings and translate it
    const payload = { questions: questions.map(q => ({
      question: q.Question || '', info: q.InfoText || '', answers: (q.answers || []).map(a => a.Answer || '')
    })) };
    const tr = await translateSection(payload, targetLang, glossary, kbContext);
    const trQs = (tr && tr.questions) || [];

    const biling = (orig, t) => {
      orig = orig || '';
      if (!t || !t.trim() || orig.includes(marker)) return orig; // skip empty / already-bilingual
      return `${orig}\n${marker} ${t.trim()}`;
    };
    let updated = 0;
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i], t = trQs[i] || {};
      const newQ = biling(q.Question, t.question);
      const newInfo = biling(q.InfoText, t.info);
      if (newQ !== q.Question || newInfo !== q.InfoText) { await dbRun('UPDATE tblQ SET Question=?, InfoText=? WHERE QID=? AND (TenantID=? OR TenantID IS NULL)', [newQ, newInfo, q.QID, tenantOf(req)]); updated++; }
      const tAns = t.answers || [];
      for (let j = 0; j < (q.answers || []).length; j++) {
        const a = q.answers[j];
        const newA = biling(a.Answer, tAns[j]);
        if (newA !== a.Answer) await dbRun('UPDATE tblQA SET Answer=? WHERE QAID=? AND (TenantID=? OR TenantID IS NULL)', [newA, a.QAID, tenantOf(req)]);
      }
    }
    await recordLegacyAudit(req.session.user.username, 'Exam', 'TRANSLATE', req.params.id, targetLang, null, null);
    res.json({ success: true, language: targetLang, glossaryTerms: glossary.length, kbArticles: kbArticleIds.length, questions: questions.length, updated });
  } catch (e) { res.status(500).json({ error: 'Translation failed: ' + e.message }); }
});

// Translate a SINGLE question (with its answers) — used by the per-question 🌐 button.
router.put('/questions/:qid/translate', async (req, res) => {
  try {
    if (!req.session.user.admin) return res.status(403).json({ error: 'Admin only' });
    const targetLang = (req.body.targetLang || '').trim();
    if (!targetLang) return res.status(400).json({ error: 'Choose a target language.' });
    const { translateSection } = require('../lib/content');
    const { langCodeFromName } = require('../lib/translate');
    const code = langCodeFromName(targetLang);
    let glossary = [];
    if (code) glossary = await dbAll('SELECT SourceTerm, TargetTerm FROM tblTerminology WHERE LangCode=?', [code]);

    let kbContext = '';
    const kbArticleIds = Array.isArray(req.body.kbArticleIds) ? req.body.kbArticleIds.map(n => parseInt(n, 10)).filter(Boolean) : [];
    if (kbArticleIds.length) {
      const ph = kbArticleIds.map(() => '?').join(',');
      const kbRows = await dbAll(`SELECT Title, Body FROM tblKBArticle WHERE ArticleID IN (${ph}) AND Status='Published'`, kbArticleIds);
      if (kbRows.length) kbContext = kbRows.map(r => `[${r.Title}]\n${r.Body}`).join('\n\n---\n\n');
    }

    const q = await dbGet('SELECT * FROM tblQ WHERE QID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.qid, tenantOf(req)]);
    if (!q) return res.status(404).json({ error: 'Question not found.' });
    const answers = await dbAll('SELECT * FROM tblQA WHERE QID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY QAID', [q.QID, tenantOf(req)]);

    const payload = { question: q.Question || '', info: q.InfoText || '', answers: answers.map(a => a.Answer || '') };
    const tr = await translateSection(payload, targetLang, glossary, kbContext);

    const marker = `[${targetLang}]`;
    const biling = (orig, t) => {
      orig = orig || '';
      if (!t || !t.trim() || orig.includes(marker)) return orig;
      return `${orig}\n${marker} ${t.trim()}`;
    };
    const newQ = biling(q.Question, tr.question);
    const newInfo = biling(q.InfoText, tr.info);
    if (newQ !== q.Question || newInfo !== q.InfoText) {
      await dbRun('UPDATE tblQ SET Question=?, InfoText=? WHERE QID=? AND (TenantID=? OR TenantID IS NULL)', [newQ, newInfo, q.QID, tenantOf(req)]);
    }
    const tAns = (tr && tr.answers) || [];
    for (let i = 0; i < answers.length; i++) {
      const a = answers[i];
      const newA = biling(a.Answer, tAns[i]);
      if (newA !== a.Answer) await dbRun('UPDATE tblQA SET Answer=? WHERE QAID=? AND (TenantID=? OR TenantID IS NULL)', [newA, a.QAID, tenantOf(req)]);
    }
    res.json({ success: true, language: targetLang, glossaryTerms: glossary.length, kbArticles: kbArticleIds.length });
  } catch (e) { res.status(500).json({ error: 'Translation failed: ' + e.message }); }
});

router.post('/tests', async (req, res) => {
  try {
    const d = req.body;
    const r = await dbRun(`INSERT INTO tblTest (TestName,CertID,PassScore,TimeLimit,Instructions,Randomize,QPerExam,ShowAnswers,TenantID)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [d.TestName, d.CertID||null, d.PassScore||80, d.TimeLimit||null, d.Instructions,
       d.Randomize!==false?1:0, d.QPerExam||null, d.ShowAnswers!==false?1:0, tenantOf(req)]);
    res.json({ TestID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/tests/:id', async (req, res) => {
  try {
    const d = req.body;
    await dbRun(`UPDATE tblTest SET TestName=?,CertID=?,PassScore=?,TimeLimit=?,Instructions=?,Randomize=?,QPerExam=?,ShowAnswers=? WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)`,
      [d.TestName, d.CertID||null, d.PassScore||80, d.TimeLimit||null, d.Instructions,
       d.Randomize!==false?1:0, d.QPerExam||null, d.ShowAnswers!==false?1:0, req.params.id, tenantOf(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lock / unlock an exam (publish). Unlock is admin-only.
router.put('/tests/:id/lock', async (req, res) => {
  try {
    const locked = req.body.locked ? 1 : 0;
    if (!locked && !(req.session.user && req.session.user.admin)) return res.status(403).json({ error: 'Only an administrator can unlock an exam.' });
    await dbRun('UPDATE tblTest SET Locked=? WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)', [locked, req.params.id, tenantOf(req)]);
    try { await recordLegacyAudit(req, locked ? 'lock' : 'unlock', 'exam', req.params.id); } catch (_) {}
    res.json({ success: true, locked });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- AI: extract questions & answers from an uploaded document ----------
// POST multipart: file=<docx|pdf|txt|image>; body: count? typeMix? difficulty?
// Inserts the extracted questions directly into tblQ/tblQA for the given exam.
const uploadExtract = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

router.post('/tests/:id/ai-extract', uploadExtract.single('file'), async (req, res) => {
  try {
    if (!(req.session.user && req.session.user.admin)) return res.status(403).json({ error: 'Admin only.' });
    if (!req.file) return res.status(400).json({ error: 'Upload a document (DOCX, PDF, image, or TXT) first.' });
    const test = await dbGet('SELECT TestID, TestName, Locked FROM tblTest WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!test) return res.status(404).json({ error: 'Exam not found.' });
    if (test.Locked) return res.status(409).json({ error: 'Unlock the exam before adding AI-generated questions.' });

    const ext = ((req.file.originalname.match(/\.([a-z0-9]+)$/i) || [, ''])[1] || '').toLowerCase();
    const ALLOWED = ['docx', 'pdf', 'pptx', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'txt'];
    if (!ALLOWED.includes(ext)) return res.status(400).json({ error: 'Unsupported file type. Use DOCX, PDF, image, or TXT.' });

    // Build the Claude content: text from DOCX/TXT, or a vision block for PDF/image.
    const { extractDocxText, extractDocxImages, extractPptxText } = require('../lib/content');
    let sourceText = '';
    const blocks = [];
    if (ext === 'docx') {
      sourceText = extractDocxText(req.file.buffer);
      // include embedded images so diagrams/photos can become Q&A material
      blocks.push(...extractDocxImages(req.file.buffer, { max: 4, minBytes: 8000 }));
    } else if (ext === 'pptx') {
      sourceText = extractPptxText(req.file.buffer);
    } else if (ext === 'txt') {
      sourceText = req.file.buffer.toString('utf8');
    } else if (ext === 'pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: req.file.buffer.toString('base64') } });
    } else {
      const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
      blocks.push({ type: 'image', source: { type: 'base64', media_type: MIME[ext] || 'image/png', data: req.file.buffer.toString('base64') } });
    }

    const wantedCount = Math.max(1, Math.min(50, parseInt(req.body.count, 10) || 10));
    const typeMix = (req.body.typeMix || 'mixed').toLowerCase(); // 'single' | 'multi' | 'truefalse' | 'mixed'
    const difficulty = (req.body.difficulty || 'medium').toLowerCase(); // easy | medium | hard

    const sys = `You are an assessment writer for a mining-industry training system. Read the supplied source document and design a high-quality competency exam from it.

OUTPUT FORMAT — return ONLY valid JSON (no markdown fences, no commentary):
{ "questions": [
  { "type": "single|multi|truefalse",
    "question": "Question text (one clear sentence ending with '?')",
    "answers": [
      { "text": "Answer option text", "isCorrect": true|false }
    ]
  }
] }

RULES:
1. Base every question on facts actually present in the source. Do NOT invent details that aren't there.
2. "single" questions = exactly ONE answer with isCorrect:true and 3–4 plausible distractors.
3. "multi" questions = TWO OR MORE answers with isCorrect:true (max 5 options total).
4. "truefalse" questions = exactly TWO answers: "True" and "False" — one isCorrect:true.
5. Distractors must be plausible but unambiguously wrong (no trick questions, no overlapping options).
6. Cover the key competencies / safety-critical facts in the source — not trivia.
7. Question wording must stand alone (don't say "according to section 3" or "as shown above").
8. NEVER reuse identical wording across questions.`;

    const taskParts = [
      `Generate ${wantedCount} ${difficulty} questions from the attached source.`,
      typeMix === 'mixed'
        ? `Use a mix of single-choice, multi-select, and true/false — favour single-choice.`
        : `Question type: ${typeMix === 'truefalse' ? 'true/false' : typeMix} only.`,
      sourceText ? `\n\nSOURCE TEXT:\n"""${sourceText.slice(0, 30000)}"""` : '',
    ].filter(Boolean).join(' ');
    const content = blocks.length ? [...blocks, { type: 'text', text: taskParts }] : taskParts;

    const msg = await aiGateway.complete({
      provider: 'anthropic',
      agent: 'AI-LRN-001',
      operation: 'question_extract',
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: sys,
      messages: [{ role: 'user', content }]
    });
    const raw = ((msg.content.find(b => b.type === 'text') || {}).text || '').trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch {
      const m = cleaned.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch {} }
      if (!parsed) return res.status(502).json({ error: 'The AI returned an unexpected format. Try a different source document.' });
    }
    const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
    if (!questions.length) return res.status(422).json({ error: 'The AI did not return any questions — the document may not contain enough content. Try a richer source.' });

    // Decide the starting "Order" value so AI questions append after existing ones.
    const ordRow = await dbGet('SELECT COALESCE(MAX("Order"), 0) AS maxOrder FROM tblQ WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    let order = ordRow.maxOrder || 0;
    const letters = ['A','B','C','D','E','F','G','H'];

    await dbRun('BEGIN');
    let inserted = 0;
    try {
      for (const q of questions) {
        const type = ['single','multi','truefalse'].includes(q.type) ? q.type : 'single';
        const answers = Array.isArray(q.answers) ? q.answers.filter(a => a && (a.text || '').trim()) : [];
        if (!q.question || !answers.length) continue;
        // Ensure at least one correct (single → mark the first if AI forgot)
        if (!answers.some(a => a.isCorrect)) answers[0].isCorrect = true;
        const r = await dbRun(
          `INSERT INTO tblQ (TestID, Question, QuestionType, Mandatory, "Order", NumAns, TenantID) VALUES (?,?,?,0,?,?,?)`,
          [req.params.id, String(q.question).trim(), type, ++order, answers.length, tenantOf(req)]);
        for (let i = 0; i < answers.length; i++) {
          await dbRun(
            `INSERT INTO tblQA (QID, Answer, Points, IsCorrect, AnswerLetter, TenantID) VALUES (?,?,?,?,?,?)`,
            [r.lastID, String(answers[i].text).trim(), answers[i].isCorrect ? 1 : 0, answers[i].isCorrect ? 1 : 0, letters[i] || String(i+1), tenantOf(req)]);
        }
        inserted++;
      }
      await dbRun('COMMIT');
    } catch (txErr) {
      try { await dbRun('ROLLBACK'); } catch {}
      throw txErr;
    }

    try {
      const user = (req.session.user && req.session.user.username) || 'system';
      await recordLegacyAudit(user, 'tblQ', 'AI-EXTRACT', req.params.id, null, req.file.originalname || ext, `${inserted} questions`);
    } catch {}

    res.json({ success: true, inserted, source: req.file.originalname || ('upload.' + ext) });
  } catch (e) {
    res.status(500).json({ error: 'AI extract failed: ' + (e && e.message ? e.message : String(e)) });
  }
});

router.delete('/tests/:id', async (req, res) => {
  const id = req.params.id;
  try {
    if (!(req.session.user && req.session.user.admin)) return res.status(403).json({ error: 'Only an administrator can delete an exam.' });
    const test = await dbGet('SELECT TestID, TestName FROM tblTest WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)', [id, tenantOf(req)]);
    if (!test) return res.status(404).json({ error: 'Exam not found.' });

    // Count what will be cascaded so we can report it back and audit it.
    const qRow  = await dbGet('SELECT COUNT(*) AS n FROM tblQ WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)', [id, tenantOf(req)]);
    const exRow = await dbGet('SELECT COUNT(*) AS n FROM tblExam WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)', [id, tenantOf(req)]);
    const wrRow = await dbGet('SELECT COUNT(*) AS n FROM tblExamWrongQ WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)', [id, tenantOf(req)]);
    // tblExamScore links via ExamID (not TestID) — find the attempts first
    const attempts = await dbAll('SELECT ExamID FROM tblExam WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)', [id, tenantOf(req)]);
    const scoreCount = attempts.length
      ? (await dbGet(`SELECT COUNT(*) AS n FROM tblExamScore WHERE ExamID IN (${attempts.map(()=>'?').join(',')}) AND (TenantID=? OR TenantID IS NULL)`, [...attempts.map(a => a.ExamID), tenantOf(req)]) || { n: 0 }).n
      : 0;

    // Cascade in dependency order. Each statement is small; wrap in a transaction so a
    // partial delete can't leave the exam in a broken state.
    await dbRun('BEGIN');
    try {
      const qs = await dbAll('SELECT QID FROM tblQ WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)', [id, tenantOf(req)]);
      const qIds = qs.map(q => q.QID);
      const examIds = attempts.map(a => a.ExamID);
      // Delete tblScore FIRST — it has FKs back to tblQ, tblQA, and tblExam, so it
      // must go before any of those, or the cascade hits FOREIGN KEY constraint failed.
      if (examIds.length) {
        await dbRun(`DELETE FROM tblScore WHERE ExamID IN (${examIds.map(()=>'?').join(',')})`, examIds);
      }
      if (qIds.length) {
        await dbRun(`DELETE FROM tblScore WHERE QID IN (${qIds.map(()=>'?').join(',')})`, qIds);
      }
      // Per-question answers (referenced by tblScore.QAID, now cleared)
      for (const qid of qIds) await dbRun('DELETE FROM tblQA WHERE QID=?', [qid]);
      // Wrong-answer learning history
      await dbRun('DELETE FROM tblExamWrongQ WHERE TestID=?', [id]);
      // Legacy score-summary rows that reference an ExamID (no FK, but clean orphans)
      if (examIds.length) {
        await dbRun(`DELETE FROM tblExamScore WHERE ExamID IN (${examIds.map(()=>'?').join(',')})`, examIds);
      }
      // Attempts (FK → tblTest.TestID, also referenced by tblScore which is now cleared)
      await dbRun('DELETE FROM tblExam WHERE TestID=?', [id]);
      // Questions (FK → tblTest.TestID)
      await dbRun('DELETE FROM tblQ WHERE TestID=?', [id]);
      // The exam itself
      await dbRun('DELETE FROM tblTest WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)', [id, tenantOf(req)]);
      await dbRun('COMMIT');
    } catch (txErr) {
      try { await dbRun('ROLLBACK'); } catch {}
      throw txErr;
    }

    try {
      const user = (req.session && req.session.user && req.session.user.username) || 'system';
      const detail = `${test.TestName} (q:${qRow.n}, attempts:${exRow.n}, scores:${scoreCount}, wrongQ:${wrRow.n})`;
      await recordLegacyAudit(user, 'tblTest', 'DELETE', id, null, detail, null);
    } catch {}

    res.json({
      success: true,
      deleted: { exam: test.TestName, questions: qRow.n, attempts: exRow.n, scores: scoreCount, wrongQ: wrRow.n }
    });
  } catch (e) {
    res.status(500).json({ error: 'Delete failed: ' + e.message });
  }
});

// ---------- Question Bank — all questions across tests, filterable ----------
router.get('/bank', async (req, res) => {
  try {
    const { testId, tag, type, search } = req.query;
    let sql = `SELECT q.*, t.TestName FROM tblQ q LEFT JOIN tblTest t ON q.TestID=t.TestID WHERE 1=1 AND (q.TenantID=? OR q.TenantID IS NULL)`;
    const p = [tenantOf(req)];
    if (testId) { sql += ' AND q.TestID=?'; p.push(testId); }
    if (tag)    { sql += ' AND q.BankTag LIKE ?'; p.push('%'+tag+'%'); }
    if (type)   { sql += ' AND q.QuestionType=?'; p.push(type); }
    if (search) { sql += ' AND q.Question LIKE ?'; p.push('%'+search+'%'); }
    sql += ' ORDER BY q.TestID, q."Order"';
    const rows = await dbAll(sql, p);
    for (const q of rows) q.answers = await dbAll('SELECT * FROM tblQA WHERE QID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY QAID', [q.QID, tenantOf(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// All distinct bank tags
router.get('/bank/tags', async (req, res) => {
  try {
    const rows = await dbAll(`SELECT BankTag FROM tblQ WHERE BankTag IS NOT NULL AND BankTag!='' AND (TenantID=? OR TenantID IS NULL) GROUP BY BankTag ORDER BY BankTag`, [tenantOf(req)]);
    res.json(rows.map(r => r.BankTag));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Questions + answers ----------
router.post('/tests/:id/questions', async (req, res) => {
  try {
    const d = req.body;
    const order = ((await dbGet('SELECT COALESCE(MAX("Order"),0)+1 as o FROM tblQ WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]))||{o:1}).o;
    const q = await dbRun(`INSERT INTO tblQ (TestID,Question,QuestionType,VideoUrl,Qimage,BankTag,InfoText,Mandatory,"Order",NumAns,TenantID)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [req.params.id, d.Question, d.QuestionType||'multi', d.VideoUrl||null, d.Qimage||null,
       d.BankTag||null, d.InfoText||null, d.Mandatory?1:0, order, (d.answers||[]).length, tenantOf(req)]);
    const letters = ['A','B','C','D','E','F','G','H'];
    for (let i=0; i<(d.answers||[]).length; i++) {
      const a = d.answers[i];
      await dbRun('INSERT INTO tblQA (QID,Answer,Points,IsCorrect,AnswerLetter,TenantID) VALUES (?,?,?,?,?,?)',
        [q.lastID, a.Answer, a.correct?1:0, a.correct?1:0, letters[i], tenantOf(req)]);
    }
    res.json({ QID: q.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Bulk import questions from a CSV (parsed to rows on the client) ----------
router.post('/tests/:id/import-questions', async (req, res) => {
  try {
    const testId = req.params.id;
    const rows = req.body.rows || [];
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows to import.' });
    const test = await dbGet('SELECT TestID FROM tblTest WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)', [testId, tenantOf(req)]);
    if (!test) return res.status(404).json({ error: 'Exam not found.' });

    const letters = ['A','B','C','D','E','F','G','H'];
    const truthy = v => /^(yes|y|true|1|x|correct)$/i.test(String(v||'').trim());
    const normType = t => {
      t = String(t||'').toLowerCase().trim();
      if (/multi/.test(t)) return 'multi';
      if (/true|false|t\/f|tf/.test(t)) return 'truefalse';
      return 'single';
    };
    let order = ((await dbGet('SELECT COALESCE(MAX("Order"),0) as o FROM tblQ WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)', [testId, tenantOf(req)]))||{o:0}).o;
    let imported = 0; const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const ln = i + 2; // header is row 1
      const question = (r.Question || r.question || '').trim();
      if (!question) { errors.push(`Row ${ln}: missing question text`); continue; }
      const type = normType(r.Type || r.QuestionType || r.type);

      // Build the answer list
      let answers = [];
      if (type === 'truefalse') {
        const correct = String(r.Correct || r.correct || '').toLowerCase().trim();
        const trueIsCorrect = /^(true|t|1|yes)$/.test(correct);
        answers = [{ Answer: 'True', correct: trueIsCorrect }, { Answer: 'False', correct: !trueIsCorrect }];
      } else {
        for (let a = 1; a <= 8; a++) {
          const txt = (r['Answer'+a] || r['answer'+a] || '').trim();
          if (txt) answers.push({ Answer: txt, correct: false });
        }
        // Correct = comma-separated 1-based indices, e.g. "1" or "1,3"
        const idxs = String(r.Correct || r.correct || '').split(/[,;]/).map(s => parseInt(s.trim(),10)).filter(n => n>0);
        idxs.forEach(n => { if (answers[n-1]) answers[n-1].correct = true; });
        if (answers.length < 2) { errors.push(`Row ${ln}: needs at least 2 answers`); continue; }
        if (!answers.some(a => a.correct)) { errors.push(`Row ${ln}: no correct answer marked (check the Correct column)`); continue; }
      }

      order++;
      const q = await dbRun(`INSERT INTO tblQ (TestID,Question,QuestionType,BankTag,Mandatory,"Order",NumAns,TenantID)
        VALUES (?,?,?,?,?,?,?,?)`,
        [testId, question, type, (r.Tag||r.BankTag||'').trim()||null, truthy(r.Mandatory)?1:0, order, answers.length, tenantOf(req)]);
      for (let a = 0; a < answers.length; a++) {
        await dbRun('INSERT INTO tblQA (QID,Answer,Points,IsCorrect,AnswerLetter,TenantID) VALUES (?,?,?,?,?,?)',
          [q.lastID, answers[a].Answer, answers[a].correct?1:0, answers[a].correct?1:0, letters[a], tenantOf(req)]);
      }
      imported++;
    }
    res.json({ success: true, imported, skipped: errors.length, errors });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/questions/:qid', async (req, res) => {
  try {
    const d = req.body;
    await dbRun(`UPDATE tblQ SET Question=?,QuestionType=?,VideoUrl=?,Qimage=?,BankTag=?,InfoText=?,Mandatory=? WHERE QID=? AND (TenantID=? OR TenantID IS NULL)`,
      [d.Question, d.QuestionType||'multi', d.VideoUrl||null, d.Qimage||null, d.BankTag||null, d.InfoText||null, d.Mandatory?1:0, req.params.qid, tenantOf(req)]);
    if (d.answers) {
      await dbRun('DELETE FROM tblQA WHERE QID=?', [req.params.qid]);
      const letters = ['A','B','C','D','E','F','G','H'];
      for (let i=0; i<d.answers.length; i++) {
        const a = d.answers[i];
        await dbRun('INSERT INTO tblQA (QID,Answer,Points,IsCorrect,AnswerLetter,TenantID) VALUES (?,?,?,?,?,?)',
          [req.params.qid, a.Answer, a.correct?1:0, a.correct?1:0, letters[i], tenantOf(req)]);
      }
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Quick toggle: mark a question mandatory (always in exam) or optional (random pool)
router.put('/questions/:qid/mandatory', async (req, res) => {
  try {
    await dbRun('UPDATE tblQ SET Mandatory=? WHERE QID=? AND (TenantID=? OR TenantID IS NULL)', [req.body.mandatory ? 1 : 0, req.params.qid, tenantOf(req)]);
    res.json({ success: true, mandatory: req.body.mandatory ? 1 : 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/questions/:qid/order', async (req, res) => {
  try {
    await dbRun('UPDATE tblQ SET "Order"=? WHERE QID=? AND (TenantID=? OR TenantID IS NULL)', [req.body.order, req.params.qid, tenantOf(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/questions/:qid', async (req, res) => {
  try {
    await dbRun('DELETE FROM tblQA WHERE QID=?', [req.params.qid]);
    await dbRun('DELETE FROM tblQ WHERE QID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.qid, tenantOf(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Questions for an exam attempt (weighted by wrong-answer history) ----------
router.get('/tests/:id/attempt-questions', async (req, res) => {
  try {
    const empId = req.query.empId || null;
    const test = await dbGet('SELECT * FROM tblTest WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!test) return res.status(404).json({ error: 'Test not found' });
    let questions = await dbAll(`SELECT q.*,
      COALESCE(w.WrongCount,0) as WrongCount
      FROM tblQ q LEFT JOIN tblExamWrongQ w ON w.QID=q.QID AND w.EmpID=? AND w.TestID=?
      WHERE q.TestID=? AND (q.TenantID=? OR q.TenantID IS NULL) ORDER BY q."Order"`, [empId||0, req.params.id, req.params.id, tenantOf(req)]);
    // Split into groups: info blocks (always shown), mandatory (always shown),
    // and the optional pool (randomly drawn, weighted by the employee's wrong-answer history).
    const infos     = questions.filter(q => q.QuestionType === 'info');
    const mandatory = questions.filter(q => q.QuestionType !== 'info' && q.Mandatory);
    let   pool      = questions.filter(q => q.QuestionType !== 'info' && !q.Mandatory);

    // Weight the optional pool so questions the employee previously got wrong float to the top
    pool = test.Randomize ? weightedShuffle(pool) : pool;

    // Decide how many scored questions to show in total
    const scoredCount = mandatory.length + pool.length;
    let perExam = (test.QPerExam && test.QPerExam > 0) ? test.QPerExam : scoredCount;
    if (perExam < mandatory.length) perExam = mandatory.length; // never drop a mandatory question

    // Always include every mandatory question, then top up from the optional pool
    const fillCount = Math.max(0, perExam - mandatory.length);
    const chosenPool = pool.slice(0, fillCount);

    let scored = [...mandatory, ...chosenPool];
    if (test.Randomize) scored = weightedShuffle(scored);

    // Re-attach info blocks, shuffled in if randomising
    questions = shuffleInInfos(infos, scored, test.Randomize);
    for (const q of questions) {
      const ans = await dbAll('SELECT QAID,Answer,AnswerLetter,IsCorrect FROM tblQA WHERE QID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY QAID', [q.QID, tenantOf(req)]);
      // Shuffle answers for randomised exams (but keep correct flag hidden)
      q.answers = test.Randomize ? shuffleArray(ans) : ans;
    }
    res.json({ test, questions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function weightedShuffle(arr) {
  // Each item gets a random value multiplied by (1 + WrongCount) → wrong items float up more
  return arr.map(q => ({ q, w: Math.random() * (1 + (q.WrongCount || 0)) * 2 }))
            .sort((a, b) => b.w - a.w).map(x => x.q);
}
function shuffleArray(arr) { return [...arr].sort(() => Math.random() - 0.5); }
function shuffleInInfos(infos, scored, randomize) {
  if (!randomize) return [...infos, ...scored];
  const all = [...infos, ...scored]; return shuffleArray(all);
}

// ---------- Submit exam — auto-score, track wrong answers ----------
router.post('/submit', async (req, res) => {
  try {
    const { testId, empId, answers } = req.body; // answers: {QID: [QAID,...]}
    const test = await dbGet('SELECT * FROM tblTest WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)', [testId, tenantOf(req)]);
    if (!test) return res.status(404).json({ error: 'Test not found' });
    const questions = await dbAll(`SELECT q.* FROM tblQ q WHERE q.TestID=? AND q.QuestionType!='info' AND (q.TenantID=? OR q.TenantID IS NULL)`, [testId, tenantOf(req)]);
    if (!questions.length) return res.status(400).json({ error: 'This exam has no questions.' });

    const exam = await dbRun("INSERT INTO tblExam (TestID,ExamDate,EmpID,TenantID) VALUES (?,date('now'),?,?)", [testId, empId||null, tenantOf(req)]);
    let correct = 0, total = 0;
    const results = [];

    for (const q of questions) {
      const correctAnswers = await dbAll('SELECT QAID FROM tblQA WHERE QID=? AND IsCorrect=1 AND (TenantID=? OR TenantID IS NULL)', [q.QID, tenantOf(req)]);
      const correctIds = correctAnswers.map(a => a.QAID).sort().join(',');
      const allAnswers  = await dbAll('SELECT QAID,Answer,IsCorrect,AnswerLetter FROM tblQA WHERE QID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY QAID', [q.QID, tenantOf(req)]);
      const submitted   = [].concat(answers[q.QID] || []).map(Number).sort().join(',');
      const isCorrect   = correctIds === submitted;
      if (isCorrect) correct++;
      total++;

      await dbRun('INSERT INTO tblScore (ExamID,QID,QAID,Selected,Score,Points,TenantID) VALUES (?,?,?,?,?,?,?)',
        [exam.lastID, q.QID, submitted || null, submitted ? 1 : 0, isCorrect ? 1 : 0, isCorrect ? 1 : 0, tenantOf(req)]);

      // Update wrong-answer tracking
      if (empId) {
        if (isCorrect) {
          // Reduce wrong count on correct answer (min 0)
          await dbRun(`UPDATE tblExamWrongQ SET WrongCount=MAX(0,WrongCount-1), LastWrong=date('now')
            WHERE EmpID=? AND TestID=? AND QID=? AND (TenantID=? OR TenantID IS NULL)`, [empId, testId, q.QID, tenantOf(req)]);
        } else {
          // Increment wrong count
          await dbRun(`INSERT INTO tblExamWrongQ (EmpID,TestID,QID,WrongCount,LastWrong,TenantID) VALUES (?,?,?,1,date('now'),?)
            ON CONFLICT(EmpID,TestID,QID) DO UPDATE SET WrongCount=WrongCount+1, LastWrong=date('now')`, [empId, testId, q.QID, tenantOf(req)]);
        }
      }
      results.push({ QID: q.QID, question: q.Question, isCorrect, correctAnswers: allAnswers.filter(a=>a.IsCorrect), submitted: submitted.split(',').map(Number).filter(Boolean), allAnswers });
    }

    const scorePct = total ? Math.round(correct / total * 100) : 100;
    const passed = scorePct >= (test.PassScore || 80);

    // Auto-create training record on pass
    let registerId = null;
    if (passed && test.CertID && empId) {
      const cert = await dbGet('SELECT Months FROM tblCerts WHERE CertID=?', [test.CertID]);
      let exp = null;
      if (cert && cert.Months) { const dd = new Date(); dd.setMonth(dd.getMonth() + cert.Months); exp = dd.toISOString().split('T')[0]; }
      const reg = await dbRun(`INSERT INTO tblRegister (StaffID,CertID,Complete,Exp,Score,Pass,State,ExamID,LastUpdateBy)
        VALUES (?,?,date('now'),?,?,1,'Completed',?,?)`,
        [empId, test.CertID, exp, scorePct, exam.lastID, req.session.user.username]);
      registerId = reg.lastID;
      // Workflow: qualification awarded via exam pass
      try {
        const aw = await dbGet(`SELECT s.FirstName,s.LastName,s.Email,sup.Email AS SupEmail,c.CertName
          FROM tblStaff s LEFT JOIN tblStaff sup ON sup.StaffID=s.SupID, tblCerts c
          WHERE s.StaffID=? AND c.CertID=?`, [empId, test.CertID]);
        if (aw) await fireWorkflow('cert_awarded', {
          employeeEmail: aw.Email, supervisorEmail: aw.SupEmail,
          vars: { Employee: `${aw.FirstName||''} ${aw.LastName||''}`.trim(), Qualification: aw.CertName||'', Score: scorePct + '%', Expires: exp||'—', Date: new Date().toISOString().slice(0,10) }
        });
      } catch (_) {}
    }
    await recordLegacyAudit(req.session.user.username, 'tblExam', 'EXAM', exam.lastID, 'Score', null, `${scorePct}% (${passed?'PASS':'FAIL'})`);
    // Fire pass/fail workflow notifications
    if (empId) {
      try {
        const info = await dbGet(`SELECT s.FirstName,s.LastName,s.Email,sup.Email AS SupEmail
          FROM tblStaff s LEFT JOIN tblStaff sup ON sup.StaffID=s.SupID WHERE s.StaffID=?`, [empId]);
        if (info) {
          const fullName = `${info.FirstName||''} ${info.LastName||''}`.trim();
          await fireWorkflow(passed ? 'exam_passed' : 'exam_failed', {
            employeeEmail: info.Email, supervisorEmail: info.SupEmail,
            vars: { Employee: fullName, Exam: test.TestName, Score: scorePct + '%', Result: passed ? 'PASS' : 'FAIL', Date: new Date().toISOString().slice(0,10) }
          });
        }
      } catch (_) { /* notifications must not block exam scoring */ }
    }
    res.json({ examId: exam.lastID, score: scorePct, correct, total, passScore: test.PassScore||80, passed, registerId,
               showAnswers: !!test.ShowAnswers, results: test.ShowAnswers ? results : [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Exam history
router.get('/history', async (req, res) => {
  try {
    const { empId, testId } = req.query;
    let sql = `SELECT e.ExamID,e.ExamDate,t.TestName,t.PassScore,s.LastName,s.FirstName,
      (SELECT COUNT(*) FROM tblScore sc WHERE sc.ExamID=e.ExamID) as Total,
      (SELECT SUM(Score) FROM tblScore sc WHERE sc.ExamID=e.ExamID) as Correct
      FROM tblExam e LEFT JOIN tblTest t ON e.TestID=t.TestID LEFT JOIN tblStaff s ON e.EmpID=s.StaffID WHERE 1=1 AND (e.TenantID=? OR e.TenantID IS NULL)`;
    const p = [tenantOf(req)];
    if (empId) { sql += ' AND e.EmpID=?'; p.push(empId); }
    if (testId) { sql += ' AND e.TestID=?'; p.push(testId); }
    sql += ' ORDER BY e.ExamDate DESC, e.ExamID DESC';
    const rows = await dbAll(sql, p);
    rows.forEach(r => { r.ScorePct = r.Total ? Math.round((r.Correct||0)/r.Total*100) : 0; r.Passed = r.ScorePct >= (r.PassScore||80); });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Wrong-answer stats per employee per test
router.get('/weak-areas', async (req, res) => {
  try {
    const { empId, testId } = req.query;
    res.json(await dbAll(`SELECT w.*, q.Question, q.QuestionType, t.TestName
      FROM tblExamWrongQ w JOIN tblQ q ON w.QID=q.QID JOIN tblTest t ON w.TestID=t.TestID
      WHERE w.EmpID=? ${testId?'AND w.TestID=?':''} AND w.WrongCount>0 AND (w.TenantID=? OR w.TenantID IS NULL)
      ORDER BY w.WrongCount DESC`, empId ? (testId ? [empId,testId,tenantOf(req)] : [empId,tenantOf(req)]) : (testId ? [testId,tenantOf(req)] : [tenantOf(req)])));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Certificate: generate and save to employee's documents folder ----
router.post('/certificate/:examId', async (req, res) => {
  try {
    const examId = req.params.examId;
    const exam  = await dbGet('SELECT * FROM tblExam WHERE ExamID=? AND (TenantID=? OR TenantID IS NULL)', [examId, tenantOf(req)]);
    if (!exam) return res.status(404).json({ error: 'Exam not found' });

    const test  = await dbGet('SELECT * FROM tblTest WHERE TestID=? AND (TenantID=? OR TenantID IS NULL)', [exam.TestID, tenantOf(req)]);
    const emp   = exam.EmpID ? await dbGet(`SELECT s.*,d.Department,j.Title as JobTitle FROM tblStaff s
      LEFT JOIN tblDept d ON s.DeptID=d.DeptID LEFT JOIN tblJobs j ON s.JobID=j.JobID
      WHERE s.StaffID=?`, [exam.EmpID]) : null;

    // Calculate score from tblScore
    const total   = await dbGet('SELECT COUNT(*) as n FROM tblScore WHERE ExamID=? AND (TenantID=? OR TenantID IS NULL)', [examId, tenantOf(req)]);
    const correct = await dbGet('SELECT SUM(Score) as n FROM tblScore WHERE ExamID=? AND (TenantID=? OR TenantID IS NULL)', [examId, tenantOf(req)]);
    const scorePct = total.n ? Math.round(((correct.n||0) / total.n) * 100) : 0;
    const passed = scorePct >= (test ? test.PassScore||80 : 80);
    if (!passed) return res.status(400).json({ error: 'Certificate is only issued for passing scores.' });

    // Linked qualification name
    let certName = '';
    if (test && test.CertID) {
      const cert = await dbGet('SELECT CertName FROM tblCerts WHERE CertID=?', [test.CertID]);
      if (cert) certName = cert.CertName;
    }

    const certNum = `CERT-${String(examId).padStart(6,'0')}-${new Date().getFullYear()}`;
    const dateStr = new Date().toLocaleDateString('en-AU', { day:'2-digit', month:'long', year:'numeric' });
    const empName = emp ? `${emp.FirstName} ${emp.LastName}` : (req.body.empName || 'Employee');
    const deptLine = emp ? [emp.JobTitle, emp.Department].filter(Boolean).join(' · ') : '';

    const [coNameCfg, coLogoCfg] = await Promise.all([
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_name'`, []),
      dbGet(`SELECT cvalue FROM tblConfig WHERE ckey='company_logo'`, [])
    ]);
    const companyName = (coNameCfg && coNameCfg.cvalue) ? coNameCfg.cvalue.trim() : '';
    const companyLogo = (coLogoCfg && coLogoCfg.cvalue) ? coLogoCfg.cvalue : '';

    const html = buildCertificateHtml({ certNum, dateStr, empName, deptLine, testName: test ? test.TestName : 'Training Assessment', certName, scorePct, instructions: test ? test.Instructions : '', companyName, companyLogo });

    // Save to employee's documents folder if we have an employee
    let fileId = null;
    if (emp) {
      const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
      const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
      if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const filename = `certificate_${certNum}.html`;
      const storedName = crypto.randomBytes(12).toString('hex') + '.html';
      fs.writeFileSync(path.join(UPLOAD_DIR, storedName), html, 'utf8');
      const fr = await dbRun(`INSERT INTO tblFiles (EntityType,EntityID,FileName,StoredName,MimeType,FileSize,Category,Description,UploadedBy)
        VALUES ('staff',?,?,?,'text/html',?,?,?,?)`,
        [emp.StaffID, filename, storedName, Buffer.byteLength(html,'utf8'), 'Certificate',
         `Exam certificate: ${test ? test.TestName : ''} (${scorePct}%)`, req.session.user.username]);
      fileId = fr.lastID;
    }

    res.json({ success: true, certNum, fileId, html, scorePct, empName, testName: test ? test.TestName : '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function buildCertificateHtml({ certNum, dateStr, empName, deptLine, testName, certName, scorePct, instructions, companyName, companyLogo }) {
  const e = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const brand = companyName || 'TrainingPro';
  const logoHtml = companyLogo
    ? `<img src="${e(companyLogo)}" style="height:52px;max-width:200px;object-fit:contain;display:block">`
    : `<div class="brand">${e(brand)}</div>`;
  const sealHtml = companyLogo
    ? `<img src="${e(companyLogo)}" style="height:44px;max-width:110px;object-fit:contain">`
    : `<div style="font-family:'Playfair Display',serif;font-size:28px;color:#F58220;letter-spacing:-1px">${e(brand.slice(0,2).toUpperCase())}</div>`;
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Certificate – ${e(testName)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=Inter:wght@400;500;600&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',sans-serif;background:#f5f5f0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .cert{background:#fff;width:794px;min-height:562px;padding:56px 64px;border:3px solid #d4af37;border-radius:4px;position:relative;box-shadow:0 8px 40px rgba(0,0,0,.12)}
  .cert::before,.cert::after{content:'';position:absolute;border:1px solid #d4af37;border-radius:2px}
  .cert::before{inset:8px} .cert::after{inset:12px}
  .logo-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:28px}
  .brand{font-family:'Playfair Display',serif;font-size:22px;color:#23272F;font-weight:700}
  .cert-type{font-size:11px;letter-spacing:2.5px;text-transform:uppercase;color:#888;text-align:center;margin-bottom:8px}
  .cert-title{font-family:'Playfair Display',serif;font-size:40px;color:#1a1d28;text-align:center;margin-bottom:6px}
  .cert-sub{font-size:13px;color:#666;text-align:center;margin-bottom:32px}
  .divider{height:2px;background:linear-gradient(90deg,transparent,#d4af37 30%,#d4af37 70%,transparent);margin:0 auto 28px;width:60%}
  .presented{font-size:12px;color:#888;text-align:center;margin-bottom:10px;letter-spacing:1px;text-transform:uppercase}
  .emp-name{font-family:'Playfair Display',serif;font-size:32px;color:#F58220;text-align:center;margin-bottom:8px}
  .dept{font-size:13px;color:#666;text-align:center;margin-bottom:28px}
  .body-text{font-size:14px;color:#444;text-align:center;line-height:1.7;max-width:560px;margin:0 auto 28px}
  .course-name{font-weight:700;color:#1a1d28}
  .score-badge{display:inline-block;background:#F58220;color:#fff;font-size:18px;font-weight:700;padding:8px 24px;border-radius:24px;margin-bottom:28px}
  .sig-row{display:flex;justify-content:space-around;align-items:flex-end;margin-top:20px;gap:24px}
  .sig-col{text-align:center;flex:1}
  .sig-line{border-top:1px solid #999;padding-top:6px;font-size:11px;color:#666}
  .cert-footer{display:flex;justify-content:space-between;margin-top:28px;font-size:10px;color:#aaa;border-top:1px solid #eee;padding-top:10px}
  @media print{body{background:#fff;padding:0}.cert{box-shadow:none;border:2px solid #d4af37;page-break-inside:avoid}.no-print{display:none}}
</style></head><body>
<div class="cert">
  <div class="logo-row">
    ${logoHtml}
    <div style="text-align:right;font-size:11px;color:#aaa">${e(brand)}<br>Training Management System</div>
  </div>
  <div class="cert-type">Certificate of Achievement</div>
  <div class="cert-title">CERTIFICATE</div>
  <div class="cert-sub">${certName ? 'for the attainment of a qualification in' : 'in recognition of successful completion of'}</div>
  <div class="divider"></div>
  <div class="presented">This certifies that</div>
  <div class="emp-name">${e(empName)}</div>
  ${deptLine ? `<div class="dept">${e(deptLine)}</div>` : ''}
  <div class="body-text">has successfully completed all requirements of<br>
    <span class="course-name">${e(testName)}</span>
    ${certName ? `<br>and has been awarded the qualification of<br><span class="course-name">${e(certName)}</span>` : ''}
  </div>
  <div style="text-align:center"><div class="score-badge">${scorePct}% — PASS</div></div>
  <div class="sig-row">
    <div class="sig-col"><div class="sig-line">Assessor / Trainer</div></div>
    <div class="sig-col" style="flex:0 0 140px">${sealHtml}<div style="font-size:10px;color:#aaa;margin-top:4px">${e(brand)}</div></div>
    <div class="sig-col"><div class="sig-line">Candidate Signature</div></div>
  </div>
  <div class="cert-footer">
    <span>Certificate No: ${e(certNum)}</span>
    <span>Date: ${e(dateStr)}</span>
    <span>Issued by ${e(brand)}</span>
  </div>
</div>
<div class="no-print" style="text-align:center;margin-top:20px">
  <button onclick="window.print()" style="padding:12px 28px;background:#F58220;border:none;color:#fff;border-radius:8px;font-size:15px;font-weight:700;cursor:pointer">🖨 Print / Save as PDF</button>
</div>
</body></html>`;
}

// ---- AI-powered answer generation ----
router.post('/ai-suggest', async (req, res) => {
  try {
    const { question, questionType, bankTag, count = 4 } = req.body;
    if (!question || !question.trim()) return res.status(400).json({ error: 'Question text is required.' });

    // 1. Fetch company name from setup
    const companyRow = await dbGet("SELECT cvalue FROM tblConfig WHERE ckey='company_name'");
    const companyName = (companyRow && companyRow.cvalue) ? companyRow.cvalue : 'the company';

    // 2. Search knowledge base for relevant articles
    const q = question.trim();
    const tag = (bankTag || '').trim();
    let kbArticles = [];
    try {
      // Tag-based match first, then keyword search on the question text
      if (tag) {
        kbArticles = await dbAll(
          `SELECT Title, Body, Tags FROM tblKBArticle WHERE Status='Published' AND (Tags LIKE ? OR Title LIKE ?) ORDER BY UpdatedAt DESC LIMIT 3`,
          [`%${tag}%`, `%${tag}%`]
        );
      }
      if (!kbArticles.length) {
        const keywords = q.split(/\s+/).filter(w => w.length > 3).slice(0, 5);
        if (keywords.length) {
          const clause = keywords.map(() => '(Title LIKE ? OR Tags LIKE ? OR Body LIKE ?)').join(' OR ');
          const params = keywords.flatMap(kw => [`%${kw}%`, `%${kw}%`, `%${kw}%`]);
          kbArticles = await dbAll(
            `SELECT Title, Body, Tags FROM tblKBArticle WHERE Status='Published' AND (${clause}) ORDER BY UpdatedAt DESC LIMIT 3`,
            params
          );
        }
      }
    } catch { /* KB unavailable — proceed without context */ }

    // 3. Build KB context block for the prompt
    let kbContext = '';
    if (kbArticles.length) {
      kbContext = `\n\nKNOWLEDGE BASE CONTEXT — from ${companyName}'s internal knowledge base. Use this as the authoritative source. Do NOT contradict it:\n`;
      kbArticles.forEach((art, i) => {
        const snippet = (art.Body || '').replace(/[#*_`]/g, '').substring(0, 400);
        kbContext += `\n[KB Article ${i + 1}] ${art.Title}\n${snippet}${art.Body && art.Body.length > 400 ? '…' : ''}\n`;
      });
    }

    const typeGuide = {
      multi:     `Generate ${count} answer options where MULTIPLE answers can be correct. Mark 2 of them correct.`,
      single:    `Generate ${count} answer options where exactly ONE is correct. Make plausible distractors.`,
      truefalse: `The answers must be exactly "True" and "False". Mark one correct.`,
      image:     `Generate ${count} answer options where exactly ONE is correct.`,
      video:     `Generate ${count} answer options where exactly ONE is correct based on observing the video.`,
    };

    const prompt = `You are an expert assessment author creating exam questions for ${companyName}'s workplace training system.${kbContext}

Question: "${q}"
Question type: ${questionType || 'single'} — ${typeGuide[questionType] || typeGuide.single}
Topic/Tag: ${tag || 'general'}

Return ONLY valid JSON in this exact shape — no markdown, no explanation, just the JSON object:
{
  "answers": [
    {"Answer": "text of answer A", "correct": false},
    {"Answer": "text of answer B", "correct": true},
    {"Answer": "text of answer C", "correct": false},
    {"Answer": "text of answer D", "correct": false}
  ],
  "hint": "One-sentence tip about why these answers were chosen${kbArticles.length ? ', noting which KB article(s) informed the content' : ''}."
}

Rules:
- Answers must be concise (≤ 12 words each)
- Distractors must be plausible — not obviously wrong
- At least one answer MUST be marked correct:true
- For truefalse: exactly 2 answers ("True" and "False")
- For multi: 2 answers correct:true
- For single/image/video: exactly 1 answer correct:true${kbArticles.length ? '\n- Answers MUST align with the knowledge base context above' : ''}`;

    const message = await aiGateway.complete({
      provider: 'anthropic',
      agent: 'AI-LRN-001',
      operation: 'generate_answers',
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }]
    });

    const raw = (message.content.find(b => b.type === 'text') || {}).text || '';
    const jsonStr = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    let parsed;
    try { parsed = JSON.parse(jsonStr); }
    catch { return res.status(500).json({ error: 'AI returned unexpected format. Try rephrasing your question.', raw }); }

    if (!Array.isArray(parsed.answers) || !parsed.answers.length)
      return res.status(500).json({ error: 'AI returned no answers. Try rephrasing your question.' });

    res.json({
      answers: parsed.answers,
      hint: parsed.hint || '',
      kbSources: kbArticles.map(a => a.Title),
      company: companyName,
    });
  } catch (e) {
    if (e.message && e.message.includes('API key')) return res.status(400).json({ error: e.message });
    res.status(500).json({ error: 'AI service error: ' + e.message });
  }
});

// ---- Settings route to save the API key ----
router.put('/ai-settings', async (req, res) => {
  try {
    const { requireAuth } = require('./auth');
    if (!req.session || !req.session.user || !req.session.user.admin)
      return res.status(403).json({ error: 'Admin access required.' });
    const { apiKey, openaiKey } = req.body;
    if (!apiKey && openaiKey === undefined) return res.status(400).json({ error: 'API key is required.' });
    const { dbRun } = require('../database/db');
    const { writeSecretConfig } = require('../lib/secret-config'); // R7 — encrypt-at-rest when CONFIG_SECRET is set
    if (apiKey) {
      await writeSecretConfig(dbRun, 'anthropic_api_key', apiKey.trim());
      aiGateway.resetClient();
    }
    if (openaiKey !== undefined) {
      await writeSecretConfig(dbRun, 'openai_api_key', String(openaiKey).trim());
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
