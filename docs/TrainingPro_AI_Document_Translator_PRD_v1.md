# TrainingPro — AI Document Translator (PRD v1)

> **Child PRD** of the [Executive Architecture Specification](./ARCHITECTURE.md).
> Phase 1 of the TrainingPro AI roadmap. Must reuse all TrainingPro shared services (no duplicate storage or permission systems).

---

## Purpose

Enterprise document **localization platform** integrated into TrainingPro.

## Supported Formats

- DOCX
- PDF
- PPTX
- XLSX
- OCR
- Images
- Scanned PDFs

## Core Features

- Bilingual placement
- Embedded translation
- Terminology management
- Translation memory
- QA
- Audit
- Approvals

## Agent Architecture

**18 agents**, including:

- Translation
- QA
- Composition
- Reflow
- Safety Review
- Final Audit
- Learning and Product Improvement

*(Agents operate on the shared AI Agent Framework: common workflow controller, orchestration model, audit trail, learning system, and approval framework.)*

## 20-Phase Build Plan

**Phase 1 (Foundation) → Phase 20 (Regression Testing).**

| Phase | Stage |
|-------|-------|
| Phase 1 | Foundation |
| … | *(phases 2–19 to be detailed)* |
| Phase 20 | Regression Testing |

## Critical Rules

1. **No overlay translations.**
2. **Preserve layout.**
3. **Save back to the Document Library.**
4. **Maintain approvals and audit logs.**

---

### Inherited from parent architecture
- Reuse shared services: Users, Roles, Permissions, Audit Logs, Approval Workflows, Version Control, Storage, Notifications, Agent Framework.
- Single source of truth Document Library with versioning, approvals, metadata, categories, and language variants.
- Security: role-based access, audit logging, approval gates, document ownership, segregation of duties.
