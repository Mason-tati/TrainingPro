// R3 (scoped slice) — Tenant administration.
//
// Manage organisations (tenants), assign users to a tenant, and let an admin switch their
// active tenant context. Enforcement of the switched context is automatic: every tenant-scoped
// query uses tenantOf(req), which reads req.session.user.tenantId. Only the AI-content family of
// tables (tblFiles, KB, tests, forms, terminology, trainmatcat, imagegen) is tenant-scoped today;
// other modules remain single-tenant until full multi-tenancy is rolled out.
const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, requireAdmin, tenantOf } = require('./auth');

router.use(requireAuth);

// Current tenant + the list an admin can switch between (for the header switcher).
router.get('/current', async (req, res) => {
  try {
    const cur = tenantOf(req);
    const current = await dbGet('SELECT TenantID, Name, Slug FROM tblTenant WHERE TenantID=?', [cur])
      || { TenantID: cur, Name: 'Default' };
    // Only admins may switch; non-admins only ever see their own tenant.
    const tenants = req.session.user.admin
      ? await dbAll("SELECT TenantID, Name, Slug, Status FROM tblTenant ORDER BY TenantID")
      : [current];
    res.json({ current, tenants, canSwitch: !!req.session.user.admin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List tenants with basic counts (admin).
router.get('/', requireAdmin, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT t.TenantID, t.Name, t.Slug, t.Status, t.CreatedDate,
        (SELECT COUNT(*) FROM tblPswd p WHERE (p.TenantID=t.TenantID OR (p.TenantID IS NULL AND t.TenantID=1))
           AND (p.DateDeleted IS NULL OR p.DateDeleted='')) AS UserCount,
        (SELECT COUNT(*) FROM tblFiles f WHERE (f.TenantID=t.TenantID OR (f.TenantID IS NULL AND t.TenantID=1))
           AND f.EntityType='document') AS DocCount
      FROM tblTenant t ORDER BY t.TenantID`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create a tenant (admin).
router.post('/', requireAdmin, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Organisation name is required.' });
    let slug = (req.body.slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || ('org-' + Date.now());
    // Ensure slug uniqueness.
    const clash = await dbGet('SELECT TenantID FROM tblTenant WHERE Slug=?', [slug]);
    if (clash) slug = slug + '-' + Date.now().toString(36);
    const r = await dbRun("INSERT INTO tblTenant (Name, Slug, Status) VALUES (?,?,'Active')", [name, slug]);
    res.json({ success: true, tenant: { TenantID: r.lastID, Name: name, Slug: slug, Status: 'Active' } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Rename / set status (admin). Tenant 1 (seeded org) cannot be deactivated.
router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const t = await dbGet('SELECT * FROM tblTenant WHERE TenantID=?', [id]);
    if (!t) return res.status(404).json({ error: 'Organisation not found.' });
    const name = req.body.name != null ? String(req.body.name).trim() : t.Name;
    let status = req.body.status != null ? String(req.body.status) : t.Status;
    if (id === 1 && status !== 'Active') status = 'Active'; // never disable the primary org
    if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
    await dbRun('UPDATE tblTenant SET Name=?, Status=? WHERE TenantID=?', [name, status, id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Users + their tenant (admin) — for assignment UI.
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const rows = await dbAll(
      "SELECT PSWDID, UserName, Admin, COALESCE(TenantID,1) AS TenantID FROM tblPswd WHERE (DateDeleted IS NULL OR DateDeleted='') ORDER BY UserName");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Assign a user to a tenant (admin).
router.post('/assign', requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.body.userId, 10);
    const tenantId = parseInt(req.body.tenantId, 10);
    if (!userId || !tenantId) return res.status(400).json({ error: 'userId and tenantId are required.' });
    const t = await dbGet('SELECT TenantID FROM tblTenant WHERE TenantID=?', [tenantId]);
    if (!t) return res.status(404).json({ error: 'Organisation not found.' });
    await dbRun('UPDATE tblPswd SET TenantID=? WHERE PSWDID=?', [tenantId, userId]);
    // If the admin reassigned themselves, update the live session too.
    if (req.session.user && req.session.user.id === userId) req.session.user.tenantId = tenantId;
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Switch the current admin's active tenant context (admin only).
router.post('/switch', requireAdmin, async (req, res) => {
  try {
    const tenantId = parseInt(req.body.tenantId, 10);
    const t = await dbGet('SELECT TenantID, Name FROM tblTenant WHERE TenantID=?', [tenantId]);
    if (!t) return res.status(404).json({ error: 'Organisation not found.' });
    req.session.user.tenantId = tenantId;
    res.json({ success: true, current: t });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
