# TrainingPro — Automated Testing (WP-07)

Enterprise testing foundation for TrainingPro. Built on the **Node.js built-in
test runner** (`node:test`) and **native assertions** (`node:assert/strict`).
**No third-party test framework or coverage tool is used** (dependency-free by
approved design). Requires Node.js 22+ (the project runs on v22.17.0).

## Running the tests

```
npm test              # full safe suite (all groups)
npm run test:coverage # full suite with native coverage
npm run test:unit     # pure-function unit tests
npm run test:db       # database layer + migration tests
npm run test:api      # in-process API tests (auth, staff, reports, exams, forms, workflows)
npm run test:docgen   # PDF / PPTX / translation round-trips (offline)
npm run test:regression # broad GET-surface + data-hygiene smoke
npm run test:perf     # non-gating performance baseline recorder
```

Every script preloads the **network guard** (`--require ./tests/helpers/network-guard.js`),
which blocks any outbound HTTP/HTTPS/fetch to non-local hosts while allowing the
in-process harness to talk to `127.0.0.1`.

## Layout

```
tests/
  helpers/      shared harness: app.js, db.js, network-guard.js (this folder)
  unit/         pure-function / module unit tests + AI-boundary tests
  db/           database layer + migration/bootstrap tests
  api/          in-process API tests (ephemeral port, temp DB + temp sessions)
  docgen/       PDF / PPTX generation + DOCX/PPTX/XLSX translation round-trips
  regression/   GET-surface liveness + data-hygiene invariants
  performance/  non-gating baseline recorder → tests/.tmp/performance-baseline.json
  regression.js DEPRECATED shim (retired live-server suite; does nothing)
```

## Safety guarantees

- **No production database.** Tests set a unique `DATABASE_PATH` under
  `tests/.tmp/` before any db module loads (C2 seam). `database/traintrack.db`
  is never opened.
- **No production sessions.** Tests set a unique `SESSION_DB_DIR` under
  `tests/.tmp/` (C3 seam). `database/sessions.db` is never opened.
- **No live server.** The app is imported and started on an ephemeral port
  (`listen(0)`) in-process; nothing binds port 3000 (C3). The old
  `tests/regression.js` live suite is retired to a no-op shim.
- **No real AI.** The Anthropic client is stubbed via the require cache; no API
  key is required (C4/C10/C11).
- **No outbound network / SMTP.** The network guard blocks non-local traffic;
  SMTP is never configured in the temp DB, so no mail is sent.
- **Synthetic data only.** Every record is created by the test.

## Conventions

- Test files are named `*.test.js` so the runner discovers them automatically.
  (`tests/regression.js` is deliberately NOT a `*.test.js` file and is not run.)
- The isolated app harness is `startTestApp()` in `tests/helpers/app.js`; the
  temp-DB helper is `freshDb()/initReady()/cleanupAll()` in `tests/helpers/db.js`.

## Logging (WP-08)

The app logs through one enterprise logger — `lib/logger.js` — dependency-free,
JSON-lines to stdout/stderr. Run the logging test group with:

```
npm run test:logging
```

### How the logger works

`logger.debug/info/warn/error/fatal(event, fields)` builds a schema-valid
record, redacts it, attaches the request context, validates it, and emits it to
the sink (stdout/stderr in production). `fields.message` (or a string second
argument) becomes the record `message`; all other fields land in `metadata`.
Levels are gated by `LOG_LEVEL` (`silent|fatal|error|warn|info|debug`,
default `info`); `LOG_FORMAT=pretty` pretty-prints for local dev.

### Log schema (lib/log-schema.js, schemaVersion 1)

Every record contains: `schemaVersion, timestamp (ISO-8601 UTC), level
(DEBUG|INFO|WARN|ERROR|FATAL), event, message, module (17 approved modules),
tenantId (null|string), requestId (null|string), actor, environment, version,
build, host, pid, metadata (object)`. Validate any record with:

```js
const { validateLogRecord } = require('../../lib/log-schema');
const { valid, errors, record } = validateLogRecord(rec);
```

Recoverable fields (message/actor/metadata) are normalised; impossible states
(bad version/level/module/timestamp/requestId/tenantId) are rejected. The
validator never throws.

### Request correlation

Every HTTP request gets an `X-Request-Id` (client value reused, else generated)
and runs inside an `AsyncLocalStorage` context (`lib/request-context.js`)
holding `requestId, actor, tenantId, module, startTime`. The logger reads this
context automatically — never attach requestId/actor manually. After the
session middleware the authenticated USERNAME is bound as `actor`.

### Event families

- **Lifecycle (L3):** `HTTP_REQUEST_START` / `HTTP_REQUEST_COMPLETE` /
  `HTTP_REQUEST_ERROR` — method, path (no query values), status, durationMs.
  `/health`, `/favicon.ico` and successful static assets are skipped.
- **Errors (L4):** `APPLICATION_ERROR` (route-caught 5xx), `STARTUP_ERROR`,
  `VALIDATION_ERROR`, `AI_PROVIDER_ERROR`, `TRANSLATION_ERROR` (+ reserved:
  `DATABASE_ERROR`, `WORKFLOW_ERROR`, `MAIL_ERROR`, `SCHEDULER_ERROR`).
  One failure → one error record (dedup flag between hook and error handler).
- **Auth/Security (L5):** `AUTH_LOGIN_SUCCESS/FAILURE`, `AUTH_LOGOUT`,
  `AUTH_PASSWORD_CHANGE_SUCCESS/FAILURE`, `SECURITY_UNAUTHENTICATED_ACCESS`
  (401), `SECURITY_ACCESS_DENIED` (403) — derived from method+path+status.
- **Boundary helpers (L6):** `logger.aiEvent(event, fields)` (module `AI`,
  allow-list: provider/model/agent/operation/tokens/costUsd/status/
  decisionStatus/approvedBy/durationMs/errorName/errorMessage) and
  `logger.dbError(event, fields)` (module `Infrastructure`, allow-list:
  operation/table/entity/errorName/errorMessage/durationMs/retryable/status).
  Everything outside the allow-list is DISCARDED. Not yet wired into routes.

### Redaction — what must never be logged

The redactor removes deny-listed keys (`password, HashPass, cookie,
authorization, token, apiKey, anthropic_api_key, sid, prompt, completion,
aiInput, aiOutput, SS, DOB, medical, disciplinary, …` → `[REDACTED]`) and masks
value patterns (emails, `sk-…` keys, Bearer/JWT tokens, long digit runs), and
truncates long strings. Additionally, by construction the app NEVER logs:
request bodies, response bodies, query-string values, headers, session ids,
stack traces, SQL statements/parameters, AI prompts/outputs, or connection
strings. The L7 safety-sweep test (`tests/api/request-logging.test.js`) proves
this end-to-end.

### Using the logger in tests

Test apps default to `LOG_LEVEL=silent` (set by `startTestApp()`), so logs never
pollute TAP output. To capture logs deterministically:

```js
const app = await startTestApp();
app.appLogger.__setLevel('info');            // enable emission for this app
app.appLogger.__setSink((rec) => logs.push(rec)); // capture records
// … drive requests, assert on `logs` …
app.appLogger.__setLevel('silent'); app.appLogger.__resetSink();
```

`__setClock(fn)` pins timestamps for fully deterministic records.

### Logging vs tblAudit

WP-08 logging is OPERATIONAL telemetry (stdout, transient, observability). The
existing `tblAudit` (`lib/audit.js`) is the BUSINESS audit trail (who changed
which record) stored in the database. They are intentionally separate: WP-08
did not modify `tblAudit`, and business audit events are not duplicated into
the log stream.

## Monitoring (WP-09)

Health, readiness and metrics endpoints backed by `lib/monitoring.js` and
`routes/monitoring.js`. Run the monitoring test group with:

```
npm run test:monitoring
```

### Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | none | probe summary: `{status, uptimeSec, startedAt, timestamp}` — always 200 |
| `GET /health/live` | none | pure liveness: `{status, timestamp}` — 200 iff the process answers |
| `GET /health/ready` | none | readiness: 200 `ready` / 503 `not-ready` + per-check statuses |
| `GET /health/metrics` | **admin** | runtime metrics: uptime, pid, node, memory MB, cpu ms, event-loop delay ms, requestsServed |

**Liveness vs readiness:** liveness = the process responds (restart-level probe,
consults nothing). Readiness = the app can do useful work NOW — it gates on the
**database check** (`SELECT 1` via `dbGet`, 1s timeout, latency reported) and
the **storage check** (`fs.access` read+write on the uploads dir). Results are
TTL-cached (~5s) so probe storms cannot amplify load.

**Placeholders (non-gating):** `checks.aiProvider` and `checks.smtp` report
`configured` / `not-configured` from configuration **presence only** (env key
or `SELECT 1` on the config row — values are never read, no provider call, no
SMTP connection). They never affect the 200/503 verdict.

**Metrics access control:** `/health/metrics` requires an admin session
(401 unauthenticated / 403 non-admin, which also emits the L5
`SECURITY_ACCESS_DENIED` event). Probe endpoints are mounted BEFORE the session
middleware (no session cost); the metrics route is mounted after it.

### Lifecycle & transition events (module `Infrastructure`)

- `APP_STARTED` (INFO) — database initialised; `APP_READY` (INFO) — listening.
- `MONITOR_DEPENDENCY_DEGRADED` (WARN) / `MONITOR_DEPENDENCY_RESTORED` (INFO)
  — emitted ONCE per ok↔down state transition of a gating check.
- `MONITOR_READINESS_FAILED` (WARN) — emitted once when readiness transitions
  into not-ready. Repeated probes never re-emit (state-change semantics + TTL).

### Disclosure policy — what must never appear in monitoring output

Endpoint bodies contain only status words, numbers, ISO timestamps (and the
node version on the admin metrics endpoint). Never: database/storage paths,
hostnames, API keys, SMTP hostnames, connection strings, SQL, passwords,
session ids, cookies, Authorization/Bearer values, prompts/completions/AI
output, medical/disciplinary data, or PII. Note: log RECORDS carry a `host`
field because the approved WP-08 log schema mandates it — the hostname ban
applies to endpoint responses. The M6 sweep test enforces all of this with
planted sentinels.

### Rollback notes

Each M-commit is independently revertible (see the M1–M6 reports). Whole-WP:
unmount the two `/health` routers + counter tap + lifecycle emits + PORT env
line in `server.js`; delete `lib/monitoring.js`, `routes/monitoring.js`,
`tests/api/monitoring.test.js`; remove the `test:monitoring` script and this
section. All endpoints are additive — no data or contract changes to undo.

## AI Governance (WP-10)

**All AI usage in TrainingPro flows through one central boundary — the enterprise
AI Gateway (`lib/ai-gateway.js`).** No production code calls a provider SDK
directly; a repository-wide guard test enforces this permanently.

Run the AI governance test group with:

```
npm run test:ai
```

### Architecture

```
Business code (routes/* , lib/translate.js , lib/content.js)
        │  complete() / stream() / generateImage() / resetClient()
        ▼
AI Gateway            lib/ai-gateway.js        — orchestration, single public API
        │
        ▼
Policy                (in ai-gateway.js)        — placeholder; currently ALWAYS allows
        │
        ▼
Provider Registry     lib/ai/providers/registry.js — name → adapter (lazy)
        │
        ▼
Provider Adapter      lib/ai/providers/anthropic.js | openai.js — owns the SDK/HTTP call
        │
        ▼
SDK / HTTP            @anthropic-ai/sdk  |  fetch → api.openai.com
```

- **Gateway** — public API is exactly `complete()`, `stream()`, `generateImage()`,
  `resetClient()`. It validates the request, runs the policy stage, resolves a
  provider from the registry, returns the provider response/stream/error
  **unchanged**, and emits one metadata-only `AI_CALL` audit per invocation.
- **Policy** — `runPolicy(request)` invokes a policy function that currently
  returns `{allow:true}` (no enforcement). Future WPs gate approval, cost/token
  limits, output classification, tenant restrictions, and a model allow-list here.
- **Provider Registry** — `getProvider(name)` resolves adapters lazily; unknown
  names and reserved-but-unimplemented providers throw deterministic errors.
- **Provider Adapters** — own the SDK/HTTP call and nothing else.

### Provider ownership

- **Anthropic adapter** (`lib/ai/providers/anthropic.js`) owns: `complete()`,
  `stream()`, `resetClient()`. It wraps `lib/ai.js` (`getClient`) — the only place
  `getClient()` is consumed.
- **OpenAI adapter** (`lib/ai/providers/openai.js`) owns: `generateImage()` (the
  `api.openai.com` image fetch).
- **No production code may call a provider SDK/HTTP endpoint directly** — only
  the two adapters may, and only the gateway may call the adapters.

### Approved providers

| Provider | Status |
|---|---|
| `anthropic` | implemented |
| `openai` | implemented |
| `gemini`, `ollama`, `azure-openai`, `bedrock`, `vertex` | **reserved** (throw "not implemented") |

New providers are added **only** by implementing an adapter and registering it in
`lib/ai/providers/registry.js` — never by calling an SDK from business code.

### Approved agents (registry)

| Agent | Purpose |
|---|---|
| `AI-DOC-001` | Content Studio generation, translation-of-sections, SVG + OpenAI cover images |
| `AI-DOC-002` | Document translation (segments, OCR/vision) + translator glossary notes |
| `AI-DOC-003` | PowerPoint deck development (streaming) |
| `AI-DOC-004` | Knowledge Base article drafting |
| `AI-ADM-001` | Admin description drafting + document layout check |
| `AI-WKF-001` | HR disciplinary drafting + HR form-field generation |
| `AI-WKF-002` | Onboarding role-description generation |
| `AI-LRN-001` | Exam question extraction + answer generation |
| `AI-FRM-001` | Competency-assessment form population |

### Approved operations

`generate_content`, `translate_section`, `translate_segments`,
`ocr_translate_visual`, `extract_flowchart`, `generate_cover_svg`,
`generate_cover_image`, `develop_deck`, `draft_description`, `doc_check`,
`draft_disciplinary`, `ai_form_fields`, `role_description`, `question_extract`,
`generate_answers`, `form_fields`, `kb_article`, `glossary_notes`.

**Naming rule:** lowercase `snake_case`, verb-led, describing the task (not the
route). New operations are added alongside their agent when a new AI call site is
introduced — always through `aiGateway.complete/stream/generateImage`.

### AI_CALL metadata

Every AI invocation emits one `AI_CALL` event (module `AI`) via
`logger.aiEvent()`. Metadata fields:

| Field | Meaning |
|---|---|
| `provider` | `anthropic` \| `openai` |
| `agent` | approved agent ID (above) |
| `operation` | approved operation name (above) |
| `status` | `ok` \| `error` |
| `decisionStatus` | `draft` (placeholder — human approval is future work) |
| `inputTokens` / `outputTokens` / `totalTokens` | from the provider `usage` block (0 if absent; 0 on error) |
| `costUsd` | `null` placeholder (cost model is a future WP) |
| `durationMs` | wall-clock provider call time (finite, ≥ 0) |
| `errorName` / `errorMessage` | on failure only; message is redactor-masked |

Correlation (`requestId`, `actor`, `tenantId`) attaches automatically from the
request context. **Intentionally absent:** any request or response content
(see below).

### NEVER LOG (permanent policy)

The gateway passes **only** the allow-listed metadata above to the logger, and
`logger.aiEvent()`'s allow-list discards anything else by construction. The
following must never appear in any log record, in any form:

prompts · messages · system prompts · responses · raw provider output · image
prompts · document text · OCR text · translation text · any AI output · API keys
· Bearer tokens · JWTs · SQL statements/params · database values · cookies ·
session IDs · PII · medical data · disciplinary data.

This is proven adversarially by the A5 sentinel tests and re-checked in each
migration test.

### Migration map (all AI now on the gateway)

| Module | AI paths (operation / agent) |
|---|---|
| `lib/translate.js` | translate_segments, ocr_translate_visual / AI-DOC-002 |
| `lib/content.js` | generate_content, extract_flowchart, translate_section, generate_cover_svg / AI-DOC-001; generate_cover_image / AI-DOC-001 (OpenAI) |
| `routes/ai.js` | draft_description, doc_check / AI-ADM-001 |
| `routes/disciplinary.js` | draft_disciplinary, ai_form_fields / AI-WKF-001 |
| `routes/onboarding.js` | role_description / AI-WKF-002 |
| `routes/exams.js` | question_extract, generate_answers / AI-LRN-001; resetClient via gateway |
| `routes/forms.js` | form_fields / AI-FRM-001 |
| `routes/knowledgebase.js` | kb_article / AI-DOC-004 |
| `routes/translator.js` | glossary_notes / AI-DOC-002 |
| `routes/powerpoints.js` | develop_deck (streaming) / AI-DOC-003 |

### Boundary rules

```
ALLOWED:   business code → gateway → adapter → SDK/HTTP
FORBIDDEN: business code → SDK/HTTP  (bypasses audit, policy, redaction)
```

Enforced permanently by `tests/unit/ai-boundary-guard.test.js`, which scans all
production `.js` under `routes/` and `lib/` and fails loudly if any file (other
than the two adapters + `lib/ai.js`) calls `messages.create/stream`,
`api.openai.com`, or `getClient()`, or if a migrated module stops importing the
gateway.

### Testing strategy

- **Provider registry stubs** — `registry.__setProvider(name, impl)` /
  `registry.__reset()` route calls through the real gateway to a deterministic
  fake provider (no SDK, no key).
- **Network guard** — preloaded on every test script; blocks any non-local
  HTTP/HTTPS/fetch, so a real provider call fails the suite.
- **Logger sink** — capture `AI_CALL` records via `logger.__setSink()` (app tests
  use the returned `appLogger`; unit tests use the module directly). App logging
  defaults to `silent` in tests to avoid TAP pollution.
- **AI_CALL verification** — assert exactly one schema-valid audit per call with
  the right provider/agent/operation and token metadata.
- **Boundary guard** — the repo-wide static scan above.
- **Content sentinel tests** — adversarial prompts/keys/PII proven absent from logs.
- **Stream testing** — a fake async-iterable stream with `finalMessage()` proves
  the streaming passthrough + on-completion audit.
- **OpenAI fetch stubbing** — `global.fetch` is temporarily replaced to assert the
  adapter's exact request and to exercise every error path — no real OpenAI call.

### Policy / gateway test seams

`gateway.__setPolicy(fn)` / `__resetPolicy()` prove the policy stage executes and
that a denying decision blocks the call (the default never denies).

> **Note:** the WP-10 policy stage above was an always-allow placeholder. It has
> been superseded by the real **AI Policy Engine (WP-11)** documented next. The
> WP-10 `__setPolicy` seam is retained (pre-existing gate) and coexists with the
> WP-11 `policy.evaluate()` engine.

## AI Policy Engine (WP-11)

A configuration-driven governance engine (`lib/ai/policy.js`) that the gateway
consults on **every** AI call via `policy.evaluate(request, context)`. It returns
a decision plus report metadata; the gateway enforces the decision. Run its tests
with:

```
npm run test:policy   # ai-policy.test.js + ai-gateway.test.js under the guard
```

### Architecture

```
AI Gateway ──▶ policy.evaluate(request, requestContext.get())
                 │  resolves mode + profile + tenant/actor/classification context
                 │  runs every rule → ruleResults[]
                 ▼
             { allow, mode, profile, tenantId, actor, classification,
               ruleResults, policyVersion, estimatedTokens, estimatedCostUsd }
                 │
   allow === false (enforce mode only) ──▶ gateway throws PolicyDeniedError
                                            BEFORE the provider is resolved/called
```

`evaluate()` is **pure and read-only**: it never mutates the request or the
request context. `policyVersion` is currently `1`.

### Report mode vs enforce mode

- **report** (default) — `allow` is **always true**. Rules still evaluate and
  report what *would* fail (`… (report-only)`), the provider always executes,
  behaviour is identical to pre-policy. **This is the production default.**
- **enforce** — a rule returning `FAIL` makes `allow:false`; the gateway denies
  the call. Which rules can FAIL depends on the mode + per-rule flags below.

### `AI_POLICY_MODE`

`report` (default) | `enforce`. Any missing/blank/invalid value → `report`. An
explicit value always wins over the profile's mode (see override precedence).

### `AI_POLICY_PROFILE` — configuration profiles

A profile sets **defaults only**; explicit env vars always override profile
values. Missing/blank/unknown → `standard`.

| Profile | mode | enforcement flags | token ceiling | cost ceiling |
|---|---|---|---|---|
| **standard** (default) | report | all off | none | none |
| **development** | report | all off | none | none |
| **strict** | enforce | token+approval+tenant+classification+cost **on** | 20000 | $5.00 |

`standard` is byte-for-byte the pre-P5 production default. `development` is an
alias of that permissive baseline. `strict` turns on full enforcement.

### The rules

Each rule returns `{ rule, status: PASS|FAIL, message }`. Two groups:

**Allow-list rules — enforce whenever mode is `enforce`** (no per-rule flag):

| Rule | PASS when | FAIL (enforce) when |
|---|---|---|
| `provider_allowed` | provider is in the model registry | unknown provider |
| `agent_registered` | agent ∈ 9 approved agents | unknown agent |
| `operation_registered` | operation ∈ approved operations | unknown operation |
| `model_allowed` | model ∈ that provider's registry list | unknown model |

**Conditionally-enforcing rules — FAIL only in enforce mode AND with their flag
`= "true"`** (exact literal); otherwise report-only PASS:

| Rule | Env flag | Denies (enforce + flag) when |
|---|---|---|
| `token_estimate` | `AI_POLICY_ENFORCE_TOKEN_LIMIT` | `estimatedTokens > AI_POLICY_MAX_ESTIMATED_TOKENS` (valid positive int) |
| `approval` (placeholder) | `AI_POLICY_ENFORCE_APPROVAL` | `request.approvalStatus !== "approved"` |
| `tenant` (placeholder) | `AI_POLICY_ENFORCE_TENANT` | resolved `tenantId` is null/empty |
| `content_classification` (placeholder) | `AI_POLICY_ENFORCE_CLASSIFICATION` | resolved `classification` missing/empty/`"unclassified"` |
| `cost` (placeholder) | `AI_POLICY_ENFORCE_COST` | `estimatedCostUsd > AI_POLICY_MAX_COST_USD` (valid positive; **and** pricing exists) |

Always-PASS observational rules: `streaming`, `image_generation`, and
**`actor_context`** — reports the resolved `actor` and its source
(`request` | `context` | `default`); never denies in P7.

The approval / tenant / classification / cost rules are **placeholders**: fully
wired and testable, but off by default and denying only when explicitly enabled.
No production request populates `approvalStatus` yet.

### Tenant / actor / classification context resolution (P6)

`evaluate()` resolves governance context, priority order:

- **tenantId** — `request.tenantId` → request-context `tenantId` → `null`.
- **actor** — `request.actor` → request-context `actor` → `"anonymous"`.
- **classification** — `request.classification` → `"unclassified"`.

The gateway passes `requestContext.get()` into `evaluate()` automatically, so
routes never thread these fields and the request is never mutated. The resolved
values are returned by `evaluate()` and drive the tenant/classification rules.

### Pricing registry & cost estimation (P4)

`PRICING` is an internal **governance-placeholder** registry (`PRICING_PLACEHOLDER
= true`) — non-authoritative figures, replace before relying on cost gating:

| Provider / model | Placeholder price |
|---|---|
| `anthropic/claude-sonnet-4-6` | $3.00 / 1M input tokens |
| `anthropic/claude-haiku-4-5` | $1.00 / 1M input tokens |
| `openai/gpt-image-1` | $0.04 / image |

- **`estimatedTokens`** — ~4 chars/token over system + prompt + message text
  (input estimate; never rejects).
- **`estimatedCostUsd`** — text: `estimatedTokens × price`; image: `price × n`;
  unknown/unpriced model or unrecognized shape → `null`.

### `PolicyDeniedError`

When `allow:false`, the gateway throws — **before** resolving/calling the
provider — a safe error: `name = "PolicyDeniedError"`, `code =
"AI_POLICY_DENIED"`, `status = 403`, `userError = true`, and a fixed generic
`message` ("This AI request was blocked by policy.") containing no prompt,
message, document text, provider request, API key, tenant secret, or
classification body. The provider is never invoked on a deny.

### How `AI_CALL` receives policy metadata

The gateway attaches, on every `AI_CALL` (success **and** deny), the existing
allow-listed fields plus:

| Field | Source |
|---|---|
| `policyVersion` | `report.policyVersion` (currently `1`) |
| `policyMode` | `report.mode` (`report` \| `enforce`) — reflects the active profile too |
| `estimatedTokens` | `report.estimatedTokens` |
| `costUsd` | `report.estimatedCostUsd` when a positive estimate exists, else `null` |

**No new metadata keys were added in P6/P7**, and the logger allow-list was not
modified. The resolved tenant/actor/classification are **not** copied into
`AI_CALL.metadata`; correlation (`requestId`/`actor`/`tenantId`) still attaches at
the record top level via request-context as before. Nothing content-bearing is
ever logged (proven by the A5 sentinel suite + the P7 safety sweep).

### What remains report-only vs what can deny

- **Report-only always:** `streaming`, `image_generation`, `actor_context`; and
  in **report mode**, *every* rule (report mode never denies).
- **Can deny (enforce mode only):** the four allow-list rules always;
  `token_estimate` / `approval` / `tenant` / `content_classification` / `cost`
  only when their `AI_POLICY_ENFORCE_*` flag is `"true"` (cost additionally needs
  pricing + a valid ceiling).

### Safe production defaults

With no policy env set: profile `standard`, mode `report`, all enforcement flags
off, no ceilings → **nothing is ever denied**, the provider always runs, and
behaviour is identical to pre-WP-11. Enabling enforcement is fully opt-in and
fails **closed** (denies) only when the required request fields are absent.

### Environment variables

| Variable | Default | Effect |
|---|---|---|
| `AI_POLICY_PROFILE` | `standard` | `standard` \| `development` \| `strict`; invalid → standard |
| `AI_POLICY_MODE` | (profile) | `report` \| `enforce`; explicit value overrides the profile |
| `AI_POLICY_ENFORCE_TOKEN_LIMIT` | `false` | enable token-ceiling denial (enforce mode) |
| `AI_POLICY_MAX_ESTIMATED_TOKENS` | (profile/none) | positive int ceiling; invalid → no limit |
| `AI_POLICY_ENFORCE_APPROVAL` | `false` | enable approval-placeholder denial |
| `AI_POLICY_ENFORCE_TENANT` | `false` | enable tenant-placeholder denial |
| `AI_POLICY_ENFORCE_CLASSIFICATION` | `false` | enable classification-placeholder denial |
| `AI_POLICY_ENFORCE_COST` | `false` | enable cost denial (needs pricing + ceiling) |
| `AI_POLICY_MAX_COST_USD` | (profile/none) | positive USD ceiling; invalid → no ceiling |

Every enforcement flag enables **only** on the exact literal string `"true"`
(case-sensitive); anything else is off (fail-safe). Blank env vars fall through
to the profile default.

### Rollback notes

Each P-commit is independently revertible (see the P1–P7 reports). Whole-WP:
restore `lib/ai/policy.js` to a `{allow:true}` no-op and drop the
`policy.evaluate(...)` calls + deny path in `lib/ai-gateway.js`; remove the
`policyVersion`/`policyMode`/`estimatedTokens`/`costUsd` policy metadata lines and
the three `AI_ALLOWED_FIELDS` additions in `lib/logger.js`; delete the P-tests and
the `test:policy` script and this section. The engine is additive and, at its
defaults, behaviour-neutral — so a rollback changes nothing observable in
production.

## Policy Context Integration & Approval Readiness (WP-12)

WP-12 connects real application context into the WP-11 policy engine and adds an
**Operation Policy Registry** as the single source of per-operation governance
metadata. It is **behaviour-neutral by default**: no enforcement is enabled, no
route/prompt/provider/log-shape changes, and the production default stays
`report`/`standard`. Run its tests with:

```
npm run test:policy-context   # operation-policy + ai-policy + ai-gateway
```

### Operation Policy Registry (`lib/ai/operation-policy.js`)

One immutable (deep-frozen) entry per approved AI operation, read via
`getOperationPolicy(operation)`, which returns a **fresh copy** of the entry or a
safe default for unknown/invalid input — never throws, never mutates. Operation
metadata fields:

| Field | Meaning | Values |
|---|---|---|
| `classification` | governance classification label | general, training, document, translation, assessment, hr, image_generation |
| `approval` | placeholder approval posture | draft, not_required |
| `owner` | human-readable business owner | e.g. Training, HR, Documentation |
| `businessArea` | owning area | Training, Learning, HR, Safety, Documentation, General |
| `riskLevel` | risk band | low, medium, high, critical |
| `retention` | placeholder | `null` everywhere (future work) |
| `pii` | may involve personal data | boolean |
| `auditRequired` | business-audit expectation | boolean (default true) |
| `humanApproval` | future workflow gate | boolean (false today) |
| `costProfile` | cost bucket | standard, large, vision, image |
| `providerPreference` | default provider | anthropic, openai |

Safe default (unknown operation): `classification:"unclassified",
approval:"not_required", owner:"Unknown", businessArea:"General",
riskLevel:"low", retention:null, pii:false, auditRequired:true,
humanApproval:false, costProfile:"standard", providerPreference:"anthropic"`.

### Context resolution — request → context → registry → default

`policy.evaluate(request, context)` resolves governance context (read-only; never
mutates the request or the ambient context). The gateway passes
`requestContext.get()` in automatically, so **routes thread nothing**.

| Field | Priority | Default |
|---|---|---|
| **actor** | `request.actor` (non-blank) → request-context `actor` (non-blank) → `"anonymous"` | anonymous |
| **actorSource** | which source won: `request` \| `context` \| `default` | default |
| **tenantId** | `request.tenantId` (non-blank) → request-context `tenantId` (non-blank) → `null` | null |
| **classification** | `request.classification` (non-blank) → `getOperationPolicy(operation).classification` → `"unclassified"` | operation-derived, else unclassified |
| **approvalStatus** | `request.approvalStatus` (non-blank) → `getOperationPolicy(operation).approval` → `"not_required"` | operation-derived, else not_required |

`evaluate()` returns all five (`actor`, `actorSource`, `tenantId`,
`classification`, `approvalStatus`) alongside the WP-11 fields. "Non-blank" means
a string with non-whitespace content (whitespace-only is treated as absent).

### Default behaviour

- **Default tenant** — `null` (single-tenant today). Tenant enforcement stays off
  by default; a `null` tenant only fails when `AI_POLICY_ENFORCE_TENANT=true`.
- **Default classification** — the operation's registry label (e.g.
  `generate_content → training`), or `"unclassified"` for unknown/absent
  operations. Enforcement off by default.
- **Default approval** — the operation's registry posture (`draft` or
  `not_required`), or `"not_required"` for unknown operations. Enforcement off.

### Why `not_required` is not treated as approved (yet)

The approval rule PASSes **only** when the resolved `approvalStatus` is exactly
`"approved"`. `draft` and `not_required` are **placeholders** and do NOT satisfy
the rule — so, under enforcement, they fail closed. Auto-passing `not_required`
belongs to a **future approval-workflow WP** that will populate real approval
state; wiring it now would be an enforcement change, which WP-12 explicitly avoids.

### Context safety rules

- Only **identifiers / enums / labels** enter policy context — never prompt,
  message, system, document, OCR, translation, medical, disciplinary, SQL, key,
  or PII **content**.
- `classification`, `approvalStatus`, `tenantId`, `actor`, and `actorSource` are
  **NOT** in the `AI_CALL` allow-list, so they cannot be logged.
- **AI_CALL metadata is unchanged** by WP-12: the metadata key-set is exactly the
  WP-11 set (provider, model, agent, operation, tokens, costUsd, status,
  decisionStatus, durationMs, policyVersion, policyMode, estimatedTokens, and
  errorName/errorMessage on failure). No new fields.
- Correlation (`requestId`, `actor`, `tenantId`) still attaches at the record
  **top level** via request-context — unchanged. `AI_CALL` carries **no prompt or
  content**. The C5 sweep plants sentinels in every context + content field and
  proves none appear in any record, deny error, or returned context, across all
  gateway paths.

### Constraints honoured

- **No route changes** — context is derived centrally from `request.operation` +
  the ambient context; no call site or route was modified.
- **No database schema changes** — `retention` and all governance fields are
  in-code placeholders; nothing is persisted.

### Future readiness

- **Approval workflow** — `approvalStatus` + `humanApproval` + per-operation
  `approval` posture are in place; a future WP populates real approval state and
  may treat `not_required`/approved as passing.
- **Tenant governance** — `tenantId` resolution (request → context → default) and
  the tenant rule are in place; a future WP adds real multi-tenant defaults and
  per-tenant policy without touching call sites.

### Rollback notes

Each C-commit is independently revertible (see the C1–C6 reports). Whole-WP:
delete `lib/ai/operation-policy.js` + its test; revert `resolveContext` in
`lib/ai/policy.js` to the WP-11 form (drop registry-derived classification/
approval, `actorSource`, and the trim hardening); remove the `test:policy` /
`test:policy-context` context tests and this section. All additions are read-only
and default-inert, so a rollback changes nothing observable in production.

## Security Hardening Foundation (WP-13)

A configuration-driven security foundation. **Every control is OFF by default** —
with no `SECURITY_*`/related env set, production behaviour is byte-for-byte
unchanged. Run the security suite with:

```
npm run test:security   # all WP-13 S1–S8 tests under the network guard
```

### Security configuration module (`lib/security/config.js`)

One immutable, deeply-frozen object resolved from the environment at load time,
grouped by concern (`session`, `cookies`, `rateLimit`, `errors`, `headers`,
`proxy`, `uploads`, `password`, `admin`). Internal helpers (not exported):
`boolEnv` (only the exact literal `"true"` enables), `stringEnv` (blank/whitespace
→ fallback), `intEnv` (positive integer, else fallback).

- **Session secret** — `session.SESSION_SECRET` = `SESSION_SECRET` env, else the
  existing `traintrack-secret-key-2024` (so sessions stay valid by default).
- **Cookie secure flag** — `cookies.SECURE_COOKIES` (default false ⇒ `cookie.secure=false`, identical to the previous omitted value).
- **Trust proxy** — `proxy.TRUST_PROXY` (default false ⇒ `app.set('trust proxy')` is never called).

### Login rate limiting (`lib/security/rate-limit.js`, S3)

Dependency-free, in-memory throttle on `POST /api/auth/login`, mounted before the
auth router in `server.js`.

- **Report-only default** — never blocks; after the threshold it emits one
  `SECURITY_LOGIN_THROTTLED` event and calls `next()`. Login success/failure
  behaviour is unchanged.
- **Enforce mode** (`RATE_LIMIT_ENFORCE=true`) — returns `429 {"error":"Too many
  login attempts. Please try again later."}` after the threshold, **before** the
  handler runs. Fails **open** on any internal error (no accidental lockout).
- Per-key state is a SHA-256 hash of IP+username (raw IP/username never stored or
  logged). Tunables: `RATE_LIMIT_LOGIN_MAX_ATTEMPTS` (10), `…_WINDOW_MS` /
  `…_BLOCK_MS` (15 min).

### Password policy advisory (`lib/security/password-policy.js`, S4)

`evaluatePassword(pw) → { valid, score, issues }`. Advisory ONLY — **not** wired
to reject logins or password changes. Rules: min length 12, lower/upper/number/
symbol, and a common-password blocklist. Issue strings never echo the password.

### Default-admin warning (S4, `server.js`)

At startup (after the admin seed) `detectDefaultAdmin()` checks whether `admin`
still uses the default credential and, if so, emits one report-only
`SECURITY_DEFAULT_CREDENTIAL` warning (gated by `ENABLE_DEFAULT_ADMIN_WARNING`,
default true). Never logs the password/hash, never disables the account, never
blocks startup (fails open).

### Security headers + CORS (`lib/security/headers.js`, S5)

Mounted early (applies to static + routes). All opt-in:

- **Security headers** (`ENABLE_SECURITY_HEADERS=true`) — `X-Content-Type-Options:
  nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`,
  `X-Permitted-Cross-Domain-Policies: none`.
- **CSP — report-only only** (`ENABLE_CSP=true` + `CSP_REPORT_ONLY=true`) →
  `Content-Security-Policy-Report-Only`. The enforcing header is **never** emitted
  in WP-13.
- **HSTS opt-in** (`ENABLE_HSTS=true`) → `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
- **Same-origin CORS** — echoes `Access-Control-Allow-Origin` **only** when the
  request's `Origin` exactly matches the server origin; never a wildcard, never
  cross-origin credentials; a same-origin `OPTIONS` returns `204`. Requests
  without an `Origin` header (the default) receive no CORS headers.

### Input validation helpers (`lib/security/validate.js`, S6)

Adoption-ready, **unwired** pure helpers: `isNonEmptyString`, `isSafeId`,
`isPositiveInteger`, `isFiniteNumber`, `isAllowedEnum`, `sanitizeFilename`,
`safeString`, `validateEmail`, `validateDate`. Never throw, never mutate, reject
path traversal + null bytes, handle non-string input safely.

### Upload hardening helpers (`lib/security/upload.js`, S6)

Adoption-ready, **unwired**: `normalizeUploadFilename` (traversal-proof basename +
fallback), `isAllowedUploadExtension` (case-insensitive), `isAllowedMimeType`
(exact lowercase), `createUploadFilter` (multer-compatible, rejects safely),
`buildUploadLimits`, `getUploadPolicy(kind)`. Frozen per-kind policies:
`document`, `image`, `spreadsheet`, `presentation`, `archive` — each with
`allowedExtensions`, `allowedMimeTypes`, and a positive `maxFileSizeBytes`.

### Security event helpers (`lib/security/events.js`, S7)

`securityEvent(event, metadata)` plus `loginThrottled` / `defaultCredential` /
`uploadRejected` / `rateLimit`. Emit via the existing logger under the
schema-valid `Authentication` module, preserving request correlation, never
throwing.

- **Metadata allow-list** — only `{path, method, status, mode, attempts, limit,
  windowMs, blockMs, enforced, username, action, severity, recommendation, kind,
  reason, filename, mimeType, sizeBytes}` are kept; everything else (password,
  hash, cookie, authorization, JWT, body, SQL, DB path, prompt, PII) is discarded
  **before** the logger is called (defence-in-depth over redaction).
- Event names: `SECURITY_LOGIN_THROTTLED`, `SECURITY_DEFAULT_CREDENTIAL`,
  `SECURITY_UPLOAD_REJECTED`, `SECURITY_RATE_LIMIT`.

### Generic error responses opt-in (S7, `server.js`)

`GENERIC_ERROR_RESPONSES=true` makes the **global** Express error handler return
`{"error":"Internal server error"}` for 5xx (structured error metadata is still
logged). Default (false) preserves the exact current body. 4xx responses come
from route handlers and are never affected. No `routes/*` handler was modified.

### Environment variable matrix

| Variable | Default | Effect |
|---|---|---|
| `SESSION_SECRET` | `traintrack-secret-key-2024` | session signing secret |
| `SECURE_COOKIES` | false | `Secure` flag on the session cookie |
| `TRUST_PROXY` | false | `app.set('trust proxy', 1)` |
| `RATE_LIMIT_ENFORCE` | false | enforce login 429 (else report-only) |
| `RATE_LIMIT_LOGIN_MAX_ATTEMPTS` / `_WINDOW_MS` / `_BLOCK_MS` | 10 / 900000 / 900000 | throttle tunables |
| `ENABLE_SECURITY_HEADERS` | false | nosniff / frame / referrer / cross-domain |
| `ENABLE_CSP` + `CSP_REPORT_ONLY` | false + true | report-only CSP |
| `ENABLE_HSTS` | false | HSTS header |
| `ENABLE_DEFAULT_ADMIN_WARNING` | true | default-credential advisory log |
| `ENABLE_PASSWORD_POLICY` / `ENABLE_UPLOAD_VALIDATION` | false | reserved (S6 helpers unwired) |
| `GENERIC_ERROR_RESPONSES` | false | generic global 5xx body |

Every boolean enables only on the exact literal `"true"`.

### Production deployment recommendations

Behind TLS/a reverse proxy, enable: `TRUST_PROXY=true`, `SECURE_COOKIES=true`,
`ENABLE_SECURITY_HEADERS=true`, `ENABLE_HSTS=true`, and set a strong unique
`SESSION_SECRET`. Roll out `ENABLE_CSP=true` (report-only) first and review
reports before any future enforcing CSP. Consider `RATE_LIMIT_ENFORCE=true` and
`GENERIC_ERROR_RESPONSES=true` once monitored. **Change the default admin
password** (the startup advisory flags it). Enable one control at a time and
verify.

### Rollback notes

Each S-commit is independently revertible (see the S1–S8 reports). Whole-WP:
remove the security requires + middleware mounts + `detectDefaultAdmin` +
generic-error branch from `server.js`; delete `lib/security/*`, the security
tests, the `test:security` script, and this section. Every control is additive
and default-inert, so a rollback changes nothing observable in production.

## Authentication & Authorization Foundation (WP-14)

An enterprise RBAC foundation. **Everything is report-only** — no route enforces
permissions, no request is ever denied by it, and the only runtime effect is
additive session fields plus an advisory audit event. Run the RBAC suite with:

```
npm run test:authz   # all WP-14 A1–A8 tests under the network guard
```

### Permission registry (`lib/auth/permissions.js`, A1)

Immutable, deep-frozen registry keyed by `module.action` id; each entry is
`{ id, description, module, risk }` (`risk ∈ low|medium|high|critical`). 25
permissions across `users`, `training`, `documents`, `ai`, `competency`,
`assessments`, `reports`, `settings`, `hr`, `safety`, and `admin.full`.

### Role registry + inheritance (`lib/auth/roles.js`, A1)

8 frozen built-in roles — `VIEWER, OPERATOR, TRAINER, SUPERVISOR,
TRAINING_MANAGER, HR, SAFETY, ADMIN` — each `{ name, description, inherits[],
permissions[] }`. Inheritance chains transitively (e.g. `ADMIN → {TRAINING_MANAGER,
HR, SAFETY}` → … → `VIEWER`), so `ADMIN` effectively holds all 25 permissions.
`lib/auth/access-control.js` provides the pure helpers: `hasPermission`,
`hasAnyPermission`, `hasAllPermissions`, `expandInheritedRoles` (cycle-safe),
`getEffectivePermissions`, `isKnownRole`, `isKnownPermission` — never throw,
unknown → false/[], fresh copies.

### User permission resolution (`lib/auth/user-permissions.js`, A2)

Turns a user object into canonical roles + effective permissions. Reads
`roleNames` → `roles` → `roleName` → `role` (first source with a known role wins;
string/array/null/undefined all safe), case-insensitively, de-duplicated, sorted.
`resolveUserPermissions` unions inherited permissions. Pure, never mutates, never
throws.

### Session permission enrichment (A3, `routes/auth.js`)

On successful login, `deriveSessionPermissions(user)` adds **additive** `roles`
and `permissions` arrays to `req.session.user` (admins always include `ADMIN`;
users with no role info get `[]`). Existing fields (`admin`, `pageAccess`,
`username`, …) are unchanged; the DB row is never mutated. `/api/auth/me` exposes
the two new arrays additively.

### Request-context role/permission binding (A3, `server.js`)

The post-session middleware that binds `actor` also sets `roles`/`permissions`
into request-context for future middleware. These context keys are **not read by
the logger** (no new log fields) and no route consumes them.

### Report-only authorization middleware (`lib/auth/authorize.js`, A4/A6/A7)

`evaluateAuthorization(user, requiredPermissions)` → `{ authorized,
requiredPermissions, evaluatedPermissions, missingPermissions }` (pure; no
required → authorized; unknown permission → missing; unknown user → not
authorized). `authorize(perms, options)` is a route-level factory (report-only,
**mounted on no route yet**). `initAuthorizationContext` is mounted globally in
`server.js` **after** session — it computes a per-request report and stores it in
request-context. It **always calls `next()`; never 401/403; never mutates
req/session/body/registry; never throws**.

### Route permission registry + matching (`lib/auth/route-permissions.js`, A5)

Immutable `(method, pathPattern) → permissions` rules, all `mode:"report"`.
`getRoutePermissions(method, path)` / `matchRoutePermission` / `listRoutePermissionRules`
are pure and never throw. Matching precedence: **exact path > parameter (`:id`) >
wildcard (`*`)**, then **method-specific > `*`**; method is case-insensitive; the
path is normalized (query stripped, no regex from input → no injection). Unknown
route → `{ permissions:[], mode:"report", matched:false }`. Results are fresh
copies — the frozen registry can't be mutated through them.

### Authorization report shape (A6)

`initAuthorizationContext` stores, under the request-context `authorization` key:

```
{ authorized, requiredPermissions, evaluatedPermissions, missingPermissions,
  matchedRoutePermission, routePermissionMode, routePermissionRule }
```

Unknown route → `matchedRoutePermission:false`, `requiredPermissions:[]`,
`authorized:true`, `routePermissionMode:"report"`, `routePermissionRule:null`.

### AUTHORIZATION_REPORT audit event (A7)

When (and only when) a route matches a registry rule, the middleware emits **one**
`AUTHORIZATION_REPORT` event (module `Authentication`, level `info`) via the
existing logger. Unmatched routes emit nothing; a logger failure is swallowed and
the request continues.

**Count-only metadata** — exactly:
`method, path, matchedRoute, authorized, requiredPermissionCount,
evaluatedPermissionCount, missingPermissionCount, mode, roleCount`. **Never**
permission names, role names, usernames/actor, tenant, classification,
approvalStatus, the route-rule object, session id, cookies, JWT, Authorization
header, request body, SQL, prompts, or AI content. The authenticated actor is
deliberately excluded (the event's `actor` is `anonymous`); requestId correlation
is preserved.

### No enforcement yet · behaviour preservation

Nothing in WP-14 denies a request or changes a response, status code, route, or
database schema. The only runtime effects are: (a) additive `roles`/`permissions`
on the session user, and (b) the report-only authorization context + advisory
audit event. Existing admin-only routes are still gated by the **pre-existing
admin flag** (`requireAdmin`), not by this RBAC layer. No route imports
`authorize()` or the route-permission registry (`routes/auth.js` imports only the
A2 resolver, for the additive session fields).

### Rollback notes

Each A-commit is independently revertible (see the A1–A8 reports). Whole-WP:
remove the `initAuthorizationContext` mount + the A3 session/context additions
from `server.js` and `routes/auth.js`; delete `lib/auth/*`, the RBAC tests, the
`test:authz` script, and this section. Every addition is additive and report-only,
so a rollback changes nothing observable in production.

### Future enforcement roadmap

A later WP can flip `authorize(perms)` from report-only to enforcing (return
`403` on `authorized:false`), mount it per route family from the A5 registry,
promote `mode` from `report` to `enforce` per rule, and (optionally) add a
persisted user↔role mapping (today roles derive from the admin flag, since
`tblPswd` has no role column). The advisory `AUTHORIZATION_REPORT` data can be
used to validate a rollout before enforcement is switched on.

## Enterprise Data Governance & Audit Foundation (WP-15)

A report-only governance foundation under `lib/governance/`. **Everything is
immutable, pure, and unwired** — no route consumes it, no schema changed, nothing
is enforced or deleted. Run the governance suite with:

```
npm run test:governance   # all WP-15 D1–D6 tests under the network guard
```

### Three audit channels (kept separate)

| Channel | Store | Purpose |
|---|---|---|
| **Operational logging** | `lib/logger.js` → JSON-lines | Diagnostics, troubleshooting, application health (redacted, allow-listed) |
| **Business audit** | `lib/audit.js` → `tblAudit` | Who changed which business record; append-only history |
| **Compliance audit** *(future)* | reserved — no store, no code | Regulatory evidence, approvals, investigations, legal discovery, chain of custody |

WP-15 preserves this separation and aligns the channels via a shared taxonomy —
it never merges them.

### `lib/audit.js` vs `lib/governance/audit.js`

- **`lib/audit.js`** (legacy) — `logAudit(user, table, action, recordId, field,
  oldVal, newVal)` writes `tblAudit` **verbatim**, fire-and-forget. Adopted by
  ~19 routes today. **Unchanged by WP-15.**
- **`lib/governance/audit.js`** (D2, new, **unwired**) — `recordAuditEvent`,
  `buildAuditRecord`, `sanitizeAuditMetadata`: validates entity+action against
  the registries, masks secrets, caps length, drops objects/arrays and forbidden
  metadata, resolves the actor safely (input → request-context → `system`; never
  a session id/cookie/token), maps to the existing `tblAudit` schema, and **fails
  open**. Nothing in production calls it yet.

> **Current-state finding (documented, NOT fixed in WP-15):** `lib/audit.js`
> still persists `OldValue`/`NewValue` without governance sanitization, so a
> caller passing sensitive free-text there would store it. This is pre-existing,
> outside WP-15 scope, unchanged, and recommended for a future PO-approved
> migration to `lib/governance/audit.js`.

### Governance registries (D1)

Immutable, deep-frozen, copy-on-read, never-throwing, fail-safe on unknown input:

- **classifications** (`classifications.js`) — 12 extensible labels: `PUBLIC,
  INTERNAL, CONFIDENTIAL, HIGHLY_CONFIDENTIAL, SAFETY_CRITICAL, HR_CONFIDENTIAL,
  MEDICAL, FINANCIAL, LEGAL, AI_GENERATED, AI_VERIFIED, EXPORT_CONTROLLED`
  (each `{id, description, sensitivityRank, extensible}`; unknown → PUBLIC).
- **retention** (`retention.js`) — `transient, standard, extended, legal_hold,
  permanent`; each reserves `{defaultYears:null, legalHoldSupported,
  archiveRequired, autoDeleteEligible, approvalRequired, exportReviewRequired}`.
  Durations are **null**; unknown → `standard` (not auto-delete-eligible).
- **sensitive-data** (`sensitive-data.js`) — `credentials, pii, medical,
  disciplinary_freetext, financial, ai_content`; each `{id, description,
  redaction ∈ drop|mask|hash_reference}`; unknown → fail-safe `drop`.
- **entities** (`entities.js`) — governed entities (`users, documents, training,
  competencies, assessments, risk_assessments, corrective_actions, ai_outputs,
  attachments, photos, approvals, audit, disciplinary, medical`), each reserving
  classification + retention + sensitiveCategories + ownership + AI-provenance +
  evidenceEdges placeholders.
- **actions** (`actions.js`) — business actions (`create … certify, complete`),
  each `{id, description, category}`.

### Audit event taxonomy (D3)

`audit-taxonomy.js` — 18 approved `entity.action` events, each `{id, entity,
action, description, category, risk, classification, retention,
complianceRelevant, lifecycleEvent, evidenceEvent}`. Every entity/action/
classification/retention is a known registry id; unknown → safe default.

### Entity governance resolver (D4)

`entity-governance.js` — `getEntityGovernance(entity, scope?)`,
`getEventGovernance(eventId, scope?)`, `listGovernedEntities()`,
`resolveGovernanceScope(scope)`. Integrates the D1 registries + D3 taxonomy into
unified governance metadata. Unknown → safe default; fresh copies; never throws.

### Reserved enterprise metadata (placeholders only)

- **Classification model** — the 12-label extensible set above.
- **Retention framework** — the reserved flags above; **no durations, no purge,
  no deletion, no enforcement**.
- **Ownership placeholders** — `businessOwner, technicalOwner,
  responsibleDepartment, approvalAuthority` (all `null`).
- **AI provenance placeholders** — `aiGenerated, aiModel, promptVersion,
  policyVersion, confidence, humanVerified, verifiedBy, verificationDate` (null/
  false; **no prompt/completion text is ever stored**).
- **Document lifecycle planning** — future states `Draft → Review → Approved →
  Published → Superseded → Archived → Deleted` (reserved; not built).
- **Evidence-chain planning** — reserved `evidenceEdges` linking Audit → Documents
  → Training → Competencies → Assessments → Risk Assessments → Corrective Actions
  → AI Outputs → Attachments → Photos → Approvals (empty placeholders today).
- **Multi-tenant governance scope** — resolution precedence **Global → Company →
  Site → Department → Project**; in WP-15 only **Global** is populated
  (`resolveGovernanceScope` normalizes but applies no override; `source:"global"`).
- **Immutability / hash-chain roadmap** — reserved (documented) tamper-evidence
  shape `{recordHash, previousHash, hashChain, verification, integrityCheck,
  exportChecksum}`; **no DB columns, triggers, hashing, or blockchain** in WP-15.

### Compliance framework readiness (documentation only)

The model *could* later align with **ISO 9001**, **ISO 14001**, **ISO 45001**,
**ISO 27001**, **SOC 2**, the **Australian Privacy Act**, and **GDPR** — via
classification, retention + legal-hold, the evidence chain, document lifecycle +
approvals, immutability/hash chain, and redaction-safe export. No compliance
functionality is implemented in WP-15.

### Sensitive-data safety rules

Business-audit metadata and operational logs must never contain: passwords,
hashes, session ids, cookies, Authorization/Bearer/JWT, request/response bodies,
SQL, database paths, AI prompts/completions/raw output, medical text,
disciplinary free-text, PII, or financial account numbers. The **D2 helper**
allow-lists safe scalars, masks secret patterns, caps length, and never writes
metadata to `tblAudit`. The **operational logger** stays separate (redaction +
allow-lists). The **D5 adversarial sweep** plants a sentinel per category and
proves none leak through the governance helper or the logger; correlation carries
only `requestId`/`actor`.

### Boundaries (WP-15)

No route adoption yet · no schema changes · no retention enforcement · no
deletion · no compliance-audit store yet. `lib/audit.js` and all routes are
untouched; nothing in production imports `lib/governance/*`.

### Rollback notes

Each D-commit is independently revertible (see the D1–D6 reports). Whole-WP:
delete `lib/governance/*`, the WP-15 tests, the `test:governance` script, and this
section; revert the D3/D4 D1-registry additions (`complete` action;
`disciplinary`/`medical` entities). Every addition is additive and report-only,
so a rollback changes nothing observable in production.

### Future migration roadmap (each separately PO-approved)

1. **Legacy audit migration** — adopt `lib/governance/audit.js` in routes;
   remediate the `lib/audit.js` free-text exposure.
2. **Retention activation** — durations + legal-hold + archive + guarded,
   reversible purge with approval/export-review gates.
3. **Compliance audit store** — tamper-evident store, hash chain, integrity
   verification, export checksums, chain of custody.
4. **Evidence-chain persistence** — link audits↔documents↔competencies↔
   assessments↔corrective-actions↔AI outputs↔attachments↔approvals.
5. **Document lifecycle enforcement** — state machine + per-transition audit +
   approval workflow.
6. **Multi-tenant overrides** — populate Company/Site/Department/Project layers
   atop the WP-12 tenant context.
7. **Compliance reporting/export** — read-only, redaction-safe export aligned to
   ISO/SOC-2/Privacy-Act/GDPR evidence needs.

## Status

Wave 1 · WP-07 commits C1–C13 complete: harness bootstrap, DB path seam,
importable app, unit/translation/lib/db/api/docgen tests, AI + network guard,
performance baseline, and the migrated regression smoke.

Wave 1 · WP-08 commits L1–L7 complete: enterprise logger, request correlation
(AsyncLocalStorage), log schema + validation, request/response lifecycle
logging, structured error consolidation, auth/security events, AI/DB boundary
placeholders, and this documentation.

Wave 1 · WP-09 commits M1–M6 complete: health/liveness/readiness/metrics
endpoints, dependency checks + placeholders, lifecycle & transition events,
monitoring safety sweep, and this documentation.

Wave 1 · WP-10 commits A1–A7 complete: enterprise AI Gateway, provider registry
+ adapters, metadata-only `AI_CALL` audit, adversarial redaction, full migration
of every AI call site onto the gateway, the repo-wide boundary guard, and this
documentation.

Wave 1 · WP-11 commits P1–P7 complete: the Enterprise AI Policy Engine —
report/enforce modes, configuration profiles (standard/development/strict),
provider/agent/operation/model allow-list rules, token/cost/approval/tenant/
classification rules, a placeholder pricing registry with `estimatedCostUsd`,
tenant/actor/classification context resolution, the safe `PolicyDeniedError`
deny path, the `test:policy` script, the P7 safety sweep, and this documentation.
Production default (profile `standard`, mode `report`) is behaviour-neutral.

Wave 1 · WP-12 commits C1–C6 complete: the Operation Policy Registry (governance
metadata per AI operation) wired into the policy engine for central
classification/approval resolution, actor-context hardening, the `test:policy-context`
tooling, and safety sweeps — all default-inert.

Wave 1 · WP-13 commits S1–S8 complete: the Security Hardening Foundation —
security config module, session/cookie hardening, login rate limiting
(report-only default), password-policy advisory + default-admin detection,
opt-in security headers + report-only CSP + same-origin CORS, input-validation
and upload-hardening toolkits, the security-events allow-list layer, opt-in
generic error responses, the `test:security` script, the S8 safety sweep, and
this documentation. Every control is OFF by default — production behaviour is
unchanged.

Wave 1 · WP-14 commits A1–A8 complete: the Authentication & Authorization
Foundation — permission + role registries with inheritance, pure access-control
and user-permission resolution, additive session role/permission enrichment,
request-context binding, a report-only authorization middleware, the route
permission registry + matching, the per-request authorization report, the
count-only `AUTHORIZATION_REPORT` advisory audit event, the `test:authz` script,
the A8 RBAC safety sweep, and this documentation. No route enforces permissions —
everything is report-only and behaviour-neutral.

Wave 1 · WP-15 commits D1–D6 complete: the Enterprise Data Governance & Audit
Foundation — immutable registries (classifications/retention/sensitive-data/
entities/actions), a safe unwired business-audit helper, the audit event
taxonomy, the entity/event governance resolver (with global-only multi-tenant
scope + reserved ownership/AI-provenance/evidence-chain placeholders), the
adversarial sensitive-data safety sweep, the `test:governance` script, and this
documentation. Nothing is wired, enforced, or deleted; `lib/audit.js` and all
routes are unchanged; production behaviour is unchanged.

Wave 1 · WP-12 commits C1–C6 complete: the Operation Policy Registry
(`lib/ai/operation-policy.js`), actor-context verification/hardening
(`actorSource`), registry-derived classification and approvalStatus resolution,
the policy-context safety sweep, the `test:policy-context` script, and this
documentation. Context is derived centrally from `request.operation` + the
ambient request context — no route, schema, prompt, provider, or AI_CALL change.
Production default remains behaviour-neutral (report/standard, no enforcement).
