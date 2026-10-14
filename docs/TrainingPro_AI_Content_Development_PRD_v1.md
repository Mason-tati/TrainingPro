# TrainingPro — AI Content Development (PRD v1)

> **Child PRD** of the [Executive Architecture Specification](./ARCHITECTURE.md). Phase 2 of the AI roadmap.
> Must reuse all TrainingPro shared services — no duplicate storage, permission, or audit systems.

## Purpose

An **AI Content Studio** inside TrainingPro that turns a prompt (and an optional source document) into draft training content, saved into the right module — pending approval and fully audit-logged.

## How it works (the AI assistant flow)

1. The user picks **what to build** (content type).
2. Optionally selects a **source document** from the Document Library for the AI to base it on.
3. Writes a **prompt** describing what they want.
4. The AI generates structured content; TrainingPro **saves it into the relevant module as a draft**.

## Content types (first release)

| Type | Generated into | Storage |
|---|---|---|
| **Exam / Question bank** | Exam Builder | `tblTest` + `tblQ` + `tblQA` (real, editable exam) |
| **Competency Assessment (TAR)** | Form Builder | `tblFormTemplate` + `tblFormField` (real, editable form) |
| **Course / Lesson content** | Document Library | Generated `.docx` (sections, objectives, summaries) |
| **SOP / Work procedure** | Document Library | Generated `.docx` in house structure (Purpose, Scope, Procedure, Hazards…) |

## Rules (inherited)

- Output is a **draft** — nothing is published without review/approval.
- Save into existing modules; **no new storage or permission systems**.
- Every generation is **audit-logged**.
- Reuse the Claude integration (`lib/ai.js`) and Document Library (`tblFiles`).

## Not in v1
Multi-document source synthesis; image/diagram generation; auto-publishing; versioned regeneration. (Roadmap.)
