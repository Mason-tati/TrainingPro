// Form → Word (.docx) exporter.
// Maps a Form Builder template (tblFormField rows) — optionally merged with a submission's answers —
// into the section shape the existing buildDocx() OOXML writer consumes, so forms download as Word
// documents with their tables/grids preserved. Pure (no DB, no I/O); the caller supplies fields,
// answers and branding. Never throws on odd field data — unknown types degrade to a labelled line.
'use strict';

const { buildDocx } = require('./content');

const FILL = '________________________';

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

// A grid field (Options.columns/rows) → a buildDocx table, optionally filled from a submission answer.
function gridToSections(sections, field, opts, answerValue) {
  const cols = (isObj(opts) && Array.isArray(opts.columns)) ? opts.columns : [];
  const defRows = (isObj(opts) && Array.isArray(opts.rows)) ? opts.rows : [];
  const headers = cols.length ? cols.map(c => c.label || '') : [];

  // A filled grid answer is stored as JSON in tblFormAnswer.Value (array of rows, or { rows: [...] }).
  let filledRows = null;
  if (answerValue) {
    try {
      const parsed = JSON.parse(answerValue);
      filledRows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.rows) ? parsed.rows : null);
    } catch (e) { filledRows = null; }
  }
  const srcRows = filledRows || defRows;

  const rows = [];
  for (const row of srcRows) {
    if (isObj(row) && row.heading) {
      // a full-width heading row → put the text in the first cell, blank the rest
      rows.push([String(row.heading)].concat(cols.slice(1).map(() => '')));
      continue;
    }
    const cells = (isObj(row) && isObj(row.cells)) ? row.cells : {};
    rows.push(cols.map((c) => {
      const v = cells[c.key];
      if (v != null && String(v).trim()) return String(v);
      if (c.check) return '☐';        // tick column → blank checkbox glyph
      return '';                       // fill column → blank cell for handwriting
    }));
  }
  if (!rows.length && cols.length) rows.push(cols.map(c => (c.check ? '☐' : '')));

  if (field.Label) sections.push({ heading: field.Label, level: 3 });
  if (headers.length) sections.push({ table: { headers, rows } });
}

// Build the .docx buffer for a template (+ optional submission). Returns { buffer, filename }.
//   template   : { Name, Description }
//   fields     : [{ FieldID, FieldType, Label, Options(parsed object|null) }]  (in display order)
//   submission : null | { answers:[{FieldID,Value}], empName, trainerName, assessDate, location }
//   opts       : { companyName, companyLogo, docNumber }
function formTemplateToDocx(template, fields, submission, opts) {
  const branding = isObj(opts) ? opts : {};
  const answerByField = {};
  if (submission && Array.isArray(submission.answers)) {
    for (const a of submission.answers) answerByField[a.FieldID] = a.Value;
  }

  const sections = [];

  // A short submission header so a completed form records who/when/where.
  if (submission) {
    const bits = [
      submission.empName ? 'Name: ' + submission.empName : '',
      submission.trainerName ? 'Assessor / Trainer: ' + submission.trainerName : '',
      submission.assessDate ? 'Date: ' + submission.assessDate : '',
      submission.location ? 'Location: ' + submission.location : '',
    ].filter(Boolean);
    if (bits.length) sections.push({ body: bits.join('\n') });
  }

  for (const f of (fields || [])) {
    const label = (f.Label || '').trim();
    const parsedOpts = isObj(f.Options) ? f.Options : null;
    const ans = answerByField[f.FieldID];
    const has = ans != null && String(ans).trim() !== '';

    switch (f.FieldType) {
      case 'section':
        sections.push({ heading: label || 'Section', level: 2 });
        break;
      case 'instructions':
        if (label) sections.push({ body: label });
        break;
      case 'text':
      case 'date':
        sections.push({ body: label + ':  ' + (has ? String(ans) : FILL) });
        break;
      case 'textarea':
        sections.push({ body: label + ':\n' + (has ? String(ans) : (FILL + '\n' + FILL)) });
        break;
      case 'checkbox': {
        const checked = ans === '✓' || ans === 'true' || ans === '1' || ans === 'on' || ans === 'yes';
        if (checked) sections.push({ body: '☑  ' + label });
        else sections.push({ checklist: [label] }); // buildDocx renders "☐  label"
        break;
      }
      case 'signature': {
        const who = submission ? (/trainer|assessor|supervisor/i.test(label) ? submission.trainerName : submission.empName) : '';
        sections.push({ body: label + ':  ' + (who ? who + '   ' : FILL + '   ') + 'Date: ____________' });
        break;
      }
      case 'grid':
        gridToSections(sections, f, parsedOpts, ans);
        break;
      default:
        if (label) sections.push({ body: label + ':  ' + (has ? String(ans) : FILL) });
    }
  }

  const title = (template && (template.Name || template.name)) || 'Form';
  const buffer = buildDocx(title, sections, {
    subtitle: (template && template.Description) ? template.Description : '',
    docNumber: branding.docNumber || '',
    meta: { status: submission ? 'Completed' : 'Blank Form' },
    companyName: branding.companyName || '',
    companyLogo: branding.companyLogo || '',
  });

  const safe = String(title).replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'form';
  return { buffer, filename: safe + (submission ? '_completed' : '') + '.docx' };
}

module.exports = { formTemplateToDocx };
