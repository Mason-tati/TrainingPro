const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, tenantOf } = require('./auth');
const { recordLegacyAudit } = require('../lib/governance/audit-adapter'); // WP-16 M5 — sanitizing audit (medium-risk; AI content dropped, identifiers masked/capped)

router.use(requireAuth);

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = new Set([
  '.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.txt','.csv','.rtf',
  '.png','.jpg','.jpeg','.gif','.bmp','.webp','.heic',
  '.zip','.msg','.eml'
]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 }, // 300 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED.has(ext)) cb(null, true);
    else cb(new Error('File type not allowed: ' + ext));
  }
});

const VALID_ENTITIES = new Set(['staff','cert','register','class','document']);

// Download / view a file  (defined before /:entityType/:entityId so "download" isn't treated as an entity)
router.get('/download/:fileId', async (req, res) => {
  try {
    const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [req.params.fileId]);
    if (!f) return res.status(404).json({ error: 'Not found' });
    // R3 — tenant isolation: never serve another tenant's file.
    if ((f.TenantID || 1) !== tenantOf(req)) return res.status(404).json({ error: 'Not found' });
    // R2 — approval gate for library DOCUMENTS: unapproved drafts are downloadable only by the
    // author, an admin, or a user who can approve/publish (documents.write). Other file kinds
    // (staff certs, sources, template forms, images, etc.) keep their prior open-to-auth behaviour.
    if (f.EntityType === 'document') {
      const u = req.session.user || {};
      const perms = Array.isArray(u.permissions) ? u.permissions : [];
      const released = f.Status === 'Approved' || f.Status === 'Published' || f.Approved === 1;
      const privileged = u.admin || (u.username && f.UploadedBy === u.username) || perms.includes('documents.write') || perms.includes('documents.publish');
      if (!released && !privileged) {
        return res.status(403).json({ error: 'This document is not yet approved for release.' });
      }
    }
    const filePath = path.join(UPLOAD_DIR, f.StoredName);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing on disk' });
    const disposition = req.query.inline === '1' ? 'inline' : 'attachment';
    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(f.FileName)}"`);
    if (f.MimeType) res.setHeader('Content-Type', f.MimeType);
    const stat = fs.statSync(filePath);
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(filePath).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Duplicate-name check for save flows: returns existing files with the same (extension-insensitive) name
// in the given folder, so the UI can offer to overwrite before creating a duplicate. Defined before the
// /:entityType/:entityId route so "name-check" isn't treated as an entity type.
router.get('/name-check', async (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    const folder = String(req.query.folder || '').trim();
    if (!name) return res.json({ dupes: [] });
    const norm = s => String(s || '').toLowerCase().replace(/\.(docx|pptx|xlsx|pdf|doc|ppt|txt|csv)$/i, '').trim();
    let sql = 'SELECT FileID, FileName, Folder FROM tblFiles WHERE 1=1';
    const p = [];
    if (folder === 'library' || folder === '') sql += " AND (Folder IS NULL OR Folder='' OR Folder='library')";
    else { sql += ' AND Folder=?'; p.push(folder); }
    const rows = await dbAll(sql, p);
    const target = norm(name);
    res.json({ dupes: rows.filter(r => norm(r.FileName) === target).map(r => ({ FileID: r.FileID, FileName: r.FileName })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List files for an entity
router.get('/:entityType/:entityId', async (req, res) => {
  try {
    const { entityType, entityId } = req.params;
    if (!VALID_ENTITIES.has(entityType)) return res.status(400).json({ error: 'Invalid entity type' });
    res.json(await dbAll(
      'SELECT FileID,FileName,MimeType,FileSize,Category,Description,UploadedBy,UploadedDate FROM tblFiles WHERE EntityType=? AND EntityID=? ORDER BY UploadedDate DESC',
      [entityType, entityId]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload one or more files to an entity
router.post('/:entityType/:entityId', (req, res) => {
  upload.array('files', 10)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      const { entityType, entityId } = req.params;
      if (!VALID_ENTITIES.has(entityType)) return res.status(400).json({ error: 'Invalid entity type' });
      const { category, description } = req.body;
      const saved = [];
      for (const f of req.files || []) {
        const r = await dbRun(
          `INSERT INTO tblFiles (EntityType,EntityID,FileName,StoredName,MimeType,FileSize,Category,Description,UploadedBy)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [entityType, entityId, f.originalname, f.filename, f.mimetype, f.size, category || null, description || null, req.session.user.username]);
        saved.push({ FileID: r.lastID, FileName: f.originalname });
        await recordLegacyAudit(req.session.user.username, 'tblFiles', 'UPLOAD', r.lastID, entityType + '#' + entityId, null, f.originalname);
      }
      res.json({ uploaded: saved.length, files: saved });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

// Update file metadata and/or replace the file (admin only)
const uploadReplace = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED.has(ext)) cb(null, true);
    else cb(new Error('File type not allowed: ' + ext));
  }
});

router.put('/:fileId', (req, res) => {
  uploadReplace.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      if (!req.session.user.admin) return res.status(403).json({ error: 'Admin access required' });
      const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [req.params.fileId]);
      if (!f) return res.status(404).json({ error: 'Not found' });

      const fileName    = (req.body.fileName    || '').trim() || f.FileName;
      const category    = (req.body.category    !== undefined) ? req.body.category    : f.Category;
      const description = (req.body.description !== undefined) ? req.body.description : f.Description;

      if (req.file) {
        // Replace file on disk
        const oldPath = path.join(UPLOAD_DIR, f.StoredName);
        fs.unlink(oldPath, () => {});
        await dbRun(
          `UPDATE tblFiles SET FileName=?, Category=?, Description=?, StoredName=?, MimeType=?, FileSize=? WHERE FileID=?`,
          [fileName, category, description, req.file.filename, req.file.mimetype, req.file.size, req.params.fileId]);
      } else {
        await dbRun(
          `UPDATE tblFiles SET FileName=?, Category=?, Description=? WHERE FileID=?`,
          [fileName, category, description, req.params.fileId]);
      }

      await recordLegacyAudit(req.session.user.username, 'tblFiles', 'EDIT', req.params.fileId, null, f.FileName, fileName);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

// Move a file to a different folder (Document Library / Training Standards / Training Material).
// For training-material, a category is required — auto-creates the category if it doesn't exist yet.
router.put('/:fileId/move', async (req, res) => {
  try {
    if (!(req.session.user && req.session.user.admin)) return res.status(403).json({ error: 'Only an administrator can move files.' });
    const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [req.params.fileId]);
    if (!f) return res.status(404).json({ error: 'File not found.' });

    const folder = String(req.body.folder || '').trim();
    const ALLOWED = ['library', 'training-standards', 'training-material', 'template-forms'];
    if (!ALLOWED.includes(folder)) return res.status(400).json({ error: 'Destination must be one of: ' + ALLOWED.join(', ') });

    let newCategory = f.Category;
    if (folder === 'training-material') {
      const cat = String(req.body.materialCategory || '').trim();
      if (!cat) return res.status(400).json({ error: 'Pick or enter a Training Material category (e.g. CAT777, Haul Truck Training Material).' });
      await dbRun('INSERT OR IGNORE INTO tblTrainMatCat (Name) VALUES (?)', [cat]);
      newCategory = cat;
    } else if (folder === 'template-forms') {
      // Template forms get a category that reflects their intent; allow override or fall back to existing
      const cat = String(req.body.materialCategory || '').trim();
      if (cat) newCategory = cat;
    }
    // training-standards / library keep the file's existing Category — useful when you bulk-categorise via Edit

    await dbRun('UPDATE tblFiles SET Folder=?, Category=? WHERE FileID=?', [folder, newCategory, req.params.fileId]);
    try { await recordLegacyAudit(req.session.user.username, 'tblFiles', 'MOVE', req.params.fileId, 'Folder', f.Folder || 'library', folder); } catch {}

    const destLabel = folder === 'training-standards' ? 'Training Standards'
      : folder === 'training-material' ? `Training Material → ${newCategory}`
      : folder === 'template-forms' ? 'Template Forms'
      : 'Document Library';
    res.json({ success: true, folder, category: newCategory, message: `Moved to ${destLabel}.` });
  } catch (e) { res.status(500).json({ error: 'Move failed: ' + e.message }); }
});

// Delete a file
router.delete('/:fileId', async (req, res) => {
  try {
    const f = await dbGet('SELECT * FROM tblFiles WHERE FileID=?', [req.params.fileId]);
    if (!f) return res.status(404).json({ error: 'Not found' });
    const filePath = path.join(UPLOAD_DIR, f.StoredName);
    fs.unlink(filePath, () => {});
    await dbRun('DELETE FROM tblFiles WHERE FileID=?', [req.params.fileId]);
    // Cascade: remove translator children so no orphaned segments / unapproved memory remain
    await dbRun('DELETE FROM tblTransSegment WHERE JobFileID=?', [req.params.fileId]);
    await dbRun('DELETE FROM tblTransMemory WHERE JobFileID=? AND Approved=0', [req.params.fileId]);
    await recordLegacyAudit(req.session.user.username, 'tblFiles', 'DELETE', req.params.fileId, null, f.FileName, null);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Recent uploads (document library view)
router.get('/', async (req, res) => {
  try {
    const { entityType, search } = req.query;
    let sql = `SELECT f.*,
      CASE f.EntityType
        WHEN 'staff' THEN (SELECT s.LastName||', '||s.FirstName FROM tblStaff s WHERE s.StaffID=f.EntityID)
        WHEN 'cert' THEN (SELECT c.CertName FROM tblCerts c WHERE c.CertID=f.EntityID)
        WHEN 'class' THEN (SELECT cl.ClassName FROM tblClass cl WHERE cl.ClassID=f.EntityID)
        WHEN 'document' THEN '#'||f.FileID
        ELSE 'Record #'||f.EntityID END as EntityName
      FROM tblFiles f WHERE 1=1`;
    const p = [];
    sql += ' AND (f.TenantID=? OR f.TenantID IS NULL)'; p.push(tenantOf(req)); // R3 — tenant isolation
    if (entityType) { sql += ' AND f.EntityType=?'; p.push(entityType); }
    // The Document Library shows ONLY general library documents. Folder-specific documents — Training
    // Standards, Training Material (incl. covers), Template Forms — live on their own pages, so exclude
    // anything filed into one of those folders from the library list.
    if (entityType === 'document') sql += " AND (f.Folder IS NULL OR f.Folder='' OR f.Folder='library')";
    if (search) { sql += ' AND (f.FileName LIKE ? OR f.Description LIKE ?)'; p.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY f.UploadedDate DESC LIMIT 300';
    res.json(await dbAll(sql, p));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
