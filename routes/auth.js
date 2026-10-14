const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { dbAll, dbGet, dbRun } = require('../database/db');
// R4 — resolve RBAC roles/permissions for the session (now ENFORCED via requirePermission).
const { resolveUserRoles, resolveUserPermissions, hasUserPermission } = require('../lib/auth/user-permissions');

// Derive the session's roles + effective permissions from a DB user row.
// R4: legacy tblPswd boolean role columns are mapped to canonical RBAC roles so existing
// users keep the capabilities they already had (no lock-out) while enabling fine-grained
// per-permission restriction. An explicit tblPswd.Roles list (comma-separated canonical
// role names) augments/overrides the legacy mapping. Admins always include ADMIN.
// Users with no derivable role fall back to VIEWER (safe read-only). Never throws.
function deriveSessionPermissions(user) {
  try {
    const u = user || {};
    const raw = [];
    // Explicit role fields (role / roles / roleName / roleNames), canonicalised.
    raw.push(...resolveUserRoles(u));
    // tblPswd.Roles column (comma-separated canonical names).
    if (u.Roles) raw.push(...String(u.Roles).split(',').map(s => s.trim()).filter(Boolean));
    // Legacy boolean → role mapping (preserves prior capabilities, enables per-permission restriction):
    if (u.Admin === 1 || u.Admin === true) raw.push('ADMIN');
    if (u.Standard === 1 || u.Standard === true) raw.push('TRAINER');   // keeps content + ai.use
    if (u.Restricted === 1 || u.Restricted === true) raw.push('VIEWER'); // read-only (no ai.use → R5)
    if (u.ExamOnly === 1 || u.ExamOnly === true) raw.push('OPERATOR');   // read-only
    if (u.ReadPrint === 1 || u.ReadPrint === true) raw.push('VIEWER');   // read-only
    const roleSet = new Set(resolveUserRoles({ roles: raw }));
    if (u.Admin === 1 || u.Admin === true) roleSet.add('ADMIN');
    const roles = [...roleSet].sort(); // a user with no derivable role resolves to [] (denied gated routes)
    return { roles, permissions: resolveUserPermissions({ roles }) };
  } catch {
    return { roles: [], permissions: [] };
  }
}

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await dbGet(
      "SELECT * FROM tblPswd WHERE UserName=? AND (DateDeleted IS NULL OR DateDeleted='') AND UserStatus='Active'",
      [username]
    );
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });

    let valid = false;
    let matchedByPlaintext = false;
    if (user.HashPass && user.HashPass !== '$2a$10$placeholder') {
      valid = bcrypt.compareSync(password, user.HashPass);
    } else if (user.Password) {
      valid = user.Password === password;
      matchedByPlaintext = valid;
    }
    if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

    // R7 — safe credential migration (no lock-out): the moment a user authenticates against a
    // stored plaintext password, transparently upgrade them to a bcrypt hash and erase the plaintext.
    if (matchedByPlaintext) {
      try {
        const hash = bcrypt.hashSync(password, 10);
        await dbRun("UPDATE tblPswd SET HashPass=?, Password=NULL WHERE PSWDID=?", [hash, user.PSWDID]);
      } catch { /* non-fatal — login still succeeds; retry upgrade next login */ }
    }

    await dbRun("INSERT INTO tblAuditLogin (LoginDate,LoginUser,LoginStatus) VALUES (datetime('now'),?,'Success')", [username]);

    const { roles, permissions } = deriveSessionPermissions(user); // R4 — enforced RBAC context
    req.session.user = {
      id: user.PSWDID, username: user.UserName, staffID: user.staffID,
      admin: user.Admin, standard: user.Standard, restricted: user.Restricted,
      examOnly: user.ExamOnly, readPrint: user.ReadPrint, deptID: user.DeptID, locID: user.LocID,
      tenantId: user.TenantID || 1, // R3 — tenant context for isolation
      pageAccess: user.PageAccess || '',
      roles, permissions // R4 — consumed by requirePermission
    };
    res.json({ success: true, user: req.session.user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

router.get('/me', (req, res) => {
  if (req.session.user) res.json(req.session.user);
  else res.status(401).json({ error: 'Not authenticated' });
});

router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const user = await dbGet('SELECT * FROM tblPswd WHERE PSWDID=?', [req.session.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    let valid = user.HashPass && user.HashPass !== '$2a$10$placeholder'
      ? bcrypt.compareSync(oldPassword, user.HashPass)
      : user.Password === oldPassword;
    if (!valid) return res.status(401).json({ error: 'Old password incorrect' });
    // R7 — store ONLY the bcrypt hash; never persist plaintext (Password/PrevPswd cleared).
    const hash = bcrypt.hashSync(newPassword, 10);
    await dbRun("UPDATE tblPswd SET HashPass=?,PrevPswd=NULL,Password=NULL,DateChanged=date('now'),UpdateBy=? WHERE PSWDID=?",
      [hash, req.session.user.username, req.session.user.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!req.session.user.admin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

// R4/R5 — fine-grained permission gate. Admins always pass (admin.full). Otherwise the
// session's resolved permission set (from deriveSessionPermissions) must include `perm`.
// Returns 401 if unauthenticated, 403 if authenticated but lacking the permission.
function requirePermission(perm) {
  return function (req, res, next) {
    const u = req.session && req.session.user;
    if (!u) return res.status(401).json({ error: 'Not authenticated' });
    if (u.admin) return next(); // admin bypass — never lock an admin out
    const perms = Array.isArray(u.permissions) ? u.permissions : [];
    if (perms.includes(perm)) return next();
    return res.status(403).json({ error: 'Permission required: ' + perm });
  };
}

// R3 — the tenant the current request operates within (defaults to the seeded org).
function tenantOf(req) {
  return (req.session && req.session.user && req.session.user.tenantId) || 1;
}

module.exports = router;
module.exports.requireAuth = requireAuth;
module.exports.requireAdmin = requireAdmin;
module.exports.requirePermission = requirePermission; // R4/R5
module.exports.tenantOf = tenantOf;                    // R3
module.exports.deriveSessionPermissions = deriveSessionPermissions;
