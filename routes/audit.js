const express = require('express');
const router = express.Router();
const { dbAll } = require('../database/db');
const { requireAuth } = require('./auth');

router.use(requireAuth);
function adminOnly(req, res, next) {
  if (!req.session.user.admin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

router.get('/', adminOnly, async (req, res) => {
  try {
    const { table, user, action, limit } = req.query;
    let sql = 'SELECT * FROM tblAudit WHERE 1=1';
    const p = [];
    if (table)  { sql += ' AND AuditTable=?';  p.push(table); }
    if (user)   { sql += ' AND AuditUser LIKE ?'; p.push(`%${user}%`); }
    if (action) { sql += ' AND AuditAction=?'; p.push(action); }
    sql += ' ORDER BY AuditID DESC LIMIT ?';
    p.push(parseInt(limit) || 300);
    res.json(await dbAll(sql, p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Login history
router.get('/logins', adminOnly, async (req, res) => {
  try {
    res.json(await dbAll('SELECT * FROM tblAuditLogin ORDER BY LoginID DESC LIMIT 200', []));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
