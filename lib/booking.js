const { dbAll, dbGet } = require('../database/db');

// Two time ranges overlap if start1 < end2 AND start2 < end1.
// Missing times are treated as a whole-day block so same-day clashes still surface.
function overlaps(s1, e1, s2, e2) {
  s1 = s1 || '00:00'; e1 = e1 || '23:59';
  s2 = s2 || '00:00'; e2 = e2 || '23:59';
  return s1 < e2 && s2 < e1;
}

// Detect trainer + room conflicts for a class being saved.
// excludeClassId lets an edit ignore itself.
async function findClassConflicts({ classId, classDate, timeStart, timeEnd, trainerId, classLocId }) {
  const conflicts = [];
  if (!classDate) return conflicts;

  if (trainerId) {
    const rows = await dbAll(
      `SELECT cl.ClassID, cl.ClassName, cl.TimeStart, cl.TimeEnd, t.FirstName, t.LastName
       FROM tblClass cl JOIN tblTrainer t ON cl.TrainerID=t.TrainerID
       WHERE cl.TrainerID=? AND cl.ClassDate=? AND cl.ClassID<>?`,
      [trainerId, classDate, classId || 0]);
    for (const r of rows) {
      if (overlaps(timeStart, timeEnd, r.TimeStart, r.TimeEnd))
        conflicts.push({ type: 'trainer', message: `Trainer ${r.FirstName} ${r.LastName} is already booked for "${r.ClassName}" (${r.TimeStart||'all day'}–${r.TimeEnd||''}) on ${classDate}.` });
    }
  }

  if (classLocId) {
    const rows = await dbAll(
      `SELECT cl.ClassID, cl.ClassName, cl.TimeStart, cl.TimeEnd, loc.ClassLoc
       FROM tblClass cl JOIN tblClassLoc loc ON cl.ClassLocID=loc.ClassLocID
       WHERE cl.ClassLocID=? AND cl.ClassDate=? AND cl.ClassID<>?`,
      [classLocId, classDate, classId || 0]);
    for (const r of rows) {
      if (overlaps(timeStart, timeEnd, r.TimeStart, r.TimeEnd))
        conflicts.push({ type: 'room', message: `Room "${r.ClassLoc}" is already booked for "${r.ClassName}" (${r.TimeStart||'all day'}–${r.TimeEnd||''}) on ${classDate}.` });
    }
  }
  return conflicts;
}

// Detect whether an employee is already booked in an overlapping class on the same day.
async function findEmployeeConflict(staffId, classId) {
  const cls = await dbGet('SELECT ClassDate, TimeStart, TimeEnd FROM tblClass WHERE ClassID=?', [classId]);
  if (!cls || !cls.ClassDate) return null;
  const rows = await dbAll(
    `SELECT cl.ClassID, cl.ClassName, cl.TimeStart, cl.TimeEnd
     FROM tblRegister r JOIN tblClass cl ON r.ClassID=cl.ClassID
     WHERE r.StaffID=? AND cl.ClassDate=? AND cl.ClassID<>?
       AND (r.DateDeleted IS NULL OR r.DateDeleted='')
       AND (r.State IS NULL OR r.State NOT IN ('Cancelled','Waitlisted'))`,
    [staffId, cls.ClassDate, classId]);
  for (const r of rows) {
    if (overlaps(cls.TimeStart, cls.TimeEnd, r.TimeStart, r.TimeEnd))
      return `Employee is already booked in "${r.ClassName}" (${r.TimeStart||'all day'}–${r.TimeEnd||''}) on ${cls.ClassDate}.`;
  }
  return null;
}

// Capacity for a class: explicit MaxSeats overrides the room capacity.
async function getCapacity(classId) {
  const cls = await dbGet(
    `SELECT cl.MaxSeats, loc.ClassCapacity
     FROM tblClass cl LEFT JOIN tblClassLoc loc ON cl.ClassLocID=loc.ClassLocID WHERE cl.ClassID=?`, [classId]);
  if (!cls) return null;
  return cls.MaxSeats || cls.ClassCapacity || null; // null = unlimited
}

// Count confirmed/registered (non-waitlist, non-cancelled) bookings.
async function getBookedCount(classId) {
  const row = await dbGet(
    `SELECT COUNT(*) as n FROM tblRegister
     WHERE ClassID=? AND (DateDeleted IS NULL OR DateDeleted='')
       AND (State IS NULL OR State NOT IN ('Cancelled','Waitlisted'))`, [classId]);
  return row.n;
}

module.exports = { findClassConflicts, findEmployeeConflict, getCapacity, getBookedCount, overlaps };
