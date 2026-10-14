# TrainingPro — Executive Architecture Specification

> **Foundation document for all TrainingPro modules**, including the AI Document Translator and AI Content Development.
> This is the **parent specification**; detailed module PRDs inherit from it.

---

## 1. Vision

TrainingPro is an enterprise training, competency, document, assessment, and AI-enabled content platform for **mining, processing, maintenance, construction, and industrial operations**.

## 2. Core Modules

- Document Library
- Course Library
- LMS
- Competency Management
- Assessments
- AI Document Translator
- AI Content Development
- Analytics
- Knowledge Base

## 3. Shared Services

Common services that **every module must reuse** (no duplication):

- Users
- Roles
- Permissions
- Audit Logs
- Approval Workflows
- Version Control
- Storage
- Notifications
- Agent Framework

## 4. AI Agent Framework

All AI modules use a common:

- Workflow controller
- Agent orchestration model
- Audit trail
- Learning system
- Approval framework

## 5. Document Management

Single source of truth document library with:

- Versioning
- Approvals
- Metadata
- Categories
- Language variants

## 6. Security

- Role-based access
- Audit logging
- Approval gates
- Document ownership
- Segregation of duties

## 7. Integration Standards

> All future modules **must reuse TrainingPro services** and **must not create duplicate storage or permission systems**.

## 8. Roadmap

| Phase | Scope | Status |
|-------|-------|--------|
| **Phase 1** | AI Document Translator | 🟢 **Built (working slice in TrainingPro)** — DOCX/PPTX/XLSX layout-preserving, PDF + image OCR, Translation Memory, Terminology, Human Review, approval + audit. See PRD v2 §"Implementation Status". |
| **Phase 2** | AI Content Development | 🟢 **Built** — Exam, Form, Course, SOP, Training Plan, Induction Pack; generate→preview/edit→save; Regenerate button; Generation History. See PRD v1. |
| **Phase 3** | Analytics, Competency Management, Knowledge Base | 🟡 **In progress** — Analytics dashboard (tiles + 4 Chart.js charts), Competency Management (frameworks, competencies, job/dept requirements, gap analysis, assessment records), Knowledge Base (categories, articles, search, ratings). Routes: `/api/analytics`, `/api/competency`, `/api/kb`. |

> The Phase-1 Translator is implemented **inside the TrainingPro app** (`TrainTrack-Web`), reusing the shared Document Library (`tblFiles`), audit log, approval flow, and the Claude integration (`lib/ai.js`) — per §7 Integration Standards.

---

## Future Detailed PRDs

This architecture document serves as the **parent specification** for:

- `TrainingPro_AI_Document_Translator_PRD_v1` → superseded by **`TrainingPro_AI_Document_Translator_PRD_v2`** (current; includes as-built status)
- `TrainingPro_AI_Content_Development_PRD_v1` *(not yet written)*
- Future AI modules
