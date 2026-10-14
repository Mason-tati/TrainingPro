const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth } = require('./auth');
const mailer = require('../lib/mailer');

router.use(requireAuth);
function adminOnly(req, res, next) {
  if (!req.session.user.admin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Keys we expose (never return the SMTP password to the client)
const KEYS = ['smtp_host','smtp_port','smtp_secure','smtp_user','smtp_from','digest_to','digest_enabled'];

router.get('/', adminOnly, async (req, res) => {
  try {
    const rows = await dbAll('SELECT ckey,cvalue FROM tblConfig', []);
    const cfg = {};
    rows.forEach(r => { if (r.ckey !== 'smtp_pass') cfg[r.ckey] = r.cvalue; });
    cfg.smtp_pass_set = rows.some(r => r.ckey === 'smtp_pass' && r.cvalue);
    res.json(cfg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/', adminOnly, async (req, res) => {
  try {
    const d = req.body;
    for (const k of [...KEYS, 'smtp_pass']) {
      if (d[k] === undefined) continue;
      if (k === 'smtp_pass' && d[k] === '') continue; // don't overwrite with blank
      await dbRun('INSERT INTO tblConfig (ckey,cvalue) VALUES (?,?) ON CONFLICT(ckey) DO UPDATE SET cvalue=excluded.cvalue', [k, String(d[k])]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/test-email', adminOnly, async (req, res) => {
  try {
    await mailer.verifyConfig();
    await mailer.sendMail({ to: req.body.to, subject: 'TrainTrack Test Email', html: '<p>✅ Your TrainTrack SMTP settings are working correctly.</p>' });
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/send-digest', adminOnly, async (req, res) => {
  try { res.json(await mailer.sendDigest()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---- Company branding (name + logo) ----
router.get('/company', async (req, res) => {
  try {
    const rows = await dbAll(`SELECT ckey,cvalue FROM tblConfig WHERE ckey IN ('company_name','company_logo')`, []);
    const cfg = {};
    rows.forEach(r => { cfg[r.ckey] = r.cvalue || ''; });
    res.json({ name: cfg.company_name || '', logo: cfg.company_logo || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/company', adminOnly, async (req, res) => {
  try {
    const { name, logo } = req.body;
    if (name !== undefined) {
      await dbRun(`INSERT INTO tblConfig (ckey,cvalue) VALUES ('company_name',?) ON CONFLICT(ckey) DO UPDATE SET cvalue=excluded.cvalue`, [String(name || '')]);
    }
    if (logo !== undefined) {
      await dbRun(`INSERT INTO tblConfig (ckey,cvalue) VALUES ('company_logo',?) ON CONFLICT(ckey) DO UPDATE SET cvalue=excluded.cvalue`, [String(logo || '')]);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
