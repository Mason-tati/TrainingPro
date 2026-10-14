# TrainingPro — AI Document Translator (PRD v2, Full)

> **Comprehensive child PRD** of the [Executive Architecture Specification](./ARCHITECTURE.md). Supersedes [PRD v1](./TrainingPro_AI_Document_Translator_PRD_v1.md).
> Phase 1 of the TrainingPro AI roadmap. **Must reuse all TrainingPro shared services** — no duplicate storage, permission, or audit systems.

---

## 0. Implementation Status — *as built* (current working slice)

A working translator is live **inside the TrainingPro app** (`TrainTrack-Web`), at **Data → 🌐 AI Translator**. It reuses the shared Document Library (`tblFiles`), audit log, approval flow, and the Claude integration (`lib/ai.js`).

**Delivered & verified end-to-end:**

| Capability | Status | Notes |
|---|---|---|
| **DOCX** translation | ✅ Built | In-place `<w:t>` replacement — layout preserved by construction (tables/images/styles untouched). |
| **DOCX bilingual** | ✅ Built | Depth-aware paragraph scanner (original + translation); safe with text boxes/tables. |
| **PPTX / XLSX** | ✅ Built | In-place replacement of `<a:t>` / sharedStrings `<t>`. |
| **PDF** (digital + scanned) | ✅ Built | Read via Claude's **native PDF support** (no rendering library) → translated `.docx`. |
| **Images** (PNG/JPG/WEBP) | ✅ Built | OCR via **Claude Vision** → translated `.docx`. |
| **Translation Memory** | ✅ Built | Approved segments reused automatically; corrections promote on approval (`tblTransMemory`, `tblTransSegment`). |
| **Terminology** | ✅ Built | Glossary enforced via the prompt (`tblTerminology`). |
| **Human Review / QA** | ✅ Built | Side-by-side source→target editor; corrections regenerate the document (no AI re-run) and feed memory. |
| **Save to Document Library** | ✅ Built | Output stored as a language variant; uploaded sources also saved for re-generation. |
| **Approvals + Audit** | ✅ Built | Pending → admin approve; every step audit-logged. |

**Key implementation choices (differ from the original aspirational spec, intentionally):**
- **Layout fidelity by construction** — we translate only the text runs inside the Office XML rather than parsing-and-rebuilding, so styles/tables/images survive untouched.
- **No OCR/PDF dependencies** — image and PDF OCR use Claude Vision / native PDF reading instead of a Tesseract/poppler stack.
- **Visual sources (PDF/image) become a clean translated `.docx`**, not a pixel overlay — consistent with the *"no overlay translations"* rule.
- The **18 agents** below are realised as **functions in one pipeline** (Workflow Controller = the `/api/translator` route + `lib/translate.js`), not 18 separate services — they can be split out later if needed.

**Not yet built:** multi-format bilingual (PPTX/XLSX bilingual); learning analytics dashboard; PDF *layout-preserving* output (current PDF output is translated text in `.docx`); full automated regression suite.

**Newly built (this pass):** automated **QA checks** (untranslated / unchanged / number-mismatch / truncation), **Safety Review** (safety-critical terms flagged per segment), and a **Final Audit gate** (approval blocked/confirmed if untranslated segments remain) — all surfaced in the Review screen.

---

## 1. Executive Summary

The AI Document Translator is an **integrated TrainingPro module** that localizes enterprise documents while preserving their exact layout and meeting compliance requirements for mining, processing, maintenance, construction, and industrial operations.

- **Integrated, not standalone** — uses the existing Document Library, permissions, approvals, and audit logs.
- **Format coverage** — DOCX, PDF, PPTX, XLSX, plus OCR workflows for images and scanned PDFs.
- **Layout-faithful** — translations replace source content in place (bilingual or target-only); **no overlay translations**.
- **Governed** — every translation is versioned, approved, and audit-logged through TrainingPro's shared services.
- **Self-improving** — translation memory, terminology, and learning agents raise quality over time.

## 2. Goals & Non-Goals

**Goals**
- One-click, layout-preserving translation of operational documents.
- Reusable terminology and translation memory across the enterprise.
- Human-in-the-loop QA and approval before any document is published back.
- Full traceability (who/what/when) for every translated artifact.

**Non-Goals**
- No separate document store, user system, or permission model (reuse TrainingPro's).
- No overlay/annotation-style translation that floats over the original.
- No publishing without passing QA, Safety Review, and Final Audit gates.

## 3. Architecture

| Component | Responsibility |
|-----------|----------------|
| **Translation Workspace** | Operator-facing UI to start jobs, pick languages/scope, review bilingual output, and approve. |
| **Agent Workflow Controller** | Orchestrates the 18 agents, manages job state, retries, and approval gates (built on the shared AI Agent Framework). |
| **Document Composition Engine** | Rebuilds the translated document in its native format (DOCX/PPTX/XLSX/PDF) preserving styles, tables, and structure. |
| **Reflow Engine** | Adjusts text frames, table cells, and pagination when translated text changes length, keeping layout intact. |
| **Final Audit Engine** | Last automated gate — verifies completeness, layout fidelity, terminology compliance, and that nothing is untranslated or overlaid. |
| **Translation Memory (TM)** | Stores approved source→target segment pairs for reuse, consistency, and cost reduction. |
| **Terminology Management** | Maintains approved glossaries (site/equipment/safety terms) enforced during translation and QA. |

## 4. Agent Framework (18 agents)

Agents run on the shared **Agent Workflow Controller** with a common audit trail, learning system, and approval framework.

| # | Agent | Responsibility |
|---|-------|----------------|
| 1 | **Document Intake** | Validate file, detect format/language, register the job against the Document Library. |
| 2 | **Structure & Layout** | Extract the document's structural model — sections, tables, frames, styles, anchors. |
| 3 | **Image OCR** | Detect text in images/scanned PDFs and extract it for translation while recording position. |
| 4 | **User Selection** | Capture operator choices — language pair, bilingual vs target-only, scope, terminology set. |
| 5 | **Terminology** | Apply approved glossary terms and flag forbidden/unapproved terms. |
| 6 | **Translation Memory** | Pre-fill segments from approved TM matches before AI translation. |
| 7 | **AI Translation** | Translate remaining segments with context (Claude), respecting terminology and tone. |
| 8 | **QA** | Automated checks — completeness, numbers/units, terminology adherence, placeholder integrity. |
| 9 | **Human Review** | Route to a qualified reviewer for correction and sign-off where required. |
| 10 | **Placement** | Place translated segments back into the structural model (bilingual or replacement). |
| 11 | **Composition** | Render the placed content into the native document format via the Composition Engine. |
| 12 | **Reflow** | Resize/repaginate so changed text length does not break the layout. |
| 13 | **Image Anchor** | Re-anchor OCR'd image text and keep figures/captions correctly positioned. |
| 14 | **Safety Review** | Verify safety-critical content (hazards, procedures, warnings) is accurate and intact. |
| 15 | **Final Audit** | Run the Final Audit Engine checks; block export on any failure. |
| 16 | **Export** | Produce the final file and **save it back to the Document Library** as a language variant/version. |
| 17 | **Learning** | Capture corrections into TM/terminology to improve future jobs. |
| 18 | **Product Improvement** | Aggregate metrics/feedback to surface model, glossary, and workflow improvements. |

## 5. End-to-End Pipeline

```
Intake → Structure & Layout → Image OCR → User Selection
   → Terminology → Translation Memory → AI Translation
   → QA → Human Review
   → Placement → Composition → Reflow → Image Anchor
   → Safety Review → Final Audit
   → Export (save to Document Library)
   → Learning → Product Improvement
```

Approval gates: **Human Review**, **Safety Review**, and **Final Audit** must all pass before **Export**.

## 6. 20-Phase Build Plan

Status: ✅ built · 🟡 partial · ⚪ not started

| Phase | Focus | Key Deliverable | Status |
|-------|-------|-----------------|--------|
| 1 | **Foundation** | Module scaffold; wire into TrainingPro Users/Roles/Permissions/Audit/Storage. | ✅ |
| 2 | **Document Intake** | Upload, format/language detection, job registration. | ✅ |
| 3 | **Structure & Layout** | Office-XML text-run extraction (no rebuild; layout preserved in place). | ✅ |
| 4 | **Image OCR** | OCR for images **and PDFs** via Claude Vision / native PDF (no rendering deps). | ✅ |
| 5 | **Translation Workspace** | Operator UI for starting and tracking jobs. | ✅ |
| 6 | **User Selection** | Language (14 incl. Thai), bilingual/target-only. | ✅ |
| 7 | **Terminology Management** | Glossary store + prompt enforcement. | ✅ |
| 8 | **Translation Memory** | TM store, reuse, promote-on-approve. | ✅ |
| 9 | **AI Translation** | Context-aware engine (Claude Sonnet 4.6). | ✅ |
| 10 | **QA** | Automated checks: untranslated/unchanged segments, number mismatch, truncation — shown per segment in Review. | ✅ |
| 11 | **Human Review** | Side-by-side editor; corrections regenerate + feed memory. | ✅ |
| 12 | **Placement** | Target replacement + DOCX bilingual placement. | 🟡 (DOCX bilingual only) |
| 13 | **Composition Engine** | Native re-pack (DOCX/PPTX/XLSX) / `.docx` from OCR. | ✅ |
| 14 | **Reflow Engine** | Not needed for in-place text approach. | ⚪ N/A |
| 15 | **Image Anchor** | Not needed (text-run approach keeps anchors). | ⚪ N/A |
| 16 | **Safety Review** | Safety-critical terms (danger, lockout, PPE, voltage, confined space…) flagged per segment in Review. | ✅ |
| 17 | **Final Audit Engine** | Approval blocked/confirmed if untranslated segments remain (Final Audit gate). | ✅ |
| 18 | **Export & Save-Back** | Saved to Document Library as language variant. | ✅ |
| 19 | **Learning & Product Improvement** | Corrections feed TM on approval (metrics dashboard pending). | 🟡 |
| 20 | **Regression Testing** | Per-feature verification done; full automated suite pending. | 🟡 |

## 7. Critical Rules

1. **No overlay translations** — content is replaced in place (bilingual or target-only), never floated over the original.
2. **Preserve layout** — styles, tables, frames, images, and pagination must match the source.
3. **Save back to the Document Library** — outputs are versioned language variants, not loose files.
4. **Maintain approvals and audit logs** — every job passes the approval gates and is fully logged.

## 8. Integration & Security (inherited from parent architecture)

- **Reuse shared services:** Users, Roles, Permissions, Audit Logs, Approval Workflows, Version Control, Storage, Notifications, Agent Framework.
- **Document Management:** single source of truth with versioning, approvals, metadata, categories, and language variants.
- **Security:** role-based access, audit logging, approval gates, document ownership, segregation of duties.
