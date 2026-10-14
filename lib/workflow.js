const { dbAll, dbGet } = require('../database/db');
const mailer = require('./mailer');

// Catalog of trigger events workflows can listen to. Keep in sync with the frontend.
const WORKFLOW_EVENTS = [
  { key: 'training_completed', label: 'Training record completed', desc: 'A training record is marked complete / signed off.' },
  { key: 'training_expiring',  label: 'Training expiring soon',    desc: 'A qualification is approaching its expiry date.' },
  { key: 'training_expired',   label: 'Training expired',          desc: 'A qualification has passed its expiry date.' },
  { key: 'exam_passed',        label: 'Exam passed',               desc: 'An employee passes an online exam.' },
  { key: 'exam_failed',        label: 'Exam failed',               desc: 'An employee fails an online exam.' },
  { key: 'cert_awarded',       label: 'Qualification awarded',     desc: 'A certificate / qualification is granted to an employee.' },
  { key: 'employee_added',     label: 'New employee added',        desc: 'A new employee record is created.' },
  { key: 'class_booked',       label: 'Training class booked',     desc: 'An employee is booked onto a scheduled class.' },
  { key: 'form_signoff',       label: 'Assessment needs sign-off', desc: 'A field assessment is awaiting supervisor sign-off.' }
];

function splitEmails(s) {
  return (s || '').split(/[,;\s]+/).map(x => x.trim()).filter(x => /.+@.+\..+/.test(x));
}

// Resolve the recipient list for a workflow given the event context.
// ctx may contain: employeeEmail, employeeName, supervisorEmail, supervisorName, subjectVars
async function resolveRecipients(wf, ctx = {}) {
  const to = new Set(splitEmails(wf.Recipients));
  if (wf.NotifyEmployee && ctx.employeeEmail) to.add(ctx.employeeEmail.trim());
  if (wf.NotifySupervisor && ctx.supervisorEmail) to.add(ctx.supervisorEmail.trim());
  return [...to];
}

// Fill {{placeholders}} in a template string using ctx.vars
function fillTemplate(tpl, vars = {}) {
  return (tpl || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
}

// Fire all active workflows registered for an event. Never throws — logs and continues.
// Returns a summary array of what was attempted.
async function fireWorkflow(event, ctx = {}) {
  const results = [];
  try {
    const flows = await dbAll('SELECT * FROM tblWorkflow WHERE TriggerEvent=? AND Active=1', [event]);
    for (const wf of flows) {
      try {
        const to = await resolveRecipients(wf, ctx);
        if (!to.length) { results.push({ workflow: wf.Name, skipped: 'no recipients' }); continue; }
        const cc = splitEmails(wf.CcRecipients);
        const vars = ctx.vars || {};
        const subject = fillTemplate(wf.SubjectTemplate || `TrainingPro: ${event}`, vars);
        const html = buildEventHtml(event, wf, vars);
        await mailer.sendMail({ to: to.join(','), cc: cc.length ? cc.join(',') : undefined, subject, html });
        results.push({ workflow: wf.Name, sentTo: to });
      } catch (e) {
        results.push({ workflow: wf.Name, error: e.message });
      }
    }
  } catch (e) {
    results.push({ error: e.message });
  }
  return results;
}

function buildEventHtml(event, wf, vars) {
  const ev = WORKFLOW_EVENTS.find(e => e.key === event);
  const rows = Object.entries(vars).map(([k, v]) =>
    `<tr><td style="padding:5px 10px;color:#666;border-bottom:1px solid #eee">${k}</td>
     <td style="padding:5px 10px;border-bottom:1px solid #eee"><strong>${v}</strong></td></tr>`).join('');
  return `<div style="font-family:Arial,sans-serif;max-width:620px">
    <div style="background:#23272F;padding:16px 20px;border-radius:8px 8px 0 0">
      <span style="color:#F58220;font-size:18px;font-weight:bold">Training</span><span style="color:#fff;font-size:18px;font-weight:bold">Pro</span>
    </div>
    <div style="border:1px solid #eee;border-top:none;padding:20px;border-radius:0 0 8px 8px">
      <h2 style="margin:0 0 4px;color:#23272F">${ev ? ev.label : event}</h2>
      <p style="color:#666;margin:0 0 16px">Workflow: <strong>${wf.Name}</strong></p>
      ${rows ? `<table style="width:100%;border-collapse:collapse;font-size:13px">${rows}</table>` : ''}
      ${wf.Note ? `<p style="margin-top:16px;color:#444">${wf.Note}</p>` : ''}
      <p style="margin-top:20px;font-size:12px;color:#999">Sent automatically by TrainingPro workflow assignment.</p>
    </div>
  </div>`;
}

// Daily scheduled checks: fire training_expiring (within 30 days) and training_expired events,
// once per record (NotifiedExpiring / NotifiedExpired columns prevent daily re-sends).
async function runScheduledChecks() {
  const { dbRun } = require('../database/db');
  const out = { expiring: 0, expired: 0 };
  try {
    const expiring = await dbAll(`SELECT r.RegisterID, r.Exp, s.FirstName, s.LastName, s.Email, sup.Email AS SupEmail, c.CertName
      FROM tblRegister r
      JOIN tblStaff s ON r.StaffID=s.StaffID LEFT JOIN tblStaff sup ON sup.StaffID=s.SupID
      LEFT JOIN tblCerts c ON r.CertID=c.CertID
      WHERE r.Exp IS NOT NULL AND r.Exp!='' AND r.Exp>=date('now') AND r.Exp<=date('now','+30 days')
        AND s.Status='Active' AND (r.DateDeleted IS NULL OR r.DateDeleted='') AND r.NotifiedExpiring IS NULL LIMIT 100`);
    for (const r of expiring) {
      await fireWorkflow('training_expiring', {
        employeeEmail: r.Email, supervisorEmail: r.SupEmail,
        vars: { Employee: `${r.FirstName||''} ${r.LastName||''}`.trim(), Course: r.CertName||'', Expires: r.Exp, Date: new Date().toISOString().slice(0,10) }
      });
      await dbRun("UPDATE tblRegister SET NotifiedExpiring=date('now') WHERE RegisterID=?", [r.RegisterID]);
      out.expiring++;
    }
    const expired = await dbAll(`SELECT r.RegisterID, r.Exp, s.FirstName, s.LastName, s.Email, sup.Email AS SupEmail, c.CertName
      FROM tblRegister r
      JOIN tblStaff s ON r.StaffID=s.StaffID LEFT JOIN tblStaff sup ON sup.StaffID=s.SupID
      LEFT JOIN tblCerts c ON r.CertID=c.CertID
      WHERE r.Exp IS NOT NULL AND r.Exp!='' AND r.Exp<date('now')
        AND s.Status='Active' AND (r.DateDeleted IS NULL OR r.DateDeleted='') AND r.NotifiedExpired IS NULL LIMIT 100`);
    for (const r of expired) {
      await fireWorkflow('training_expired', {
        employeeEmail: r.Email, supervisorEmail: r.SupEmail,
        vars: { Employee: `${r.FirstName||''} ${r.LastName||''}`.trim(), Course: r.CertName||'', Expired: r.Exp, Date: new Date().toISOString().slice(0,10) }
      });
      await dbRun("UPDATE tblRegister SET NotifiedExpired=date('now') WHERE RegisterID=?", [r.RegisterID]);
      out.expired++;
    }
  } catch (e) { out.error = e.message; }
  return out;
}

module.exports = { WORKFLOW_EVENTS, fireWorkflow, splitEmails, runScheduledChecks };
// Additive exports for unit testing pure helpers (WP-07 C5). No runtime behaviour
// changes — these are the same functions used internally.
module.exports.fillTemplate = fillTemplate;
module.exports.resolveRecipients = resolveRecipients;
