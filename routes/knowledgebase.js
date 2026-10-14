const express = require('express');
const router = express.Router();
const { dbAll, dbGet, dbRun } = require('../database/db');
const { requireAuth, requireAdmin } = require('./auth');
const { recordLegacyAudit } = require('../lib/governance/audit-adapter'); // WP-16 M5 — sanitizing audit (medium-risk; AI content dropped, identifiers masked/capped)
// WP-10 A6.4 — AI calls go through the central AI Gateway (byte-identical passthrough).
const aiGateway = require('../lib/ai-gateway');

router.use(requireAuth);

// ---- Categories ----
router.get('/categories', async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT k.*, COUNT(a.ArticleID) AS articleCount
       FROM tblKBCategory k
       LEFT JOIN tblKBArticle a ON a.CategoryID=k.CategoryID AND a.Status='Published'
       GROUP BY k.CategoryID ORDER BY k.SortOrder, k.Name`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/categories', requireAdmin, async (req, res) => {
  try {
    const { name, color, icon } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required.' });
    const r = await dbRun(`INSERT INTO tblKBCategory (Name,Color,Icon) VALUES (?,?,?)`,
      [name, color || '#4f46e5', icon || '📄']);
    res.json({ success: true, id: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/categories/:id', requireAdmin, async (req, res) => {
  try {
    const { name, color, icon, sortOrder } = req.body;
    await dbRun(`UPDATE tblKBCategory SET Name=?,Color=?,Icon=?,SortOrder=? WHERE CategoryID=?`,
      [name, color || '#4f46e5', icon || '📄', sortOrder || 0, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/categories/:id', requireAdmin, async (req, res) => {
  try {
    await dbRun(`DELETE FROM tblKBCategory WHERE CategoryID=?`, [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Articles ----
router.get('/articles', async (req, res) => {
  try {
    const { categoryId, status, q } = req.query;
    const wheres = [], params = [];
    if (categoryId) { wheres.push('a.CategoryID=?'); params.push(categoryId); }
    if (status)     { wheres.push('a.Status=?'); params.push(status); }
    else            { wheres.push("a.Status='Published'"); }
    if (q)          { wheres.push("(a.Title LIKE ? OR a.Tags LIKE ? OR a.Body LIKE ?)"); params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
    const rows = await dbAll(
      `SELECT a.ArticleID, a.Title, a.Tags, a.Status, a.ViewCount, a.AuthoredBy, a.CategoryID,
              a.CreatedAt, a.UpdatedAt, a.UpdatedBy,
              k.Name AS categoryName, k.Color AS catColor, k.Icon AS catIcon,
              (SELECT COUNT(*) FROM tblKBRating r WHERE r.ArticleID=a.ArticleID AND r.Helpful=1) AS helpfulCount
       FROM tblKBArticle a
       LEFT JOIN tblKBCategory k ON k.CategoryID=a.CategoryID
       ${where}
       ORDER BY a.UpdatedAt DESC`, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/articles/:id', async (req, res) => {
  try {
    const a = await dbGet(
      `SELECT a.*, k.Name AS categoryName, k.Color AS catColor, k.Icon AS catIcon,
              (SELECT COUNT(*) FROM tblKBRating r WHERE r.ArticleID=a.ArticleID AND r.Helpful=1) AS helpfulCount
       FROM tblKBArticle a
       LEFT JOIN tblKBCategory k ON k.CategoryID=a.CategoryID
       WHERE a.ArticleID=?`, [req.params.id]);
    if (!a) return res.status(404).json({ error: 'Not found.' });
    // bump view count
    dbRun(`UPDATE tblKBArticle SET ViewCount=ViewCount+1 WHERE ArticleID=?`, [req.params.id]).catch(() => {});
    res.json(a);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/articles', requireAdmin, async (req, res) => {
  try {
    const { title, categoryId, body, tags, status } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required.' });
    const user = req.session.user.username;
    const r = await dbRun(
      `INSERT INTO tblKBArticle (CategoryID,Title,Body,Tags,Status,AuthoredBy,UpdatedBy) VALUES (?,?,?,?,?,?,?)`,
      [categoryId || null, title, body || '', tags || '', status || 'Published', user, user]);
    await recordLegacyAudit(user, 'KBArticle', 'CREATE', r.lastID, null, null, title);
    res.json({ success: true, id: r.lastID });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/articles/:id', requireAdmin, async (req, res) => {
  try {
    const { title, categoryId, body, tags, status } = req.body;
    const user = req.session.user.username;
    await dbRun(
      `UPDATE tblKBArticle SET CategoryID=?,Title=?,Body=?,Tags=?,Status=?,UpdatedBy=?,UpdatedAt=datetime('now') WHERE ArticleID=?`,
      [categoryId || null, title, body || '', tags || '', status || 'Published', user, req.params.id]);
    await recordLegacyAudit(user, 'KBArticle', 'UPDATE', req.params.id, null, null, title);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/articles/:id', requireAdmin, async (req, res) => {
  try {
    await dbRun(`DELETE FROM tblKBArticle WHERE ArticleID=?`, [req.params.id]);
    await dbRun(`DELETE FROM tblKBRating WHERE ArticleID=?`, [req.params.id]);
    await recordLegacyAudit(req.session.user.username, 'KBArticle', 'DELETE', req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Ratings ----
router.post('/articles/:id/rate', async (req, res) => {
  try {
    const { helpful } = req.body;
    const user = req.session.user.username;
    await dbRun(
      `INSERT INTO tblKBRating (ArticleID,UserName,Helpful) VALUES (?,?,?)
       ON CONFLICT(ArticleID,UserName) DO UPDATE SET Helpful=excluded.Helpful, RatedAt=datetime('now')`,
      [req.params.id, user, helpful ? 1 : 0]);
    const row = await dbGet(`SELECT COUNT(*) AS n FROM tblKBRating WHERE ArticleID=? AND Helpful=1`, [req.params.id]);
    res.json({ success: true, helpfulCount: row?.n || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// AI-assisted body drafting
router.post('/ai-draft', requireAdmin, async (req, res) => {
  try {
    const { prompt, title, tags } = req.body;
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Describe what to write.' });
    const ctx = [title ? `Article title: ${title}` : '', tags ? `Tags: ${tags}` : ''].filter(Boolean).join('\n');
    const msg = await aiGateway.complete({
      provider: 'anthropic',
      agent: 'AI-DOC-004',
      operation: 'kb_article',
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: 'You are a technical writer for a mining operation. Write clear, factual Knowledge Base articles that site personnel can use as quick reference. Return ONLY the article body — no title, no preamble, no closing remarks.',
      messages: [{ role: 'user', content: `${ctx ? ctx + '\n\n' : ''}Write a Knowledge Base article body for:\n${prompt.trim()}\n\nUse plain text with simple Markdown (## headings, **bold**, bullet lists with -). Be concise, factual, and practical.` }]
    });
    const body = (msg.content.find(b => b.type === 'text') || {}).text || '';
    res.json({ success: true, body });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
