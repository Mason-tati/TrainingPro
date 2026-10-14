// Employee Onboarding — tracks pre-hire candidates from CV upload through medical
// to contract sign-off. Promotes the record to tblStaff once Status='Completed'.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
// WP-10 A6.3 — AI calls go through the central AI Gateway (audit + policy +
// provider registry). Prompts/models/max_tokens/messages/parsing are byte-identical.
const aiGateway = require('../lib/ai-gateway');
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');
const { recordLegacyAudit } = require('../lib/governance/audit-adapter'); // WP-16 M4 — sanitizing audit (high-risk; drops sensitive free-text)

router.use(requireAuth);

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXT = new Set(['.pdf','.doc','.docx','.xls','.xlsx','.png','.jpg','.jpeg','.txt','.rtf']);
const VALID_DOC_TYPES = new Set(['cv', 'contract', 'role-description', 'medical', 'id', 'other']);
const VALID_REVIEWER_ROLES = new Set(['Superintendent', 'Manager', 'Supervisor']);
const VALID_STATUSES = new Set(['New', 'CV Review', 'Interview', 'Medical', 'Contract', 'Completed', 'Withdrawn']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, 'onb_' + crypto.randomBytes(16).toString('hex') + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXT.has(ext)) cb(null, true);
    else cb(new Error('File type not allowed: ' + ext));
  }
});

const requireAdmin = (req, res, next) => {
  if (!req.session.user || !req.session.user.admin) return res.status(403).json({ error: 'Admin only' });
  next();
};

// ── LIST candidates ─────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const status = (req.query.status || '').trim();
    const q = (req.query.q || '').trim();
    const where = [], params = [];
    if (status) { where.push('o.Status = ?'); params.push(status); }
    if (q) { where.push('(o.FirstName LIKE ? OR o.LastName LIKE ? OR o.Email LIKE ? OR o.Position LIKE ?)'); const w = `%${q}%`; params.push(w, w, w, w); }
    where.push('(o.TenantID=? OR o.TenantID IS NULL)'); params.push(tenantOf(req));
    const sql = `
      SELECT o.*, d.Department AS DeptName, j.Title AS JobName,
        (SELECT COUNT(*) FROM tblOnboardingDoc WHERE CandidateID = o.CandidateID AND DocType = 'cv') AS HasCV,
        (SELECT COUNT(*) FROM tblOnboardingDoc WHERE CandidateID = o.CandidateID AND DocType = 'contract') AS HasContract,
        (SELECT COUNT(*) FROM tblOnboardingDoc WHERE CandidateID = o.CandidateID AND DocType = 'role-description') AS HasRoleDesc,
        (SELECT COUNT(*) FROM tblOnboardingReview WHERE CandidateID = o.CandidateID AND Decision = 'Approved') AS ApprovedReviews,
        (SELECT COUNT(*) FROM tblOnboardingReview WHERE CandidateID = o.CandidateID) AS TotalReviews,
        (SELECT FitForWork FROM tblOnboardingMedical WHERE CandidateID = o.CandidateID ORDER BY MedicalID DESC LIMIT 1) AS MedicalFit
      FROM tblOnboarding o
      LEFT JOIN tblDept d ON d.DeptID = o.DeptID
      LEFT JOIN tblJobs j ON j.JobID  = o.JobID
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY o.CreatedAt DESC`;
    const rows = await dbAll(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET one candidate (full record + children) ──────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const c = await dbGet(`
      SELECT o.*, d.Department AS DeptName, j.Title AS JobName
      FROM tblOnboarding o
      LEFT JOIN tblDept d ON d.DeptID = o.DeptID
      LEFT JOIN tblJobs j ON j.JobID  = o.JobID
      WHERE o.CandidateID = ? AND (o.TenantID=? OR o.TenantID IS NULL)`, [req.params.id, tenantOf(req)]);
    if (!c) return res.status(404).json({ error: 'Candidate not found' });
    c.documents = await dbAll('SELECT DocID, DocType, FileName, MimeType, FileSize, Notes, UploadedBy, UploadedAt FROM tblOnboardingDoc WHERE CandidateID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY UploadedAt DESC', [c.CandidateID, tenantOf(req)]);
    c.reviews = await dbAll('SELECT * FROM tblOnboardingReview WHERE CandidateID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY CreatedAt ASC', [c.CandidateID, tenantOf(req)]);
    c.medical = await dbGet('SELECT * FROM tblOnboardingMedical WHERE CandidateID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY MedicalID DESC LIMIT 1', [c.CandidateID, tenantOf(req)]);
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CREATE candidate ────────────────────────────────────────────────────────
router.post('/', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.FirstName || !b.LastName) return res.status(400).json({ error: 'First & last name required.' });
    const status = VALID_STATUSES.has(b.Status) ? b.Status : 'New';
    const r = await dbRun(`
      INSERT INTO tblOnboarding (FirstName,LastName,Email,Phone,DOB,Gender,Address,EmergencyContact,EmergencyPhone,Position,DeptID,JobID,StartDate,Status,Notes,CreatedBy,TenantID)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [b.FirstName.trim(), b.LastName.trim(), b.Email||null, b.Phone||null, b.DOB||null, b.Gender||null, b.Address||null, b.EmergencyContact||null, b.EmergencyPhone||null, b.Position||null, b.DeptID||null, b.JobID||null, b.StartDate||null, status, b.Notes||null, req.session.user.username, tenantOf(req)]);
    // Seed three review rows so the three approvals are visible / actionable on the candidate page from day one
    for (const role of ['Superintendent', 'Manager', 'Supervisor']) {
      await dbRun('INSERT INTO tblOnboardingReview (CandidateID, ReviewerRole, TenantID) VALUES (?,?,?)', [r.lastID, role, tenantOf(req)]);
    }
    await recordLegacyAudit(req.session.user.username, 'Onboarding', 'CREATE', r.lastID, null, null, `${b.FirstName} ${b.LastName}`);
    res.json({ success: true, CandidateID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── UPDATE candidate ────────────────────────────────────────────────────────
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const existing = await dbGet('SELECT * FROM tblOnboarding WHERE CandidateID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!existing) return res.status(404).json({ error: 'Candidate not found' });
    if (b.Status && !VALID_STATUSES.has(b.Status)) return res.status(400).json({ error: 'Invalid status.' });
    await dbRun(`UPDATE tblOnboarding SET
      FirstName=?, LastName=?, Email=?, Phone=?, DOB=?, Gender=?, Address=?, EmergencyContact=?, EmergencyPhone=?,
      Position=?, DeptID=?, JobID=?, StartDate=?, Status=?, Notes=?, UpdatedAt=datetime('now')
      WHERE CandidateID=? AND (TenantID=? OR TenantID IS NULL)`,
      [b.FirstName||existing.FirstName, b.LastName||existing.LastName, b.Email??existing.Email, b.Phone??existing.Phone, b.DOB??existing.DOB, b.Gender??existing.Gender, b.Address??existing.Address, b.EmergencyContact??existing.EmergencyContact, b.EmergencyPhone??existing.EmergencyPhone, b.Position??existing.Position, b.DeptID??existing.DeptID, b.JobID??existing.JobID, b.StartDate??existing.StartDate, b.Status||existing.Status, b.Notes??existing.Notes, req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Onboarding', 'UPDATE', req.params.id, 'Status', existing.Status, b.Status||existing.Status);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE candidate (cascade clears docs + reviews + medical via FK ON DELETE CASCADE) ─
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    // Remove uploaded files from disk first (FK cascade will clear the rows)
    const docs = await dbAll('SELECT StoredName FROM tblOnboardingDoc WHERE CandidateID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    docs.forEach(d => { try { fs.unlinkSync(path.join(UPLOAD_DIR, d.StoredName)); } catch {} });
    const existing = await dbGet('SELECT FirstName, LastName FROM tblOnboarding WHERE CandidateID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await dbRun('DELETE FROM tblOnboarding WHERE CandidateID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Onboarding', 'DELETE', req.params.id, null, `${existing.FirstName} ${existing.LastName}`, null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── UPLOAD document (CV / contract / role-description / medical / id / other) ───────
router.post('/:id/documents', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const docType = String(req.body.docType || '').toLowerCase();
    if (!VALID_DOC_TYPES.has(docType)) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(400).json({ error: 'Invalid document type.' });
    }
    const candidate = await dbGet('SELECT CandidateID FROM tblOnboarding WHERE CandidateID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!candidate) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(404).json({ error: 'Candidate not found' });
    }
    const r = await dbRun(`INSERT INTO tblOnboardingDoc (CandidateID, DocType, FileName, StoredName, MimeType, FileSize, Notes, UploadedBy, TenantID)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [req.params.id, docType, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.body.notes || null, req.session.user.username, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Onboarding', 'UPLOAD_DOC', req.params.id, docType, null, req.file.originalname);
    res.json({ success: true, DocID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DOWNLOAD / preview a document ───────────────────────────────────────────
router.get('/documents/:docId', async (req, res) => {
  try {
    const d = await dbGet('SELECT * FROM tblOnboardingDoc WHERE DocID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.docId, tenantOf(req)]);
    if (!d) return res.status(404).json({ error: 'Not found' });
    const fp = path.join(UPLOAD_DIR, d.StoredName);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File missing on disk' });
    const disposition = req.query.inline === '1' ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(d.FileName)}"`);
    if (d.MimeType) res.setHeader('Content-Type', d.MimeType);
    fs.createReadStream(fp).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE a document ───────────────────────────────────────────────────────
router.delete('/documents/:docId', requireAdmin, async (req, res) => {
  try {
    const d = await dbGet('SELECT * FROM tblOnboardingDoc WHERE DocID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.docId, tenantOf(req)]);
    if (!d) return res.status(404).json({ error: 'Not found' });
    try { fs.unlinkSync(path.join(UPLOAD_DIR, d.StoredName)); } catch {}
    await dbRun('DELETE FROM tblOnboardingDoc WHERE DocID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.docId, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Onboarding', 'DELETE_DOC', d.CandidateID, d.DocType, d.FileName, null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SUBMIT a CV review (Superintendent / Manager / Supervisor) ──────────────
router.put('/reviews/:reviewId', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const existing = await dbGet('SELECT * FROM tblOnboardingReview WHERE ReviewID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.reviewId, tenantOf(req)]);
    if (!existing) return res.status(404).json({ error: 'Review not found' });
    const decision = ['Approved', 'Rejected', 'Pending'].includes(b.Decision) ? b.Decision : existing.Decision;
    await dbRun(`UPDATE tblOnboardingReview SET
      ReviewerName=?, Decision=?, Comments=?, ReviewedAt=CASE WHEN ?='Pending' THEN NULL ELSE datetime('now') END
      WHERE ReviewID=? AND (TenantID=? OR TenantID IS NULL)`,
      [b.ReviewerName || req.session.user.username, decision, b.Comments || null, decision, req.params.reviewId, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'OnboardingReview', 'UPDATE', existing.CandidateID, existing.ReviewerRole, existing.Decision, decision);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── SAVE pre-employment medical record ──────────────────────────────────────
router.put('/:id/medical', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const candidate = await dbGet('SELECT CandidateID FROM tblOnboarding WHERE CandidateID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    const existing = await dbGet('SELECT MedicalID FROM tblOnboardingMedical WHERE CandidateID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY MedicalID DESC LIMIT 1', [req.params.id, tenantOf(req)]);
    const fit = b.FitForWork ? 1 : 0;
    if (existing) {
      await dbRun(`UPDATE tblOnboardingMedical SET Provider=?, AppointmentDate=?, CompletedDate=?, Result=?, FitForWork=?, Restrictions=?, Notes=? WHERE MedicalID=? AND (TenantID=? OR TenantID IS NULL)`,
        [b.Provider||null, b.AppointmentDate||null, b.CompletedDate||null, b.Result||null, fit, b.Restrictions||null, b.Notes||null, existing.MedicalID, tenantOf(req)]);
    } else {
      await dbRun(`INSERT INTO tblOnboardingMedical (CandidateID, Provider, AppointmentDate, CompletedDate, Result, FitForWork, Restrictions, Notes, CreatedBy, TenantID) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [req.params.id, b.Provider||null, b.AppointmentDate||null, b.CompletedDate||null, b.Result||null, fit, b.Restrictions||null, b.Notes||null, req.session.user.username, tenantOf(req)]);
    }
    await recordLegacyAudit(req.session.user.username, 'Onboarding', 'MEDICAL', req.params.id, 'FitForWork', null, fit ? 'Yes' : 'No');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI: generate a role description ─────────────────────────────────────────
router.post('/:id/role-description', requireAdmin, async (req, res) => {
  try {
    const c = await dbGet(`SELECT o.*, d.Department AS DeptName, j.Title AS JobName
      FROM tblOnboarding o LEFT JOIN tblDept d ON d.DeptID=o.DeptID LEFT JOIN tblJobs j ON j.JobID=o.JobID
      WHERE o.CandidateID=? AND (o.TenantID=? OR o.TenantID IS NULL)`, [req.params.id, tenantOf(req)]);
    if (!c) return res.status(404).json({ error: 'Candidate not found' });
    const position = (req.body.position || c.Position || c.JobName || '').trim();
    if (!position) return res.status(400).json({ error: 'Position required to generate role description.' });
    const extraNotes = String(req.body.notes || '').trim();

    const sys = `You are an HR specialist writing concise, accurate role descriptions for a mining / industrial operations company. Return valid JSON only — no markdown, no preamble.`;
    const userMsg = `Write a role description for the following position. Return JSON shaped EXACTLY like:
{
  "title": "...",
  "summary": "2-3 sentence summary",
  "responsibilities": ["...","...", ...],
  "requirements": ["...","...", ...],
  "qualifications": ["...","...", ...],
  "competencies": ["...","...", ...],
  "reportsTo": "..."
}

Position: ${position}
Department: ${c.DeptName || '(unspecified)'}
${extraNotes ? 'Extra notes: ' + extraNotes : ''}`;
    const msg = await aiGateway.complete({
      provider: 'anthropic',
      agent: 'AI-WKF-002',
      operation: 'role_description',
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: sys,
      messages: [{ role: 'user', content: userMsg }]
    });
    let raw = (msg.content.find(b => b.type === 'text') || {}).text || '';
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let json;
    try { json = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]*\}/); if (m) json = JSON.parse(m[0]); else throw new Error('AI returned unexpected format.'); }
    res.json({ success: true, roleDescription: json });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PROMOTE candidate to tblStaff (creates a staff record from the candidate) ───
router.post('/:id/promote', requireAdmin, async (req, res) => {
  try {
    const c = await dbGet('SELECT * FROM tblOnboarding WHERE CandidateID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!c) return res.status(404).json({ error: 'Candidate not found' });
    if (c.PromotedStaffID) return res.status(400).json({ error: 'Already promoted to staff #' + c.PromotedStaffID });
    const approved = await dbGet('SELECT COUNT(*) AS n FROM tblOnboardingReview WHERE CandidateID=? AND Decision=? AND (TenantID=? OR TenantID IS NULL)', [c.CandidateID, 'Approved', tenantOf(req)]);
    if (!approved || approved.n < 3) return res.status(400).json({ error: 'All three CV reviews (Superintendent, Manager, Supervisor) must be Approved before promotion.' });
    const medical = await dbGet('SELECT FitForWork FROM tblOnboardingMedical WHERE CandidateID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY MedicalID DESC LIMIT 1', [c.CandidateID, tenantOf(req)]);
    if (!medical || !medical.FitForWork) return res.status(400).json({ error: 'Pre-employment medical must be Fit for Work before promotion.' });

    // Map onboarding fields → tblStaff (CellPhone, Address fields exist; DateRecAdded is auto)
    const r = await dbRun(`INSERT INTO tblStaff (FirstName, LastName, Email, CellPhone, DOB, Gender, JobID, DeptID, StartDate, Address, Status, AddedBy)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [c.FirstName, c.LastName, c.Email, c.Phone, c.DOB, c.Gender, c.JobID, c.DeptID, c.StartDate || new Date().toISOString().slice(0,10), c.Address, 'Active', req.session.user.username]);
    await dbRun(`UPDATE tblOnboarding SET PromotedStaffID=?, Status='Completed', UpdatedAt=datetime('now') WHERE CandidateID=? AND (TenantID=? OR TenantID IS NULL)`, [r.lastID, c.CandidateID, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Onboarding', 'PROMOTE', c.CandidateID, null, null, 'StaffID=' + r.lastID);
    res.json({ success: true, StaffID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── STATS: dashboard counts ─────────────────────────────────────────────────
router.get('/stats/summary', async (req, res) => {
  try {
    const total = await dbGet('SELECT COUNT(*) AS n FROM tblOnboarding WHERE (TenantID=? OR TenantID IS NULL)', [tenantOf(req)]);
    const byStatus = await dbAll('SELECT Status, COUNT(*) AS n FROM tblOnboarding WHERE (TenantID=? OR TenantID IS NULL) GROUP BY Status', [tenantOf(req)]);
    res.json({ total: total ? total.n : 0, byStatus });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
