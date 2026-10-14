// ─────────────────────────────────────────────────────────────────────────────
// Storage adapter for generated images.
//
// Default backend is the app's existing local-disk store (uploads/ + tblFiles,
// served through /api/files/download/:id with the normal session auth).
//
// S3 seam: set IMAGE_STORE=s3 plus the AWS_* vars and implement putS3() below —
// nothing else in the feature needs to change, it only calls saveImage()/urlFor().
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dbRun } = require('../database/db');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const FOLDER = 'generated-images';          // keeps them out of the Document Library

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * Persist a PNG buffer.
 * @returns {Promise<{fileId:number, url:string, storedName:string, bytes:number}>}
 */
async function saveImage(buf, { fileName, user, description }) {
  if (String(process.env.IMAGE_STORE || 'local').toLowerCase() === 's3') return putS3(buf, { fileName, user, description });

  const storedName = crypto.randomBytes(16).toString('hex') + '.png';
  fs.writeFileSync(path.join(UPLOAD_DIR, storedName), buf);
  const r = await dbRun(
    `INSERT INTO tblFiles (EntityType, EntityID, FileName, StoredName, MimeType, FileSize, Category, Description, UploadedBy, Approved, Folder)
     VALUES ('document', 0, ?, ?, 'image/png', ?, 'Generated Image', ?, ?, 1, ?)`,
    [fileName || 'generated-image.png', storedName, buf.length, description || 'AI generated illustration', user || 'system', FOLDER]);
  return { fileId: r.lastID, url: `/api/files/download/${r.lastID}?inline=1`, storedName, bytes: buf.length };
}

/** Read a previously saved image back (used for caption-only re-runs). */
function readImage(storedName) {
  return fs.readFileSync(path.join(UPLOAD_DIR, storedName));
}

function urlFor(fileId) { return `/api/files/download/${fileId}?inline=1`; }

// ── S3 seam ──────────────────────────────────────────────────────────────────
// Implement this to move storage to S3. Keep the same return shape.
async function putS3() {
  throw new Error('IMAGE_STORE=s3 is configured but the S3 backend is not implemented. ' +
    'Implement putS3() in lib/imagestore.js (upload the buffer, return { fileId, url, storedName, bytes }).');
}

module.exports = { saveImage, readImage, urlFor, UPLOAD_DIR, FOLDER };
