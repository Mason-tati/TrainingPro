# Audit Governance & Engineering Notes

> Moved here from the original `README.md` when the README was replaced with a setup/run guide.
> This is the project's internal engineering changelog (WP-16 audit governance migration, etc.).

---

# TrainingPro (TrainTrack-Web)

A Node.js / Express + SQLite training-management application (training records,
competencies, assessments, forms, documents, HR/onboarding/leave, disciplinary,
equipment, AI-assisted content and translation).

Tests run against **isolated temporary databases** (never the production DB) with a
network guard that blocks all outbound calls. See `package.json` for the test scripts
(`npm test`, `npm run test:governance`, `npm run test:audit`, `npm run test:coverage`, …).

---

## Audit Governance (WP-16 — COMPLETE)

**Status: WP-16 is complete.** Every production route that records an audit trail now
writes through the governance audit adapter (`lib/governance/audit-adapter.js`) instead
of the legacy helper (`lib/audit.js`). The legacy helper is retained but has **zero
production callers**.

### Migration summary

The migration removed **90 legacy `logAudit()` call sites across 19 route files** in
three reviewed batches, each shipped commit-by-commit with a full test battery:

| Batch | Risk tier | Routes | Sites |
|-------|-----------|--------|-------|
| M3 | Low (scheduling / operational) | classes, trainers, roster, register, assignment, attendance, equipment | 28 |
| M4 | High (HR / medical / disciplinary) | disciplinary, onboarding, leave, staff | 24 |
| M5 | Medium (documents / AI / exams / forms) | competency, forms, content, exams, powerpoints, files, translator, knowledgebase | 38 |
| **Total** | | **19 files** | **90** |

M1 produced the inventory; M2 built the adapter; **M6** closed the work package with
retirement verification, adversarial sanitization tests, documentation, and this README.

### Architecture

**Old flow** (pre-WP-16):

```
Routes
   ↓
logAudit()            (lib/audit.js — raw values written verbatim)
   ↓
tblAudit
```

**New flow** (WP-16):

```
Routes
   ↓
recordLegacyAudit()   (lib/governance/audit-adapter.js)
   ↓
Governance Adapter    (map legacy AuditTable/AuditAction → governance entity/action)
   ↓
Sanitization          (drop sensitive content / mask secrets / cap length)
   ↓
tblAudit              (same schema; legacy AuditTable/AuditAction strings preserved)
```

### Why the adapter exists

The legacy `logAudit()` wrote whatever the caller passed straight into
`tblAudit.OldValue` / `NewValue`. That risked persisting sensitive free-text — HR /
medical / disciplinary notes, PII, and AI prompts/completions — into an
append-only audit table. The adapter is a **sanitizing, drop-in replacement**: it
keeps the exact same call signature and row shape, but classifies each write against
the governance registries and redacts or masks sensitive material before it is stored.
It **fails open** (never throws, never blocks a request) so auditing can never break a
route.

### Why tblAudit was preserved

By Product-Owner decision the physical `tblAudit` structure is unchanged — same
columns, same `AuditTable` / `AuditAction` string values, same `AuditDate`
(`datetime('now')`), same fire-and-forget insert. This avoids any schema migration,
keeps existing reports/queries working, and makes the change **behaviourally invisible**
to the rest of the system. The governance entity/action ids are used **internally only**
(for classification and sanitization) and are never written to the table.

### Sanitization rules

- **Content drop** — for entities whose sensitive category is one of
  `medical`, `disciplinary_freetext`, or `ai_content`, the Old/New value is replaced
  entirely with `[REDACTED]`. This covers `ai_outputs` (AI prompts/completions/output),
  `disciplinary`, `medical`, `onboarding`, and `leave`.
- **Mask + cap** — for all other entities the value is kept as a useful identifier but
  scrubbed: API keys (`sk-…`), `Bearer …` tokens, JWTs (`eyJ….….…`),
  `connect.sid=…` cookies, and 6+ digit runs are replaced with `[REDACTED]`; control
  characters are stripped; and the value is capped at 256 characters.
- **Actor** — `AuditUser` is derived only from username sources (session user /
  `req.user` / request context); a session id, cookie, authorization header, or body
  payload is never used as the actor.
- **Fail-open** — any error in preparation or the DB write is swallowed; the route
  response is never affected.

### Governance mappings

Legacy `AuditTable` → governance entity (via the adapter's `TABLE_MAP`):

| Legacy AuditTable(s) | Governance entity |
|----------------------|-------------------|
| tblStaff, tblEmpJob, tblTrainer | `users` |
| Disciplinary | `disciplinary` |
| Onboarding, OnboardingReview | `onboarding` |
| LeaveType, LeaveBooking | `leave` |
| Competency, CompetencyFramework, CompetencyRecord | `competencies` |
| Exam, tblExam, tblTest, tblQ, tblFormTemplate, tblFormSubmission | `assessments` |
| KBArticle, tblFiles, PPTX | `documents` |
| AIContent | `ai_outputs` |
| tblClass, tblRoster, tblRegister, Assignment, Attendance | `training` |
| Equipment, EquipmentType, EquipmentService, EquipmentBreakdown | `equipment` |

Legacy `AuditAction` → governance action (via `ACTION_MAP`): `CREATE→create`,
`UPDATE→update`, `DELETE→delete`, `ASSIGN→assign`, `ASSESS→assess`,
`SIGN`/`SUPERVISOR_SIGN→verify`, `APPROVE_TRANSLATION→approve`, `TRANSLATE→translate`,
`AI-EXTRACT`/`DEVELOP`/`COVER`/`PPTX_BUILD→generate_ai`, `CERTIFICATE→certify`, etc.
Unknown tables fall back to the `audit` entity and unknown actions to the `update`
action — so **every mapping always returns a real governance entity/action**. The
original legacy strings are still what gets stored.

### Future retirement plan for lib/audit.js

`lib/audit.js` is intentionally **retained, not deleted**, in WP-16:

1. It has no production callers today (guarded permanently by
   `tests/api/audit-retirement.test.js`, which fails if any route re-imports it or
   calls `logAudit()`).
2. Unit tests still exercise the helper directly to document its historical behaviour.
3. A future work package may delete `lib/audit.js` once those unit tests are retired
   and no external tooling references it. Until then the retirement test ensures the
   legacy path cannot silently return.

### Running the audit test suite

```
npm run test:audit
```

runs every WP-16 audit test: the M1 inventory, the adapter unit/API tests, the M3/M4/M5
migration tests, and the M6 retirement/sanitization suite.

---

## Enterprise Document Foundation (WP-17 — COMPLETE)

**Status: WP-17 is complete.** The Enterprise Document Foundation is a set of **exactly
23 immutable registries** under `lib/document/` that define the vocabulary and rules a
future enterprise document-management system will consume. **Nothing consumes them yet —
the entire foundation is unwired.** They add no routes, no schema, no runtime behaviour;
the application behaves identically with or without them.

### Purpose
To establish a single, authoritative, immutable source of truth for every document
concept — types, statuses, review cadences, approvals, templates, metadata, relationships,
versioning, publishing, distribution, access, storage, notifications, workflows,
validation, search, and compliance — *before* any engine is built on top. Building the
vocabulary first keeps the future document engine, workflow engine, and integrations
consistent and testable.

### Architecture
Every registry follows the identical pattern established in WP-14/WP-15:

- **Immutable registry pattern** — a frozen `X` map of entries + a frozen `X_IDS` key
  array, exposed only through accessor functions.
- **Deep freeze** — the map, the id array, every entry, and every nested object/array
  (e.g. `futureReserved`, `allowedChannels`) are recursively `Object.freeze`d.
- **Copy-on-read** — `getX(id)` and `listX()` return **fresh** copies (fresh nested
  arrays/objects too), so a caller can never mutate the registry.
- **Safe defaults** — an unknown/garbage id returns a most-restrictive `UNKNOWN` (or
  `unknown`) default that is **not** a member of `X_IDS`; the registries never throw.
- **Pure, dependency-free, CommonJS** — no npm dependencies, no env vars, no I/O.

### The 23 registries
1. **Document types** (`document-types.js`) — governed document types + capability flags.
2. **Document status** (`document-status.js`) — lifecycle workflow statuses.
3. **Review frequencies** (`review-frequency.js`) — review cadences + default months.
4. **Approval levels** (`approval-levels.js`) — approval authority levels.
5. **Document numbering** (`document-numbering.js`) — pure `SITE-DEPT-TYPE-000001` helpers.
6. **Document lifecycle** (`document-lifecycle.js`) — lifecycle actions + control flags.
7. **Document governance** (`document-governance.js`) — maps types → WP-15 classification/
   retention/entity/sensitive categories.
8. **Metadata builder** (`document-metadata.js`) — pure, sanitizing metadata assembler.
9. **Template registry** (`document-templates.js`) — enterprise document templates.
10. **Layout templates** (`document-layout-templates.js`) — standard template layouts.
11. **Metadata field registry** (`document-metadata-fields.js`) — every metadata field.
12. **Relationships** (`document-relationships.js`) — reciprocal document relationships.
13. **Approval workflows** (`document-approval-workflows.js`) — approval-workflow patterns.
14. **Versioning** (`document-versioning.js`) — versioning schemes + policies.
15. **Publishing** (`document-publishing.js`) — publishing channels/formats/rules.
16. **Distribution** (`document-distribution.js`) — audiences + distribution rules.
17. **Access** (`document-access.js`) — access modes + read/write capabilities.
18. **Storage** (`document-storage.js`) — storage providers/classes + safety rules.
19. **Notifications** (`document-notifications.js`) — notification templates + triggers.
20. **Workflows** (`document-workflows.js`) — document workflow definitions.
21. **Validation** (`document-validation.js`) — validation rules + severities.
22. **Search** (`document-search.js`) — search/index modes + capabilities.
23. **Compliance** (`document-compliance.js`) — compliance frameworks (ISO, WHS, …).

### Registry interaction philosophy
The registries share a common vocabulary. Higher-level registries reference lower-level
ids (e.g. templates reference document types/statuses/review-frequencies/approval-levels;
approval-workflows and workflows reference document statuses/approval levels; publishing
references statuses; governance maps types to the WP-15 governance registries). The
`document-registry-sweep` test cross-validates that every such reference resolves.

### Why everything is unwired
The foundation is deliberately **not** imported by `server.js`, any route, or any
top-level `lib` module. This guarantees zero production-behaviour risk while the
vocabulary stabilises, and lets each future engine adopt the registries deliberately,
one at a time, behind its own reviewed commit.

### Future integration roadmap (document-engine phases)
Future work packages may build, in order, on top of this foundation — each a separate,
reviewed, reversible step:
- **Document engine** — CRUD over documents using the type/status/metadata registries.
- **Workflow engine** — drive status transitions using the workflow + approval-workflow
  registries.
- **Approval engine** — enforce approval levels + electronic signatures.
- **Search engine** — index/query using the search registry (FTS/vector later).
- **Storage engine** — persist using the storage registry (local/object/cloud).
- **Notification engine** — deliver using the notification + distribution registries.
- **AI integration** — govern AI-generated content via `ai_outputs`/AI registries.
- **Translation engine** — manage translations via the translation vocabulary.
- **Relationship graph** — build the document graph from the relationship registry.
- **Version engine** — apply the versioning registry's schemes.
- **Audit integration** — record document actions through the WP-16 governance adapter.
- **Security integration** — enforce access/classification via the access + governance
  registries and RBAC.

### No production behaviour
WP-17 changed **no** production code path. The only non-registry change is the addition
of the `test:document` npm script. Production and session databases are byte-identical
before and after.

### Rollback notes
Because the foundation is unwired, rollback is a clean file deletion: remove the 23
`lib/document/*.js` modules and their `tests/unit/*` tests, and revert the single
`test:document` line in `package.json`. No schema, data, dependency, or route is affected.

### Running the document test suite
```
npm run test:document
```
runs every WP-17 document-registry test (all 23 module suites plus the
`document-registry-sweep` cross-registry invariant test).

---

## Generate Image from Page Content (AI Content Studio)

A single reusable feature — available on **every** Content Studio page/section — that
generates an illustration from the content already on the page, with bilingual
(English/Thai) captions and a review → approve → regenerate loop.

### How it works
The image model is **never** asked to render text (models misspell, especially Thai):

1. **Claude** turns the page's `{ title, body, keyPoints }` into a prompt for the **scene only**,
   applying the house style + the locale's people descriptor, and requiring an **empty banner
   area** for the caption.
2. You **review and edit** that prompt before anything is generated.
3. **gpt-image-1** draws the artwork (no text in it).
4. The **real company logo** is composited onto each worker's hard hat and shirt, plus a
   corner brand mark (see *Branding* below).
5. **Sharp** composites the caption on the server. Text is shaped with **fontkit** into SVG
   *paths*, so Thai vowels/tone marks are always correct and rendering does not depend on
   system fonts. It is placed into the empty area the artwork actually provides, so it can
   never print over faces, hard hats or equipment.

### Branding — the real logo on PPE (`lib/imagebrand.js`)
Image models cannot draw a logo legibly at hard-hat scale; they produce a garbled imitation
of the wordmark. So the artwork is generated with **completely plain** hats and shirts and
the genuine logo (Admin → Settings → company logo) is composited on afterwards:

| Step | How |
|---|---|
| Where roughly | Claude's **vision**, with a **labelled 16×16 grid** drawn over the image. It answers in cell references (`"from":"H7","to":"I8"`), reading printed labels instead of estimating pixel coordinates — raw coordinates put the first marks in mid-air. |
| Where exactly | A **local** colour check nudges each mark onto the patch that really looks like the garment (intense hi-vis yellow / white hat) and **drops** it if none does. Local only — sunlit sand and a cream sky read as "yellow" and "white" globally. |
| Chest badge | Derived from the hat above it by scanning down to the first sustained band of hi-vis fabric. The vision model reports only some shirts in a group, which left workers unbranded. |

One vision call per scene (~3s). It runs on the **artwork**, which is stored branded, so
caption-only changes reuse it at no extra cost. Every failure path returns the image
unchanged — branding never breaks an image. Turn it off with `LOGO.onPpe = false`.

## Flow charts (AI Content Studio)
**🔀 Flow chart at cursor** on any section inserts a decision flow chart — terminators,
process boxes and decision diamonds with labelled Yes/No branches — at a `[FLOW:uid]`
marker, exactly like an image, so it lands where the cursor was and moves with the text.

Not to be confused with the older **➡️ Stage pathway** (`section.flowchart`, `stages[]` /
`items[]`), which draws a straight left→right progression as a Word table and is what the
AI generator emits for competency pathways. That cannot express a branch, which is why the
flow chart is a separate feature. Both are kept and both still translate.

```js
flow = { uid, title, nodes:[Node], png, pngTr }
Node = { id, type:'start'|'process'|'decision'|'end', text, trans,
         mainLabel, branchLabel, branchDir:'left'|'right', branch:[Node] }
```
A decision has two exits: `mainLabel` continues down the spine, `branchLabel` leaves to a
side column (`branch`) which is itself a sequence and may contain further decisions. Layout
is recursive, so nesting is not limited by the drawing code — the branch's first box is
centred on the decision so the connector is a straight arrow rather than an elbow.

**Labelled-diagram mode** (the builder's second tab): upload a picture, then drop
`point → leader-line → text callout` labels onto its parts (like a classic parts diagram).
`flow.mode = 'label'`, `flow.bgImage`, `flow.labels = [{ px, py, lx, ly, text, trans }]` —
the point (px,py) and the label anchor (lx,ly) are each a percentage of the image, so a
callout stays on its part at any size. Drag the ● dot onto the part and the text box into a
clear margin. The image is embedded in the SVG and rasterised with the labels for Word.

Drawn as SVG on screen; rasterised to PNG in the browser (SVG → canvas, 2×) for Word, the
same approach as image callouts — no server-side drawing. If rasterising fails, the DOCX
falls back to an indented numbered list of the steps so the procedure is never lost.
**Translation:** the shape text *and* the branch labels are sent as a flat array of strings
(never the nodes themselves, which would let the translator rewrite ids and directions),
then a translated copy of the chart is rendered for the translation side.

### Two regeneration paths (cost/speed)
| Change | Path | Cost |
|---|---|---|
| Scene (people, PPE, background, composition) | new gpt-image-1 call | counts against the daily limit (~5–20s) |
| Caption only (wording, size, colour, position) | Sharp overlay re-run on the **stored artwork** | free & instant (~0.1s), **not** counted |

Claude classifies each plain-language change request and the UI takes the cheaper path automatically.

### Setup
```bash
npm install                 # sharp + openai are already in package.json
cp .env.example .env        # then fill in the keys
npm run start:5050
```

Required env vars (see `.env.example` for the full list):

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude — builds and revises image prompts |
| `OPENAI_API_KEY` | **Required for artwork** — gpt-image-1 + prompt moderation |
| `IMAGE_STORE` | `local` (default) or `s3` |

Both keys also fall back to `tblConfig` (`anthropic_api_key` / `openai_api_key`).
Without `OPENAI_API_KEY` everything still loads and prompt-building works — generation
returns a clear "key not configured" message.

### Editing the style, locales and captions
Everything tunable lives in **`lib/imagegen-config.js`**:

- `HOUSE_STYLE` — prepended to every prompt (flat-cartoon, hi-vis PPE, Akara branding, white bg).
- `LOCALES` — add a locale by copying an entry: `{ code, label, peopleDescriptor, fonts, sampleCaption }`.
  The Thai entry sets Thai/Southeast Asian features + black hair (read from config, never hard-coded).
- `DEFAULT_CAPTION` — the bilingual default (Thai stacked above English, dark navy). Editable per page in the UI.
- `IMAGE` (model/size) and `DAILY_SCENE_LIMIT` (default **20/user/day**).
- `LOGO` — the corner mark (`position`, `widthPct`, `marginPct`) and the PPE marks:
  `onPpe`, `maxMarks`, and per-garment `hardHat` / `shirt` `{ widthScale, heightScale, opacity }`.

**Fonts:** by default the system Thai font (Leelawadee UI) and Arial are used. To bundle
open fonts instead, drop `NotoSansThai-Regular.ttf` / `NotoSansThai-Bold.ttf` (or `Sarabun-*`)
and `NotoSans-*` into **`assets/fonts/`** — bundled files take precedence automatically.

### Wiring a page in
Every page maps its own content into the shared shape; all other logic is shared:

```js
function csExtractPageContent(sec) {
  return { title, body, keyPoints };   // see app.js — worked example for document sections
}
```

### Handoff to image placement
This feature does **not** position images. On **Approve** it hands the finalised image to the
Content Studio's existing placement system — inserting an `[IMG:uid]` marker at the cursor and
registering the image with the section-image store, so the existing **⚙️ Layout** modal,
save/reload and Word export all work unchanged. Provenance
(`{ imageUrl, fileId, language, sourcePageId }`) is carried on the image object.

### Files
| File | Purpose |
|---|---|
| `lib/imagegen-config.js` | House style, locales, default caption, limits (**edit here**) |
| `lib/imagetext.js` | fontkit text→SVG paths, empty-area detection, Sharp caption + corner-logo overlay |
| `lib/imagebrand.js` | Real logo onto hard hats and shirts (grid-labelled vision + local colour check) |
| `lib/imagestore.js` | Storage adapter (local disk; S3 seam in `putS3()`) |
| `routes/imagegen.js` | `/config`, `/prompt`, `/revise`, `/generate`, `/recaption` + limits, moderation, logging |
| `public/js/app.js` | Shared UI: language picker, prompt review, approve/regenerate loop, attempt history |

Every generation is logged to `tblImageGen` (user, page, language, prompt, attempt,
scene-vs-caption, success/failure, timestamp).
