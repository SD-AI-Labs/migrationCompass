# Project Status — Migration Compass (V2)

Tracks implementation against `PROJECT_PLAN_V2.md` using the milestone breakdown
in `v2/IMPLEMENTATION_PLAN.md`.

**Rules for this file:** a milestone is only marked complete once its
verification commands have actually been run and their real output is recorded
here. Nothing is committed to git — all work sits in the working tree.

Last updated: M3 complete.

---

## Summary

| Milestone | Scope | Status |
|---|---|---|
| M0 | Scaffold: Next.js app, Drizzle schema, OTel→Postgres, pino, env | ✅ complete |
| M1 | Ingestion: upload, extraction, chunking, embedding, duplicates | ✅ complete |
| M2 | RAG + Ask: multi-query, rerank, retrieval, ask bar | ✅ complete |
| M3 | Agent orchestration (LangGraph.js) + dependency extraction | ✅ complete |
| M4 | Scoring engine, scorecard, dependency graph | ⏳ not started |
| M5 | Operational data + refinement | ⏳ not started |
| M6 | Tracing UI (`/admin/traces`) | ⏳ not started |
| M7 | Polish: progressive disclosure, states, accessibility | ⏳ not started |

---

## M0 — Scaffold ✅

### What exists now

```
v2/
  package.json                 Next 16.3.4, React 19.2.8, Drizzle 0.45, TS 5.9.3
  docker-compose.yml           postgres (pgvector/pgvector:pg17) + ollama
  drizzle.config.ts
  pnpm-workspace.yaml          pnpm 11 build-script approvals (esbuild, unrs-resolver)
  src/instrumentation.ts       OTel bootstrap, node-runtime guard
  src/app/                     layout, one continuous project page, theme tokens
  src/db/schema.ts             9 tables + 8 enums
  src/db/client.ts             lazy postgres.js + Drizzle
  src/db/migrations/0000_easy_marauders.sql
  src/lib/env.ts               per-capability zod env
  src/lib/session.ts           session-scoped ownerId cookie
  src/lib/observability/       pino logger with trace-id mixin, OTel→Postgres exporter
```

### Decisions taken during M0 (not in the plan, worth knowing)

1. **Server Actions over tRPC.** The plan allowed either. Server Actions win
   because there is no second client — a typed RPC layer would add a dependency
   boundary with nothing on the other side of it. Recorded here because it is a
   deviation from the plan's first-listed option, not an oversight.
2. **Per-capability env validation, not one global schema.** A missing
   `DEEPSEEK_API_KEY` must not take down a page whose numbers come from the
   rubric. Each capability asks for exactly what it needs and throws
   `MissingConfigurationError` naming the variable.
3. **TypeScript pinned to 5.9.3, ESLint to 9.39.5.** `latest` resolved to TS 7.0
   and ESLint 10, and `eslint-config-next` fails on both (typescript-eslint does
   not support TS 7.0; eslint-plugin-react breaks on ESLint 10). Pinned to the
   versions the ecosystem currently supports rather than carrying a broken lint
   step.
4. **`service_dependencies` is per-run, not per-project only.** It carries both
   `projectId` and `runId` so a re-analysis produces a second, comparable graph
   instead of overwriting the first.
5. **`findings.dependentCount` is a stored column**, written from the dependency
   edges at run time. The rubric reads a number; it does not re-derive graph
   topology per score.

### Schema

9 tables: `projects` (with required `ownerId`), `chunks` (pgvector, 768-dim),
`analysis_runs`, `findings`, `service_dependencies`, `scorecards`,
`operational_data`, `migration_parameters`, `trace_spans`.

The plan's Phase-1 requirement that `ownerId` exist from the initial schema is
enforced by test (`src/db/schema.test.ts`), not just by convention.

### Verification (actual output)

| Command | Result |
|---|---|
| `pnpm lint` | clean — no output, exit 0 |
| `pnpm typecheck` | clean — no output, exit 0 |
| `pnpm test` | **42 passed (42)**, 4 files, 326ms |
| `pnpm build` | ✓ compiled successfully in 2.4s; routes `/` (dynamic), `/_not-found` |
| `pnpm db:generate` | ✓ `src/db/migrations/0000_easy_marauders.sql` — 9 tables, 14 indexes, 8 FKs |

### Known limitations carried forward

- ~~**The migration has not been applied to a live Postgres.**~~ **Resolved** — see
  "Live database verification" at the end of this file. The migration applied
  cleanly to a real `pgvector/pgvector:pg17` instance, all 9 tables, both
  extensions, and the `vector(768)` column confirmed by direct inspection.
- Ollama has never been contacted — no real embedding call has been made yet.
- `next.config.ts` declares nothing yet; `typedRoutes` is on, which will start
  failing builds once routes are added without `<Link>` types handled.

### Notes for the next milestone

M1 (Ingestion) is next: safe zip extraction, code-aware chunking, the Ollama
embeddings client, duplicate detection by content hash, and the upload server
action scoped to `ownerId`. The chunker and extractor are planned as pure,
unit-tested modules so they do not need a live database to verify.

---

## M1 — Ingestion ✅

### What was built

```
src/lib/ingestion/
  chunking.ts     code-aware chunker — pure, no I/O
  extract.ts      zip extraction: traversal + zip-bomb + entry-flood guards
  scan.ts         extension allowlist, binary rejection, ground-truth exclusion
  hash.ts         sha256 content hash
  service.ts      plan → duplicate check → embed → persist, with compensation
src/lib/embeddings/embeddings.ts   Ollama client + deterministic stub + batching
src/lib/projects/repository.ts     Drizzle store + owner-scoped reads
src/app/actions/upload.ts          upload Server Action
src/app/actions/projects.ts        delete Server Action (owner-scoped)
src/components/upload-form.tsx     client form (useActionState)
src/components/project-list.tsx    project list
src/app/page.tsx                   rewritten: setup panel | upload + list + env panel
```

### Decisions taken during M1

1. **Extraction is in-memory, not to a temp directory.** The pipeline only ever
   reads these files as text to embed, so a temp-dir lifecycle would add a
   cleanup failure mode in exchange for nothing. V1 wrote to a temp dir because
   it walked the filesystem afterwards; this version does not.
2. **A single shared `evaluate()` decides every accept/reject**, called both by
   the plan-ahead path (tests) and by the decompression filter (production), so
   the two cannot drift.
3. **Ground-truth exclusion is a filtering rule with a test, not a log warning.**
   V1 warned when ground truth leaked into ingestion; here the files are dropped
   before chunking and the count is surfaced in the UI and the logs, so a
   regression is visible rather than silent.
4. **Dead directories are excluded everywhere** (`node_modules`, `.git`, `target`,
   `build`, `dist`), not just in the bundled example's include list.
5. **Ingestion order: plan → empty check → duplicate check → embed → create
   project → insert chunks.** A duplicate costs zero embeddings; an empty archive
   costs zero embeddings; a chunk-write failure deletes the project row rather
   than leaving an unretrievable project in the user's list.
6. **The store is a port** (`ProjectStore`) with a Drizzle implementation and a
   fake in tests. This is what makes the ordering guarantees above testable
   without Postgres.
7. **Vector inserts are batched at 200 rows.** pgvector rows are wide and one
   statement for a large upload is slow and memory-hungry.

### Verification (actual output)

| Command | Result |
|---|---|
| `pnpm lint` | clean — exit 0 |
| `pnpm typecheck` | clean — exit 0 |
| `pnpm test` | **125 passed (125)**, 9 files, 383ms |
| `pnpm build` | ✓ compiled successfully; `/` dynamic, `/_not-found` static |

Notable behaviors covered by tests (not just "functions exist"):

- path traversal (`../../etc/passwd`, `..\..\`, `C:/…`, NUL, double slash)
  rejected while the rest of the archive still ingests
- zip-bomb-shaped entry rejected by compression ratio; legitimately compressible
  logs still accepted
- entry-count and total-size ceilings enforced cumulatively
- directory entries counted as neither accepted nor rejected
- ground truth never reaches the plan; the excluded count is reported
- a byte-identical re-upload is rejected, names the existing project, and costs
  zero embedding calls; `override` creates a second project
- duplicate detection is session-scoped (two sessions may upload the same code)
- an empty archive fails before any embedding spend
- a chunk-write failure triggers the compensating delete (no orphan project)
- code chunks get a larger budget than prose; a trailing sliver merges upward;
  an unbreakable minified line is hard-split

### Newly added dependency

`fflate` — in-memory zip decode. Chosen over `yauzl`/`unzipper` because its
filter callback runs after the central directory is read and before any entry is
inflated, which is exactly where the bomb and traversal checks need to sit.

### Known limitations

- ~~**Still no live database in this environment.**~~ **Resolved** — the Drizzle
  store, the ingestion pipeline, and owner-scoped reads all ran against a real
  Postgres. See "Live database verification" at the end of this file.
- **No embedding call has ever been made against Ollama.** The client's
  request/response shape is written from the documented API but has only ever been
  exercised through the deterministic stub. The live-database suite uses the stub
  too, at 768 dimensions, so the *vector plumbing* is verified but the *model* is
  not.
- **Chunking is a size tuning, not syntax-aware.** It reduces how often a
  boundary lands inside a declaration; it does not eliminate it. Stated in the
  module docstring rather than implied.
- **The example project is not bundled in V2.** `scanFiles` supports the
  `includeTopLevelDirs` restriction and it is tested, but nothing calls it yet —
  there is no bundled OrderVault equivalent to load.

### Notes for the next milestone

M2 (RAG + Ask) is next: multi-query expansion, LLM reranking with fail-open
behavior, pgvector retrieval scoped by `projectId`, and the ask bar. Expansion
and rerank parsing are planned as pure functions so their failure paths
(unparseable model output, model unreachable) are testable without a model.

---

## M2 — RAG + Ask ✅

### What was built

```
src/lib/llm/client.ts        LlmClient port: complete() + stream(); DeepSeek impl;
                             parseOpenAiSse (pure); createStubLlm for tests
src/lib/rag/multiQuery.ts    expansion: original always first, refusal/prose
                             rejection, degrades to a single query on failure
src/lib/rag/rerank.ts        ranking parse, merge, fail-open reranking
src/lib/rag/retrieve.ts      pgvector cosine search, project-scoped
src/lib/rag/ask.ts           the pipeline (expand → embed → retrieve → merge →
                             rerank → answer), streaming and non-streaming
src/lib/sse.ts               SSE frame parsing, shared by server and client
src/app/api/ask/route.ts     POST /api/ask, streamed, ownership-checked
src/components/ask-bar.tsx   persistent ask bar
```

### Decisions taken during M2

1. **`askQuestion` is implemented on top of `askStreaming`**, not beside it. One
   pipeline definition, so the streaming and non-streaming paths cannot diverge.
2. **The original question is always query #1 in expansion.** Expansion is a
   recall improvement; if the model drifts, the literal question is still
   searched. Tested.
3. **Expansion never throws.** An auxiliary model call failing must not turn a
   question into an error — it turns it into a plain single-query search.
4. **Refusals and preambles are filtered out of parsed variants.** A model that
   answers "I'm sorry, I can't help with that" was previously parseable as a
   *query*; the length filter alone let it through. Found by test, fixed.
5. **Reranking is skipped when the candidate set already fits `keepTop`.** Order
   does not affect which chunks are used, so the call would be a round-trip for
   nothing. This made one M2 test's expectation wrong rather than the code —
   the test now forces 9 candidates against `keepTop: 4`.
6. **Fail-open reranking returns the list untruncated**, not truncated by
   retrieval order. The latter would be presenting a judgement that was never
   made.
7. **`[DONE]` terminates the SSE stream rather than being skipped.** Anything
   after it is not part of that response. Found by test, fixed.
8. **SSE parsing is shared between server and client and tested against split
   frames**, because chunk boundaries do not respect frame boundaries.
9. **Ownership is checked before retrieval in `/api/ask`**, so a guessed project
   id cannot read another session's codebase through the ask path.
10. **The ask bar shows which queries were searched and how many chunks were
    used of how many retrieved.** Progressive disclosure without that number
    invites the reader to assume the answer considered everything.

### Verification (actual output)

| Command | Result |
|---|---|
| `pnpm lint` | clean — exit 0 |
| `pnpm typecheck` | clean — exit 0 |
| `pnpm test` | **186 passed (186)**, 14 files, 628ms |
| `pnpm build` | ✓ compiled; routes `/` (dynamic), `/api/ask` (dynamic), `/_not-found` (static) |

Pipeline shape assertions (call counts, not just outputs):

- exactly 1 expansion call, 1 embedding call for the whole query set, 3 retrieval
  calls, 1 rerank call, 1 answer call per question
- rerank call is *absent* when the merged set already fits `keepTop`
- 6 retrieved / 2 used when two queries surface the same two chunks (de-dupe)
- expansion failure → 1 retrieval call, answer still produced
- no retrieval results → answer still produced, zero citations
- citations are emitted before the first answer delta; deltas concatenate to the
  final answer
- `parseOpenAiSse`: event split mid-line across chunks, `[DONE]` termination,
  malformed frame skipped without dropping the stream, keep-alive comments
  ignored, UTF-8 across a byte-chunked body

### Known limitations

- **The database paths are now verified; the model paths are not.** See "Live
  database verification" below — ingestion, the Drizzle store, pgvector writes,
  cosine ordering, and owner scoping all ran against real Postgres. The DeepSeek
  client has still never made a real HTTP call, and the ask bar has never
  streamed a real answer.
- **The similarity floor is off by default.** `minSimilarity` is plumbed into SQL
  and is now covered by a live test (unrelated vocabulary returns zero rows at a
  0.99 floor), but no application caller sets it — so every query returns
  `retrieveLimit` rows even when none are relevant, and the reranker then ranks
  irrelevant chunks against each other. Worth revisiting once real retrieval can
  be observed end to end.
- **`keepTop` (8) exceeds `retrieveLimit` for a single query (6)**, so a
  single-query search can never fill the context. That is intentional (expansion
  is expected to supply the rest) but it means the fail-open expansion path
  yields a thinner context than the happy path.
- **No caching.** Repeated questions re-expand, re-embed, and re-rank.

### Notes for the next milestone

M3 (Agent orchestration) is next: LangGraph.js graph with Discovery →
Architecture ∥ Risk → Comparison, tool sharing across agents, the bounded
one-round self-critique, and the new `dependencies: [{from, to, type}]` field in
the Discovery extraction schema that M4's dependency graph needs. The critique
"is this COMPLETE?" parser is planned as a pure function — a critique that
begins "Complete except…" must not be treated as complete.

---

## Live database verification (after M2)

The Docker daemon was not running for the M0–M2 runs, so those milestones were
recorded with "generated but never applied" limitations. It was reachable
afterwards, and the migration plus every database path was then verified for
real.

### How the daemon came up

`open -a Docker`, then a poll for the socket. The earlier background
`docker compose up` had failed with the same socket error this file already
recorded — no new information, just confirmation.

### Commands run and what they produced

```
docker compose up -d postgres
  → Image pgvector/pgvector:pg17 Pulled; Container compass-postgres Started
docker exec compass-postgres pg_isready -U compass -d compass
  → postgres ready
DATABASE_URL=postgres://compass:compass@localhost:5432/compass pnpm db:migrate
  → [✓] migrations applied successfully!
```

Independent inspection through `psql` (not through the app, so this is not the
app grading itself):

```
\dt                       → 9 tables: analysis_runs, chunks, findings,
                            migration_parameters, operational_data, projects,
                            scorecards, service_dependencies, trace_spans
pg_extension              → vector, pgcrypto
chunks.embedding          → udt_name=vector, atttypmod=768
leftover test projects    → 0
```

### The integration suite

`src/lib/projects/repository.integration.test.ts` (new) runs the real pipeline:
it ingests an archive through `ingestArchive` and `createDrizzleProjectStore`
into live Postgres, then asserts on real pgvector behaviour. It skips itself when
`DATABASE_URL` is unset, so `pnpm test` still runs with nothing installed.

| Command | Result |
|---|---|
| `pnpm test` (no `DATABASE_URL`) | **186 passed**, 8 skipped, 1 file skipped |
| `pnpm test` (with `DATABASE_URL`) | **194 passed (194)**, 15 files |
| `pnpm test:integration` | the 8 live-database tests, run in isolation |
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm build` | ✓ compiled; `/`, `/api/ask`, `/_not-found` |

What the 8 live tests actually establish:

- a real ingest writes real rows: project persisted with its file and chunk counts
- every stored chunk carries a 768-dimension embedding (validated against the
  column, so a width mismatch would fail here)
- **real cosine ordering**: a query mirroring one class declaration retrieves that
  file first, with descending similarity across the result set
- the similarity floor works in SQL: unrelated vocabulary returns zero rows at a
  0.99 floor
- byte-identical re-upload is refused by the database-backed duplicate check
- owner scoping holds end to end: another session gets `null` for the project,
  an empty project list, and zero retrieval rows even when given the real
  project id
- deleting a project cascades to its chunks (verified by counting rows); deleting
  with the wrong owner returns `false` and removes nothing
- the duplicate check is scoped per session, so the same bytes ingest cleanly
  under a second owner

### One expectation was wrong, not the code

The cosine-ordering test initially asserted `similarity > 0.9` and measured
0.825. The ordering assertion had already passed; the magic number was mine and
encoded the stub embedder's behaviour rather than the retrieval contract. It now
asserts a floor of 0.8 plus a real separation from the runner-up (> 0.05), which
tests the ordering without pinning an arbitrary value.

### Still unverified after this

- **Ollama has never been contacted.** The embedding client's request shape is
  written from the API docs and exercised only through the deterministic stub.
  The integration suite uses the stub at 768 dimensions too, so the vector
  plumbing is proven but the model is not.
- **The DeepSeek client has never made a real HTTP call**, and no answer has ever
  streamed through the ask bar.
- **No page has ever been rendered with a non-empty project list** — the upload
  action and ask bar are typechecked and built, but not exercised in a browser.

---

## M3 — Agent orchestration ✅

### 1. Files created / changed

```
src/lib/agents/
  prompts.ts                      every prompt + per-step tags; extraction prompts embed a
                                  JSON Schema generated from the zod validators
  schemas.ts                      validated structured outputs; dependency-type normalization;
                                  JSON extraction from model responses
  critique.ts                     pure "is this critique COMPLETE?" parser
  refinement.ts                   the one-round bound, as straight-line code
  tool-loop.ts                    bounded ReAct tool-calling loop
  graph.ts                        the LangGraph state graph
  persistence.ts                  findings + dependency edges + dependent counts (pure merge)
  run.ts                          run lifecycle, ownership gate, failure semantics
  stores.ts                       Drizzle RunStore + AnalysisStore
  sources.ts                      RAG-backed knowledge source; operational-data monitoring source
  wiring.ts                       composes the real deps (only file that knows DeepSeek/DB/Ollama)
  tools/
    types.ts                      AgentTool / ToolResult / ToolContext
    knowledge-base.ts             queryKnowledgeBase, backed by the existing RAG pipeline
    monitoring.ts                 checkApiHealth, getTrafficStats
    index.ts                      the shared tool set + per-agent tool policy
  testing/fake-model.ts           scripted model + recorded fake tools (test support)
  *.test.ts, run.integration.test.ts

src/lib/llm/client.ts             + chat() with tool-calling; + optional prompt tag
src/app/actions/analysis.ts       server action: create pending run, execute via after()
src/components/project-list.tsx   run status + "Run analysis" trigger
src/app/page.tsx                  loads latest run per project
src/db/schema.ts                  run_status gains 'pending'
src/db/migrations/0001_spooky_brood.sql   ALTER TYPE run_status ADD VALUE 'pending' BEFORE 'running'
```

### 2. Graph structure implemented

```
                 ┌── runArchitecture ──┐
START → runDiscovery ─┤                    ├→ runComparison → END
                 └── runRisk ──────────┘
```

Real fan-out, verified by test rather than asserted. Two independent checks:

- **Concurrency**: Architecture's draft refuses to produce a report until Risk has
  started, via a rendezvous promise with a deadline. A serialised implementation
  deadlocks and fails the test with an explicit message.
- **Fan-in runs once**: every Architecture/Risk model call precedes every
  Comparison call by index, and `runComparison` executes exactly once — not once
  per incoming edge.

`AnalysisState` is explicit and typed (`Annotation.Root` with four domain channels
plus a reducer-appended `completedStages`). Node names are prefixed
(`runDiscovery`) because LangGraph forbids a node name colliding with a state
channel name — a constraint confirmed against the installed library before the
graph was written, then hit anyway and fixed.

Dependencies are injected (`AgentDeps`: model, shared tools, stage callback). No
module-level model client exists anywhere in the agent layer, so the graph runs
with no API key, no Ollama, and no database.

### 3. Discovery schema implemented

`discoveryOutputSchema` carries the service inventory plus
`dependencies: [{from, to, type, evidence?}]`, and the rubric's structured fields
per service (`hasTestCoverageGap`, `dataQualityIssueCount`,
`requiresMajorRestructuring`) as **required** fields rather than defaults — a
silently-defaulted `false` is a claim the model never made, and the readiness
score is computed from exactly these values.

Model output is validated, not trusted: JSON is extracted by brace-depth scanning
that respects string state, parsed, then run through zod. A failure raises
`AgentOutputError` carrying the failing field paths, and triggers **one** retry
whose prompt contains that error verbatim. A second failure fails the stage.

Dependency types are normalized rather than rejected: "synchronous call",
"sync-call" and "REST request" all map to `sync_call`; anything unrecognised
becomes `unknown` (kept, because a dropped edge is a missing edge in the graph);
external integrations are classified by destination before mechanism. Self-edges
and duplicates are dropped where edges enter the pipeline.

### 4. Dependency persistence implemented

Every edge is written to `service_dependencies` with **both** `projectId` and
`runId`, so re-analysing a project produces a second comparable graph rather than
overwriting the first. `replaceResults` deletes only rows for its own run id, which
makes it idempotent for that run and inert for every other.

`findings.dependentCount` is computed from the stored edges at run time — counting
**distinct dependents**, not edges (a service called from three call sites by one
neighbour has one dependent, not three). The scoring engine therefore reads a
number and never reconstructs topology.

Where Discovery and Risk disagree about the inventory, matches are made on a
normalized service key, and a service the Risk Agent rated but Discovery never
listed becomes a finding carrying its reasoning, with the structured rubric fields
conservatively defaulted and the discrepancy reported.

### 5. Shared tools implemented

`createSharedTools` builds `queryKnowledgeBase`, `checkApiHealth`, and
`getTrafficStats` **once** per run; Architecture and Risk receive the same
instances. The test asserts object identity of the tool that actually ran in both
branches, not merely that both branches called something similarly named.

Tool policy per agent is explicit: Discovery and Architecture get the knowledge
base; Risk additionally gets the operational tools; Comparison gets **none**,
because retrieval would let the evaluator rewrite the analysis it is grading.

The knowledge base is the *existing* RAG pipeline (expansion, rerank, grounded
answer) behind a `KnowledgeSource` port — not a second, cheaper implementation for
agents. Operational signals read the `operational_data` table and return an honest
"no data" when empty, and `ToolContext` scopes every call to the run's project.

### 6. Critique / refinement behaviour

`critique.ts` is pure and dependency-free. Contract: after trimming whitespace and
trailing sentence punctuation, the critique must equal `complete`,
case-insensitively. `"Complete"` → complete; `"Complete except…"`, `"Complete,
but…"`, `"Complete with…"`, `"Incomplete"`, empty, and `null` → **not** complete.
Interior punctuation is never stripped, which is what stops `"complete, but the
schema was skipped"` collapsing into the token.

`refinement.ts` enforces the one-round bound **structurally**: straight-line code
with no loop and no recursion, so no code path can request a second refinement.
Tests assert `critiqueCalls === 1` always — there is no second critique, therefore
nothing that could start a second refinement — across eight different critique
inputs.

### 7. Run-state persistence

`pending → running → discovery → architecture → risk → comparison → complete`,
or `failed` with the stage and message. Persisted to `analysis_runs` at every
transition, so a poller reads progress from the database.

**Schema change**: `run_status` gained `pending` (migration
`0001_spooky_brood.sql`, applied). This fixes a real ambiguity in the M0 default:
a row created but not yet started previously claimed to be `running`. Now a process
that dies between create and start leaves a visibly `pending` run instead of an
invisibly `running` one.

Failures persist before they propagate: the runner catches, marks `failed` with the
stage it died in and the message chain unwrapped from the framework's wrapper, then
rethrows `AnalysisFailedError`. A failed run never writes partial results, and a
store that is itself broken does not replace the original error.

The server action creates the run and returns immediately, executing it via
`after()` — so the page shows a run that exists and is pending rather than a request
that appears to hang.

### 8. Tests added, and what they prove

| File | Tests | Proves |
|---|---|---|
| `critique.test.ts` | 17 | the four required cases, the `"Complete except…"` trap, whitespace/case/punctuation contract, silence-is-not-approval |
| `refinement.test.ts` | 9 | one refinement maximum; critique called exactly once for eight critique shapes; refinement failure surfaces instead of silently keeping the draft |
| `schemas.test.ts` | 40 | brace-in-string JSON extraction, validation failures naming fields, enum rejection, dependency-type normalization table, self-edge/duplicate removal, rubric fields required |
| `tool-loop.test.ts` | 11 | tool execution, scope pass-through, assistant `tool_calls` echo, unknown tool / bad JSON / thrown tool all fed back as text, iteration ceiling with `stoppedEarly` |
| `tools/tools.test.ts` | 26 | answer+sources formatting, source de-duplication, honest empty retrieval, failures as text, service-name matching across conventions, shared-instance identity, per-agent tool policy |
| `graph.test.ts` | 23 | Discovery first; both branches receive Discovery; Comparison receives all three; branches finish before the join; **real concurrency** (rendezvous); join runs once; no second refinement; extraction retry bounded; shared tool identity and project scoping; failure stops the join; stage transitions reported once each |
| `persistence.test.ts` | 18 | distinct-dependent counting, risk-rating precedence, cross-convention name matching, undiscovered services kept, dependent count attached to the right finding, idempotent per-run writes, other runs untouched |
| `run.test.ts` | 17 | pending → running → steps → complete; each stage persisted; results written before completion; ownership refusal creates no run row; failures marked `failed` with stage + message; failed runs write no partial results; broken store does not mask the error |
| `run.integration.test.ts` | 11 | live Postgres: complete run with all four narratives; findings with rubric inputs; edges with projectId **and** runId; dependent count derived from edges; a second run adds a separate graph; foreign session refused with no run row; run invisible to another owner on read; failure persisted as `failed` in the right stage; created-but-unstarted run stays `pending` |

M3 added **172** tests (per-file counts above are from `--reporter=json`, not
estimated); the whole suite is 366.

### 9. Verification — actual command output

| Command | Result |
|---|---|
| `pnpm lint` | clean — no output, exit 0 |
| `pnpm typecheck` | clean — no output, exit 0 |
| `pnpm test` (no `DATABASE_URL`) | **347 passed, 19 skipped** (22 files passed, 2 skipped) |
| `pnpm test` (with `DATABASE_URL`) | **366 passed (366)**, 24 files |
| `pnpm build` | ✓ compiled; routes `/`, `/api/ask`, `/_not-found` |
| `pnpm db:migrate` | `[✓] migrations applied successfully!` |
| `psql: select unnest(enum_range(null::run_status))` | `pending, running, complete, failed` |

The M3 integration suite in isolation (`vitest run src/lib/agents/run.integration.test.ts`):
`Test Files 1 passed (1) / Tests 11 passed (11)`.

### 10. Bugs found by tests during M3 (fixed, not worked around)

1. **LangGraph node/channel name collision** — the four state channels shared names
   with the four nodes, which the library rejects outright. Every graph test failed
   with `discovery is already being used as a state attribute`. Nodes are now
   prefixed; channels keep the domain names.
2. **Dependency-type normalization missed camelCase** — the boundary-anchored regex
   classified `"SyncCall"` as `unknown`. Found by the normalization table test.
3. **Tool scoping would have blanked the project id** — an intermediate
   `scopedTools` wrapper spread an empty context over the real scope. Caught by
   review before it ran; the design was simplified to thread the real `ToolContext`
   from graph state, and `graph.test.ts` now asserts every tool call carries the
   run's project id.
4. **Edge normalization was only half-applied** — `buildPersistencePlan` relied on
   the graph having cleaned the edges. It now normalizes too, so a direct caller
   cannot write duplicates into the table.
5. **A test fixture asserted a dependent count on a service absent from the
   inventory** — the assertion, not the code, was wrong; the fixture was extended.

### Known limitations

- **No real model has ever run this pipeline.** The graph is exercised end to end
  with a scripted fake. The DeepSeek client's `chat`/tool-call wire format is
  written from the OpenAI-compatible spec but has never made a real HTTP call, so
  the *orchestration* is proven and the *integration* is not.
- **Comparison has no ground truth to compare against.** M1 excludes `ground-truth/`
  from ingestion (so the pipeline cannot retrieve the answer it is graded against)
  and nothing has added a separate store for it. The Comparison prompt degrades to
  an internal-consistency evaluation and says so explicitly.
- **The risk/architecture agents' self-critique is bounded to one round and
  unconditionally accepts the refinement's output** — the refined report is not
  re-critiqued. That is the documented cost/quality tradeoff, not an oversight.
- **`pending` runs are not reaped.** If the process dies mid-run, the row stays
  `pending` (or `running`) forever; nothing marks stale runs failed on startup.
  Worth a startup sweep once runs are long enough for it to matter.
- **Retrieval quality is unmeasured.** Dependency edges and rubric inputs are only
  as good as what the model extracts, and no run has been scored against a
  reference yet.
- **No `/admin/traces` yet** (M6), so the spans this layer emits via `withSpan`
  are written but not rendered.

### M4-facing contract, as delivered

```
Discovery
  ├── services[]  { name, riskLevel, riskFactors, recommendation,
  │                 hasTestCoverageGap, dataQualityIssueCount, requiresMajorRestructuring }
  └── dependencies[] { from, to, type, evidence }        → service_dependencies (per runId)
                                                          → findings.dependentCount
          ↓
Architecture (approach, proposedServices, keyTechnologyChoices,
              currentArchitectureLargelySound, phasedPlan)
Risk (ranked[] with riskLevel + evidenceSource, operationalDataAvailable)
          ↓
Comparison (matched[], missed[], incorrect[], accuracyAssessment)
          ↓
analysis_runs row: status, step, four narratives
```

Everything M4 needs is persisted. Nothing in M4 should need to re-derive topology
or re-parse prose.
