const express = require('express');
const router = express.Router();
const { requireAuth } = require('./auth');
// WP-10 A6.3 — AI calls go through the central AI Gateway (audit + policy +
// provider registry). Prompts, models, max_tokens, message shapes and response
// parsing are byte-identical.
const aiGateway = require('../lib/ai-gateway');

router.use(requireAuth);

const ITEM_PROMPTS = {
  competency: 'You are writing a concise competency description for a mining-industry training management system. Based on the name and category provided, write 1–2 sentences describing what this competency covers, the skills or knowledge it assesses, and why it matters on site. Be factual and practical. No preamble.',
  framework:  'You are writing a concise competency framework description for a mining-industry training management system. Based on the framework name, write 1–2 sentences describing its purpose, the area it covers, and who it applies to. Be factual and practical. No preamble.',
  course:     'You are writing a concise training course description for a mining-industry training management system. Based on the course name provided, write 2–3 sentences describing what the course covers, its learning outcomes, and who it is intended for. Be factual, practical, and suitable for a training register. No preamble.',
  form:       'You are writing a short description for a training assessment form in a mining-industry system. Based on the form name, write 1–2 sentences explaining the purpose of the form and when it is used. Be factual and practical. No preamble.',
  pattern:    'You are writing a brief description for a roster shift pattern in a mining-industry workforce management system. Based on the pattern name and cycle, write 1 sentence describing the roster arrangement. Be factual and concise. No preamble.',
  document:   'You are writing a brief document description for a mining-industry document management system. Based on the document name and category, write 1–2 sentences describing the document\'s purpose and intended audience. Be factual and practical. No preamble.',
};

router.post('/draft-desc', async (req, res) => {
  try {
    const { itemType, context } = req.body;
    if (!context || !context.trim()) return res.status(400).json({ error: 'Context required.' });
    const system = ITEM_PROMPTS[itemType] || ITEM_PROMPTS.document;
    const msg = await aiGateway.complete({
      provider: 'anthropic',
      agent: 'AI-ADM-001',
      operation: 'draft_description',
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system,
      messages: [{ role: 'user', content: context.trim() }],
    });
    const description = (msg.content.find(b => b.type === 'text') || {}).text?.trim() || '';
    res.json({ success: true, description });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/doc-check', async (req, res) => {
  try {
    const { summary } = req.body;
    if (!summary) return res.status(400).json({ error: 'summary required' });

    const msg = await aiGateway.complete({
      provider: 'anthropic',
      agent: 'AI-ADM-001',
      operation: 'doc_check',
      model: 'claude-sonnet-4-6',
      max_tokens: 1800,
      system: `You are a document layout auditor for a corporate training management system used by a mining company. You receive a JSON summary describing a document's cover-page fields, footer zones, and section content. Identify issues that would make the printed document look wrong or incomplete.

Check ALL of the following in order:

COVER PAGE (first page) checks — severity "error":
- coverPage.companyLogoConfigured is false → "No company logo configured" — the cover header will have no logo on either side; go to Settings → Company to upload one.
- coverPage.companyNameConfigured is false → "No company name configured" — the header and footer will show no company name; go to Settings → Company to set one.
- coverPage.documentTitlePresent is false → "Document has no title" — the cover heading will be blank.
- coverPage.documentNumberPresent is false → "No document number" — the Document No field on the cover and footer center zone will be empty. (severity: "warning")

FOOTER checks — severity "warning":
- footer.leftZonePopulated is false → "Footer left zone is empty" — the bottom-left of every page will be blank (should show company · title).
- footer.centerZonePopulated is false → "Footer center zone is empty" — the bottom-center will be blank (should show document number and status).

SECTION content checks:
- A section has hasTranslation true but translationHasHeading, translationHasBody, translationHasTable, and translationHasChecklist are all false → "Empty translation block in section N" renders as a blank coloured box. (severity: "error")
- A section has a heading but hasBody, hasTable, hasChecklist are all false → "Section N has heading but no content" (severity: "warning")
- A section has bodyLength > 8000 → "Section N body may overflow a page" — consider splitting into sub-sections. (severity: "warning")
- Some sections have hasTranslation true and others false → "Inconsistent translation coverage" — sections without translation will print English-only. (severity: "warning")

META / SIGNATURES — severity "warning":
- coverPage.preparedBy is empty AND coverPage.reviewedBy is empty AND coverPage.approvedBy is empty → "Signature fields are all blank" — the approval table on the cover will show no names.

Respond ONLY with valid JSON — no markdown fences, no preamble:
{"issues":[{"title":"Short title (under 8 words)","detail":"One clear sentence explaining the problem and how to fix it","severity":"error|warning","sectionIndex":N_or_null,"field":"body|table|checklist|translation|approvedBy|preparedBy|reviewedBy|companyLogo|companyName|documentTitle|documentNumber|footer|null"}],"summary":"One sentence overall assessment."}

For section-related issues, set sectionIndex to the 1-based section number you flagged (matches the "index" in the input). For cover/footer/global issues, set sectionIndex to null. Always include the field name for the part the user needs to fix (e.g. "body" when bodyLength is too high, "approvedBy" when the approving signature is blank, "footer" for footer-zone problems).

If there are no issues: {"issues":[],"summary":"Document looks correct and is ready to print."}`,
      messages: [{ role: 'user', content: JSON.stringify(summary, null, 2) }],
    });

    const raw = (msg.content.find(b => b.type === 'text') || {}).text?.trim() || '{}';
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    let result;
    try { result = JSON.parse(cleaned); }
    catch { result = { issues: [], summary: 'Could not parse AI response.' }; }

    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
