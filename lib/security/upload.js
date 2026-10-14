// WP-13 · S6 — Upload hardening helpers (ADVISORY / adoption-ready).
//
// Dependency-free (no new packages; multer may be adopted later by routes). No
// DB, no network, no logging. NOTHING wires these into routes yet. Conservative
// policies mirror TrainingPro's currently-accepted upload kinds. Every helper:
// never throws, never mutates its input, and makes path traversal impossible.
'use strict';

const { isPositiveInteger } = require('./validate');

const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;
const FALLBACK_NAME = 'upload';
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024; // 12 MB (matches current body limit)

// Per-kind upload policy registry (frozen). Conservative, non-executable types.
const UPLOAD_POLICIES = Object.freeze({
  document: Object.freeze({
    allowedExtensions: Object.freeze(['.pdf', '.doc', '.docx', '.txt', '.rtf', '.odt']),
    allowedMimeTypes: Object.freeze([
      'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain', 'application/rtf', 'application/vnd.oasis.opendocument.text',
    ]),
    maxFileSizeBytes: 12 * 1024 * 1024,
  }),
  image: Object.freeze({
    allowedExtensions: Object.freeze(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']),
    allowedMimeTypes: Object.freeze([
      'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
    ]),
    maxFileSizeBytes: 12 * 1024 * 1024,
  }),
  spreadsheet: Object.freeze({
    allowedExtensions: Object.freeze(['.xls', '.xlsx', '.csv', '.ods']),
    allowedMimeTypes: Object.freeze([
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv', 'application/vnd.oasis.opendocument.spreadsheet',
    ]),
    maxFileSizeBytes: 12 * 1024 * 1024,
  }),
  presentation: Object.freeze({
    allowedExtensions: Object.freeze(['.ppt', '.pptx', '.odp']),
    allowedMimeTypes: Object.freeze([
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.oasis.opendocument.presentation',
    ]),
    maxFileSizeBytes: 25 * 1024 * 1024,
  }),
  archive: Object.freeze({
    allowedExtensions: Object.freeze(['.zip']),
    allowedMimeTypes: Object.freeze(['application/zip', 'application/x-zip-compressed']),
    maxFileSizeBytes: 50 * 1024 * 1024,
  }),
});

// Normalise an upload filename to a safe basename. Removes path components, null
// bytes, control chars, and traversal; collapses unsafe chars; preserves a safe
// extension; returns a fallback when nothing safe remains. Traversal is impossible
// (only the final path segment is kept).
function normalizeUploadFilename(filename) {
  if (typeof filename !== 'string') return FALLBACK_NAME;
  let name = filename.replace(CONTROL_CHARS, '');   // null bytes + control chars
  name = name.split(/[\\/]/).pop();                 // final path segment only
  name = name.replace(/\.{2,}/g, '.').trim();       // collapse traversal dots

  // Extension-only input (e.g. ".pdf") → keep it as the fallback's extension.
  if (/^\.[A-Za-z0-9]+$/.test(name)) return FALLBACK_NAME + name;

  const dot = name.lastIndexOf('.');
  let base = dot > 0 ? name.slice(0, dot) : name;
  let ext = dot > 0 ? name.slice(dot) : '';
  base = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._]+|[._]+$/g, '');
  ext = /^\.[A-Za-z0-9]+$/.test(ext) ? ext : '';

  if (!base && !ext) return FALLBACK_NAME;
  if (!base) return FALLBACK_NAME + ext;            // only an extension survived
  return base + ext;
}

// Case-insensitive extension allow-list check.
function isAllowedUploadExtension(filename, allowedExtensions) {
  if (typeof filename !== 'string' || !Array.isArray(allowedExtensions)) return false;
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return false;
  const ext = filename.slice(dot).toLowerCase();
  return allowedExtensions.some((e) => String(e).toLowerCase() === ext);
}

// Exact lowercase MIME allow-list check.
function isAllowedMimeType(mimeType, allowedMimeTypes) {
  if (typeof mimeType !== 'string' || !Array.isArray(allowedMimeTypes)) return false;
  const mt = mimeType.toLowerCase();
  return allowedMimeTypes.some((m) => String(m).toLowerCase() === mt);
}

// Build a multer-compatible fileFilter (req, file, cb) → cb(null, accept:boolean).
// Rejects (cb(null,false)) safely on any error — never throws, never errors out.
function createUploadFilter(options) {
  const opts = options || {};
  const exts = Array.isArray(opts.allowedExtensions) ? opts.allowedExtensions : [];
  const mimes = Array.isArray(opts.allowedMimeTypes) ? opts.allowedMimeTypes : [];
  return function uploadFilter(req, file, cb) {
    try {
      const f = file || {};
      const okExt = exts.length === 0 || isAllowedUploadExtension(f.originalname || '', exts);
      const okMime = mimes.length === 0 || isAllowedMimeType(f.mimetype || '', mimes);
      return cb(null, !!(okExt && okMime));
    } catch {
      return cb(null, false); // reject safely
    }
  };
}

// Build a multer-compatible limits object with a positive-integer fileSize.
function buildUploadLimits(options) {
  const opts = options || {};
  const size = isPositiveInteger(opts.maxFileSizeBytes) ? opts.maxFileSizeBytes : DEFAULT_MAX_BYTES;
  return { fileSize: size };
}

// Return a FRESH copy of a policy for `kind`, or null for unknown kinds.
function getUploadPolicy(kind) {
  const p = (typeof kind === 'string') ? UPLOAD_POLICIES[kind] : undefined;
  if (!p) return null;
  return {
    allowedExtensions: [...p.allowedExtensions],
    allowedMimeTypes: [...p.allowedMimeTypes],
    maxFileSizeBytes: p.maxFileSizeBytes,
  };
}

module.exports = {
  normalizeUploadFilename,
  isAllowedUploadExtension,
  isAllowedMimeType,
  createUploadFilter,
  buildUploadLimits,
  getUploadPolicy,
  UPLOAD_POLICIES,
  DEFAULT_MAX_BYTES,
};
