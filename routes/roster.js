const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');
const { recordLegacyAudit } = require('../lib/governance/audit-adapter'); // WP-16 M3 — sanitizing audit (shape-preserving)

router.use(requireAuth);

// ---- Shift types (flexible, user-defined: Day / Night / Afternoon / Late / etc.) ----
router.get('/shift-types', async (req, res) => {
  try {
    res.json(await dbAll('SELECT * FROM tblShiftType WHERE (TenantID=? OR TenantID IS NULL) ORDER BY SortOrder, Label', [tenantOf(req)]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/shift-types', async (req, res) => {
  try {
    const d = req.body;
    if (!d.Label || !d.Label.trim()) return res.status(400).json({ error: 'Shift name is required.' });
    const existing = await dbGet('SELECT ShiftTypeID FROM tblShiftType WHERE Label=? COLLATE NOCASE AND (TenantID=? OR TenantID IS NULL)', [d.Label.trim(), tenantOf(req)]);
    if (existing) return res.status(409).json({ error: `A shift type named "${d.Label.trim()}" already exists.` });
    const max = ((await dbGet('SELECT COALESCE(MAX(SortOrder),0)+1 AS o FROM tblShiftType WHERE (TenantID=? OR TenantID IS NULL)', [tenantOf(req)]))||{o:1}).o;
    const r = await dbRun('INSERT INTO tblShiftType (Label,Color,StartTime,EndTime,SortOrder,IsOff,TenantID) VALUES (?,?,?,?,?,?,?)',
      [d.Label.trim(), d.Color||'#F58220', d.StartTime||null, d.EndTime||null, d.SortOrder||max, d.IsOff?1:0, tenantOf(req)]);
    try { await recordLegacyAudit(req, 'create', 'shift-type', r.lastID, d.Label); } catch (_) {}
    res.json({ ShiftTypeID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/shift-types/:id', async (req, res) => {
  try {
    const d = req.body;
    if (!d.Label || !d.Label.trim()) return res.status(400).json({ error: 'Shift name is required.' });
    await dbRun('UPDATE tblShiftType SET Label=?,Color=?,StartTime=?,EndTime=?,IsOff=? WHERE ShiftTypeID=? AND (TenantID=? OR TenantID IS NULL)',
      [d.Label.trim(), d.Color||'#F58220', d.StartTime||null, d.EndTime||null, d.IsOff?1:0, req.params.id, tenantOf(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/shift-types/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM tblShiftType WHERE ShiftTypeID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Shift patterns ----
router.get('/patterns', async (req, res) => {
  try {
    const patterns = await dbAll('SELECT * FROM tblShiftPattern WHERE (TenantID=? OR TenantID IS NULL) ORDER BY Name', [tenantOf(req)]);
    for (const p of patterns) p.days = await dbAll('SELECT * FROM tblShiftPatternDay WHERE PatternID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY DayNum', [p.PatternID, tenantOf(req)]);
    res.json(patterns);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/patterns/:id', async (req, res) => {
  try {
    const p = await dbGet('SELECT * FROM tblShiftPattern WHERE PatternID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!p) return res.status(404).json({ error: 'Not found' });
    p.days = await dbAll('SELECT * FROM tblShiftPatternDay WHERE PatternID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY DayNum', [req.params.id, tenantOf(req)]);
    res.json(p);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/patterns', async (req, res) => {
  try {
    const d = req.body;
    const r = await dbRun('INSERT INTO tblShiftPattern (Name,Description,CycleLength,Color,Status,TenantID) VALUES (?,?,?,?,?,?)',
      [d.Name, d.Description, d.CycleLength || (d.days ? d.days.length : 7), d.Color || '#4f46e5', d.Status || 'Active', tenantOf(req)]);
    await saveDays(r.lastID, d.days, tenantOf(req));
    res.json({ PatternID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/patterns/:id', async (req, res) => {
  try {
    const d = req.body;
    await dbRun('UPDATE tblShiftPattern SET Name=?,Description=?,CycleLength=?,Color=?,Status=? WHERE PatternID=? AND (TenantID=? OR TenantID IS NULL)',
      [d.Name, d.Description, d.CycleLength || (d.days ? d.days.length : 7), d.Color || '#4f46e5', d.Status || 'Active', req.params.id, tenantOf(req)]);
    if (d.days) { await dbRun('DELETE FROM tblShiftPatternDay WHERE PatternID=?', [req.params.id]); await saveDays(req.params.id, d.days, tenantOf(req)); }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/patterns/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM tblShiftPatternDay WHERE PatternID=?', [req.params.id]);
    await dbRun('DELETE FROM tblShiftPattern WHERE PatternID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function saveDays(patternId, days, tenantId) {
  for (let i = 0; i < (days || []).length; i++) {
    const d = days[i];
    await dbRun('INSERT INTO tblShiftPatternDay (PatternID,DayNum,ShiftLabel,StartTime,EndTime,TenantID) VALUES (?,?,?,?,?,?)',
      [patternId, i, d.ShiftLabel || 'Off', d.StartTime || null, d.EndTime || null, tenantId]);
  }
}

// ---- Assign a pattern to a person over a date range (generates roster entries) ----
// If endDate is omitted/blank the cycle is generated forward for ROSTER_AUTO_HORIZON_YEARS years
// (default 5) — the user can later enter an end date and re-run with replace:true to truncate.
router.post('/assign', async (req, res) => {
  try {
    const { personType, personId, patternId, startDate, anchorDate, replace } = req.body;
    let { endDate } = req.body;
    if (!personId || !patternId || !startDate) return res.status(400).json({ error: 'personId, patternId and startDate are required.' });
    const pattern = await dbGet('SELECT * FROM tblShiftPattern WHERE PatternID=? AND (TenantID=? OR TenantID IS NULL)', [patternId, tenantOf(req)]);
    const days = await dbAll('SELECT * FROM tblShiftPatternDay WHERE PatternID=? AND (TenantID=? OR TenantID IS NULL) ORDER BY DayNum', [patternId, tenantOf(req)]);
    if (!pattern || !days.length) return res.status(400).json({ error: 'Pattern has no days defined.' });

    const cycle = pattern.CycleLength || days.length;
    const anchor = new Date((anchorDate || startDate) + 'T00:00:00');
    const start = new Date(startDate + 'T00:00:00');
    // Indefinite cycle: no endDate → generate up to ROSTER_AUTO_HORIZON_YEARS years from start.
    // This lets the calendar show the pattern continuing without an arbitrary cutoff;
    // the user supplies an end date later if/when the cycle should stop.
    let openEnded = false;
    if (!endDate || !String(endDate).trim()) {
      openEnded = true;
      const horizonYears = parseInt(process.env.ROSTER_AUTO_HORIZON_YEARS, 10) || 5;
      const auto = new Date(start);
      auto.setFullYear(auto.getFullYear() + horizonYears);
      endDate = `${auto.getFullYear()}-${String(auto.getMonth()+1).padStart(2,'0')}-${String(auto.getDate()).padStart(2,'0')}`;
    }
    const end = new Date(endDate + 'T00:00:00');
    if (end < start) return res.status(400).json({ error: 'End date must be after start date.' });

    // clearAll wipes EVERY existing roster row for this person (past AND future) before generating
    // — used when a previous assignment left stale shifts behind the new start date.
    let clearedAll = 0;
    if (req.body.clearAll) {
      const r = await dbRun("DELETE FROM tblRoster WHERE PersonType=? AND PersonID=?",
        [personType || 'employee', personId]);
      clearedAll = r && r.changes ? r.changes : 0;
    } else if (replace) {
      await dbRun("DELETE FROM tblRoster WHERE PersonType=? AND PersonID=? AND RosterDate>=? AND RosterDate<=?",
        [personType || 'employee', personId, startDate, endDate]);
    }

    let created = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const diff = Math.floor((d - anchor) / 86400000);
      const idx = ((diff % cycle) + cycle) % cycle;
      const day = days.find(x => x.DayNum === idx) || days[idx % days.length];
      if (!day) continue;
      const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      // skip if a manual entry already exists for that day (unless replace cleared them)
      const exists = await dbGet('SELECT RosterID FROM tblRoster WHERE PersonType=? AND PersonID=? AND RosterDate=? AND (TenantID=? OR TenantID IS NULL)',
        [personType || 'employee', personId, ds, tenantOf(req)]);
      if (exists) continue;
      await dbRun(`INSERT INTO tblRoster (PersonType,PersonID,RosterDate,ShiftLabel,StartTime,EndTime,PatternID,CreatedBy,TenantID)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        [personType || 'employee', personId, ds, day.ShiftLabel, day.StartTime, day.EndTime, patternId, req.session.user.username, tenantOf(req)]);
      created++;
    }
    await recordLegacyAudit(req.session.user.username, 'tblRoster', 'ASSIGN', personId, 'Pattern', null, `${pattern.Name} (${created} days${openEnded ? ' · open-ended' : ''})`);
    res.json({ created, openEnded, horizonEnd: openEnded ? endDate : null, clearedAll });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Roster entries (range) with person names ----
router.get('/', async (req, res) => {
  try {
    const { from, to, personType, personId, shift } = req.query;
    let sql = `SELECT r.*,
      CASE r.PersonType WHEN 'trainer'
        THEN (SELECT t.FirstName||' '||t.LastName FROM tblTrainer t WHERE t.TrainerID=r.PersonID)
        ELSE (SELECT s.FirstName||' '||s.LastName FROM tblStaff s WHERE s.StaffID=r.PersonID) END as PersonName,
      CASE r.PersonType WHEN 'trainer' THEN ''
        ELSE (SELECT d.Department FROM tblStaff s LEFT JOIN tblDept d ON s.DeptID=d.DeptID WHERE s.StaffID=r.PersonID) END as Department
      FROM tblRoster r WHERE 1=1 AND (r.TenantID=? OR r.TenantID IS NULL)`;
    const p = [tenantOf(req)];
    if (from) { sql += ' AND r.RosterDate>=?'; p.push(from); }
    if (to) { sql += ' AND r.RosterDate<=?'; p.push(to); }
    if (personType) { sql += ' AND r.PersonType=?'; p.push(personType); }
    if (personId) { sql += ' AND r.PersonID=?'; p.push(personId); }
    if (shift) { sql += ' AND r.ShiftLabel=?'; p.push(shift); }
    sql += ' ORDER BY r.RosterDate, PersonName';
    res.json(await dbAll(sql, p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// A roster row counts as "on duty" when the shift label IS NOT one whose ShiftType.IsOff = 1.
// We LEFT JOIN tblShiftType by case-insensitive Label so any user-defined off-day (e.g. "Day Off",
// "R&R", "Rest Day") is correctly excluded. Falls back to the legacy literal-'Off' check when no
// matching shift type exists, so old rows still behave correctly.
const ON_DUTY_FRAG = `(
  COALESCE(
    (SELECT MAX(st.IsOff) FROM tblShiftType st WHERE LOWER(st.Label) = LOWER(IFNULL(r.ShiftLabel,''))),
    CASE WHEN LOWER(IFNULL(r.ShiftLabel,'')) = 'off' THEN 1 ELSE 0 END
  ) = 0
)`;

// Who is on duty on a given date (excludes any IsOff shift type)
router.get('/onduty', async (req, res) => {
  try {
    const date = req.query.date;
    if (!date) return res.status(400).json({ error: 'date required' });
    const rows = await dbAll(`SELECT r.*,
      CASE r.PersonType WHEN 'trainer'
        THEN (SELECT t.FirstName||' '||t.LastName FROM tblTrainer t WHERE t.TrainerID=r.PersonID)
        ELSE (SELECT s.FirstName||' '||s.LastName FROM tblStaff s WHERE s.StaffID=r.PersonID) END as PersonName
      FROM tblRoster r WHERE r.RosterDate=? AND ${ON_DUTY_FRAG} AND (r.TenantID=? OR r.TenantID IS NULL) ORDER BY r.PersonType, PersonName`, [date, tenantOf(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Year summary: per person, count of on-duty days per month
router.get('/year', async (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear();
    const rows = await dbAll(`SELECT r.PersonType, r.PersonID,
      CASE r.PersonType WHEN 'trainer'
        THEN (SELECT t.FirstName||' '||t.LastName FROM tblTrainer t WHERE t.TrainerID=r.PersonID)
        ELSE (SELECT s.FirstName||' '||s.LastName FROM tblStaff s WHERE s.StaffID=r.PersonID) END as PersonName,
      strftime('%m', r.RosterDate) as Mon, COUNT(*) as Days
      FROM tblRoster r
      WHERE strftime('%Y', r.RosterDate)=? AND ${ON_DUTY_FRAG} AND (r.TenantID=? OR r.TenantID IS NULL)
      GROUP BY r.PersonType, r.PersonID, Mon ORDER BY PersonName`, [String(year), tenantOf(req)]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Manual single entry CRUD ----
router.post('/', async (req, res) => {
  try {
    const d = req.body;
    if (!d.PersonID || !d.RosterDate) return res.status(400).json({ error: 'Person and date are required.' });
    const r = await dbRun(`INSERT INTO tblRoster (PersonType,PersonID,RosterDate,ShiftLabel,StartTime,EndTime,Note,CreatedBy,TenantID)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      [d.PersonType || 'employee', d.PersonID, d.RosterDate, d.ShiftLabel, d.StartTime, d.EndTime, d.Note, req.session.user.username, tenantOf(req)]);
    res.json({ RosterID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  try {
    const d = req.body;
    await dbRun('UPDATE tblRoster SET ShiftLabel=?,StartTime=?,EndTime=?,Note=? WHERE RosterID=? AND (TenantID=? OR TenantID IS NULL)',
      [d.ShiftLabel, d.StartTime, d.EndTime, d.Note, req.params.id, tenantOf(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', async (req, res) => {
  try { await dbRun('DELETE FROM tblRoster WHERE RosterID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Clear a person's roster within a range
router.post('/clear', async (req, res) => {
  try {
    const { personType, personId, from, to } = req.body;
    await dbRun('DELETE FROM tblRoster WHERE PersonType=? AND PersonID=? AND RosterDate>=? AND RosterDate<=?',
      [personType || 'employee', personId, from, to]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
