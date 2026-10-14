const express = require('express');
const router = express.Router();
const { dbAll, dbRun } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');

router.use(requireAuth);

function mkRoutes(path, table, pk, labelField, extraInsert, owned) {
  router.get(path, async (req, res) => {
    try { res.json(await dbAll(`SELECT * FROM ${table}${owned ? ' WHERE (TenantID=? OR TenantID IS NULL)' : ''} ORDER BY ${labelField}`, owned ? [tenantOf(req)] : [])); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.post(path, async (req, res) => {
    try {
      const body = extraInsert ? extraInsert(req.body) : [req.body[labelField]];
      const fields = extraInsert ? extraInsert._fields : [labelField];
      const insBody = owned ? [...body, tenantOf(req)] : body;
      const insFields = owned ? [...fields, 'TenantID'] : fields;
      const placeholders = insBody.map(() => '?').join(',');
      const r = await dbRun(`INSERT INTO ${table} (${insFields.join(',')}) VALUES (${placeholders})`, insBody);
      res.json({ [pk]: r.lastID });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.put(`${path}/:id`, async (req, res) => {
    try {
      await dbRun(`UPDATE ${table} SET ${labelField}=? WHERE ${pk}=?${owned ? ' AND (TenantID=? OR TenantID IS NULL)' : ''}`, owned ? [req.body[labelField], req.params.id, tenantOf(req)] : [req.body[labelField], req.params.id]);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  router.delete(`${path}/:id`, async (req, res) => {
    try { await dbRun(`DELETE FROM ${table} WHERE ${pk}=?${owned ? ' AND (TenantID=? OR TenantID IS NULL)' : ''}`, owned ? [req.params.id, tenantOf(req)] : [req.params.id]); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
}

mkRoutes('/depts',     'tblDept',     'DeptID',      'Department', null, true);
mkRoutes('/jobs',      'tblJobs',     'JobID',        'Title', null, true);
mkRoutes('/locations', 'tblLoc',      'LocID',        'Location', null, true);
mkRoutes('/shifts',    'tblShift',    'ShiftID',      'Shift');
mkRoutes('/emptypes',  'tblEmpType',  'empTypeID',    'empType', null, true);
mkRoutes('/traintypes','tblTrainType','TrainTypeID',  'TrainType', null, true);

// ClassLoc has extra field
router.get('/classlocs', async (req, res) => {
  try { res.json(await dbAll('SELECT * FROM tblClassLoc ORDER BY ClassLoc', [])); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/classlocs', async (req, res) => {
  try {
    const r = await dbRun('INSERT INTO tblClassLoc (ClassLoc,ClassCapacity) VALUES (?,?)', [req.body.ClassLoc, req.body.ClassCapacity||0]);
    res.json({ ClassLocID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/classlocs/:id', async (req, res) => {
  try { await dbRun('UPDATE tblClassLoc SET ClassLoc=? WHERE ClassLocID=?', [req.body.ClassLoc, req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/classlocs/:id', async (req, res) => {
  try { await dbRun('DELETE FROM tblClassLoc WHERE ClassLocID=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/expperiods', async (req, res) => {
  try { res.json(await dbAll('SELECT * FROM tblExpPeriod ORDER BY PeriodID', [])); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
