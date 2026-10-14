const nodemailer = require('nodemailer');
const { dbAll, dbGet } = require('../database/db');

// Load SMTP config from tblConfig
async function getConfig() {
  const rows = await dbAll('SELECT ckey, cvalue FROM tblConfig', []);
  const cfg = {};
  rows.forEach(r => cfg[r.ckey] = r.cvalue);
  return cfg;
}

function buildTransport(cfg) {
  if (!cfg.smtp_host) return null;
  return nodemailer.createTransport({
    host: cfg.smtp_host,
    port: parseInt(cfg.smtp_port) || 587,
    secure: cfg.smtp_secure === '1' || parseInt(cfg.smtp_port) === 465,
    auth: cfg.smtp_user ? { user: cfg.smtp_user, pass: cfg.smtp_pass } : undefined
  });
}

async function sendMail({ to, cc, subject, html, text }) {
  const cfg = await getConfig();
  const transport = buildTransport(cfg);
  if (!transport) throw new Error('SMTP is not configured. Add settings under Admin → Email Settings.');
  const from = cfg.smtp_from || cfg.smtp_user || 'traintrack@localhost';
  return transport.sendMail({ from, to, cc, subject, html, text: text || html.replace(/<[^>]+>/g, '') });
}

async function verifyConfig() {
  const cfg = await getConfig();
  const transport = buildTransport(cfg);
  if (!transport) throw new Error('SMTP is not configured.');
  return transport.verify();
}

// Build the reminder digest (expired + expiring 90d + missing required)
async function buildDigest() {
  const expired = await dbAll(`SELECT s.LastName,s.FirstName,s.Email,c.CertName,r.Exp
    FROM tblRegister r LEFT JOIN tblStaff s ON r.StaffID=s.StaffID LEFT JOIN tblCerts c ON r.CertID=c.CertID
    WHERE r.Exp IS NOT NULL AND r.Exp!='' AND r.Exp<date('now') AND s.Status='Active'
    AND (r.DateDeleted IS NULL OR r.DateDeleted='') ORDER BY r.Exp`, []);
  const expiring = await dbAll(`SELECT s.LastName,s.FirstName,s.Email,c.CertName,r.Exp
    FROM tblRegister r LEFT JOIN tblStaff s ON r.StaffID=s.StaffID LEFT JOIN tblCerts c ON r.CertID=c.CertID
    WHERE r.Exp IS NOT NULL AND r.Exp!='' AND r.Exp>=date('now') AND r.Exp<=date('now','+90 days')
    AND s.Status='Active' AND (r.DateDeleted IS NULL OR r.DateDeleted='') ORDER BY r.Exp`, []);
  return { expired, expiring };
}

function digestHtml(d) {
  const rows = (list, color) => list.map(r =>
    `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${r.LastName}, ${r.FirstName}</td>
     <td style="padding:6px 10px;border-bottom:1px solid #eee">${r.CertName}</td>
     <td style="padding:6px 10px;border-bottom:1px solid #eee;color:${color}">${r.Exp}</td></tr>`).join('');
  return `<div style="font-family:Arial,sans-serif;max-width:640px">
    <h2 style="color:#4f46e5">TrainTrack — Training Reminder Digest</h2>
    <p>${new Date().toDateString()}</p>
    <h3 style="color:#b91c1c">Expired (${d.expired.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px"><tr style="background:#f6f7fb"><th align="left" style="padding:6px 10px">Employee</th><th align="left" style="padding:6px 10px">Course</th><th align="left" style="padding:6px 10px">Expired</th></tr>${rows(d.expired,'#b91c1c')||'<tr><td colspan=3 style="padding:10px;color:#888">None</td></tr>'}</table>
    <h3 style="color:#b45309">Expiring within 90 days (${d.expiring.length})</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px"><tr style="background:#f6f7fb"><th align="left" style="padding:6px 10px">Employee</th><th align="left" style="padding:6px 10px">Course</th><th align="left" style="padding:6px 10px">Expires</th></tr>${rows(d.expiring,'#b45309')||'<tr><td colspan=3 style="padding:10px;color:#888">None</td></tr>'}</table>
  </div>`;
}

// Send the digest to all configured admin recipients
async function sendDigest() {
  const cfg = await getConfig();
  if (!cfg.digest_to) throw new Error('No digest recipient configured.');
  const d = await buildDigest();
  if (!d.expired.length && !d.expiring.length) return { skipped: true, reason: 'Nothing to report' };
  await sendMail({ to: cfg.digest_to, subject: `TrainTrack Reminder Digest — ${d.expired.length} expired, ${d.expiring.length} expiring`, html: digestHtml(d) });
  return { sent: true, expired: d.expired.length, expiring: d.expiring.length };
}

module.exports = { sendMail, verifyConfig, sendDigest, buildDigest, getConfig };
