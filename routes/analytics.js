const express = require('express');
const router = express.Router();
const { dbAll, dbGet } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');

router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const [
      empCount, completionsMonth, expiringCount,
      monthly, byDept, topCourses, byType, recentCompletions, complianceSummary
    ] = await Promise.all([
      // Active employee count
      dbGet(`SELECT COUNT(*) AS n FROM tblStaff WHERE Status='Active' AND (DateRecDeleted IS NULL OR DateRecDeleted='')
             AND (TenantID=? OR TenantID IS NULL)`, [tenantOf(req)]),
      // Completions this calendar month
      dbGet(`SELECT COUNT(*) AS n FROM tblRegister
             WHERE (DateDeleted IS NULL OR DateDeleted='')
             AND strftime('%Y-%m', Complete) = strftime('%Y-%m', 'now')
             AND (TenantID=? OR TenantID IS NULL)`, [tenantOf(req)]),
      // Expiring within 30 days
      dbGet(`SELECT COUNT(*) AS n FROM tblRegister r
             JOIN tblCerts c ON c.CertID=r.CertID
             WHERE (r.DateDeleted IS NULL OR r.DateDeleted='')
             AND r.Exp IS NOT NULL AND r.Exp!=''
             AND julianday(r.Exp) - julianday('now') BETWEEN 0 AND 30
             AND c.Months IS NOT NULL AND c.Months > 0
             AND (r.TenantID=? OR r.TenantID IS NULL)`, [tenantOf(req)]),
      // Monthly completions — last 12 months
      dbAll(`SELECT strftime('%Y-%m', Complete) AS month, COUNT(*) AS completions
             FROM tblRegister
             WHERE Complete IS NOT NULL AND Complete!=''
             AND (DateDeleted IS NULL OR DateDeleted='')
             AND strftime('%Y-%m', Complete) >= strftime('%Y-%m', date('now','-11 months'))
             AND (TenantID=? OR TenantID IS NULL)
             GROUP BY month ORDER BY month`, [tenantOf(req)]),
      // Compliance by department (% current / required)
      dbAll(`SELECT d.Department,
               COUNT(DISTINCT s.StaffID) AS employees,
               COUNT(DISTINCT r.RegisterID) AS completions,
               COUNT(DISTINCT req.RqdID) AS requirements
             FROM tblDept d
             JOIN tblStaff s ON s.DeptID=d.DeptID AND s.Status='Active' AND (s.DateRecDeleted IS NULL OR s.DateRecDeleted='')
             LEFT JOIN tblRqd req ON (req.JobID=s.JobID OR req.StaffID=s.StaffID OR req.DeptID=s.DeptID)
               AND (req.DateDeleted IS NULL OR req.DateDeleted='')
             LEFT JOIN tblRegister r ON r.StaffID=s.StaffID AND r.CertID=req.CertID
               AND (r.DateDeleted IS NULL OR r.DateDeleted='')
               AND r.Complete IS NOT NULL AND r.Complete!=''
               AND (r.Exp IS NULL OR r.Exp='' OR r.Exp >= date('now'))
             GROUP BY d.DeptID, d.Department HAVING employees > 0
             ORDER BY employees DESC LIMIT 10`),
      // Top 10 courses by attendance
      dbAll(`SELECT c.CertName, COUNT(r.RegisterID) AS attendances
             FROM tblCerts c
             JOIN tblRegister r ON r.CertID=c.CertID
             WHERE (r.DateDeleted IS NULL OR r.DateDeleted='')
             AND r.Complete IS NOT NULL AND r.Complete!=''
             AND (c.TenantID=? OR c.TenantID IS NULL)
             GROUP BY c.CertID, c.CertName
             ORDER BY attendances DESC LIMIT 10`, [tenantOf(req)]),
      // Completions by training type
      dbAll(`SELECT tt.TrainType, COUNT(r.RegisterID) AS completions
             FROM tblTrainType tt
             JOIN tblCerts c ON c.TrainTypeID=tt.TrainTypeID
             JOIN tblRegister r ON r.CertID=c.CertID
             WHERE (r.DateDeleted IS NULL OR r.DateDeleted='')
             AND r.Complete IS NOT NULL AND r.Complete!=''
             GROUP BY tt.TrainTypeID, tt.TrainType ORDER BY completions DESC`),
      // Recent 10 completions
      dbAll(`SELECT s.FirstName||' '||s.LastName AS empName, c.CertName, r.Complete
             FROM tblRegister r
             JOIN tblStaff s ON s.StaffID=r.StaffID
             JOIN tblCerts c ON c.CertID=r.CertID
             WHERE (r.DateDeleted IS NULL OR r.DateDeleted='')
             AND r.Complete IS NOT NULL AND r.Complete!=''
             AND (r.TenantID=? OR r.TenantID IS NULL)
             ORDER BY r.Complete DESC LIMIT 10`, [tenantOf(req)]),
      // Overall compliance (current completions vs required)
      dbGet(`SELECT
               (SELECT COUNT(*) FROM tblRqd WHERE DateDeleted IS NULL OR DateDeleted='') AS totalReq,
               (SELECT COUNT(DISTINCT r.RegisterID)
                FROM tblRegister r
                JOIN tblRqd req ON req.CertID=r.CertID AND (req.StaffID=r.StaffID OR req.JobID IN (SELECT JobID FROM tblStaff WHERE StaffID=r.StaffID))
                WHERE (r.DateDeleted IS NULL OR r.DateDeleted='')
                AND r.Complete IS NOT NULL AND r.Complete!=''
                AND (r.Exp IS NULL OR r.Exp='' OR r.Exp >= date('now'))
                AND (req.DateDeleted IS NULL OR req.DateDeleted='')
                AND (r.TenantID=? OR r.TenantID IS NULL)) AS metReq`, [tenantOf(req)])
    ]);

    const compRate = complianceSummary && complianceSummary.totalReq > 0
      ? Math.round((complianceSummary.metReq / complianceSummary.totalReq) * 100)
      : null;

    // Fill in missing months with 0
    const monthlyFilled = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(); d.setMonth(d.getMonth() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const found = (monthly || []).find(m => m.month === key);
      monthlyFilled.push({ month: key, completions: found ? found.completions : 0 });
    }

    res.json({
      summary: {
        employees: empCount?.n || 0,
        completionsMonth: completionsMonth?.n || 0,
        expiring30: expiringCount?.n || 0,
        complianceRate: compRate
      },
      monthly: monthlyFilled,
      byDept: byDept || [],
      topCourses: topCourses || [],
      byType: byType || [],
      recentCompletions: recentCompletions || []
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
