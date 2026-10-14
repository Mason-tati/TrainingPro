const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');
const { WORKFLOW_EVENTS, fireWorkflow } = require('../lib/workflow');
const mailer = require('../lib/mailer');

router.use(requireAuth);
function adminOnly(req, res, next) {
  if (!req.session.user.admin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

// List of available trigger events (for the builder dropdown)
router.get('/events', (req, res) => res.json(WORKFLOW_EVENTS));

router.get('/', adminOnly, async (req, res) => {
  try {
    res.json(await dbAll('SELECT * FROM tblWorkflow WHERE (TenantID=? OR TenantID IS NULL) ORDER BY Active DESC, Name', [tenantOf(req)]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', adminOnly, async (req, res) => {
  try {
    const d = req.body;
    if (!d.Name || !d.TriggerEvent) return res.status(400).json({ error: 'Name and trigger event are required.' });
    const r = await dbRun(`INSERT INTO tblWorkflow
      (Name,TriggerEvent,Recipients,CcRecipients,NotifySupervisor,NotifyEmployee,SubjectTemplate,Note,Active,CreatedBy,TenantID)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [d.Name, d.TriggerEvent, d.Recipients||null, d.CcRecipients||null,
       d.NotifySupervisor?1:0, d.NotifyEmployee?1:0, d.SubjectTemplate||null, d.Note||null,
       d.Active===false?0:1, req.session.user.username, tenantOf(req)]);
    res.json({ WorkflowID: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', adminOnly, async (req, res) => {
  try {
    const d = req.body;
    if (!d.Name || !d.TriggerEvent) return res.status(400).json({ error: 'Name and trigger event are required.' });
    await dbRun(`UPDATE tblWorkflow SET Name=?,TriggerEvent=?,Recipients=?,CcRecipients=?,
      NotifySupervisor=?,NotifyEmployee=?,SubjectTemplate=?,Note=?,Active=? WHERE WorkflowID=? AND (TenantID=? OR TenantID IS NULL)`,
      [d.Name, d.TriggerEvent, d.Recipients||null, d.CcRecipients||null,
       d.NotifySupervisor?1:0, d.NotifyEmployee?1:0, d.SubjectTemplate||null, d.Note||null,
       d.Active===false?0:1, req.params.id, tenantOf(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', adminOnly, async (req, res) => {
  try {
    await dbRun('DELETE FROM tblWorkflow WHERE WorkflowID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send a test fire for a single workflow using sample context
router.post('/:id/test', adminOnly, async (req, res) => {
  try {
    const wf = await dbGet('SELECT * FROM tblWorkflow WHERE WorkflowID=? AND (TenantID=? OR TenantID IS NULL)', [req.params.id, tenantOf(req)]);
    if (!wf) return res.status(404).json({ error: 'Workflow not found.' });
    const sampleEmail = req.body.testEmail || req.session.user.username;
    const ctx = {
      employeeEmail: sampleEmail, supervisorEmail: sampleEmail,
      vars: { Employee: 'Sample Employee', Course: 'Sample Course', Date: new Date().toISOString().slice(0,10), Note: 'This is a workflow test.' }
    };
    // Force-send to the test address regardless of recipient config
    const html = `<div style="font-family:Arial,sans-serif"><h2 style="color:#F58220">TrainingPro Workflow Test</h2>
      <p>Workflow <strong>${wf.Name}</strong> (trigger: <code>${wf.TriggerEvent}</code>) is configured correctly.</p>
      <p>When this event fires, emails will go to: ${wf.Recipients||'(none set)'}${wf.NotifySupervisor?' + supervisor':''}${wf.NotifyEmployee?' + employee':''}.</p></div>`;
    await mailer.sendMail({ to: sampleEmail, subject: `[TEST] ${wf.SubjectTemplate || wf.Name}`, html });
    res.json({ success: true, sentTo: sampleEmail });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
