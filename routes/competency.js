const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');
const { recordLegacyAudit } = require('../lib/governance/audit-adapter'); // WP-16 M5 — sanitizing audit (medium-risk; AI content dropped, identifiers masked/capped)

router.use(requireAuth);

// ---- Frameworks ----
router.get('/frameworks', async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT f.*, COUNT(c.CompetencyID) AS competencyCount
       FROM tblCompetencyFramework f
       LEFT JOIN tblCompetency c ON c.FrameworkID=f.FrameworkID AND c.Status='Active'
       WHERE f.Status='Active'
         AND (f.TenantID=? OR f.TenantID IS NULL)
       GROUP BY f.FrameworkID ORDER BY f.Name`, [tenantOf(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/frameworks', async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    const r = await dbRun(`INSERT INTO tblCompetencyFramework (Name,Description,CreatedBy,TenantID) VALUES (?,?,?,?)`,
      [name, description || null, req.session.user.username, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'CompetencyFramework', 'CREATE', r.lastID, null, null, name);
    res.json({ success: true, id: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/frameworks/:id', async (req, res) => {
  try {
    const { name, description, status } = req.body;
    await dbRun(`UPDATE tblCompetencyFramework SET Name=?,Description=?,Status=? WHERE FrameworkID=? AND (TenantID=? OR TenantID IS NULL)`,
      [name, description || null, status || 'Active', req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'CompetencyFramework', 'UPDATE', req.params.id, null, null, name);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/frameworks/:id', async (req, res) => {
  try {
    await dbRun(`UPDATE tblCompetencyFramework SET Status='Inactive' WHERE FrameworkID=? AND (TenantID=? OR TenantID IS NULL)`, [req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'CompetencyFramework', 'DELETE', req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Competencies ----
router.get('/competencies', async (req, res) => {
  try {
    const { frameworkId } = req.query;
    const where = frameworkId ? 'AND c.FrameworkID=?' : '';
    const params = frameworkId ? [tenantOf(req), frameworkId] : [tenantOf(req)];
    const rows = await dbAll(
      `SELECT c.*, f.Name AS frameworkName,
              COUNT(DISTINCT req.ReqID) AS reqCount,
              COUNT(DISTINCT rec.RecordID) AS recordCount
       FROM tblCompetency c
       LEFT JOIN tblCompetencyFramework f ON f.FrameworkID=c.FrameworkID
       LEFT JOIN tblCompetencyReq req ON req.CompetencyID=c.CompetencyID
       LEFT JOIN tblCompetencyRecord rec ON rec.CompetencyID=c.CompetencyID
       WHERE c.Status='Active' AND (c.TenantID=? OR c.TenantID IS NULL) ${where}
       GROUP BY c.CompetencyID ORDER BY c.Category, c.Name`, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/competencies', async (req, res) => {
  try {
    const { frameworkId, name, description, category } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    const r = await dbRun(`INSERT INTO tblCompetency (FrameworkID,Name,Description,Category,CreatedBy,TenantID) VALUES (?,?,?,?,?,?)`,
      [frameworkId || null, name, description || null, category || null, req.session.user.username, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Competency', 'CREATE', r.lastID, null, null, name);
    res.json({ success: true, id: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/competencies/:id', async (req, res) => {
  try {
    const { frameworkId, name, description, category, status } = req.body;
    await dbRun(`UPDATE tblCompetency SET FrameworkID=?,Name=?,Description=?,Category=?,Status=? WHERE CompetencyID=? AND (TenantID=? OR TenantID IS NULL)`,
      [frameworkId || null, name, description || null, category || null, status || 'Active', req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Competency', 'UPDATE', req.params.id, null, null, name);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/competencies/:id', async (req, res) => {
  try {
    await dbRun(`UPDATE tblCompetency SET Status='Inactive' WHERE CompetencyID=? AND (TenantID=? OR TenantID IS NULL)`, [req.params.id, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'Competency', 'DELETE', req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Requirements (competency → job/dept links) ----
router.get('/requirements', async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT req.*, c.Name AS compName, c.Category, j.Title AS jobTitle, d.Department
       FROM tblCompetencyReq req
       LEFT JOIN tblCompetency c ON c.CompetencyID=req.CompetencyID
       LEFT JOIN tblJobs j ON j.JobID=req.JobID
       LEFT JOIN tblDept d ON d.DeptID=req.DeptID
       WHERE (req.TenantID=? OR req.TenantID IS NULL)
       ORDER BY j.Title, d.Department, c.Name`, [tenantOf(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/requirements', async (req, res) => {
  try {
    const { competencyId, jobId, deptId, requiredLevel } = req.body;
    if (!competencyId) return res.status(400).json({ error: 'Competency is required.' });
    const r = await dbRun(
      `INSERT OR IGNORE INTO tblCompetencyReq (CompetencyID,JobID,DeptID,RequiredLevel,CreatedBy,TenantID) VALUES (?,?,?,?,?,?)`,
      [competencyId, jobId || null, deptId || null, requiredLevel || 3, req.session.user.username, tenantOf(req)]);
    res.json({ success: true, id: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/requirements/:id', async (req, res) => {
  try {
    await dbRun(`DELETE FROM tblCompetencyReq WHERE ReqID=? AND (TenantID=? OR TenantID IS NULL)`, [req.params.id, tenantOf(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Records (employee competency assessments) ----
router.get('/records', async (req, res) => {
  try {
    const { empId, competencyId } = req.query;
    const wheres = [], params = [];
    wheres.push('(rec.TenantID=? OR rec.TenantID IS NULL)'); params.push(tenantOf(req));
    if (empId) { wheres.push('rec.EmpID=?'); params.push(empId); }
    if (competencyId) { wheres.push('rec.CompetencyID=?'); params.push(competencyId); }
    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
    const rows = await dbAll(
      `SELECT rec.*, c.Name AS compName, c.Category,
              s.FirstName||' '||s.LastName AS empName
       FROM tblCompetencyRecord rec
       JOIN tblCompetency c ON c.CompetencyID=rec.CompetencyID
       JOIN tblStaff s ON s.StaffID=rec.EmpID
       ${where}
       ORDER BY s.LastName, s.FirstName, c.Name`, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/records', async (req, res) => {
  try {
    const { empId, competencyId, status, achievedLevel, assessedDate, notes } = req.body;
    if (!empId || !competencyId) return res.status(400).json({ error: 'Employee and competency are required.' });
    // upsert: update if exists, insert if not
    const existing = await dbGet(`SELECT RecordID FROM tblCompetencyRecord WHERE EmpID=? AND CompetencyID=? AND (TenantID=? OR TenantID IS NULL)`, [empId, competencyId, tenantOf(req)]);
    let id;
    if (existing) {
      await dbRun(`UPDATE tblCompetencyRecord SET Status=?,AchievedLevel=?,AssessedDate=?,AssessedBy=?,Notes=? WHERE RecordID=? AND (TenantID=? OR TenantID IS NULL)`,
        [status || 'Competent', achievedLevel || null, assessedDate || null, req.session.user.username, notes || null, existing.RecordID, tenantOf(req)]);
      id = existing.RecordID;
    } else {
      const r = await dbRun(`INSERT INTO tblCompetencyRecord (EmpID,CompetencyID,Status,AchievedLevel,AssessedDate,AssessedBy,Notes,TenantID) VALUES (?,?,?,?,?,?,?,?)`,
        [empId, competencyId, status || 'Competent', achievedLevel || null, assessedDate || null, req.session.user.username, notes || null, tenantOf(req)]);
      id = r.lastID;
    }
    await recordLegacyAudit(req.session.user.username, 'CompetencyRecord', existing ? 'UPDATE' : 'CREATE', id, null, null, `EmpID=${empId} CompID=${competencyId} Status=${status}`);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Gap analysis: employees vs required competencies for their job ----
router.get('/gap-analysis', async (req, res) => {
  try {
    const { deptId, jobId } = req.query;
    const staffWhere = ['s.Status=\'Active\'', '(s.DateRecDeleted IS NULL OR s.DateRecDeleted=\'\')'];
    const staffParams = [];
    if (deptId) { staffWhere.push('s.DeptID=?'); staffParams.push(deptId); }
    if (jobId)  { staffWhere.push('s.JobID=?');  staffParams.push(jobId); }

    const staff = await dbAll(
      `SELECT s.StaffID, s.FirstName||' '||s.LastName AS empName, s.JobID, s.DeptID,
              j.Title AS jobTitle, d.Department
       FROM tblStaff s
       LEFT JOIN tblJobs j ON j.JobID=s.JobID
       LEFT JOIN tblDept d ON d.DeptID=s.DeptID
       WHERE ${staffWhere.join(' AND ')} ORDER BY s.LastName, s.FirstName`, staffParams);

    const allReqs = await dbAll(
      `SELECT req.CompetencyID, req.JobID, req.DeptID, c.Name AS compName, c.Category
       FROM tblCompetencyReq req
       JOIN tblCompetency c ON c.CompetencyID=req.CompetencyID AND c.Status='Active'
       WHERE (req.TenantID=? OR req.TenantID IS NULL)`, [tenantOf(req)]);

    const allRecords = await dbAll(
      `SELECT EmpID, CompetencyID, Status FROM tblCompetencyRecord WHERE (TenantID=? OR TenantID IS NULL)`, [tenantOf(req)]);

    const recordMap = {};
    allRecords.forEach(r => { recordMap[`${r.EmpID}:${r.CompetencyID}`] = r.Status; });

    const result = staff.map(emp => {
      const reqs = allReqs.filter(r =>
        (r.JobID && r.JobID === emp.JobID) ||
        (r.DeptID && r.DeptID === emp.DeptID));
      const gaps = reqs.filter(r => {
        const st = recordMap[`${emp.StaffID}:${r.CompetencyID}`];
        return !st || st !== 'Competent';
      });
      return {
        empId: emp.StaffID, empName: emp.empName, jobTitle: emp.jobTitle || '—', department: emp.Department || '—',
        required: reqs.length, met: reqs.length - gaps.length, gaps: gaps.length,
        gapList: gaps.map(g => ({ id: g.CompetencyID, name: g.compName, category: g.Category,
          status: recordMap[`${emp.StaffID}:${g.CompetencyID}`] || 'Not Assessed' }))
      };
    });

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Full report data ----
router.get('/report', async (req, res) => {
  try {
    const [frameworks, competencies, requirements, assessments, staff] = await Promise.all([
      dbAll(`SELECT f.*, COUNT(c.CompetencyID) AS competencyCount
             FROM tblCompetencyFramework f
             LEFT JOIN tblCompetency c ON c.FrameworkID=f.FrameworkID AND c.Status='Active'
             WHERE (f.TenantID=? OR f.TenantID IS NULL)
             GROUP BY f.FrameworkID ORDER BY f.Name`, [tenantOf(req)]),

      dbAll(`SELECT c.*, f.Name AS frameworkName,
                    COUNT(DISTINCT req.ReqID) AS reqCount,
                    COUNT(DISTINCT rec.RecordID) AS totalAssessed,
                    SUM(CASE WHEN rec.Status='Competent' THEN 1 ELSE 0 END) AS competentCount,
                    SUM(CASE WHEN rec.Status='Not Competent' THEN 1 ELSE 0 END) AS notCompetentCount
             FROM tblCompetency c
             LEFT JOIN tblCompetencyFramework f ON f.FrameworkID=c.FrameworkID
             LEFT JOIN tblCompetencyReq req ON req.CompetencyID=c.CompetencyID
             LEFT JOIN tblCompetencyRecord rec ON rec.CompetencyID=c.CompetencyID
             WHERE c.Status='Active' AND (c.TenantID=? OR c.TenantID IS NULL)
             GROUP BY c.CompetencyID ORDER BY c.Category, c.Name`, [tenantOf(req)]),

      dbAll(`SELECT req.*, c.Name AS compName, c.Category,
                    j.Title AS jobTitle, d.Department
             FROM tblCompetencyReq req
             LEFT JOIN tblCompetency c ON c.CompetencyID=req.CompetencyID
             LEFT JOIN tblJobs j ON j.JobID=req.JobID
             LEFT JOIN tblDept d ON d.DeptID=req.DeptID
             WHERE (req.TenantID=? OR req.TenantID IS NULL)
             ORDER BY j.Title, d.Department, c.Name`, [tenantOf(req)]),

      dbAll(`SELECT rec.CompetencyID, rec.Status, rec.AssessedDate, rec.AssessedBy,
                    c.Name AS compName, c.Category,
                    s.FirstName||' '||s.LastName AS empName,
                    j.Title AS jobTitle, d.Department
             FROM tblCompetencyRecord rec
             JOIN tblCompetency c ON c.CompetencyID=rec.CompetencyID
             JOIN tblStaff s ON s.StaffID=rec.EmpID
             LEFT JOIN tblJobs j ON j.JobID=s.JobID
             LEFT JOIN tblDept d ON d.DeptID=s.DeptID
             WHERE (rec.TenantID=? OR rec.TenantID IS NULL)
             ORDER BY c.Name, s.LastName`, [tenantOf(req)]),

      dbAll(`SELECT COUNT(*) AS n FROM tblStaff
             WHERE Status='Active' AND (DateRecDeleted IS NULL OR DateRecDeleted='')`)
    ]);

    // Gap summary: for each competency required for a role, how many employees are missing it
    const allReqs = await dbAll(
      `SELECT req.CompetencyID, req.JobID, req.DeptID FROM tblCompetencyReq req WHERE (req.TenantID=? OR req.TenantID IS NULL)`, [tenantOf(req)]);
    const allRecords = await dbAll(
      `SELECT EmpID, CompetencyID, Status FROM tblCompetencyRecord WHERE (TenantID=? OR TenantID IS NULL)`, [tenantOf(req)]);
    const allStaff = await dbAll(
      `SELECT s.StaffID, s.JobID, s.DeptID FROM tblStaff s
       WHERE s.Status='Active' AND (s.DateRecDeleted IS NULL OR s.DateRecDeleted='')`);

    const recordMap = {};
    allRecords.forEach(r => { recordMap[`${r.EmpID}:${r.CompetencyID}`] = r.Status; });

    // Top gaps: count employees who are missing each required competency
    const gapCounts = {};
    allStaff.forEach(emp => {
      const empReqs = allReqs.filter(r =>
        (r.JobID && r.JobID === emp.JobID) || (r.DeptID && r.DeptID === emp.DeptID));
      empReqs.forEach(r => {
        const st = recordMap[`${emp.StaffID}:${r.CompetencyID}`];
        if (!st || st !== 'Competent') {
          gapCounts[r.CompetencyID] = (gapCounts[r.CompetencyID] || 0) + 1;
        }
      });
    });

    // Enrich competencies with gap count
    const compMap = {};
    competencies.forEach(c => { compMap[c.CompetencyID] = c; });
    const topGaps = Object.entries(gapCounts)
      .map(([id, count]) => ({ id, name: compMap[id]?.Name || '?', category: compMap[id]?.Category || '', count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Requirements grouped by role (job/dept)
    const reqByRole = {};
    requirements.forEach(r => {
      const key = r.jobTitle ? `Job: ${r.jobTitle}` : r.Department ? `Dept: ${r.Department}` : 'Unspecified';
      (reqByRole[key] = reqByRole[key] || []).push({ name: r.compName, category: r.Category });
    });

    res.json({
      generatedAt: new Date().toISOString(),
      activeStaffCount: staff[0]?.n || 0,
      frameworks,
      competencies,
      requirementsByRole: reqByRole,
      topGaps,
      totalRequirements: requirements.length,
      totalAssessments: assessments.length,
      assessmentsByStatus: {
        competent: assessments.filter(a => a.Status === 'Competent').length,
        notCompetent: assessments.filter(a => a.Status === 'Not Competent').length,
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
