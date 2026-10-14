// Protected-value / number-unit validation (brief §11–12).
//
// Deterministic (no AI): extracts safety- and technically-significant VALUES from text —
// measurements with units, percentages, temperatures, pressures, speeds, times, loads,
// voltages, torques, money, and equipment model codes — and compares a SOURCE against a
// GENERATED/DERIVED output. Any value present in the source but missing (or changed) in the
// output is flagged for human review BEFORE approval. Language may change; values may not.
'use strict';

// Unit vocabulary (lowercased, no spaces). Order matters: longer units first so "m/s" is not
// eaten by "m", "mm" not by "m", "kpa" not by "pa", etc.
const UNITS = [
  'km/h', 'kph', 'mph', 'm/s', 'rpm',
  'kpa', 'mpa', 'psi', 'bar', 'pa',
  '°c', '°f', 'degc', 'degf', '℃', '℉',
  'mm', 'cm', 'km', 'm', 'in', 'ft',
  'kg', 'mg', 'g', 'tonnes', 'tonne', 't', 'lbs', 'lb',
  'ml', 'l', 'litres', 'litre', 'liters', 'liter', 'gal',
  'kv', 'v', 'ma', 'a', 'kw', 'w', 'hz',
  'knm', 'nm', 'kn', 'n',
  'seconds', 'second', 'secs', 'sec', 'mins', 'minutes', 'minute', 'min',
  'hrs', 'hours', 'hour', 'hr', 'days', 'day', 's', 'h',
];
// Regexes built once.
const RE_PERCENT = /(\d+(?:\.\d+)?)\s?%/g;
const RE_MONEY = /\$\s?(\d+(?:[.,]\d+)?)/g;
const RE_TEMP = /(-?\d+(?:\.\d+)?)\s?(?:°|deg(?:rees)?\s?)\s?[cf]\b/gi;
// number + unit (unit token bounded so "min" != "m in")
const RE_NUM_UNIT = new RegExp(
  '(-?\\d+(?:\\.\\d+)?)\\s?(' + UNITS.map(u => u.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|') + ')(?![a-z])',
  'gi'
);
// Equipment / model codes. UPPERCASE only, so ordinary "load 35" / "mark 80" prose never matches.
//  • spaced: two-plus uppercase letters + optional space/dash + digits (+opt letter): CAT 745, HD 785
//  • joined: one-plus uppercase letters immediately followed by digits (+opt letter): D11T, PC2000, CAT745
const RE_MODEL_SPACED = /\b([A-Z]{2,4})[- ]?(\d{2,5})([A-Za-z])?\b/g;
const RE_MODEL_JOINED = /\b([A-Z]{1,4}\d{2,5}[A-Za-z]?)\b/g;
// Standalone significant numbers: decimals, or integers with 2+ digits (skip lone 0–9 step numbers).
const RE_BARE = /(?<![\w.])(\d+\.\d+|\d{2,})(?![\w.%])/g;

function normUnit(u) {
  const x = String(u).toLowerCase();
  const map = {
    'degc': '°c', 'degf': '°f', '℃': '°c', '℉': '°f',
    'kph': 'km/h', 'litres': 'l', 'litre': 'l', 'liters': 'l', 'liter': 'l',
    'tonnes': 't', 'tonne': 't', 'lbs': 'lb',
    'seconds': 's', 'second': 's', 'secs': 's', 'sec': 's',
    'minutes': 'min', 'minute': 'min', 'mins': 'min',
    'hours': 'h', 'hour': 'h', 'hrs': 'h', 'hr': 'h',
    'days': 'day',
  };
  return map[x] || x;
}
function normNum(n) {
  const f = parseFloat(String(n).replace(/,/g, ''));
  return Number.isFinite(f) ? String(f) : String(n);
}

// Extract a map of normalized-token -> display string. Using a map de-duplicates while keeping
// a human-readable representative for each distinct value.
function extractValueMap(text) {
  const t = String(text || '');
  const out = new Map();
  const add = (key, display) => { if (!out.has(key)) out.set(key, display.trim()); };

  let m;
  RE_PERCENT.lastIndex = 0;
  while ((m = RE_PERCENT.exec(t))) add('pct:' + normNum(m[1]), m[0]);
  RE_MONEY.lastIndex = 0;
  while ((m = RE_MONEY.exec(t))) add('money:' + normNum(m[1]), m[0]);
  RE_TEMP.lastIndex = 0;
  while ((m = RE_TEMP.exec(t))) add('temp:' + normNum(m[1]), m[0]);
  RE_NUM_UNIT.lastIndex = 0;
  while ((m = RE_NUM_UNIT.exec(t))) add(normNum(m[1]) + normUnit(m[2]), m[0]);
  RE_MODEL_SPACED.lastIndex = 0;
  while ((m = RE_MODEL_SPACED.exec(t))) {
    // Canonical key ignores the space so "CAT 745" and "CAT745" are the same value.
    add('model:' + (m[1] + m[2] + (m[3] || '')).toLowerCase(), m[0]);
  }
  RE_MODEL_JOINED.lastIndex = 0;
  while ((m = RE_MODEL_JOINED.exec(t))) add('model:' + m[1].toLowerCase(), m[0]);
  RE_BARE.lastIndex = 0;
  while ((m = RE_BARE.exec(t))) add('num:' + normNum(m[1]), m[0]);
  return out;
}

// Compare SOURCE text against OUTPUT text. Returns values that are in the source but NOT present
// in the output (dropped or altered), split into safety-weighted categories for display.
function compareValues(sourceText, outputText) {
  const src = extractValueMap(sourceText);
  const out = extractValueMap(outputText);
  const missing = [];
  for (const [key, display] of src) {
    if (!out.has(key)) missing.push({ key, value: display, kind: key.split(':')[0] === key ? 'measure' : key.split(':')[0] });
  }
  // Weight: unit-bearing / percentage / temperature / model / money are "critical"; bare numbers "minor".
  const critical = missing.filter(x => x.kind !== 'num');
  const minor = missing.filter(x => x.kind === 'num');
  return {
    // Pass/fail is driven by CRITICAL values (units, %, temperatures, model codes, money). Bare
    // numbers are reported as `minor` but do not fail the check, since section/step numbers create noise.
    ok: critical.length === 0,
    sourceCount: src.size,
    outputCount: out.size,
    missing,               // every source value absent from the output
    critical,              // unit/percent/temp/model/money values absent from output (review these)
    minor,                 // bare numbers absent from output (often benign)
    criticalCount: critical.length,
    minorCount: minor.length,
  };
}

// Flatten a structured document (the AI Content Studio data model) into plain text for value
// comparison — includes headings, body, callouts, checklist items, table cells and risk scores.
function documentText(data) {
  const parts = [];
  const d = data || {};
  if (d.title) parts.push(d.title);
  if (d.subtitle) parts.push(d.subtitle);
  const secs = Array.isArray(d.sections) ? d.sections : [];
  for (const s of secs) {
    if (!s) continue;
    if (s.heading) parts.push(s.heading);
    if (s.body) parts.push(s.body);
    if (s.callout) parts.push(s.callout);
    if (Array.isArray(s.checklist)) parts.push(s.checklist.join(' '));
    if (s.table && Array.isArray(s.table.headers)) {
      parts.push(s.table.headers.join(' '));
      for (const row of (s.table.rows || [])) if (Array.isArray(row)) parts.push(row.join(' '));
    }
    const risks = Array.isArray(s.risk) ? s.risk : (s.risk ? [s.risk] : []);
    for (const r of risks) if (r && typeof r === 'object') parts.push([r.hazard, r.score, r.residual, r.controls].filter(v => v != null).join(' '));
  }
  return parts.join('\n');
}

module.exports = { extractValueMap, compareValues, documentText, UNITS };
