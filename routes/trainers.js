const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');
const { recordLegacyAudit } = require('../lib/governance/audit-adapter'); // WP-16 M3 — sanitizing audit (shape-preserving)

router.use(requireAuth);

// List trainers (with qualified course count)
router.get('/', async (req, res) => {
  try {
    const { status, certID, search } = req.query;
    let sql = `SELECT t.*,
      (SELECT COUNT(*) FROM tblTrainerCert tc WHERE tc.TrainerID=t.TrainerID) as CourseCount
      FROM tblTrainer t WHERE 1=1 AND (t.TenantID=? OR t.TenantID IS NULL)`;
    const p = [tenantOf(req)];
    if (status) { sql += ' AND t.Status=?'; p.push(status); }
    if (search) { sql += ' AND (t.FirstName LIKE ? OR t.LastName LIKE ? OR t.Company LIKE ?)'; p.push(`%${search}%`,`%${search}%`,`%${search}%`); }
    if (certID) { sql += ' AND t.TrainerID IN (SELECT TrainerID FROM tblTrainerCert WHERE CertID=?)'; p.push(certID); }
    sql += ' ORDER BY t.LastName, t.FirstName';
    res.json(await dbAll(sql, p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const t = await dbGet('SELECT * FROM tblTrainer WHERE TrainerID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!t) return res.status(404).json({ error: 'Not found' });
    t.courses = await dbAll(`SELECT tc.TrainerCertID, c.CertID, c.CertName, c.CertNum
      FROM tblTrainerCert tc JOIN tblCerts c ON tc.CertID=c.CertID WHERE tc.TrainerID=? AND (tc.TenantID=? OR tc.TenantID IS NULL) ORDER BY c.CertName`, [req.params.id, tenantOf(req)]);
    res.json(t);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Trainer's scheduled classes (their calendar)
router.get('/:id/schedule', async (req, res) => {
  try {
    res.json(await dbAll(`SELECT cl.ClassID, cl.ClassName, cl.ClassDate, cl.TimeStart, cl.TimeEnd,
      c.CertName, loc.ClassLoc
      FROM tblClass cl LEFT JOIN tblCerts c ON cl.CertID=c.CertID LEFT JOIN tblClassLoc loc ON cl.ClassLocID=loc.ClassLocID
      WHERE cl.TrainerID=? ORDER BY cl.ClassDate DESC`, [req.params.id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const d = req.body;
    const r = await dbRun(`INSERT INTO tblTrainer (FirstName,LastName,Email,Phone,TrainerType,StaffID,Company,HourlyRate,DailyRate,Status,Notes,TenantID)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.FirstName,d.LastName,d.Email,d.Phone,d.TrainerType||'Internal',d.StaffID||null,d.Company,
       d.HourlyRate||null,d.DailyRate||null,d.Status||'Active',d.Notes,tenantOf(req)]);
    await saveCourses(r.lastID, d.courseIds, tenantOf(req));
    await recordLegacyAudit(req.session.user.username, 'tblTrainer', 'CREATE', r.lastID, null, null, `${d.LastName}, ${d.FirstName}`);
    res.json({ TrainerID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const d = req.body;
    await dbRun(`UPDATE tblTrainer SET FirstName=?,LastName=?,Email=?,Phone=?,TrainerType=?,StaffID=?,Company=?,
      HourlyRate=?,DailyRate=?,Status=?,Notes=? WHERE TrainerID=? AND (TenantID=? OR TenantID IS NULL)`,
      [d.FirstName,d.LastName,d.Email,d.Phone,d.TrainerType||'Internal',d.StaffID||null,d.Company,
       d.HourlyRate||null,d.DailyRate||null,d.Status||'Active',d.Notes,req.params.id,tenantOf(req)]);
    if (d.courseIds) { await dbRun('DELETE FROM tblTrainerCert WHERE TrainerID=?', [req.params.id]); await saveCourses(req.params.id, d.courseIds, tenantOf(req)); }
    await recordLegacyAudit(req.session.user.username, 'tblTrainer', 'UPDATE', req.params.id, null, null, `${d.LastName}, ${d.FirstName}`);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM tblTrainerCert WHERE TrainerID=?', [req.params.id]);
    await dbRun('DELETE FROM tblTrainer WHERE TrainerID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function saveCourses(trainerId, courseIds, tenantId) {
  for (const cid of (courseIds || [])) {
    await dbRun('INSERT INTO tblTrainerCert (TrainerID,CertID,TenantID) VALUES (?,?,?)', [trainerId, cid, tenantId]);
  }
}

module.exports = router;
