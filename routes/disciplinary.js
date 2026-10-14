// HR Disciplinary Actions — warnings, performance issues, over-entitlement triggers, etc.
// Optional document uploads per action; optional link to an HR-category Form template/submission.
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

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, 'disc_' + crypto.randomBytes(16).toString('hex') + ext);
  }
});
const upload = multer({
  storage, limits: { fileSize: 50 * 1024 * 1024 },
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

const VALID_SEVERITY = new Set(['Minor', 'Major', 'Critical']);
const VALID_STATUS   = new Set(['Open', 'In Progress', 'Resolved', 'Cancelled']);

// ── LIST ───────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const where = [], params = [];
    if (req.query.empId)    { where.push('a.EmpID=?');    params.push(req.query.empId); }
    if (req.query.status)   { where.push('a.Status=?');   params.push(req.query.status); }
    if (req.query.severity) { where.push('a.Severity=?'); params.push(req.query.severity); }
    if (req.query.q) {
      where.push('(s.FirstName LIKE ? OR s.LastName LIKE ? OR a.Reason LIKE ? OR a.ActionType LIKE ?)');
      const w = `%${req.query.q}%`; params.push(w, w, w, w);
    }
    where.push('(a.TenantID=? OR a.TenantID IS NULL)'); params.push(tenantOf(req));
    const sql = `SELECT a.*, s.FirstName||' '||s.LastName AS EmpName, d.Department AS DeptName, j.Title AS JobName,
        (SELECT COUNT(*) FROM tblDisciplinaryDoc WHERE ActionID=a.ActionID) AS DocCount,
        ft.Name AS FormTemplateName
      FROM tblDisciplinary a
      LEFT JOIN tblStaff s ON s.StaffID=a.EmpID
      LEFT JOIN tblDept  d ON d.DeptID=s.DeptID
      LEFT JOIN tblJobs  j ON j.JobID=s.JobID
      LEFT JOIN tblFormTemplate ft ON ft.TemplateID=a.FormTemplateID
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.IssuedDate DESC, a.ActionID DESC`;
    res.json(await dbAll(sql, params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET single (with documents) ────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const a = await dbGet(`SELECT a.*, s.FirstName||' '||s.LastName AS EmpName, d.Department AS DeptName, j.Title AS JobName,
        ft.Name AS FormTemplateName
      FROM tblDisciplinary a
      LEFT JOIN tblStaff s ON s.StaffID=a.EmpID
      LEFT JOIN tblDept  d ON d.DeptID=s.DeptID
      LEFT JOIN tblJobs  j ON j.JobID=s.JobID
      LEFT JOIN tblFormTemplate ft ON ft.TemplateID=a.FormTemplateID
      WHERE a.ActionID=? AND (a.TenantID=? OR a.TenantID IS NULL)`, [req.params.id, tenantOf(req)]);
    if (!a) return res.status(404).json({ error: 'Not found' });
    a.documents = await dbAll('SELECT DocID, FileName, MimeType, FileSize, Notes, UploadedBy, UploadedAt FROM tblDisciplinaryDoc WHERE ActionID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY UploadedAt DESC', [a.ActionID, tenantOf(req)]);
    res.json(a);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CREATE ─────────────────────────────────────────────────────────────────
router.post('/', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.EmpID || !b.Reason) return res.status(400).json({ error: 'EmpID and Reason required.' });
    const severity = VALID_SEVERITY.has(b.Severity) ? b.Severity : 'Minor';
    const status = VALID_STATUS.has(b.Status) ? b.Status : 'Open';
    const r = await dbRun(`INSERT INTO tblDisciplinary
      (EmpID, ActionType, Severity, Reason, Description, IssuedDate, IssuedBy, FollowUpDate, Status, Resolution, FormTemplateID, FormSubmissionID, AutoGenerated, Notes, TenantID)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [b.EmpID, b.ActionType || 'Verbal Warning', severity, b.Reason, b.Description || null,
       b.IssuedDate || new Date().toISOString().slice(0,10), b.IssuedBy || req.session.user.username,
       b.FollowUpDate || null, status, b.Resolution || null,
       b.FormTemplateID || null, b.FormSubmissionID || null, b.AutoGenerated ? 1 : 0, b.Notes || null, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Disciplinary', 'CREATE', r.lastID, 'Severity', null, severity);
    res.json({ success: true, ActionID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── UPDATE ─────────────────────────────────────────────────────────────────
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const existing = await dbGet('SELECT * FROM tblDisciplinary WHERE ActionID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const severity = VALID_SEVERITY.has(b.Severity) ? b.Severity : existing.Severity;
    const status = VALID_STATUS.has(b.Status) ? b.Status : existing.Status;
    await dbRun(`UPDATE tblDisciplinary SET ActionType=?, Severity=?, Reason=?, Description=?, IssuedDate=?, IssuedBy=?, FollowUpDate=?, Status=?, Resolution=?, FormTemplateID=?, FormSubmissionID=?, Notes=? WHERE ActionID=? AND (TenantID=? OR TenantID IS NULL)`,
      [b.ActionType||existing.ActionType, severity, b.Reason||existing.Reason, b.Description??existing.Description,
       b.IssuedDate||existing.IssuedDate, b.IssuedBy??existing.IssuedBy, b.FollowUpDate??existing.FollowUpDate,
       status, b.Resolution??existing.Resolution, b.FormTemplateID??existing.FormTemplateID,
       b.FormSubmissionID??existing.FormSubmissionID, b.Notes??existing.Notes, req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Disciplinary', 'UPDATE', req.params.id, 'Status', existing.Status, status);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE ─────────────────────────────────────────────────────────────────
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const existing = await dbGet('SELECT EmpID FROM tblDisciplinary WHERE ActionID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const docs = await dbAll('SELECT StoredName FROM tblDisciplinaryDoc WHERE ActionID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    docs.forEach(d => { try { fs.unlinkSync(path.join(UPLOAD_DIR, d.StoredName)); } catch {} });
    await dbRun('DELETE FROM tblDisciplinary WHERE ActionID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Disciplinary', 'DELETE', req.params.id, null, String(existing.EmpID), null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DOCUMENT UPLOAD / DOWNLOAD / DELETE ────────────────────────────────────
router.post('/:id/documents', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const action = await dbGet('SELECT ActionID FROM tblDisciplinary WHERE ActionID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!action) {
      try { fs.unlinkSync(req.file.path); } catch {}
      return res.status(404).json({ error: 'Action not found' });
    }
    const r = await dbRun(`INSERT INTO tblDisciplinaryDoc (ActionID, FileName, StoredName, MimeType, FileSize, Notes, UploadedBy, TenantID) VALUES (?,?,?,?,?,?,?,?)`,
      [req.params.id, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.body.notes || null, req.session.user.username, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Disciplinary', 'UPLOAD_DOC', req.params.id, null, null, req.file.originalname);
    res.json({ success: true, DocID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/documents/:docId', async (req, res) => {
  try {
    const d = await dbGet('SELECT * FROM tblDisciplinaryDoc WHERE DocID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.docId, tenantOf(req)]);
    if (!d) return res.status(404).json({ error: 'Not found' });
    const fp = path.join(UPLOAD_DIR, d.StoredName);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File missing on disk' });
    const disposition = req.query.inline === '1' ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(d.FileName)}"`);
    if (d.MimeType) res.setHeader('Content-Type', d.MimeType);
    fs.createReadStream(fp).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/documents/:docId', requireAdmin, async (req, res) => {
  try {
    const d = await dbGet('SELECT * FROM tblDisciplinaryDoc WHERE DocID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.docId, tenantOf(req)]);
    if (!d) return res.status(404).json({ error: 'Not found' });
    try { fs.unlinkSync(path.join(UPLOAD_DIR, d.StoredName)); } catch {}
    await dbRun('DELETE FROM tblDisciplinaryDoc WHERE DocID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.docId, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Disciplinary', 'DELETE_DOC', d.ActionID, null, d.FileName, null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI: draft a description for a disciplinary action ─────────────────────
// Pulls the employee's context (job, dept, leave balance for the year, recent disciplinary history)
// and asks Claude to write a concise, professional description tailored to the chosen action type.
router.post('/ai-draft', requireAdmin, async (req, res) => {
  try {
    const { EmpID, ActionType, Reason } = req.body || {};
    if (!EmpID || !ActionType) return res.status(400).json({ error: 'EmpID and ActionType are required.' });
    const emp = await dbGet(`SELECT s.StaffID, s.FirstName, s.LastName, s.StartDate, s.Status,
        d.Department, j.Title AS JobTitle
      FROM tblStaff s LEFT JOIN tblDept d ON d.DeptID=s.DeptID LEFT JOIN tblJobs j ON j.JobID=s.JobID
      WHERE s.StaffID=?`, [EmpID]);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    // Leave balance — current calendar year
    const year = new Date().getFullYear();
    const leaveTypes = await dbAll('SELECT * FROM tblLeaveType WHERE Active=1');
    const leaveContext = [];
    for (const t of leaveTypes) {
      const used = await dbGet(`SELECT COALESCE(SUM(Days),0) AS d FROM tblLeaveBooking
        WHERE EmpID=? AND LeaveTypeID=? AND Status='Approved' AND strftime('%Y', StartDate) = ?`,
        [EmpID, t.LeaveTypeID, String(year)]);
      if (used && used.d > 0) {
        const status = (t.DefaultDays && used.d > t.DefaultDays) ? `OVER (entitled ${t.DefaultDays}, used ${used.d}, over by ${(used.d - t.DefaultDays).toFixed(1)})` : `within entitlement (used ${used.d} of ${t.DefaultDays || 'unlimited'})`;
        leaveContext.push(`${t.Name}: ${status}`);
      }
    }

    // Recent disciplinary history (last 5)
    const recentActions = await dbAll(`SELECT ActionType, Severity, Reason, IssuedDate, Status FROM tblDisciplinary
      WHERE EmpID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY IssuedDate DESC, ActionID DESC LIMIT 5`, [EmpID, tenantOf(req)]);

    // Recent attendance issues (last 60 days — Absent/Late/No Show only)
    const recentAtt = await dbAll(`SELECT AttDate, Status, Notes FROM tblAttendance
      WHERE EmpID=? AND AttDate >= date('now','-60 days') AND Status IN ('Absent','Late','No Show')
      ORDER BY AttDate DESC LIMIT 20`, [EmpID]);

    const employeeBlock = `Name: ${emp.FirstName} ${emp.LastName}
Job Title: ${emp.JobTitle || 'Unspecified'}
Department: ${emp.Department || 'Unspecified'}
Status: ${emp.Status || 'Active'}
Start Date: ${emp.StartDate || 'Unknown'}`;
    const leaveBlock = leaveContext.length ? leaveContext.join('\n') : 'No approved leave taken in ' + year + '.';
    const histBlock = recentActions.length ? recentActions.map(a => `- ${a.IssuedDate}: ${a.ActionType} (${a.Severity}) — ${a.Reason} [${a.Status}]`).join('\n') : 'None on record.';
    const attBlock  = recentAtt.length ? recentAtt.map(a => `- ${a.AttDate}: ${a.Status}${a.Notes ? ' — ' + a.Notes : ''}`).join('\n') : 'No attendance exceptions in the last 60 days.';

    const sys = `You are an HR specialist drafting concise, professional, factual disciplinary action descriptions for a mining / industrial operations company. Use neutral, non-emotive language. Cite specific facts from the supplied context (dates, days, counts). Do NOT invent facts that aren't in the context. Output PLAIN TEXT — no markdown, no headings, 2-4 short paragraphs.`;
    const userMsg = `Draft the **Description** field for a disciplinary action.

ACTION TYPE: ${ActionType}
${Reason ? 'REASON HEADING: ' + Reason : ''}

EMPLOYEE CONTEXT
${employeeBlock}

LEAVE USAGE (${year})
${leaveBlock}

RECENT DISCIPLINARY HISTORY
${histBlock}

RECENT ATTENDANCE EXCEPTIONS
${attBlock}

Write a description that:
1. States the specific behaviour or breach in factual terms.
2. References the relevant data above (e.g. exact days over entitlement, dates of absences).
3. Notes any prior disciplinary actions on record if relevant.
4. Closes with what is expected of the employee going forward.

Output only the description text. Do not include the heading.`;
    const msg = await aiGateway.complete({
      provider: 'anthropic',
      agent: 'AI-WKF-001',
      operation: 'draft_disciplinary',
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: sys,
      messages: [{ role: 'user', content: userMsg }]
    });
    const description = ((msg.content.find(b => b.type === 'text') || {}).text || '').trim();
    res.json({ success: true, description, contextUsed: { leaveOverEntitlement: leaveContext.filter(l => l.includes('OVER')).length, recentActions: recentActions.length, recentAttendanceIssues: recentAtt.length } });
  } catch (e) { res.status(500).json({ error: 'AI draft failed: ' + (e && e.message ? e.message : String(e)) }); }
});

// ── AI: generate HR form fields from a prompt ──────────────────────────────
// Returns a structured `fields[]` array shaped to drop into POST /api/forms/templates.
router.post('/ai-form-fields', requireAdmin, async (req, res) => {
  try {
    const { formName, actionType, prompt } = req.body || {};
    if (!formName && !prompt) return res.status(400).json({ error: 'formName or prompt is required.' });

    const sys = `You are an HR specialist designing structured HR forms (disciplinary records, warnings, performance reviews, exit interviews). Return ONLY valid JSON — no preamble, no markdown.`;
    const userMsg = `Design the fields for an HR form.

FORM NAME: ${formName || '(unnamed)'}
${actionType ? 'ACTION TYPE: ' + actionType : ''}
${prompt ? 'EXTRA REQUIREMENTS: ' + prompt : ''}

Return JSON shaped EXACTLY like:
{
  "fields": [
    { "Label": "Employee Name", "FieldType": "text", "Required": 1, "OrderNum": 1 },
    { "Label": "Date of Incident", "FieldType": "date", "Required": 1, "OrderNum": 2 },
    { "Label": "Severity", "FieldType": "select", "Required": 1, "OrderNum": 3, "Options": ["Minor","Major","Critical"] },
    { "Label": "Description of Incident", "FieldType": "textarea", "Required": 1, "OrderNum": 4 },
    { "Label": "Employee Acknowledgement Signature", "FieldType": "signature", "Required": 1, "OrderNum": 5 }
  ]
}

Use FieldType from: text, textarea, number, date, time, select, multiselect, radio, checkbox, signature, file.
For select / multiselect / radio, include an Options array of choice strings.
Include 8-15 fields appropriate for the form's purpose. Order them logically (identification, incident details, evidence, signatures).`;
    const msg = await aiGateway.complete({
      provider: 'anthropic',
      agent: 'AI-WKF-001',
      operation: 'ai_form_fields',
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: sys,
      messages: [{ role: 'user', content: userMsg }]
    });
    let raw = ((msg.content.find(b => b.type === 'text') || {}).text || '')
      .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let json;
    try { json = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]*\}/); if (m) json = JSON.parse(m[0]); else throw new Error('AI returned unexpected format.'); }
    res.json({ success: true, fields: json.fields || [] });
  } catch (e) { res.status(500).json({ error: 'AI generate failed: ' + (e && e.message ? e.message : String(e)) }); }
});

// ── STATS ──────────────────────────────────────────────────────────────────
router.get('/stats/summary', async (req, res) => {
  try {
    const r = await dbGet(`SELECT
      (SELECT COUNT(*) FROM tblDisciplinary WHERE (TenantID=? OR TenantID IS NULL)) AS total,
      (SELECT COUNT(*) FROM tblDisciplinary WHERE Status='Open' AND (TenantID=? OR TenantID IS NULL)) AS open,
      (SELECT COUNT(*) FROM tblDisciplinary WHERE Status='In Progress' AND (TenantID=? OR TenantID IS NULL)) AS inProgress,
      (SELECT COUNT(*) FROM tblDisciplinary WHERE Status='Resolved' AND (TenantID=? OR TenantID IS NULL)) AS resolved,
      (SELECT COUNT(*) FROM tblDisciplinary WHERE Severity='Critical' AND Status<>'Resolved' AND (TenantID=? OR TenantID IS NULL)) AS criticalOpen,
      (SELECT COUNT(*) FROM tblDisciplinary WHERE AutoGenerated=1 AND (TenantID=? OR TenantID IS NULL)) AS auto`,
      [tenantOf(req), tenantOf(req), tenantOf(req), tenantOf(req), tenantOf(req), tenantOf(req)]);
    res.json(r || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
