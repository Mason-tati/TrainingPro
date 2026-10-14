const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');

router.use(requireAuth);

// ---- Template / column definitions matching the original TT_*.xlsx files ----
const TEMPLATES = {
  // TT_Employee.xlsx  (+ Gender column added)
  employee: {
    label: 'Employees',
    columns: ['LastName','FirstName','Status','Gender','EmployeeNumber','Dept','SupervisorLast','SupervisorFirst','SupEmployeeNumber','Shift','Location','Phone','JobTitle','StartDate','EndDate','Other','Email','EmpType','empLink'],
    sample:  ['Smith','John','Active','Male','EMP-1001','Operations','Doe','Jane','EMP-1000','Day','Main Plant','555-0100','Technician','2024-01-15','','','john.smith@company.com','Full Time','']
  },
  // TT_Training.xlsx
  training: {
    label: 'Training Courses',
    columns: ['TrainingTitle','TrainingNum','Rev','Retrain','ReleaseDate','ExpirationLength','ExpireMonthsDays','GracePeriod','Type','Hours','Location','ExamRequired','Description','Status','LinkedDocument'],
    sample:  ['Forklift Safety','SAF-101','A','No','2024-01-01','12','Months','30','Safety','4','Main Plant','Yes','OSHA forklift operator certification','Active','']
  },
  // TT_Required.xlsx
  required: {
    label: 'Training Requirements',
    columns: ['TrainingTitle','TrainingNumber','Department','JobTitle','LastName','FirstName','EmpID'],
    sample:  ['Forklift Safety','SAF-101','Operations','Technician','','','']
  },
  // TT_Complete.xlsx
  complete: {
    label: 'Training Records (Completions)',
    columns: ['TrainingTitle','TrainingNum','LastName','FirstName','EmpID','DateComplete','DateExpires','Paid','Score','Pass','Revision'],
    sample:  ['Forklift Safety','SAF-101','Smith','John','EMP-1001','2024-03-10','2025-03-10','0','95','Yes','A']
  }
};

const yes = v => /^(yes|y|true|pass|1|x)$/i.test((v||'').trim());
const no  = v => /^(no|n|false|fail|0)$/i.test((v||'').trim());

function toCsv(rows) {
  return rows.map(r => r.map(c => {
    const s = (c == null ? '' : String(c));
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
}

// ---- Download blank template (headers + one sample row) ----
router.get('/template/:type', (req, res) => {
  const t = TEMPLATES[req.params.type];
  if (!t) return res.status(404).json({ error: 'Unknown template type' });
  const csv = toCsv([t.columns, t.sample]);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="TT_${req.params.type}_template.csv"`);
  res.send(csv);
});

// ---- Export current data in the same template layout ----
router.get('/export/:type', async (req, res) => {
  try {
    const t = TEMPLATES[req.params.type];
    if (!t) return res.status(404).json({ error: 'Unknown export type' });
    const tenantId = tenantOf(req); // export only the current tenant's data
    let rows = [];
    if (req.params.type === 'employee') {
      const data = await dbAll(`SELECT s.LastName,s.FirstName,s.Status,s.Gender,s.FileNum,d.Department,s.Supervisor,
        sh.Shift,l.Location,s.CellPhone,j.Title as JobTitle,s.StartDate,s.EndDate,s.Other,s.Email,et.empType,s.empLink
        FROM tblStaff s LEFT JOIN tblDept d ON s.DeptID=d.DeptID LEFT JOIN tblJobs j ON s.JobID=j.JobID
        LEFT JOIN tblLoc l ON s.LocID=l.LocID LEFT JOIN tblShift sh ON s.ShiftID=sh.ShiftID
        LEFT JOIN tblEmpType et ON s.empTypeID=et.empTypeID
        WHERE (s.DateRecDeleted IS NULL OR s.DateRecDeleted='') AND (s.TenantID=? OR s.TenantID IS NULL) ORDER BY s.LastName`, [tenantId]);
      rows = data.map(r => [r.LastName,r.FirstName,r.Status,r.Gender,r.FileNum,r.Department,r.Supervisor,'','',r.Shift,r.Location,r.CellPhone,r.JobTitle,r.StartDate,r.EndDate,r.Other,r.Email,r.empType,r.empLink]);
    } else if (req.params.type === 'training') {
      const data = await dbAll(`SELECT c.CertName,c.CertNum,c.CurrentRev,c.ReleaseDate,c.Months,c.ExpPeriod,c.GracePer,
        c.CertType,c.TrHours,l.Location,c.Exam,c.TrainDesc,c.Status,c.LinkDoc
        FROM tblCerts c LEFT JOIN tblLoc l ON c.LocID=l.LocID
        WHERE (c.DateRecDeleted IS NULL OR c.DateRecDeleted='') AND (c.TenantID=? OR c.TenantID IS NULL) ORDER BY c.CertName`, [tenantId]);
      rows = data.map(r => [r.CertName,r.CertNum,r.CurrentRev,'',r.ReleaseDate,r.Months,r.ExpPeriod==='D'?'Days':'Months',r.GracePer,r.CertType,r.TrHours,r.Location,r.Exam?'Yes':'No',r.TrainDesc,r.Status,r.LinkDoc]);
    } else if (req.params.type === 'required') {
      const data = await dbAll(`SELECT c.CertName,c.CertNum,d.Department,j.Title as JobTitle,s.LastName,s.FirstName,s.FileNum
        FROM tblRqd rq LEFT JOIN tblCerts c ON rq.CertID=c.CertID LEFT JOIN tblDept d ON rq.DeptID=d.DeptID
        LEFT JOIN tblJobs j ON rq.JobID=j.JobID LEFT JOIN tblStaff s ON rq.StaffID=s.StaffID
        WHERE (rq.DateDeleted IS NULL OR rq.DateDeleted='') AND (rq.TenantID=? OR rq.TenantID IS NULL) ORDER BY c.CertName`, [tenantId]);
      rows = data.map(r => [r.CertName,r.CertNum,r.Department,r.JobTitle,r.LastName,r.FirstName,r.FileNum]);
    } else if (req.params.type === 'complete') {
      const data = await dbAll(`SELECT c.CertName,c.CertNum,s.LastName,s.FirstName,s.FileNum,r.Complete,r.Exp,r.Paid,r.Score,r.Pass,r.Rev
        FROM tblRegister r LEFT JOIN tblStaff s ON r.StaffID=s.StaffID LEFT JOIN tblCerts c ON r.CertID=c.CertID
        WHERE (r.DateDeleted IS NULL OR r.DateDeleted='') AND (r.TenantID=? OR r.TenantID IS NULL) ORDER BY r.Complete DESC`, [tenantId]);
      rows = data.map(r => [r.CertName,r.CertNum,r.LastName,r.FirstName,r.FileNum,r.Complete,r.Exp,r.Paid,r.Score,r.Pass!=null?(r.Pass?'Yes':'No'):'',r.Rev]);
    }
    const csv = toCsv([t.columns, ...rows]);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="TT_${req.params.type}_export.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// helper: find or create a lookup row, return id
// tenantId scopes tenant-owned lookup tables (dept/jobs/loc/emptype). Pass null for non-tenant
// tables (e.g. tblShift) to keep the original unscoped behaviour.
async function findOrCreate(table, pk, field, value, tenantId) {
  if (!value || !String(value).trim()) return null;
  value = String(value).trim();
  const scoped = tenantId != null;
  const existing = await dbGet(
    `SELECT ${pk} as id FROM ${table} WHERE ${field}=? COLLATE NOCASE${scoped ? ' AND (TenantID=? OR TenantID IS NULL)' : ''}`,
    scoped ? [value, tenantId] : [value]);
  if (existing) return existing.id;
  const r = scoped
    ? await dbRun(`INSERT INTO ${table} (${field}, TenantID) VALUES (?, ?)`, [value, tenantId])
    : await dbRun(`INSERT INTO ${table} (${field}) VALUES (?)`, [value]);
  return r.lastID;
}

// helper: resolve a staff record by EmployeeNumber (FileNum), else by name
async function resolveStaff(empNum, last, first, tenantId) {
  if (empNum && empNum.trim()) {
    const s = await dbGet('SELECT StaffID FROM tblStaff WHERE FileNum=? AND (TenantID=? OR TenantID IS NULL)', [empNum.trim(), tenantId]);
    if (s) return s.StaffID;
  }
  if (last && first) {
    const s = await dbGet('SELECT StaffID FROM tblStaff WHERE LastName=? COLLATE NOCASE AND FirstName=? COLLATE NOCASE AND (TenantID=? OR TenantID IS NULL)', [last.trim(), first.trim(), tenantId]);
    if (s) return s.StaffID;
  }
  return null;
}

// helper: resolve a course by number, else by title (within the tenant)
async function resolveCert(num, title, tenantId) {
  if (num && num.trim()) {
    const c = await dbGet('SELECT CertID,Months FROM tblCerts WHERE CertNum=? AND (TenantID=? OR TenantID IS NULL)', [num.trim(), tenantId]);
    if (c) return c;
  }
  if (title && title.trim()) {
    const c = await dbGet('SELECT CertID,Months FROM tblCerts WHERE CertName=? COLLATE NOCASE AND (TenantID=? OR TenantID IS NULL)', [title.trim(), tenantId]);
    if (c) return c;
  }
  return null;
}

// Ensure imported employees get a primary tblEmpJob role matching their job title
async function syncRole(empId, jobId, user, tenantId) {
  const existing = await dbGet("SELECT EmpJobID FROM tblEmpJob WHERE EmpID=? AND JobID=? AND (DateDeleted IS NULL OR DateDeleted='')", [empId, jobId]);
  if (existing) return;
  await dbRun("UPDATE tblEmpJob SET IsPrimary=0 WHERE EmpID=? AND (DateDeleted IS NULL OR DateDeleted='')", [empId]);
  await dbRun("INSERT INTO tblEmpJob (EmpID,JobID,IsPrimary,DateAssigned,LastUpdateBy,TenantID) VALUES (?,?,1,date('now'),?,?)", [empId, jobId, user, tenantId]);
  await dbRun("INSERT INTO tblEmpJobHist (EmpID,JobID,Action,ChangedBy,TenantID) VALUES (?,?,'Assigned',?,?)", [empId, jobId, user, tenantId]);
}

function normGender(v) {
  v = (v || '').trim().toLowerCase();
  if (v === 'm' || v === 'male') return 'Male';
  if (v === 'f' || v === 'female') return 'Female';
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : null;
}

// ---- Bulk import ----
router.post('/:type', async (req, res) => {
  try {
    const rows = req.body.rows || [];
    const user = req.session.user.username;
    const tenantId = tenantOf(req); // R3 — imported records + lookups belong to the current tenant
    let inserted = 0, updated = 0, skipped = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const ln = i + 2; // human row number (header = row 1)
      try {
        if (req.params.type === 'employee') {
          if (!row.FirstName || !row.LastName) { skipped++; errors.push(`Row ${ln}: missing name`); continue; }
          const deptID = await findOrCreate('tblDept','DeptID','Department', row.Dept, tenantId);
          const jobID  = await findOrCreate('tblJobs','JobID','Title', row.JobTitle, tenantId);
          const locID  = await findOrCreate('tblLoc','LocID','Location', row.Location, tenantId);
          const shiftID= await findOrCreate('tblShift','ShiftID','Shift', row.Shift); // tblShift has no TenantID
          const empTypeID = await findOrCreate('tblEmpType','empTypeID','empType', row.EmpType, tenantId);
          const sup = [row.SupervisorLast, row.SupervisorFirst].filter(Boolean).join(', ');
          const gender = normGender(row.Gender);
          const existing = row.EmployeeNumber ? await dbGet('SELECT StaffID FROM tblStaff WHERE FileNum=? AND (TenantID=? OR TenantID IS NULL)', [row.EmployeeNumber, tenantId]) : null;
          if (existing) {
            await dbRun(`UPDATE tblStaff SET LastName=?,FirstName=?,Status=?,Gender=?,DeptID=?,Supervisor=?,ShiftID=?,
              LocID=?,CellPhone=?,JobID=?,StartDate=?,EndDate=?,Other=?,Email=?,empTypeID=?,empLink=?,LastUpdateBy=? WHERE StaffID=? AND (TenantID=? OR TenantID IS NULL)`,
              [row.LastName,row.FirstName,row.Status||'Active',gender,deptID,sup,shiftID,locID,row.Phone,jobID,
               row.StartDate||null,row.EndDate||null,row.Other,row.Email,empTypeID,row.empLink,user,existing.StaffID,tenantId]);
            if (jobID) await syncRole(existing.StaffID, jobID, user, tenantId);
            updated++;
          } else {
            await dbRun(`INSERT INTO tblStaff (LastName,FirstName,Status,Gender,FileNum,DeptID,Supervisor,ShiftID,LocID,
              CellPhone,JobID,StartDate,EndDate,Other,Email,empTypeID,empLink,DateRecAdded,AddedBy,LastUpdateBy,LinkAll,TenantID)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,date('now'),?,?,0,?)`,
              [row.LastName,row.FirstName,row.Status||'Active',gender,row.EmployeeNumber,deptID,sup,shiftID,locID,
               row.Phone,jobID,row.StartDate||null,row.EndDate||null,row.Other,row.Email,empTypeID,row.empLink,user,user,tenantId]);
            const newStaff = await dbGet('SELECT StaffID FROM tblStaff WHERE FileNum=? AND (TenantID=? OR TenantID IS NULL) ORDER BY StaffID DESC LIMIT 1', [row.EmployeeNumber, tenantId]);
            if (jobID && newStaff) await syncRole(newStaff.StaffID, jobID, user, tenantId);
            inserted++;
          }

        } else if (req.params.type === 'training') {
          if (!row.TrainingTitle) { skipped++; errors.push(`Row ${ln}: missing TrainingTitle`); continue; }
          const locID = await findOrCreate('tblLoc','LocID','Location', row.Location, tenantId);
          const expPeriod = /day/i.test(row.ExpireMonthsDays||'') ? 'D' : 'M';
          const existing = row.TrainingNum ? await dbGet('SELECT CertID FROM tblCerts WHERE CertNum=? AND (TenantID=? OR TenantID IS NULL)', [row.TrainingNum, tenantId]) : null;
          const params = [row.TrainingTitle,row.CurrentRev||row.Rev,row.ReleaseDate||null,row.ExpirationLength||null,
            expPeriod,row.GracePeriod||0,row.Type,row.Hours||null,locID,yes(row.ExamRequired)?1:0,row.Description,row.Status||'Active'];
          if (existing) {
            await dbRun(`UPDATE tblCerts SET CertName=?,CurrentRev=?,ReleaseDate=?,Months=?,ExpPeriod=?,GracePer=?,
              CertType=?,TrHours=?,LocID=?,Exam=?,TrainDesc=?,Status=?,LinkDoc=?,LastUpdateBy=? WHERE CertID=? AND (TenantID=? OR TenantID IS NULL)`,
              [...params, row.LinkedDocument, user, existing.CertID, tenantId]);
            updated++;
          } else {
            await dbRun(`INSERT INTO tblCerts (CertName,CurrentRev,ReleaseDate,Months,ExpPeriod,GracePer,CertType,TrHours,
              LocID,Exam,TrainDesc,Status,CertNum,LinkDoc,DateRecAdded,AddedBy,LastUpdateBy,LinkAll,TenantID)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,date('now'),?,?,0,?)`,
              [...params, row.TrainingNum, row.LinkedDocument, user, user, tenantId]);
            inserted++;
          }

        } else if (req.params.type === 'required') {
          const cert = await resolveCert(row.TrainingNumber, row.TrainingTitle, tenantId);
          if (!cert) { skipped++; errors.push(`Row ${ln}: course "${row.TrainingNumber||row.TrainingTitle}" not found`); continue; }
          const deptID = row.Department ? await findOrCreate('tblDept','DeptID','Department', row.Department, tenantId) : null;
          const jobID  = row.JobTitle ? await findOrCreate('tblJobs','JobID','Title', row.JobTitle, tenantId) : null;
          const staffID = await resolveStaff(row.EmpID, row.LastName, row.FirstName, tenantId);
          if (!deptID && !jobID && !staffID) { skipped++; errors.push(`Row ${ln}: no Department, JobTitle, or Employee to assign`); continue; }
          await dbRun(`INSERT INTO tblRqd (CertID,JobID,StaffID,DeptID,LastUpdateBy,TenantID) VALUES (?,?,?,?,?,?)`,
            [cert.CertID, jobID, staffID, deptID, user, tenantId]);
          inserted++;

        } else if (req.params.type === 'complete') {
          const staffID = await resolveStaff(row.EmpID, row.LastName, row.FirstName, tenantId);
          const cert = await resolveCert(row.TrainingNum, row.TrainingTitle, tenantId);
          if (!staffID) { skipped++; errors.push(`Row ${ln}: employee "${row.EmpID||row.LastName}" not found`); continue; }
          if (!cert) { skipped++; errors.push(`Row ${ln}: course "${row.TrainingNum||row.TrainingTitle}" not found`); continue; }
          let exp = row.DateExpires || null;
          if (!exp && row.DateComplete && cert.Months) {
            const d = new Date(row.DateComplete); d.setMonth(d.getMonth() + parseInt(cert.Months));
            exp = d.toISOString().split('T')[0];
          }
          const pass = yes(row.Pass) ? 1 : (no(row.Pass) ? 0 : null);
          await dbRun(`INSERT INTO tblRegister (StaffID,CertID,Complete,Exp,Paid,Score,Pass,Rev,State,LastUpdateBy,TenantID)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [staffID, cert.CertID, row.DateComplete||null, exp, row.Paid||null, row.Score||null, pass, row.Revision, 'Completed', user, tenantId]);
          inserted++;

        } else {
          return res.status(404).json({ error: 'Unknown import type' });
        }
      } catch (rowErr) { skipped++; errors.push(`Row ${ln}: ${rowErr.message}`); }
    }
    res.json({ inserted, updated, skipped, errors: errors.slice(0, 50) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
