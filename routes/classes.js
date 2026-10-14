const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');
const { recordLegacyAudit } = require('../lib/governance/audit-adapter'); // WP-16 M3 — sanitizing audit (shape-preserving)
const booking = require('../lib/booking');
const { fireWorkflow } = require('../lib/workflow');

router.use(requireAuth);

const CLASS_SELECT = `SELECT cl.*, c.CertName, c.CertNum, cl2.ClassLoc, cl2.ClassCapacity,
  t.FirstName as TrainerFirst, t.LastName as TrainerLast,
  (SELECT COUNT(*) FROM tblRegister r WHERE r.ClassID=cl.ClassID AND (r.DateDeleted IS NULL OR r.DateDeleted='')
     AND (r.State IS NULL OR r.State NOT IN ('Cancelled','Waitlisted'))) as Enrolled,
  (SELECT COUNT(*) FROM tblRegister r WHERE r.ClassID=cl.ClassID AND (r.DateDeleted IS NULL OR r.DateDeleted='')
     AND r.State='Waitlisted') as Waitlisted
  FROM tblClass cl
  LEFT JOIN tblCerts c ON cl.CertID=c.CertID
  LEFT JOIN tblClassLoc cl2 ON cl.ClassLocID=cl2.ClassLocID
  LEFT JOIN tblTrainer t ON cl.TrainerID=t.TrainerID`;

router.get('/', async (req, res) => {
  try {
    const { certID, upcoming, search } = req.query;
    let sql = CLASS_SELECT + ' WHERE 1=1 AND (cl.TenantID=? OR cl.TenantID IS NULL)';
    const p = [tenantOf(req)];
    if (certID) { sql += ' AND cl.CertID=?'; p.push(certID); }
    if (upcoming === '1') { sql += " AND cl.ClassDate >= date('now')"; }
    if (search) { sql += ' AND (cl.ClassName LIKE ? OR c.CertName LIKE ?)'; p.push(`%${search}%`,`%${search}%`); }
    sql += ' ORDER BY cl.ClassDate DESC';
    res.json(await dbAll(sql, p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Calendar feed (optionally by month: ?from=YYYY-MM-DD&to=YYYY-MM-DD)
router.get('/calendar', async (req, res) => {
  try {
    const { from, to } = req.query;
    let sql = CLASS_SELECT + " WHERE cl.ClassDate IS NOT NULL AND cl.ClassDate<>'' AND (cl.TenantID=? OR cl.TenantID IS NULL)";
    const p = [tenantOf(req)];
    if (from) { sql += ' AND cl.ClassDate>=?'; p.push(from); }
    if (to) { sql += ' AND cl.ClassDate<=?'; p.push(to); }
    sql += ' ORDER BY cl.ClassDate, cl.TimeStart';
    res.json(await dbAll(sql, p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  try {
    const c = await dbGet(CLASS_SELECT + ' WHERE cl.ClassID=? AND (cl.TenantID=? OR cl.TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    c.Capacity = await booking.getCapacity(req.params.id);
    res.json(c);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id/roster', async (req, res) => {
  try {
    const rows = await dbAll(`SELECT r.*, s.LastName, s.FirstName, s.FileNum, s.Email, d.Department
      FROM tblRegister r LEFT JOIN tblStaff s ON r.StaffID=s.StaffID LEFT JOIN tblDept d ON s.DeptID=d.DeptID
      WHERE r.ClassID=? AND (r.DateDeleted IS NULL OR r.DateDeleted='')
        AND (r.TenantID=? OR r.TenantID IS NULL)
      ORDER BY CASE WHEN r.State='Waitlisted' THEN 1 ELSE 0 END, r.BookedDate, s.LastName`, [req.params.id, tenantOf(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Check conflicts before saving a class (does not save)
router.post('/check-conflicts', async (req, res) => {
  try {
    const d = req.body;
    res.json(await booking.findClassConflicts({
      classId: d.ClassID, classDate: d.ClassDate, timeStart: d.TimeStart, timeEnd: d.TimeEnd,
      trainerId: d.TrainerID, classLocId: d.ClassLocID
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  try {
    const d = req.body;
    const r = await dbRun(`INSERT INTO tblClass
      (ClassName,ClassNum,OfferedBy,CertID,DateTime,EstCost,OfferID,ClassDate,ClassLocation,TimeStart,TimeEnd,ClassLocID,TrainerID,MaxSeats,LinkAll,TenantID)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
      [d.ClassName,d.ClassNum,d.OfferedBy,d.CertID||null,d.DateTime,d.EstCost||null,d.OfferID||null,
       d.ClassDate||null,d.ClassLocation,d.TimeStart||null,d.TimeEnd||null,d.ClassLocID||null,d.TrainerID||null,d.MaxSeats||null,tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'tblClass', 'CREATE', r.lastID, null, null, d.ClassName);
    res.json({ ClassID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const d = req.body;
    await dbRun(`UPDATE tblClass SET ClassName=?,ClassNum=?,OfferedBy=?,CertID=?,DateTime=?,EstCost=?,
      ClassDate=?,ClassLocation=?,TimeStart=?,TimeEnd=?,ClassLocID=?,TrainerID=?,MaxSeats=? WHERE ClassID=? AND (TenantID=? OR TenantID IS NULL)`,
      [d.ClassName,d.ClassNum,d.OfferedBy,d.CertID||null,d.DateTime,d.EstCost||null,
       d.ClassDate||null,d.ClassLocation,d.TimeStart||null,d.TimeEnd||null,d.ClassLocID||null,
       d.TrainerID||null,d.MaxSeats||null,req.params.id,tenantOf(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try { await dbRun('DELETE FROM tblClass WHERE ClassID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Booking: add an employee to a class (capacity → waitlist, conflict aware) ----
router.post('/:id/book', async (req, res) => {
  try {
    const classId = req.params.id;
    const { staffId, force } = req.body;
    const cls = await dbGet('SELECT * FROM tblClass WHERE ClassID=? AND (TenantID=? OR TenantID IS NULL)', [classId, tenantOf(req)]);
    if (!cls) return res.status(404).json({ error: 'Class not found' });

    // Already booked?
    const existing = await dbGet(`SELECT RegisterID, State FROM tblRegister WHERE ClassID=? AND StaffID=?
      AND (DateDeleted IS NULL OR DateDeleted='') AND (State IS NULL OR State<>'Cancelled')
      AND (TenantID=? OR TenantID IS NULL)`, [classId, staffId, tenantOf(req)]);
    if (existing) return res.status(400).json({ error: 'This employee is already booked on this class.' });

    // Employee schedule conflict (warn unless forced)
    const conflict = await booking.findEmployeeConflict(staffId, classId);
    if (conflict && !force) return res.status(409).json({ conflict });

    // Capacity → waitlist
    const cap = await booking.getCapacity(classId);
    const booked = await booking.getBookedCount(classId);
    const state = (cap && booked >= cap) ? 'Waitlisted' : 'Registered';

    const r = await dbRun(`INSERT INTO tblRegister (ClassID,StaffID,CertID,State,BookedDate,LastUpdateBy,TenantID)
      VALUES (?,?,?,?,datetime('now'),?,?)`, [classId, staffId, cls.CertID||null, state, req.session.user.username, tenantOf(req)]);
    await recordLegacyAudit(req.session.user.username, 'tblRegister', 'BOOK', r.lastID, 'State', null, state);
    // Workflow: training class booked
    try {
      const info = await dbGet(`SELECT s.FirstName,s.LastName,s.Email,sup.Email AS SupEmail
        FROM tblStaff s LEFT JOIN tblStaff sup ON sup.StaffID=s.SupID WHERE s.StaffID=?`, [staffId]);
      if (info) await fireWorkflow('class_booked', {
        employeeEmail: info.Email, supervisorEmail: info.SupEmail,
        vars: { Employee: `${info.FirstName||''} ${info.LastName||''}`.trim(), Class: cls.ClassName||'', Date: cls.ClassDate||'', Status: state }
      });
    } catch (_) {}
    res.json({ RegisterID: r.lastID, state, waitlisted: state === 'Waitlisted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update a booking's status (check-in: Attended / No-Show / Confirmed / Cancelled)
router.put('/booking/:regId/status', async (req, res) => {
  try {
    const { status } = req.body;
    const reg = await dbGet('SELECT * FROM tblRegister WHERE RegisterID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.regId, tenantOf(req)]);
    if (!reg) return res.status(404).json({ error: 'Booking not found' });

    const checkIn = status === 'Attended' ? "datetime('now')" : 'CheckedInAt';
    await dbRun(`UPDATE tblRegister SET State=?, CheckedInAt=${checkIn}, LastUpdateBy=? WHERE RegisterID=? AND (TenantID=? OR TenantID IS NULL)`,
      [status, req.session.user.username, req.params.regId, tenantOf(req)]);

    // If marking Attended and the class is linked to a cert, record completion
    if (status === 'Attended' && reg.CertID) {
      const cert = await dbGet('SELECT Months FROM tblCerts WHERE CertID=?', [reg.CertID]);
      let exp = null;
      if (cert && cert.Months) { const dd = new Date(); dd.setMonth(dd.getMonth() + cert.Months); exp = dd.toISOString().split('T')[0]; }
      await dbRun("UPDATE tblRegister SET Complete=date('now'), Exp=COALESCE(Exp,?) WHERE RegisterID=? AND (TenantID=? OR TenantID IS NULL)", [exp, req.params.regId, tenantOf(req)]);
    }

    // If cancelled, auto-promote the first waitlisted person
    let promoted = null;
    if (status === 'Cancelled') {
      const next = await dbGet(`SELECT RegisterID, StaffID FROM tblRegister WHERE ClassID=? AND State='Waitlisted'
        AND (DateDeleted IS NULL OR DateDeleted='') AND (TenantID=? OR TenantID IS NULL) ORDER BY BookedDate LIMIT 1`, [reg.ClassID, tenantOf(req)]);
      if (next) {
        await dbRun("UPDATE tblRegister SET State='Registered', LastUpdateBy=? WHERE RegisterID=? AND (TenantID=? OR TenantID IS NULL)", [req.session.user.username, next.RegisterID, tenantOf(req)]);
        promoted = next.RegisterID;
      }
    }
    await recordLegacyAudit(req.session.user.username, 'tblRegister', 'STATUS', req.params.regId, 'State', null, status);
    res.json({ success: true, promoted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
