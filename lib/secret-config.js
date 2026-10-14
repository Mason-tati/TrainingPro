// R7 — encryption-at-rest for secrets stored in tblConfig (API keys).
//
// Activation is OPT-IN via the CONFIG_SECRET environment variable:
//   • CONFIG_SECRET set  → stored secrets are AES-256-GCM encrypted at rest and
//                          transparently decrypted on read. Boot re-encrypts any
//                          plaintext key it finds.
//   • CONFIG_SECRET unset → behaviour is IDENTICAL to before (values stored/read as
//                          plaintext). Nothing breaks, no key becomes unreadable —
//                          honouring the "no lock-out" migration choice.
//
// Environment variables (e.g. OPENAI_API_KEY / ANTHROPIC_API_KEY) always take
// precedence in the callers and are never touched here.
'use strict';

const crypto = require('crypto');

const PREFIX = 'enc:v1:'; // marks an encrypted value; also lets us detect already-encrypted rows
const SECRET_KEYS = ['anthropic_api_key', 'openai_api_key']; // tblConfig keys treated as secrets

function secret() {
  const s = process.env.CONFIG_SECRET;
  return (s && String(s).length >= 8) ? String(s) : null; // require a non-trivial secret
}

function keyFrom(sec) {
  // Deterministic 32-byte key derived from the configured secret.
  return crypto.scryptSync(sec, 'traintrack-config-v1', 32);
}

function isEncrypted(v) {
  return typeof v === 'string' && v.startsWith(PREFIX);
}

// Encrypt a plaintext string → "enc:v1:<iv>:<tag>:<ciphertext>" (all base64). Returns the
// input unchanged when no secret is configured or the value is already encrypted/empty.
function encryptValue(plain) {
  const sec = secret();
  if (!sec || plain == null || plain === '' || isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(sec), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString('base64') + ':' + tag.toString('base64') + ':' + ct.toString('base64');
}

// Decrypt an "enc:v1:…" value. A plaintext (non-prefixed) value is returned as-is, so a
// database still holding plaintext keeps working. If decryption fails (wrong/rotated
// secret), returns null rather than throwing — the caller then reports "key not configured".
function decryptValue(stored) {
  if (!isEncrypted(stored)) return stored; // plaintext or empty — pass through
  const sec = secret();
  if (!sec) return null; // encrypted at rest but no secret available to read it
  try {
    const [, , ivB64, tagB64, ctB64] = stored.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(sec), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// Read a tblConfig secret value, decrypting if needed. `dbGet` is the db.js promise helper.
async function readSecretConfig(dbGet, ckey) {
  const row = await dbGet('SELECT cvalue FROM tblConfig WHERE ckey=?', [ckey]);
  const v = row && row.cvalue ? String(row.cvalue).trim() : null;
  if (!v) return null;
  return decryptValue(v);
}

// Write a tblConfig secret value, encrypting at rest when a secret is configured.
async function writeSecretConfig(dbRun, ckey, plain) {
  const toStore = encryptValue(plain);
  await dbRun(
    `INSERT INTO tblConfig (ckey, cvalue) VALUES (?, ?)
     ON CONFLICT(ckey) DO UPDATE SET cvalue=excluded.cvalue`,
    [ckey, toStore]
  );
}

// Boot step: when a secret is configured, encrypt any secret key still stored as plaintext.
// No-op when CONFIG_SECRET is unset. Never throws.
async function encryptExistingSecrets(dbAll, dbRun) {
  if (!secret()) return { encrypted: 0, skipped: 'no CONFIG_SECRET' };
  let n = 0;
  try {
    const rows = await dbAll(
      `SELECT ckey, cvalue FROM tblConfig WHERE ckey IN (${SECRET_KEYS.map(() => '?').join(',')})`,
      SECRET_KEYS
    );
    for (const r of rows) {
      const v = r && r.cvalue ? String(r.cvalue) : '';
      if (v && !isEncrypted(v)) {
        await dbRun('UPDATE tblConfig SET cvalue=? WHERE ckey=?', [encryptValue(v), r.ckey]);
        n++;
      }
    }
  } catch { /* non-fatal — keys still readable as plaintext */ }
  return { encrypted: n };
}

module.exports = {
  SECRET_KEYS,
  isSecretConfigured: () => !!secret(),
  encryptValue, decryptValue,
  readSecretConfig, writeSecretConfig, encryptExistingSecrets,
};
