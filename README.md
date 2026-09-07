# MigrationCompass

A Spring Boot + Spring AI portfolio project demonstrating modern AI
capabilities — RAG, tool calling, multi-agent orchestration, and
structured output — applied to legacy system migration analysis.

**Generic by design:** analyze any uploaded codebase, not just the bundled
example. A fictional legacy system, "OrderVault," ships with the project
as a zero-setup example (`POST /api/rag/upload/load-example`), but the
pipeline works the same way against a real project uploaded as a zip
(`POST /api/rag/upload/source`) — the AI discovers what services/components
exist rather than being told upfront.

Built incrementally, module by module, so each AI capability can be understood
and demoed independently before being composed together.

## Current status

- [x] `common` — shared DTOs used across modules
- [x] `persistence-module` — shared JPA entities/repositories (`Project`,
      `AnalysisRun`) backed by PostgreSQL, used by rag/agent/report modules
- [x] `chat-module` — conversational assistant with per-conversation memory
      and streaming (SSE) responses, backed by DeepSeek
- [x] `tools-module` — AI-callable functions (`checkApiHealth`,
      `getTrafficStats`) backed by monitoring REST endpoints; operational
      data is optional/uploadable, defaults to the bundled OrderVault example
- [x] `rag-module` — document Q&A over an uploaded codebase's source code,
      specs, and database schema (Ollama local embeddings + persistent
      PostgreSQL/pgvector storage); supports the bundled OrderVault example
      or any number of uploaded projects, all queryable — pick any one by
      `projectId`, not just whichever was uploaded most recently. Detects
      byte-for-byte duplicate re-uploads (override-able); projects can be
      deleted (embeddings + grounding removed, run history kept)
- [x] `agent-module` — multi-agent migration planning: Discovery Agent
      (queries rag-module, discovers services/components rather than being
      told them) -> Architecture Agent -> Risk Agent (queries tools-module)
      -> Comparison against uploaded/loaded grounding docs (optional).
      Runs synchronously or asynchronously (start/poll/result) with
      historical-average-based progress estimates, and persists every run.
      Every run targets a specific project (`projectId`, optional —
      defaults to most recent), correctly isolated end-to-end including
      the RAG queries and grounding lookups made *during* the run
- [x] `structured-output-module` — extracts a structured JSON migration
      report (target architecture, risk-ranked services, phased plan) from
      the agent pipeline's free-text output. Two modes: always-fresh (runs
      a brand-new full pipeline every call) or reuse-aware (extracts from
      an existing completed run for a project if one exists — zero or one
      LLM call instead of four)
- [x] `web-dashboard` — lightweight React (Vite) GUI: upload (with
      duplicate-upload detection), live agent progress, RAG Q&A, chat, and
      report history — including project pickers on RAG/Agent/Reports so
      any previously uploaded project can be targeted, not just the latest
      — see its own README for setup

## Observability

- **Correlation IDs**: every request gets a correlation ID (generated at
  the entry point if none exists, propagated via `X-Correlation-Id`
  header on every inter-module call this project makes). Every log line
  across every module shows it (`[correlationId]` in the console pattern),
  so one user action can be traced across `chat-module` -> `rag-module` ->
  `agent-module` etc., not just within a single process. Correctly
  survives the async pipeline's virtual-thread boundary too (see
  `MigrationPlanningOrchestrator.executeRunAsync`'s javadoc for the
  MDC-doesn't-cross-threads gotcha this handles).
- **AI-specific observability**: every `ChatClient` has Spring AI's
  built-in `SimpleLoggerAdvisor` (logs prompts/responses/tool-calls at
  DEBUG) plus a custom `TokenUsageLoggingAdvisor` (logs prompt/completion/
  total token counts at INFO for every LLM call) — both in `common`,
  reused across all 5 modules.
- **Distributed tracing**: Micrometer + Zipkin, via Boot 4's
  `spring-boot-starter-zipkin` (bundles the Brave tracing bridge and
  Zipkin reporter automatically — no separate dependencies needed). Spring
  AI's `ChatClient` calls are automatically instrumented once this is on
  the classpath, no extra code required. 100% sampling
  (`management.tracing.sampling.probability: 1.0`) — fine for a
  demo/portfolio project, would be turned down in anything resembling
  production. View traces at **http://localhost:9411** (Zipkin's own UI)
  once the `zipkin` container is running — see the containerization
  section below. Note this is a SEPARATE mechanism from the correlation
  ID above (`traceId`/`spanId` in the log pattern vs. `correlationId`) —
  intentionally kept side by side: the correlation ID works with zero
  extra infrastructure, Zipkin's IDs are what actually populate its UI.

## Roadmap (not yet built)

- **Secrets management beyond `.env`** — the current `.env` +
  `./run.sh` setup (see "A note on secrets" below) is correct practice
  for local dev, but the natural next step for anything beyond a laptop:
  - *Near-term, low-effort*: Docker Compose file-based secrets — mounts
    the key as a file at `/run/secrets/deepseek_api_key` inside the
    container instead of an environment variable (env vars are visible
    via `docker inspect` / `/proc/<pid>/environ`; a mounted file isn't).
    Spring supports this natively via `config/import: optional:file:/run/secrets/`
    with no code changes needed beyond that.
  - *Real target*: a proper secrets manager — HashiCorp Vault
    (`spring-cloud-starter-vault-config`) or AWS Secrets Manager
    (`spring-cloud-aws-starter-secrets-manager`). Both plug into Spring's
    `PropertySource` mechanism, so `${DEEPSEEK_API_KEY}` in every
    module's `application.yml` wouldn't even need to change — just where
    it resolves from — and both support rotation without a redeploy.
- **Structured-output-module's report generation is a single long-blocking
  HTTP call**, unlike agent-module's async start/poll/result pattern —
  fine for a curl demo, but the dashboard's only progress signal for it is
  an elapsed-time counter, not real step-by-step status. Worth giving it
  the same async job-tracking treatment agent-module already has.
- Log ingestion currently treats each uploaded log file as one document
  before chunking — a smarter log-aware chunking strategy (e.g. grouping
  by timestamp windows or log level) would likely retrieve more precisely
  for very large log files

## Stack

- Java 21, **Spring Boot 4.1.0**, Gradle (Groovy DSL)
- **Spring AI 2.0.0** (GA, June 2026 — built on Spring Framework 7.0, Jackson 3)
  - Chat/agents/tools: **DeepSeek** (`deepseek-chat` model)
  - Embeddings (`rag-module`): **Ollama** (`nomic-embed-text`, local, free)
  - Vector storage: **PostgreSQL + pgvector** (via Docker Compose)
- **PostgreSQL + pgvector** — persistent vector storage plus project/run
  history (`projects`, `analysis_runs` tables), shared across
  `rag-module`/`agent-module`/`structured-output-module` via
  `persistence-module`

## Prerequisites

1. **Java 21** installed (`java -version` to check)
2. **Gradle 8.14+ or 9.x** — Spring Boot 4.1's Gradle plugin requires this minimum
   (only matters for the one-time `gradle wrapper` step below; after that, `./gradlew`
   handles the correct version automatically for the project)
3. **Docker** (for PostgreSQL + pgvector — see below)
4. **A DeepSeek API key** — get one at https://platform.deepseek.com
5. **Set up your `.env` file** (do NOT `export` this in your shell profile —
   see the security note below):
   ```bash
   cp .env.example .env
   # then edit .env and paste in your real key
   ```

## Running everything — two options

**Option 1: Individual modules via `./run.sh` (recommended for development)**

Just Postgres + Ollama are containerized; the 5 Spring Boot modules and
the React dashboard run directly on your machine, giving fast
edit-rebuild-restart cycles and easy debugging.

```bash
docker compose up -d postgres ollama ollama-init zipkin
```

Then run each module with `./run.sh :module-name:bootRun` as documented
in each module's section below.

**Option 2: Everything containerized (recommended for a clean demo)**

One command builds and runs all 5 Spring Boot modules plus Postgres and
Ollama together, wired via Docker's internal networking (no `localhost`
between containers — each module reaches the others by container name,
e.g. `http://rag-module:8082`):

```bash
docker compose up -d --build
```

First run is slow (~5-10 min: each module does a full Gradle build inside
its own image, and Ollama downloads the embedding model). Subsequent runs
are much faster thanks to Docker's layer cache.

```bash
docker compose logs -f agent-module    # tail one service's logs
docker compose down                     # stop (data/models persist)
docker compose down -v                  # stop AND wipe everything
```

The React dashboard (`web-dashboard/`) is **not** containerized — it's a
dev-server frontend, run it separately with `npm run dev` regardless of
which option above you chose; it talks to whichever set of containers is
running via the same `localhost` ports either way.

⚠️ Don't run both options at once — both bind the same host ports (5432,
8080-8084, 11434), so they'll conflict.

### Database schema

`rag-module`, `agent-module`, and `structured-output-module` all share one
Postgres database (different tables) for vector storage and project/run
history. The `projects`, `analysis_runs`, and `vector_store` tables (plus
the `pgvector` extension itself) are created automatically on first
startup by each module (Hibernate `ddl-auto: update` for the JPA tables,
Spring AI's `initialize-schema: true` for the vector table). No manual
migration step needed for this portfolio-scale setup.

### A note on secrets

This project uses a `.env` file (git-ignored) plus `./run.sh`, a small
wrapper that loads `.env` into the environment of **only the single Gradle
process being started** — not your interactive shell. This matters:
`export DEEPSEEK_API_KEY=...` in a shell profile (`~/.zshrc`, `~/.bashrc`)
or a long-lived terminal session makes the key persistently readable by
*any* tool with terminal access — including AI coding assistants that read
shell/terminal context. `./run.sh` avoids that exposure entirely.

Use `./run.sh <gradle-task>` instead of `gradle <gradle-task>` or
`./gradlew <gradle-task>` throughout this README, e.g.:
```bash
./run.sh :chat-module:bootRun
```

If you've previously run `export DEEPSEEK_API_KEY=...` in a shell session,
**rotate that key now** at platform.deepseek.com — treat it as
compromised regardless of this fix.

See the Roadmap above for where this goes next (Docker secrets, then a
real secrets manager).

## Running chat-module

This project doesn't include the Gradle wrapper jar (binary file, kept out of
this environment). Generate it once, locally, with:

```bash
gradle wrapper --gradle-version 9.0
```

(Requires Gradle installed locally — `brew install gradle` on Mac, or download
from https://gradle.org/install. After this, `./run.sh` uses `./gradlew`
under the hood automatically — see run.sh if you want to check.)

Then run:

```bash
./run.sh :chat-module:bootRun
```

The app starts on `http://localhost:8080`.

### Try it

**Simple request/response:**
```bash
curl -X POST localhost:8080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"demo-1","message":"What risks come with migrating a SOAP API to REST?"}'
```

**Streaming (SSE) — watch it type incrementally:**
```bash
curl -N -X POST localhost:8080/api/chat/stream \
  -H "Content-Type: application/json" \
  -d '{"conversationId":"demo-1","message":"Now summarize that in one sentence."}'
```

Use the same `conversationId` across calls to see memory in action — the second
call above references "that," and the model resolves it using conversation history.

## Running tools-module

```bash
./run.sh :tools-module:bootRun
```

The app starts on `http://localhost:8081` (deliberately different port from
chat-module so you can run both at once later).

**Operational data is optional and swappable.** On startup, this module
loads the bundled OrderVault example data by default, so it works with
zero setup. To analyze a real/generic project's own operational data
instead, upload it — this REPLACES the currently active data:

```bash
curl -X POST localhost:8081/api/tools/upload/operational-data \
  -F "health=@my-health-status.json" \
  -F "traffic=@my-traffic-stats.json"
```

(Files must match this module's schema — see
`MonitoringDtos.java` for the exact shape, or use
`test-data/mock-legacy-app/operational-data/*.json` as a template.)

### Try it

**Ask something that requires live data — watch the model call tools:**
```bash
curl -X POST localhost:8081/api/tools-chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Is InventoryCheckService healthy right now, and how much does its traffic spike during sales events?"}'
```

With `logging.level.org.springframework.ai: DEBUG` (already set in
`application.yml`), you'll see the tool call requests/responses in the
console — useful for confirming the model actually invoked
`checkApiHealth` / `getTrafficStats` rather than guessing.

**You can also hit the underlying mock endpoints directly**, without going
through the AI, to see the raw data the tools are working with:
```bash
curl localhost:8081/internal/legacy-monitoring/health/InventoryCheckService
curl localhost:8081/internal/legacy-monitoring/traffic/InventoryCheckService
```

(Service names depend on whichever operational data is currently loaded —
`InventoryCheckService` etc. only work while the bundled OrderVault
example is active. If you've uploaded your own data, use your own
service names instead — an unrecognized name returns a helpful list of
what's actually available.)

## Running rag-module

**Prerequisite: install Ollama and pull the embedding model** (one-time setup):

```bash
# Mac: brew install ollama    |    or download from https://ollama.com
ollama pull nomic-embed-text
```

Make sure the Ollama server is running (it usually starts automatically
after install; if not, run `ollama serve` in a separate terminal).

Then:

```bash
./run.sh :rag-module:bootRun
```

The app starts on `http://localhost:8082`. **Nothing is ingested
automatically on startup anymore** — this module now supports analyzing
any codebase, not just the bundled OrderVault example, so you choose what
to load:

**Option A — try the bundled OrderVault example (zero setup):**
```bash
curl -X POST localhost:8082/api/rag/upload/load-example
```
This ingests OrderVault's source code/specs/data AND auto-populates the
grounding text from its `ground-truth/` docs, so the whole pipeline
(including agent-module's Comparison step) works immediately.

**Option B — analyze your own codebase:**
```bash
# zip up the project first, e.g.: zip -r my-project.zip my-project/
curl -X POST localhost:8082/api/rag/upload/source \
  -F "file=@/path/to/my-project.zip"
```
Every file with a recognized extension (`.java .py .js .ts .go .rb .cs
.kt .xml .yaml .yml .json .sql .md`) anywhere in the zip gets indexed —
no folder-naming convention required, unlike the OrderVault example.

**Optionally, also upload grounding docs** (a hand-written architecture
summary, known-issues doc, etc.) for a project — used later by
agent-module's Comparison step to score its own output. Pass `projectId`
to target a specific project; omit it to target the most-recently-created
one:
```bash
curl -X POST "localhost:8082/api/rag/upload/grounding?projectId=..." \
  -F "files=@architecture-notes.md"
```

**Every uploaded project's embeddings persist permanently** — uploading a
new one does NOT replace or delete earlier ones. It just becomes the new
default "active" project (whichever request doesn't explicitly pass a
`projectId` targets whichever project is most recently created) — any
earlier project remains fully queryable by passing its `projectId`
explicitly (see "Try it" and "Project history" below).

**Duplicate-upload detection**: if a zip's bytes exactly match an
already-uploaded project, the request is rejected with HTTP 409 and the
existing project's info, instead of silently creating a redundant
duplicate. A genuinely updated project (even a single changed file)
always produces a different hash, so this never blocks a real new
version — only a byte-for-byte repeat. Pass `override=true` to force
re-ingestion anyway:
```bash
curl -X POST "localhost:8082/api/rag/upload/source?override=true" \
  -F "file=@/path/to/my-project.zip"
```

**Deleting a project**: removes its vector store chunks and grounding
text permanently. Any agent-module run history for that project is
NOT deleted — it remains viewable in Reports even after its source
project is gone:
```bash
curl -X DELETE localhost:8082/api/rag/projects/{projectId}
```

Watch the console for `[RAG ingestion]` log lines during upload — this can
take anywhere from a few seconds to a minute or two depending on project
size, since every chunk needs a real embedding call to your local Ollama
server.

### Try it

```bash
curl -X POST localhost:8082/api/rag/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"What services or components exist in this codebase?"}'
```

`projectId` in the request body is OPTIONAL — pass it to ask against a
SPECIFIC previously uploaded project (see `GET /api/rag/projects` below
for the list to pick from); omit it to target the most-recently-created
project:
```bash
curl -X POST localhost:8082/api/rag/ask \
  -H "Content-Type: application/json" \
  -d '{"question":"What services exist?","projectId":"..."}'
```

Good follow-up questions once you know what's there (for the OrderVault
example specifically):
- "Why is CustomerAccountService considered risky to migrate?"
- "What are all the known data-quality issues in the database?"
- "Compare how InventoryCheckService and PartnerCatalogFeed each get their stock data"

If an answer seems vague or generic rather than citing specific
classes/files, check that you've actually loaded/uploaded a project first
(see above) — a fresh `rag-module` boot starts with nothing indexed.

**To verify exactly what got ingested** (useful for checking a chat
answer's claims against what was actually retrievable, rather than
trusting the model's own account of its sources):

```bash
curl localhost:8082/api/rag/sources
```

Returns the full list of ingested file paths plus a `groundTruthFilesFound`
count — for the OrderVault example this should always be `0` (verifying
the exclusion still holds); for a generic upload it's not a meaningful
check since there's no ground-truth/ convention to exclude.

**Project history** — every project ever loaded, most recent first, all
of them genuinely searchable (see above; nothing gets truncated on a new
upload):
```bash
curl localhost:8082/api/rag/projects
```

## Running agent-module

**This module composes rag-module and tools-module over HTTP** — both
must already be running for the full pipeline to work:

```bash
# In separate terminals, from the project root:
./run.sh :tools-module:bootRun
./run.sh :rag-module:bootRun
# then, once both are up:
./run.sh :agent-module:bootRun
```

The app starts on `http://localhost:8083`.

### Try it

**Full pipeline (the main demo) — slow, since it's 3+ separate LLM
conversations with multiple tool calls each. Expect it to take a while:**

```bash
curl -X POST localhost:8083/api/agent/analyze
```

`projectId` is OPTIONAL on every agent-module endpoint below — pass it to
target a SPECIFIC previously uploaded project (`GET /api/rag/projects`
for the list); omit it to default to the most-recently-uploaded project.
This is threaded through correctly end-to-end, including every RAG query
and grounding lookup made *during* the run, not just at creation:
```bash
curl -X POST "localhost:8083/api/agent/analyze?projectId=..."
```

Returns four sections: `discoveryReport`, `architectureProposal`,
`riskAssessment`, and `groundTruthComparison` — that last one is the
interesting part: an honest scoring of what the AI pipeline got right vs.
missed vs. got wrong, compared against the hand-written
`ground-truth/architecture-overview.md` and `dependency-graph.md`.

**Individual steps, useful for faster iteration/debugging** (each agent
can be tested on its own without waiting for the full chain):

```bash
# Discovery only (requires rag-module running)
curl -X POST localhost:8083/api/agent/discovery

# Architecture only — needs a discovery report in the body
curl -X POST localhost:8083/api/agent/architecture \
  -H "Content-Type: application/json" \
  -d '{"discoveryReport":"...paste discovery output here..."}'

# Risk only — needs a discovery report, requires tools-module running
curl -X POST localhost:8083/api/agent/risk \
  -H "Content-Type: application/json" \
  -d '{"discoveryReport":"...paste discovery output here..."}'
```

If the full pipeline fails partway through, the individual endpoints are
the fastest way to isolate which agent/service is the problem.

**Run history** — every pipeline run ever executed is saved permanently
(regardless of whether its source project's vector data still exists).
`projectId` is optional here too — omit for the full cross-project
history, pass it to see only one project's runs:
```bash
curl localhost:8083/api/agent/runs              # list all, most recent first
curl "localhost:8083/api/agent/runs?projectId=..."  # scoped to one project
curl localhost:8083/api/agent/runs/{id}          # get one run's full detail
```

**Async version (for a real GUI, or just to watch live progress)** —
`POST /api/agent/analyze` above blocks for minutes. The async endpoints
return immediately and let you poll (same optional `projectId` param):

```bash
# 1. Start — returns immediately with a runId
curl -X POST localhost:8083/api/agent/analyze/start
curl -X POST "localhost:8083/api/agent/analyze/start?projectId=..."

# 2. Poll status — shows current step, elapsed time, and an estimated
#    remaining time computed from past completed runs' actual step
#    durations (falls back to a static guess only for the very first run
#    ever, before any history exists to compute a real average from)
curl localhost:8083/api/agent/analyze/status/{runId}

# 3. Once status shows "COMPLETE", fetch the result:
curl localhost:8083/api/agent/analyze/result/{runId}
```

`status` response shape:
```json
{
  "runId": "...",
  "status": "RUNNING",
  "currentStep": "ARCHITECTURE",
  "elapsedSeconds": 47,
  "estimatedRemainingSeconds": 156
}
```
`currentStep` is one of `DISCOVERY`, `ARCHITECTURE`, `RISK`, `COMPARISON`,
`DONE`. Calling `/result/{runId}` before status shows `COMPLETE` returns
HTTP 409 with a message telling you to keep polling.

## Running structured-output-module

Two ways to use it:

**Standalone** (fastest — no other services required, you supply the
three reports yourself, e.g. copy-pasted from agent-module's individual
step endpoints):

```bash
./run.sh :structured-output-module:bootRun

curl -X POST localhost:8084/api/report/generate \
  -H "Content-Type: application/json" \
  -d '{"discoveryReport":"...","architectureProposal":"...","riskAssessment":"..."}'
```

**Full pipeline** (the complete end-to-end demo — one call triggers
everything: Discovery -> Architecture -> Risk -> structured extraction).
Requires `tools-module`, `rag-module`, and `agent-module` all already
running:

```bash
curl -X POST localhost:8084/api/report/generate-from-pipeline
curl -X POST "localhost:8084/api/report/generate-from-pipeline?projectId=..."
```

This is the slowest possible call in the whole project (the entire agent
pipeline plus one more extraction call — often several minutes; the
inter-module `RestClient` has a 15-minute read timeout specifically to
accommodate this), but it's also the single command that demonstrates the
complete system end-to-end — RAG, tool calling, multi-agent orchestration,
and structured output all in one response. Good candidate for the
centerpiece of an interview demo. Always starts a brand-new run, even if
one already exists for this project — see below for the version that
avoids that.

**Reuse-aware** (avoids re-calling the LLM pipeline entirely when
possible) — reuses the latest COMPLETE agent-module run for a project
instead of always starting fresh:
```bash
curl -X POST localhost:8084/api/report/generate-for-project/{projectId}
```
- Already has a structured report cached from an earlier call? Returned
  directly — **zero** LLM calls.
- Has a completed run but no structured report yet? **One** LLM call
  (just the extraction step — Discovery/Architecture/Risk/Comparison are
  NOT re-run).
- No completed run exists yet for this project? Falls back to running the
  full live pipeline (same cost as `/generate-from-pipeline` above).

This is the one the dashboard's Reports tab uses by default.

Returns a `MigrationReport` JSON object: `systemName`, `executiveSummary`,
`targetArchitecture` (approach, proposed services, tech choices),
`serviceRisks` (per-service risk level, factors, recommendation — array),
and `phasedPlan` (ordered migration phases with rationale — array).

## Running web-dashboard

A lightweight React (Vite) GUI wrapping all 5 backend modules — upload,
live agent progress, chat, RAG Q&A, and report history. See
`web-dashboard/README.md` for full details; quick start:

```bash
cd web-dashboard
npm install
npm run dev
```

Opens on `http://localhost:5173`. All 5 backend modules need to be
running first (CORS is already configured to allow this exact origin —
see each module's `CorsConfig.java`).

## Project structure

```
legacy-api-migration-advisor/
├── common/                    shared DTOs, reused across modules
├── persistence-module/         shared JPA entities/repositories (Project, AnalysisRun)
├── chat-module/                conversational assistant (port 8080)
├── tools-module/                AI tool/function calling (port 8081)
├── rag-module/                  document Q&A, generic upload (port 8082)
├── agent-module/                 multi-agent migration planning (port 8083)
├── structured-output-module/      structured JSON report extraction (port 8084)
├── web-dashboard/               React (Vite) GUI (port 5173) — see its own README
├── test-data/                  synthetic mock legacy system (fake code/specs, no real IP)
│   └── mock-legacy-app/         "OrderVault" — bundled example project
│       ├── source-code/          legacy Java (EJBs, DAOs, messaging, integrations)
│       ├── api-specs/            3 legacy WSDLs + 1 newer OpenAPI spec
│       ├── operational-data/     mock traffic + health stats (JSON)
│       ├── database/             schema, seed data, scale/data-quality notes
│       └── ground-truth/         answer-key docs, NOT fed to the app — see its README
├── docker-compose.yml          PostgreSQL + pgvector (`docker compose up -d`)
└── settings.gradle             module registry
```

## Design notes (for interview talking points)

- **Provider abstraction**: chat/agents use DeepSeek, embeddings use local Ollama —
  demonstrates picking the right model per capability rather than one-size-fits-all,
  using Spring AI's provider-agnostic APIs so swapping providers later is low-risk.
- **Conversation memory is per-conversation-ID, not per-HTTP-session** — keeps the
  API stateless-friendly and makes it trivial to swap the in-memory store for a
  persistent one (JDBC/Redis) without touching controller or service code.
- **Test data is entirely synthetic** — a fictional "OrderVault" legacy system,
  invented specifically for this project, with no real employer IP involved.
- **SSE events can legitimately span multiple `data:` lines** — per spec,
  when a single streamed delta contains an internal newline, a compliant
  server splits it into consecutive `data:` lines that the client must
  rejoin with `\n`. Missing this silently dropped every embedded newline
  in streamed chat responses (paragraph breaks, table rows, markdown
  headers) — a subtle protocol-correctness bug, not a markdown-rendering
  one, and a good example of why "it looks unformatted" isn't always a
  CSS problem.
- **`@Lob` on a String field means something different on PostgreSQL than
  you'd expect** — Hibernate maps it to Postgres's actual Large Object
  type (an `oid` reference into `pg_largeobject`), a genuinely
  transactional resource, rather than a plain `text` column. Reading one
  outside an explicit transaction throws `"Large Objects may not be used
  in auto-commit mode"` — fixed here via `@JdbcTypeCode(SqlTypes.LONGVARCHAR)`
  instead, which maps to plain unbounded `text` with no such restriction.