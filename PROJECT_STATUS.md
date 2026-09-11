# Project Status — Migration Compass (V2)

Tracks implementation against `PROJECT_PLAN_V2.md` using the milestone breakdown
in `v2/IMPLEMENTATION_PLAN.md`.

**Rules for this file:** a milestone is only marked complete once its
verification commands have actually been run and their real output is recorded
here. M0–M3 are committed as `9b9dda5`; all M4–M7 work sits uncommitted in
the working tree.

Last updated: **M7 implemented and unit-tested, and partly browser-verified.** The
analysis lifecycle (persisted stages, polling, automatic refresh, structured logging),
the **Analysis Report**, per-service findings, the graph text alternative, the error and
empty states, owner-scoped not-found and the accessibility gaps in those surfaces are
built. The page, the scorecard, the report, the dependency text list, the graph canvas
and `/admin/traces` have been loaded in a real browser on the seeded demo project — the
scorecard and report at three widths — and exactly what that did and did not cover is
recorded in §4 (*Verification actually performed*) and §5 (*What is still not verified*)
of the M7 section. The React Flow rendering defect is still open (see the Consolidated
defect-fix pass at the end of this file), the whole suite has not been re-run since the
report landed, and no live model call has ever completed. Milestones are not marked
complete; each states which of implemented / test-verified / browser-verified applies.

**Ownership model, as implemented:** anonymous, session-scoped isolation. A random
`ownerId` lives in an httpOnly cookie (`mc_owner`, 30 days), every create path mints one
and every read path filters on it, and there is no account, login, OAuth provider,
magic link or RBAC anywhere in the codebase. It is a visibility scope, not a credential
(see `src/lib/session.ts`).

Status vocabulary used in this file, so a reader can tell the difference:

- **implemented** — the code exists and is reachable.
- **tested** — automated tests exist and have actually been run, with the result recorded here.
- **browser-verified** — a page was actually loaded in a browser and what it rendered was
  inspected; this file always names which surfaces and at which widths, because "rendered
  and inspected" is weaker than "driven by hand", and both are weaker than "verified complete".
- **verified complete** — the milestone's own acceptance criteria (including any manual or
  browser checks) were performed and passed.
- **known limitation** — a real, current gap, recorded whether or not it is scheduled work.

---

## Summary

| Milestone | Scope | Status |
|---|---|---|
| M0 | Scaffold: Next.js app, Drizzle schema, OTel→Postgres, pino, env | ✅ complete |
| M1 | Ingestion: upload, extraction, chunking, embedding, duplicates | ✅ complete |
| M2 | RAG + Ask: multi-query, rerank, retrieval, ask bar | ✅ complete |
| M3 | Agent orchestration (LangGraph.js) + dependency extraction | ✅ complete |
| M4 | Scoring engine, scorecard, dependency graph | ⚠️ implemented, not verified complete — graph rendering unresolved (§11) |
| M5 | Operational data + refinement | ⚠️ implemented and tested; scoring path verified against a live database in both directions; the refinement controls have been rendered and inspected, but not driven |
| M6 | Tracing UI (`/admin/traces`) | ⚠️ implemented and unit-tested; route builds; the page has now been loaded in a browser against stored spans; `trace-store.ts` (the read layer) still has no integration test, and the numeric span kind is open |
| M7 | Polish: progressive disclosure, states, accessibility, **analysis report**, analysis lifecycle | ⚠️ implemented and unit-tested, and browser-verified for the main surfaces — report (incl. per-service findings), theme, ask handoff, graph text alternative, run progress, loading/empty/error states and owner-scoped not-found are built; the run/error/loading states and the graph canvas have not been driven in a browser |

The current visual system (tokens, surfaces, measures) and the report's composition are
recorded in the M7 section under *Theme* and *Report composition*, and the browser checks
that were actually performed under §4 (*Verification actually performed*).

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

**Correction (found during M4).** The sentence above was wrong in one respect:
the dependency edges and findings were persisted, but the *structured* outputs of
Architecture, Risk and Comparison were not — only their narratives were. M4 needs
the architecture's `phasedPlan` length for the effort formula and
`currentArchitectureLargelySound` for readiness, so discarding them meant M4 would
have had to re-parse prose, which the brief forbids. Migration `0002` therefore
adds four nullable `jsonb` columns (`discovery_output`, `architecture_output`,
`risk_output`, `comparison_output`) written by the same `complete()` call that
already wrote the narratives. See M4 §7.

---

## M4 — Deterministic scoring, scorecard, dependency graph ⚠️

Status: **implemented and test-verified; not verified complete.** Two items from
the brief's manual checklist failed (the dependency graph does not render its
edges, and no analysis has been produced by a live model). Both are recorded in
§10 and §11 rather than smoothed over.

### 0. The blocking regression, fixed first

Submitting the home page failed with:

```
A "use server" file can only export async functions, found object.
```

Cause: `src/app/actions/upload.ts` is a `"use server"` module and exported
`initialUploadState`, a plain object. Next.js requires every export of such a
module to be an async function.

Fix: moved `UploadState` and `initialUploadState` into a normal module,
`src/app/actions/upload-state.ts`; `upload.ts` imports the type and keeps its
`"use server"` directive and all error handling; `upload-form.tsx` imports the
initial state from the new module. The whole `src` tree was swept for other
`"use server"` modules exporting non-functions — `analysis.ts` and `projects.ts`
export only async functions, so `upload.ts` was the only offender.

Verified: `pnpm typecheck`, `pnpm lint` and `pnpm build` clean, 366 tests passing
(the M4 test files did not exist yet), and the home page loads in a real browser
with no Server Action error.

### 1. Files created / changed

```
v2/src/lib/scoring/
  assumptions.ts        every tunable number, in one place, with rationale
  weights.ts            equal + dependency risk weighting
  rubric.ts             risk, effort, time, cost, readiness, evidence assessment
  explain.ts            per-score contributions and factors (no LLM prose)
  loader.ts             persisted rows → ScorecardInput, zod-validated on read
  rubric.test.ts  explain.test.ts  sample-fixture.test.ts  scorecard.integration.test.ts
v2/src/lib/graph/
  build-graph.ts        pure graph model: dedupe, cycles, layered layout, risk colours
  build-graph.test.ts
v2/src/lib/fixtures/archive.ts          reproducible directory → zip packing
v2/src/lib/testing/sample-fixture.ts    test-side access to the fixture
v2/src/components/
  scorecard.tsx         the five scores + confidence + expandable arithmetic
  dependency-graph.tsx  React Flow renderer
v2/scripts/
  seed-sample.ts        pnpm seed:sample
  demo-run.ts           pnpm demo:run
v2/src/app/actions/upload-state.ts
fixtures/sample-legacy-api/**           24-file synthetic legacy system
fixtures/sample-legacy-api.expected.json
```

Changed: `upload.ts`, `upload-form.tsx`, `project-list.tsx` (scorecard section),
`app/page.tsx` (loads scorecards), `db/schema.ts` (+4 jsonb columns),
`lib/agents/{run,stores}.ts` (+`RunOutputs`, `latestCompletedRun`), `run.test.ts`,
`package.json` (+2 scripts), `v2/README.md`, root `README.md`.

### 2. The rubric as implemented

Risk level values are the documented ones (`critical 100 / high 75 / medium 50 /
low 25`). Both weighting modes exist: `equal`, and `dependency`, where a service's
weight is `1 + distinct dependents` — so with no edges recorded the two modes are
identical by construction, which is asserted rather than assumed. `dependentCount`
is read from the column M3 derived from the edges; M4 never reconstructs topology.

```
effort     = clamp(1 + 9 × (0.3·norm(services,12) + 0.2·norm(phases,6)
                            + 0.3·risk/100 + 0.2·shareMajorRestructuring), 1, 10)
time       = effort band, then ÷ √(teamSize / referenceTeamSize)
             bands: 1–2 → 4–8w · 2–4 → 8–16w · 4–6 → 13–26w · 6–8 → 26–39w · 8–10 → 39–52w
cost       = (durationWeeks × teamSize) × weeklyRate        (default 5, USD 6,000)
readiness  = clamp(55 + 25·architectureSound + 20·(1 − risk/100)
                      − 15·((effort−1)/9) − 15·shareMajorRestructuring
                      − 10·shareCoverageGap − 5·min(issuesPerService/4, 1), 0, 100)
```

One deliberate adjustment: the plan's band table overlaps (effort 4 tops out at 16
weeks while effort 5 starts at 13), so each band's floor is raised to the previous
band's ceiling — 16–26 weeks for the third band, still inside the documented
"3–6 months". Without it, *more* effort could estimate *less* time.

The engine has no imports from React, Next.js, the database, the LLM client or the
network; the whole rubric suite runs with no infrastructure.

### 3. Confidence and explanations

`confidence.label` is always `code-only estimate` in M4 — operational refinement is
M5, so claiming anything else would be false. Alongside it sits an evidence quality
(`strong` / `partial` / `limited`) computed from what was actually available:
number of findings, presence of typed edges, presence of an architecture output,
coverage of the risk ranking, and whether the comparison stage reported anything
missed. The reasons are listed, so a downgrade is traceable — and in the fixture
integration test the single reason is the comparison miss, not a missing input.

`explain.ts` produces structured contributions, not prose: the additive scores
(risk, effort, readiness) show labelled rows that sum to the score, and the UI
states whether they do — or says the value is unreliable if they ever don't.
Time and cost are products, so they expose factors instead of a fake sum, and
`additive: false` says so. Risk contributions are ordered biggest-first.

### 4. Scorecard and dependency graph UI

Both live on the continuous page inside the project row, as opened-by-default
`<details>` (the scorecard is the headline artifact) with per-score disclosure
inside. The scorecard shows value, confidence tags, a one-line summary, the
formula, the contribution table, and the assumptions in force. The graph draws the
persisted edges: typed labels, risk-coloured nodes, deterministic layered layout,
pan/zoom, click-to-expand, and a service known only from an edge drawn as
*unrated* rather than guessed. See §10 for what actually renders.

### 5. Sample fixture

`fixtures/sample-legacy-api/` — 24 files, three services
(`customer-service → order-service → payment-service`) plus one external gateway,
written to contain what an assessment should notice: JAX-RS controllers, service
classes, JDBC repositories with string-concatenated SQL, synchronous
`HttpURLConnection` calls with no idempotency key, property files, a service with
no test tree at all, denormalized customer names, money stored as `DOUBLE`, and one
service needing major restructuring. `fixtures/sample-legacy-api.expected.json`
beside it records what it is designed to expose (kept outside the ingested
directory so it cannot leak into retrieval), and a test asserts the fixture's own
Java files match that expectation.

### 6. Seeding, and the bug it exposed

```
pnpm seed:sample      # idempotent; --owner <id>, --override
pnpm demo:run         # completed run for the demo, no model call
```

`seed:sample` packs the fixture and submits it through the real ingestion path —
same guards, chunker, duplicate detection, embeddings and store as an upload.

**Bug found:** a second `pnpm seed:sample` created a *second* project instead of
reporting the duplicate. The archive was built with "now" as every entry's
modification time and in filesystem iteration order, so the bytes — and therefore
the content hash the duplicate check uses — differed on every run. Fixed by
sorting entries and pinning a fixed mtime in `lib/fixtures/archive.ts`; a
regression test asserts two builds are byte-identical. Verified: three consecutive
runs, one project, `Reused` on runs 2 and 3.

`demo:run` exists so the scorecard can be demonstrated without an API key. It
drives the real stores and the real graph with a scripted model, and prefixes every
narrative it writes with `[DETERMINISTIC DEMO RUN — ... no model was called]` so a
demo run can never be mistaken for a model-derived one.

### 7. The one additive M3 change

Four nullable `jsonb` columns on `analysis_runs` (`discovery_output`,
`architecture_output`, `risk_output`, `comparison_output`), written by the existing
`complete()` call. M3 already computed these validated objects and threw them away;
M4 cannot re-derive them from narratives without prose parsing, which the brief
forbids. This change persists data M3 already had — it is not a change to the
graph, the agents or the orchestration. Migration `0002_dry_scarlet_spider.sql` was
generated and applied.

### 8. Tests added

154 new tests across 5 files (85 rubric, 28 explanations, 17 graph, 13 database-backed
integration, 11 fixture): rubric boundaries, both weighting modes, effort
monotonicity and clamping, time bands and their adjustment, cost sensitivity to
each of its three inputs, readiness across high/low/major-restructuring scenarios,
empty input, deterministic repeated execution, explanation contributions and their
sums, assumption exposure, graph construction (empty, single, fan-out, fan-in,
typed edges, cycles, duplicate/self-edge/blank-endpoint suppression, risk metadata,
determinism, the fixture graph), fixture↔source consistency, and a database-backed
fixture → analysis → scoring suite. No existing test was weakened.

### 9. Verification — actual output

```
pnpm typecheck                          clean (exit 0)
pnpm lint                               clean (exit 0)
pnpm build                              ✓ Compiled successfully; / and /api/ask dynamic, /_not-found static
pnpm test    (with DATABASE_URL)        520 passed (520), 29 files
pnpm test    (no DATABASE_URL)          488 passed | 32 skipped (520), 26 passed | 3 skipped files
pnpm test:integration                   8 passed (8)
pnpm db:generate                        0002_*.sql generated
pnpm db:migrate                         applied (verified: 4 new columns on analysis_runs)
pnpm seed:sample                        24 files → 24 chunks, real Ollama embeddings
                                        (sha256 7a8a6fcec17f…); runs 2 and 3 → "Reused"
pnpm demo:run                           Readiness 33.2/100 · Risk 83.3/100 · Effort 5.1/10
                                        · Cost USD 711,000 · Time 21.3–26 weeks
                                        (mid 23.7) · code-only estimate · partial evidence
```

Embeddings were real (`nomic-embed-text` via Ollama, 768-dim). The one attempt at a
*live model* run failed on credentials, and was recorded as such:

```
status failed · step discovery
LLM request failed (401 Unauthorized): {"error":{"message":"Authentication Fails,
Your api key: ****388a is invalid", ...}}
```

Worth recording as a positive: the failure produced a persisted `failed` run with
the failing stage, not an ambiguous in-progress one — the M3 run-state guarantee,
now exercised against a real external failure rather than a fake one.

Browser verification (production build, `http://localhost:3001`): hydrated, and the
five scores, their confidence tags, the assumptions and the full arithmetic render
with no interaction. Read from the rendered DOM: readiness `33.2 / 100`
(contributions 55 − 0 + 3.33 − 6.77 − 5 − 10 − 3.33 = 33.23), risk `83.3 / 100`
(payment-service 33.33 + customer-service 25.00 + order-service 25.00 = 83.33),
effort `5.06 / 10`, cost `USD 711,000` from `118.5 person-weeks × USD 6,000` — the
same numbers the command-line read-back produced from the database.

### 10. Manual verification — pass/fail, as it actually went

| # | Check | Result |
|---|---|---|
| 1 | Home page loads without the Server Action error | pass |
| 2 | Upload functionality still works | **partial** — the form renders and the ingestion path it calls is exercised end-to-end by `seed:sample`; a file has not been driven through the browser |
| 3 | Sample project can be loaded | pass |
| 4 | Sample project appears in the project list | pass |
| 5 | An analysis result can be viewed | pass, with the demo run (not a model run) |
| 6 | Five scores displayed | pass |
| 7 | Score explanations visible | pass (each score expands in place) |
| 8 | Confidence tags visible | pass |
| 9 | Dependency graph renders | **FAIL at the time** — the failure mode has since changed; see §11 for what renders now |
| 10 | Service risk reflected in the graph | **FAIL at the time** — node risk colouring does render now; the edge geometry is what is wrong |
| 11 | No score produced by an LLM | pass by construction |
| 12 | Existing M3 functionality intact | pass (M3 suites green) |

### 11. Known limitations

- **The dependency graph does not render correctly — the failure mode has changed
  since it was first recorded.** The M4-era observation was that nodes stayed
  `visibility: hidden` and no edge paths existed at all (hydration, stylesheet
  loading, container sizing and the dev-origin restriction were ruled out at the
  time; an unrelated stale process holding `127.0.0.1:3000` muddied the diagnosis).
  A later browser check on the demo project found something different: **all four
  nodes render** — visible, with labels, risk level, dependent counts and
  risk-coloured borders, 256px wide — and **three edge paths are emitted** with the
  right stroke colours (synchronous calls in the accent, external API in slate) and
  real `d` geometry, but that geometry is wrong: the connectors arc well above the
  node row instead of joining node to node, a small unstyled control rectangle sits
  at the canvas's left edge, and the canvas reserves ~200px of height for ~40px of
  content. The graph *model* (`src/lib/graph/build-graph.ts`) is correct and
  unit-tested; the defect is in the rendering layer, and the model must not be
  rewritten to work around it. The presentation passes deliberately changed only the
  surrounding chrome (heading, separator, well surface).
- **No model run has completed against a live API.** The key in `.env` is invalid
  (401). Everything downstream of the model is verified with a scripted model and a
  real database.
- **Comparison has no ground truth**: ground-truth directories are excluded from
  ingestion, so the evaluator grades internal consistency, and any gap it reports
  downgrades evidence quality to `partial`.
- **Scorecards are computed on read, not persisted.** `scorecards` exists from M0
  and M4 deliberately does not write it — recomputation is instant and cannot go
  stale. M5 will write it when user-adjusted assumptions need remembering.
- **Scores are always `code-only`**; no refined confidence until M5.
- No `/admin/traces` existed at M4 (it arrives in M6), so emitted spans had nowhere to
  render. It exists now, and has been loaded against stored spans — see the M6 section
  and §4.
- Stale `pending`/`running` runs are still never reaped.
- No authentication or RBAC — session-cookie scoping only, by design.

### 12. Bugs found and fixed during M4

1. **Repeat seeding created a duplicate project** (non-reproducible archive bytes) —
   fixed in `lib/fixtures/archive.ts`, regression test added.
2. **A dependency row with a blank endpoint drew a phantom node**, and an
   untyped row produced an edge id containing `undefined`. Fixed in
   `build-graph.ts` `normalizeEdges`: blank endpoints are suppressed, a missing
   type becomes `unknown`.
3. **`NODE_HEIGHT` used after its import was removed** while clearing a lint
   warning — a self-inflicted `ReferenceError` that broke the page's render. Caught
   by the browser check and then by `typecheck`; fixed by restoring the import.
   Recorded because it is the case for actually loading the page rather than
   trusting a green unit suite.
4. **Node height drift**: the declared `NODE_HEIGHT` (72) did not match the rendered
   box (~111 with two lines of text), which would have overlapped nodes in a
   multi-row layer. Fixed by pinning the node's height in its style.
5. **The headline scorecard was collapsed by default**, hiding the five scores
   behind a click. Fixed: the scorecard disclosure opens by default; the per-score
   breakdowns stay collapsed.

---

## M5 — Operational data + score refinement ⚠️

Status: **implemented and test-verified. The scoring path is verified against a live
database in both directions. Not verified complete:** no page was rendered in a browser
during this work, so the refinement form and the upload-time disclosure are typechecked,
lint-clean and built, but have never been exercised by a person.

### 1. What was built

```
v2/src/lib/scoring/
  operational.ts        file parsing + validation, signal derivation, bounded
                        bidirectional Risk adjustment — pure, no I/O
  parameters.ts         migration-parameter validation, parameter → assumptions
                        mapping, budget/timeline/environment assessment
  refine.ts             recomputeScorecard(): deterministic, synchronous, LLM-free,
                        network-free, vector-free recalculation
  assumptions.ts        + OPERATIONAL_RISK (bounds and thresholds), OPERATIONAL_KINDS,
                        TARGET_ENVIRONMENTS, PARAMETER_LIMITS
  rubric.ts             + ScorecardInput.operational; the adjustment enters Risk and
                        propagates through the rubric's own formulas
  explain.ts            + operational terms as contributions, + a clamping row so the
                        table still sums, + operational on ScorecardExplanation
  loader.ts             every load now goes through recomputeScorecard — one score
                        path, so a "baseline" and a "refined" implementation cannot drift
v2/src/lib/operational/
  repository.ts         owner-scoped Drizzle store: operational data accumulates,
                        parameters replace (one row per project)
  ingest.ts             shared FormData → OperationalFile reader (upload and refine)
v2/src/app/actions/refine.ts, refine-state.ts
                        refineEstimatesAction, removeOperationalDataAction
v2/src/components/refine-form.tsx
                        "Refine these estimates" (operational data + parameters)
fixtures/sample-legacy-api.operational/{healthy,degraded}/
                        app.log, health.json, incidents.json — the files a user attaches
```

Changed: `scorecard.tsx` (code-only vs refined framing, "was X" per score, refinement
detail), `project-list.tsx` (renders the refine form), `upload-form.tsx` (collapsed
"Add operational data for more accurate results" disclosure), `upload.ts` (attaches
operational data to the newly created project), `db/schema.ts` (unique index on
`migration_parameters.project_id`), `scripts/demo-run.ts`
(`--operational healthy|degraded|none`).

### 2. The recalculation contract, as implemented

`recomputeScorecard()` is a pure function over data the product already has: the
persisted structured findings and edges, plus optional validated operational entries and
migration parameters. Its module graph contains no model client, no embedder, no
retriever, no database and no `fetch`, so "zero LLM calls, zero network calls" is a
property of the file rather than a claim about call sites. It is asserted four ways:
a call-counting LLM stub, a call-counting embedding stub, a stubbed `globalThis.fetch`
that throws if touched, and a source scan of the scoring modules for forbidden imports.

**Run analysis** (agents, model, minutes) and **Refine these estimates** (this function,
arithmetic, instant) stay separate. Recalculation returns numbers; it cannot return a
narrative, because it never receives one. A test asserts the caller's input object is
byte-identical after a recalculation, and the database-backed test re-reads the run row
and asserts all four narratives and all finding rows are untouched.

Confidence keeps the plan's two-value vocabulary and neither value implies model
involvement: `code-only estimate` when no operational data applies, `refined with
operational data` once measured data has moved a number. The UI says the refinement is
parsed deterministically and that "no model was called".

Bidirectional Risk, bounded to ±15 points:

- measured error rate: credit up to −6 (at or below 1%), penalty up to +10 (at 10%+)
- measured availability: credit up to −4 (at 99.9%+), penalty up to +8 (at 99% or below)
- critical incidents: +3 each, capped at +8; other incidents +1 each, capped at +4
- incident data reporting nothing: −3 (evidence of stability)
- error density in logs: up to +4, and **penalty-only** — a clean log sample is not evidence of health

### 3. Schema change

Migration `0003_rainy_quicksilver.sql` adds a unique index on
`migration_parameters.project_id` — one parameter set in force per project, so a
re-submitted form is an update rather than a second opinion. Generated with
`pnpm db:generate`, applied with `pnpm db:migrate`, and confirmed in Postgres directly
(`\di migration_parameters*` shows `migration_parameters_project_idx`).

### 4. Tests added

| File | Tests | What they establish |
|---|---|---|
| `src/lib/scoring/operational.test.ts` | 21 | per-file rejection messages, incident/log/db-stats parsing, order-independent signals, both directions, the bound, penalty-only logs |
| `src/lib/scoring/parameters.test.ts` | 16 | blank ≠ invalid, range and enum rejection with actionable messages, parameter → assumption mapping, budget/timeline assessment |
| `src/lib/scoring/refine.test.ts` | 22 | zero LLM / zero embedding / zero network calls, forbidden imports absent, input not mutated, no narrative in the output, Risk moves both ways, clamping, team size affects time and cost, weekly rate affects cost only, a budget never lowers the estimate, determinism, empty input preserves the baseline |
| `src/lib/scoring/operational-fixture.test.ts` | 5 | the checked-in files parse; `healthy` lowers Risk; `degraded` raises it; both stay inside the bound |
| `src/lib/scoring/refine.integration.test.ts` | 9 | live Postgres: code-only baseline, refined reload, narratives and findings unchanged, operational data accumulates, parameters replace, foreign session refused, removal restores the baseline, determinism |

73 new tests. No existing test was weakened; the four pre-existing scoring files
(137 tests) pass unchanged, which is what makes "empty operational data preserves the
baseline" a claim about the code rather than a claim about a new code path.

### 5. Bugs found by these tests (fixed, not worked around)

1. **An incident report was classified as health data.** `payloadKind` checked health
   markers before incident ones, and an incident payload (`{service, window, incidents}`)
   matched none of them, so it fell through to the `health` default and its incidents were
   never counted. Found by the degraded fixture test — Risk came out lower than the data
   justified. Fixed by testing incident markers first.
2. **A `db_stats` file contributed nothing.** Database size was only read from
   health/traffic payloads, so a file supplied purely for data volume produced no signal
   and no explanation. Found by test; the reader now handles `db_stats` entries and the
   rendered reasons name the volume.
3. **The error-rate reason text counted services, not measurements.** A three-record
   health array reported "across 1 service(s)". Found by the fixture test; the count is
   now the number of measurements the mean was taken over.

### 6. Verification — actual command output

```
pnpm typecheck                       clean (exit 0)
pnpm lint                            clean (exit 0) — after fixing one unused import
                                     introduced during this work
pnpm test        (DATABASE_URL set)  588 passed (588), 33 files
pnpm build                           ✓ Compiled successfully; / and /api/ask dynamic,
                                     /_not-found static
pnpm db:generate                     0003_rainy_quicksilver.sql generated
pnpm db:migrate                      [✓] migrations applied successfully!
docker exec psql \di migration_*     migration_parameters_project_idx present
pnpm seed:sample                     Reused project bb6b9238-… (24 files, 24 chunks)
                                     — idempotent, unchanged from M4
pnpm vitest run src/lib/scoring      210 passed (210), 9 files   [after the M5 files
                                     and operational-fixture.test.ts had landed]
pnpm vitest run src/lib/scoring/refine.integration.test.ts
                                     9 passed (9)
```

Live refinement, read back from Postgres through the real loader:

```
pnpm demo:run                     (attaches the "healthy" fixture)
  Code-only baseline   readiness 33.2 · risk 83.3 · effort 5.1 · cost USD 711,000
  Migration Readiness  36.1 / 100
  Risk                 71.6 / 100 (-11.7 from operational data)
  Effort               4.7 / 10
  Cost                 USD 687,000
  Time                 19.7–26 weeks (3–6 months)
  Confidence           refined with operational data · partial evidence
  Risk breakdown       payment-service 33.3, customer-service 25.0, order-service 25.0,
                       Clean incident history -3.0, Measured availability -3.2,
                       Measured error rate -5.5

pnpm demo:run --operational degraded
  Code-only baseline   readiness 33.2 · risk 83.3 · effort 5.1 · cost USD 711,000
  Migration Readiness  29.9 / 100
  Risk                 97.1 / 100 (+13.8 from operational data)
  Effort               5.4 / 10
  Cost                 USD 738,000
  Time                 23.2–26 weeks (3–6 months)
  Confidence           refined with operational data · partial evidence
  Risk breakdown       payment-service 33.3, customer-service 25.0, order-service 25.0,
                       Measured availability 3.6, Error density in logs 3.2,
                       Measured error rate 3.0, Critical incidents 3.0,
                       Incident volume 1.0
```

That pair is the plan's bidirectional claim demonstrated end to end: the same code,
the same persisted findings, and measured data moving Risk down 11.7 points in one case
and up 13.8 in the other, with Effort, Readiness, Time and Cost following through the
rubric's own formulas.

### 7. Known limitations

- **The M5 UI was not rendered during that milestone's work.** The refine form, the
  upload-time disclosure and the refined-scorecard panels are typechecked, lint-clean,
  built and unit-typed, and the §10-style manual checklist is **not** satisfied for M5.
  (Later passes did render them — the refinement row and the refined scorecard panels
  were inspected in a browser, with the refined figures showing their movement from the
  code-only baseline — but they were not *driven*: no file was attached and no parameter
  was submitted from the browser. See §4 and §5.)
- **Operational data moves Risk only.** The plan mentions DB data volume as a plausible
  Effort input; here data volume and restart counts are *reported* and deliberately not
  scored, because no defensible threshold for them was established. Log evidence is
  penalty-only. Free-text incident reports are counted by declared severity keywords,
  which is all a keyword scan can honestly claim and is stated in the rendered detail.
- **Target environment and provider are recorded, not used.** They appear on the
  scorecard and in the assumptions; an infrastructure cost delta by target is not in the
  cost formula, and the UI says so.
- **A budget never lowers the estimate.** It is compared against the computed cost and
  reported as a conflict; folding it in would let a small budget produce a small cost.
- **The `scorecards` table is still never written.** The M4 decision holds — scores are
  computed on read. M5 persists the *inputs* (operational data, parameters) instead of the
  outputs, so there is no stale-score invalidation problem, and the schema decision to
  write scorecards "when user-adjusted assumptions need remembering" is satisfied by
  persisting the assumptions rather than the results.
- **`pnpm demo:run` now attaches the `healthy` operational fixture by default**, so a
  freshly seeded demo shows a refined scorecard. `--operational none` reproduces the M4
  code-only output; `--operational degraded` shows the other direction.
- **The `test:integration` script was changed and not re-run.** It went from a single
  hard-coded path to `vitest run integration.test.ts` (matching all three integration
  files). The individual suites were run and passed; the script itself was not executed
  after the change.

---

## M6 — Tracing UI (`/admin/traces`) ⚠️

Status: **implemented and unit-tested; the route builds; the page has been rendered in a
browser against stored spans. Not verified complete:** its database read path has no
integration test, and the numeric span kind is open.

### 1. What was built

```
v2/src/lib/observability/
  waterfall.ts       pure waterfall model: parent-link placement, duration maths,
                     nesting, ordering, orphan and cycle re-rooting, depth and span
                     caps, skipped-row reasons, credential redaction
  fixture-trace.ts   a deterministic 16-span fixture
  trace-store.ts     reads trace_spans back out; fails soft with a rendered reason
v2/src/components/trace-waterfall.tsx
                     server-rendered waterfall, <details> per span
v2/src/app/admin/traces/page.tsx      trace list, detail in place, fixture, and an
                                      explicit "what is not on this page"
v2/src/app/admin/traces/loading.tsx   the streaming/loading state
```

### 2. The waterfall contract

Placement is computed from `parentSpanId` alone, so input order cannot affect the
result — the tests assert a reversed, child-before-parent batch produces an identical
model. What the model refuses to hide:

- a span whose parent is not in the trace is drawn at the root and the trace is
  reported incomplete (as a span-level note *and* an aggregate issue);
- a parent cycle is detected by walking up the chain and re-rooted rather than followed;
- an unreadable row (no span id, unparseable timestamp, duplicate id) is skipped with a
  reason that is rendered, not swallowed;
- nesting beyond 32 levels is truncated and said to be;
- a stored duration that disagrees with its own timestamps is flagged, and a missing
  duration is recovered from the timestamps (the timestamps are the ground truth);
- **self time is the duration minus the union of the children's intervals**, not the sum
  of their durations — Architecture and Risk run concurrently, so summing siblings
  double-counted and reported a self time of zero for a busy root.

Credential-shaped attributes are replaced before rendering: keys matching
`authorization`, `api`, `token`, `secret`, `password`, `cookie`, `credential`,
`session`, `signature`, `bearer` (case-insensitively, at any nesting depth) and values
that look like a bearer token, an `sk-…` key or a JWT. The withheld keys are listed per
span so the omission is visible. A test asserts on the whole serialized fixture model
that none of its planted credentials survive.

### 3. Tests added

`src/lib/observability/waterfall.test.ts` — **18 tests**: normal nesting, depth and
ordering, self time and offsets, out-of-order input, orphan spans, deep nesting and
truncation, cycles, unreadable rows, duration recovery and disagreement, empty input,
determinism, trace-id resolution, redaction (keys, values, nesting, truncation), duration
formatting, and the fixture's own structure.

### 4. Verification — actual command output

```
pnpm typecheck               clean (exit 0)
pnpm lint                    clean (exit 0)
pnpm vitest run src/lib/observability
                             29 passed (29), 3 files — includes waterfall.test.ts
pnpm build                   ✓ Compiled successfully; routes now include
                             ƒ /admin/traces (dynamic)
```

The 18 waterfall tests were run in isolation. **The full suite has not been re-run since
they were added** (see "Final verification state").

### 5. Known limitations

- **The page was rendered late, and not against a full set of states.** `/admin/traces`
  builds as a dynamic route and has since been loaded in a browser, which showed the
  stored traces the application had written and the fixture waterfall. It has not been
  exercised with an empty trace table, with a query failure, or with a trace whose spans
  fail to parse — the states the page's own error and empty branches exist for. That,
  plus the untested query layer below, is why M6 is not marked complete.
- **The database read path is untested.** `trace-store.ts` (`listRecentTraces`,
  `listSpansForTrace`, `loadRecentTraces`) has no unit or integration test: it needs
  stored rows, and none had been written when it was built (spans are being written now —
  the page rendered them — but nothing asserts what the query returns). The pure waterfall
  builder underneath it is well covered; the query layer is not.
- **Real spans will render a numeric span kind.** The exporter stores
  `String(span.kind)`, which for an OTel `SpanKind` enum is `"0"`/`"2"` rather than
  `internal`/`client`. The fixture uses names, so the page looks right on the fixture and
  will show digits on real traces. A rendering-layer defect for the consolidated pass.
- **Spans carry no owner id**, so the page is an environment-gated operations surface
  (`ADMIN_TRACES_ENABLED`), not a per-session view. It must not be presented as an
  authorization boundary, and the page says so itself.
- **No live tail.** The page reads what has been flushed to Postgres; spans still in the
  batch processor's buffer are not shown. The list is capped at the 20 most recent traces.
- **The fixture is not a real trace.** It is synthetic, labelled as such on the page, and
  exists so the surface is reviewable without a model credential.

---

## M7 — Polish, the Analysis Report, the theme, and the analysis lifecycle ⚠️ IMPLEMENTED, PARTLY BROWSER-VERIFIED

Status: **implemented and unit-tested; verified complete is not claimed.** Every
implementation item is built (the report, per-service findings, the graph text
alternative, the ask handoff, the theme and report composition, the analysis lifecycle,
loading/empty/error states, owner-scoped not-found, and the accessibility gaps in these
surfaces), and the main surfaces have since been rendered and inspected in a real browser
at 1680 / 1100 / 414px — the page, scorecard, report, dependency text list, graph canvas
and `/admin/traces`. What is still *unverified* is everything that needs a hand or a
failure: expand/collapse driven by a person, focus movement, the error / not-found /
loading / in-flight-progress states, and a screen-reader pass. §4 records exactly what was
looked at, and §6 what remains.

### 1. What was built

**Analysis Report** — the explanation layer beneath the scorecard. The scorecard states
five numbers; the report states what was discovered, why the numbers are what they are,
and what the migration considerations are. It is **composed, not generated**: no second
model pass exists, and the composer performs no fetch.

```
v2/src/lib/report/
  types.ts                 the report model (client-safe: no runtime imports)
  builder.ts               buildAnalysisReport(): pure composition over persisted data
  sources.ts               listIndexedSources(): one grouped, owner-joined read over
                           `chunks` — path, document type, chunk count; never content
  builder.test.ts          44 tests
  sources.integration.test.ts   4 tests against live Postgres
v2/src/components/analysis-report.tsx       the seven sections, behind <details>
v2/src/components/analysis-report.test.tsx  11 rendering/a11y/handoff tests
v2/src/lib/ask-handoff.ts                 the handoff channel into the ask bar
v2/src/lib/ask-handoff.test.ts            6 tests
```

The report reads only what the pipeline already persists — the four validated structured
outputs, the findings, the dependency edges, the indexed source inventory and the
scorecard's explanations — so **no schema change and no migration were needed**. Sections:
Executive Summary, System Discovery, Architecture Analysis, Risk Analysis, Findings by
Service, Migration Considerations, Effort and Cost Explanation, Evidence.

**Analysis lifecycle** — the run's persisted stages are now visible, and a completed run
no longer needs a reload or an application restart to appear:

- `step` advances `discovery` → `architecture`/`risk` → `comparison` → `finalizing` →
  `done`; `finalizing` is new and is the results write (migration `0004`).
- The stage a run is in is persisted and read back by an owner-scoped server action; a
  client component polls it every 4s while the run is unfinished and asks the router to
  re-render once the persisted run reaches `complete` or `failed`.
- A failed poll or an unreadable run keeps the last known state on screen and retries —
  it never claims a run finished, and never claims one vanished.

**The bug this fixed:** the page is a server render, and the only refresh it got was the
server action's `revalidatePath("/")`, which fires while the run is still `pending`. A
long run therefore displayed "Analysing…" indefinitely while the database already held
the completed run and the scores; a fresh request showed the truth. There was no polling,
no revalidation and no client watcher anywhere in the tree.

**Logging** — one structured line per lifecycle event (start, each stage's start and
completion with `durationMs` and tool-call counts, ingestion, retrieval, finalization,
completion, failure) carrying `projectId`, `runId` and `stage`. Nothing logs source
contents, prompts or credentials. A failure line carries the cause chain as text, because
an `Error`'s message is not an enumerable property and would otherwise serialize to a
shape with no explanation in it.

**Other M7 work in the same pass:** an Ask handoff from report sections and findings into
the existing ask bar (prefill + focus + the origin shown; still one conversational
surface, still an explicit Ask press); a home-page loading state (`src/app/loading.tsx`);
the ask bar's textarea now has an accessible name; the destructive project button now
carries a project-specific accessible name.

**Per-service findings, outside the graph.** The report gained an eighth section,
**Findings by Service**: one disclosure per service, carrying its severity, the rubric's
structured inputs (restructuring, coverage gap, data-quality issues, dependents), the
Discovery stage's recommendation and risk factors for it, the rubric's level value, the
evidence source behind the rating, and what it calls and is called by — the latter read
from the graph model, so this view and the diagram cannot disagree. Services that appear
only as an endpoint of an edge are listed explicitly as **unrated**, which is the fact
rather than an omission (they are otherwise invisible outside the graph). The section is
capped at 40 items with the real count still stated, and each service carries its own Ask
control. It reads the same persisted findings the rest of the report does: nothing new is
computed and no model is involved.

**Graph text alternative.** `src/components/dependency-list.tsx` renders the same
`DependencyGraphModel` the React Flow canvas draws — as headings, sentences and lists:
every recorded edge ("X depends on Y — synchronous call (critical risk source, unrated
target)"), every service with its risk, dependents and outgoing dependencies, circular
chains named in dependency order, and a note when duplicate/self edges were suppressed.
No SVG, no colour-only severity, no second derivation of the topology. It is open by
default and collapsible, because the visual layer has a known rendering defect and the
text list is the reliable view until that is fixed.

**Error states.** The page's reads now distinguish a failure from an empty result. The
project-list read returns an outcome, and a failure renders an explicit error panel
(`src/components/error-notice.tsx`) instead of the "No projects yet" panel — the previous
behaviour stated, falsely, that the reader had no projects when the database was
unreachable. A per-project scorecard/report read failure renders its own notice on that
row, keeping the row usable (run again, delete). The analysis failure state gained a
recovery sentence and `role="alert"`; the ask bar's error region is an alert too (the Ask
button is the retry); `/admin/traces` already had a query-failure reason and an empty
state. Nothing renders a database message: a connection error can carry a URL with a
password in it, so the rendered text says what failed and the log line carries the
diagnostic — asserted by a test that plants a password in the thrown error.

**Owner-scoped not-found.** Deleting or analysing a project the session cannot see now
ends in `notFound()` and a rendered `src/app/not-found.tsx`, rather than a silent
success. Missing and unauthorized are one outcome on purpose: distinguishing them would
confirm that another session's project id exists, and the not-found page says exactly
that much. A malformed submission (no project id) is not a missing resource — it returns
without a lookup and without a not-found. The polling action still answers "absent" for a
project it cannot see, because a poll must never navigate a reader into a 404 mid-watch.
Form actions that return state (`refineEstimatesAction`, `removeOperationalDataAction`)
keep their existing pattern and report an owner-scoped miss as an error state — a form
result, not a page boundary. There is no per-project or per-resource route in V2 (the
project is one continuous page, and trace detail expands in place), so the boundary is
reached from actions rather than from route segments; `notFound()` is supported in server
functions as well as server components, per the bundled Next documentation. `/api/ask`
already answered `404` for a project the session cannot see, and is unchanged.

**Theme (two passes; the second is the one in the tree).** The first pass moved a
near-black canvas with a bright blue accent to a navy/slate foundation — and was too
subtle to see: page `#0b0f14` → `#0f1420` is a CIE L* step of about 1, so the running UI
looked unchanged. The second pass rebuilt the ramp around **perceptible** steps and is
what `globals.css` now holds:

| Role | Token | Value | Notes |
|---|---|---|---|
| Page | `--background` | `#070b16` | deep navy, not black |
| Panel | `--surface` | `#121a2e` | |
| Raised tile | `--surface-raised` | `#1e2745` | scorecard tiles, takeaway cards, canvas nodes |
| Inset well | `--surface-inset` | `#0b1120` | code blocks, the graph canvas |
| Border | `--border` / `--border-subtle` | `#2f3b61` / `#242e52` | |
| Text | `--foreground` / `--muted` | `#eef1fb` / `#a4adcb` | |
| Primary | `--accent` / `--accent-ink` | `#8b96ff` / `#070b16` | indigo/periwinkle; actions, links, selected state |
| Secondary | `--accent-cyan` | `#63c9dd` | one more hue where it is informative (asynchronous edges) |
| Risk | `--risk-critical` … `--risk-unknown` | `#f56a72`, `#f08a4b`, `#e6bd5c`, `#5cb87f`, `#8b95b3` | the *only* semantic palette: success, warning, error and "unrated" all resolve to it |

Adjacent surfaces differ by ≈6.5 points of CIE L* (page 3 → panel 10 → tile 16; the well
sits at 5), which is what makes the hierarchy visible rather than nominal. Four surfaces
and nothing nesting deeper; the shared vocabulary in `globals.css` is small and named by
intent — `.panel` / `.panel-quiet` / `.panel-bare` / `.tile` / `.well`, `.eyebrow` /
`.caption` / `.meta` / `.measure` / `.report-measure` / `.report-prose` / `.report-lede`,
`.btn` + `primary`/`secondary`/`ghost`/`quiet-danger`, `.chip-accent`, `.row-disclosure`
with its rotating `.marker`, `.masthead-rule`, `.note`, plus a global `:focus-visible`
outline. Every colour in the application resolves to a token: there are **no colour
literals in `src/components` or `src/app`** (the dependency graph's edge palette was moved
into tokens — `--edge-sync`, `--edge-async`, `--edge-shared-db`, `--edge-external`,
`--edge-unknown`), and there is no new framework, icon library or design-system package.

Contrast was checked numerically, not by eye: `--muted` is 7.8:1 on a panel and 6.6:1 on a
raised tile, every risk colour is ≥4.8:1 on a raised tile, the accent is 6.5:1 as text on a
panel and 7.4:1 as ink on the accent — all at or above WCAG AA for body text.

**Report composition (two passes; the second replaced the first outright).** The first
pass treated the report as a document *inside* the dashboard and capped its container at
`42rem` — which left roughly half a 1600px dashboard empty and made the report read as a
narrow article embedded in the product. That cap is gone: the report is a **chapter of the
assessment surface** and its container spans the dashboard, while readability is enforced
on the text instead.

- **Masthead** — `Analysis Report` at 22px semibold, a one-line subtitle, and a secondary
  metadata line assembled from the sections' own counts ("3 findings · 3 dependency edges ·
  24 indexed files · partial evidence"; a label the run did not record is simply omitted).
  A `.masthead-rule` (hairline plus a short accent segment) marks it as a new chapter after
  the scorecard, and the scorecard's own masthead uses the same scale, so the two halves
  read as one surface rather than two panels.
- **Executive summary** — the lede paragraph (17px, full-contrast) beside its supporting
  paragraphs (14.5px, muted) in two columns from `xl` up, each capped by
  `.report-measure` at 40rem (≈79 characters). One paragraph alone renders full width
  rather than leaving half the band empty.
- **Key takeaways** — the highlighted findings as a **two-up grid of raised cards** (severity
  dot + word, the finding, one line of reasoning, then `Evidence (n) ›` and the Ask control
  on one footer row). Renamed from "Key findings" to say what the block is; the Risk
  section still owns "findings".
- **Findings** — rows that split on a wide screen: the finding and its reasoning on the
  left (measure-capped), its counted evidence disclosure and Ask control in an 18rem column
  on the right. Evidence is collapsed and counted everywhere, because a dozen
  static-analysis lines per finding is the wall of text the report is meant not to be.
- **Sections** — hairline-separated navigation rows (15px title, 11px descriptor, chevron),
  a counts strip capped at 54rem, and the evidence section at reduced weight as supporting
  material. Empty sections state what is missing in one compact note.

Nothing about the report's *content* changed: the same eight sections, the same builder,
the same structured data. It deliberately still does not subdivide the executive summary
into labelled blocks ("overall assessment", "highest risk", "migration direction") — the
builder returns ordered paragraphs with no labels, and assigning them by position in the UI
would invent a structure the data does not carry.

What the report deliberately does **not** do: subdivide the executive summary into labelled
blocks ("overall assessment", "highest risk", "migration direction"). The builder returns
that content as ordered paragraphs with no labels, and assigning them by position in the UI
would invent a structure the data does not carry — the scorecard explains the numbers, the
report explains the assessment, and neither reaches into the other's lane.

**Presentation pass (same milestone, no behaviour change).** The product's information
was right and its presentation read as an engineering prototype: six bordered boxes in a
row, a paragraph of prose in every score tile, `Delete` styled as loudly as `Run
analysis`, nested rectangles inside rectangles, and the upload card the tallest thing on
the page. Nothing about the workflow, routes, data, scoring, RAG, pipeline, report model
or analysis lifecycle changed — the changes are classes, small markup restructurings and
one shared vocabulary:

- **A small shared vocabulary instead of repeated class soup.** `globals.css` gained a
  `components` layer with `.panel` / `.panel-quiet` / `.panel-bare` / `.tile`, a five-step
  type scale (`.eyebrow`, `.caption`, `.meta`, `.measure`, `.report-prose`), a button set
  (`.btn` + `primary` / `secondary` / `ghost` / `quiet-danger`), `.row-disclosure` with a
  rotating `.marker`, and `.note` for empty states. It also gained `--border-subtle` for
  separators drawn *inside* a surface (the thing that stops every internal divider from
  reading as another box) and a global `:focus-visible` outline — previously left to each
  control, which meant the ones that forgot it were unusable without a mouse.
- **Page shell.** The container went from `max-w-6xl` to `max-w-[1600px]` with responsive
  padding, and long-form text is capped at a `68ch` measure inside it, so width is used
  without stretching prose. Header, section rhythm (8–10 units), the environment panel (a
  quiet footer of one-line capability rows) and the setup panel follow the same scale.
- **Upload.** One compressed step: heading and description on the left, file and the
  primary action on the right, duplicate handling and the operational-data disclosure
  behind a hairline. All fields, states and behaviour unchanged.
- **Project list.** A project is a row of a list rather than a box inside a box: name,
  metadata, state and actions, with the results opening under a single hairline. Run state
  became a dot-and-words chip (running / complete / failed / not analysed — "Not analysed"
  is stated instead of leaving the state blank); `Run analysis` is the secondary button and
  `Delete` is a ghost control that only reddens on hover, so the destructive action no
  longer competes for attention.
- **Scorecard.** The number is the card. Each tile reads name → ring → confidence words →
  one clipped line → "Why this number", and the full explanation, formula and contribution
  table (restacked as label/value/detail rows, because a three-column table cannot breathe
  in a 234px tile) live inside the disclosure. The clipped line is `aria-hidden` *because*
  it is a clip — the full sentence is rendered again at the top of the disclosure, so
  nothing is lost and nothing is announced twice. The rings are 100px with an 8px stroke
  and a 22px figure; the assumptions tile is the intentional sixth member (team × rate as
  its focal value, no invented arc); the card's own metadata is a caption line, not a row
  of pills.
- **Report.** Set as a document: a measured column, `line-height: 1.7`, and sections that
  are navigation rows (title, one-line descriptor, chevron) separated by hairlines rather
  than bordered cards. Severity became a dot beside a word instead of a bordered pill;
  evidence is quieter than the finding it supports; every disclosure is a ghost button
  rather than a bordered control repeated twenty times.
- **States, graph, ask, traces.** Errors are a left accent edge rather than a full red
  outline; the dependency graph keeps its canvas and gained a heading, a description and a
  legend that matches the text list below it; the text list became a two-column section
  rather than a fallback panel; the ask bar, refinement form, trace waterfall and traces
  page now use the same vocabulary as everything else. The loading state is shaped like the
  page it becomes (and contains no numbers at all — a skeleton that invented them would be
  fake data).

### 2. Design decisions worth recording

- **No second LLM pass, deliberately.** A model-written narrative cannot be checked
  against anything, which is the argument that produced the rubric in the first place.
  The report is arithmetic and reuse: the agents' own statements, the rubric's own
  contributors, the graph's own model.
- **One graph build, two consumers.** The report's Architecture section reads the same
  `buildDependencyGraph()` model the React Flow diagram renders, so the coupling it
  describes cannot disagree with the picture.
- **One score formatter.** `src/lib/scoring/format.ts` now holds the formatting the
  scorecard's tiles used inline, and the report calls the same functions — so a test can
  assert the report's figures are literally the scorecard's strings. No scoring
  calculation changed.
- **The report never invents a conclusion.** No architecture output means no recommended
  direction is stated; no operational data means the estimates are described as code-only;
  a run with no structured output and no findings renders an explicit empty state rather
  than seven empty boxes.
- **Operational vs parameter-driven movement.** The report's "operational data moved Risk"
  item keys off the operational adjustment itself, not off `refinement.changed` — editing
  team size changes cost and time without any operational data being involved.
- **`finalizing` is recorded tolerantly.** A database whose `run_step` enum predates
  migration `0004` logs a warning and carries on rather than failing a run whose results
  are otherwise complete.
- **A failed read is not an empty result.** The distinction is the difference between
  "you have nothing" and "I could not look" — the first is a claim about the reader's
  data, and getting it wrong is the worst thing an interface can say. Loads that feed a
  page therefore return an outcome, and only genuinely optional enrichments (run state,
  a project's source list) degrade quietly to empty, because the page remains usable and
  the log records why.
- **Missing and unauthorized are one answer.** Every project-scoped read is owner-scoped
  in the repository; the boundary is the not-found page for a request and an "absent"
  result for a poll, and neither distinguishes a deleted project from another session's.

### 3. Tests added

| File | Tests | What they establish |
|---|---|---|
| `src/lib/report/builder.test.ts` | 44 | every section composed from real structured fixtures (parsed through the pipeline's own zod schemas and scored by the real rubric); executive summary content; discovery, architecture, risk, migration, estimates and evidence sections; severity ordering; per-section empty notes; the empty-report state; elision notes; determinism; that the module imports no model client and performs no fetch; that no raw source content leaks into the report; and that the estimates' figures are the scorecard's own |
| `src/components/analysis-report.test.tsx` | 11 | the report rendered from a composed analysis: headings, executive summary visible without expanding, sections closed by default behind native `<details>`/`<summary>`, severity stated in words, counts as a definition list, list semantics and accessible names, the evidence list, the estimate explanation, the empty state as a status region, and both ask handoffs (section-level and finding-level) |
| `src/lib/ask-handoff.test.ts` | 6 | the channel's contract: a well-formed request crosses, a malformed one does not, every subscriber receives it, unsubscribing stops delivery, one event name |
| `src/lib/report/sources.integration.test.ts` | 4 | live Postgres: every indexed file once with its chunk count and type, no source content returned, a foreign session gets nothing, the listing cap is sane |

The second M7 pass added:

| File | Tests | What they establish |
|---|---|---|
| `src/lib/report/builder.test.ts` (extended) | +9 (53 in the file) | the per-service grouping: severity order, each service's traits, the recommendation and rating evidence kept with the service, both directions of the topology, an isolated service said to be isolated, edge-only services listed as unrated, the counts, a per-service question, the 40-item cap with the real count stated, and the empty case |
| `src/components/analysis-report.test.tsx` (extended) | +4 (15 in the file) | one disclosure per service (closed, named, severity in words), the evidence and per-service Ask inside it, the section's honest statement when no findings exist, and its empty note when there is nothing to group |
| `src/components/dependency-list.test.tsx` | 8 | the text alternative: heading and open disclosure, each edge as a sentence with its type and both endpoints' risk words, every service with its counts, circular chains named, no-edges and no-services states, suppressed-edge reconciliation, and no colour-only severity |
| `src/components/error-notice.test.tsx` | 4 | the error panel: a named region with the failure as a heading, an action when there is one, nothing extra when there is not, and deliberately not `role="alert"` (a message present at first paint is not a change) |
| `src/lib/page-data.test.ts` | 8 | the outcomes the page renders: no read for a session with no owner id, success, failure reported as failure rather than an empty list, the database's own message never reaching a reader (a planted password is asserted absent), the run state degrading quietly, one project's assessment failing while another loads, a project with no completed run being neither loaded nor failed, and the source list keyed per project with the session's owner |
| `src/app/actions/projects.test.ts` | 5 | owner scoping on delete, not-found when nothing was deleted (missing or another session's), not-found with no session, and no lookup for a malformed submission |
| `src/app/actions/analysis.test.ts` | 3 | the run is queued for the session's own project, a project the session cannot see ends in not-found with nothing queued and nothing revalidated, and a malformed submission does nothing |

96 tests in total across those files. No existing test was weakened or
deleted; the pre-existing suites that sit alongside this work (`analysis-progress`,
`progress`, `scorecard`, `graph`, `run`, `scorecard.integration`) pass unchanged, and the
scorecard/loader changes were re-run against live Postgres.

The presentation pass added presentation-contract tests and one new suite:

| File | Tests | What they establish |
|---|---|---|
| `src/components/project-list.test.tsx` | 7 | the row hierarchy (name, then metadata, then state, in that order), "Not analysed" stated rather than blank, the run action as a secondary button and the delete as a quiet control with a project-specific accessible name, a failed assessment read stated on the row with the row still usable, the completed-but-unpersisted case explained, and the empty state saying what is empty and what creates a project |
| `src/app/loading.test.tsx` | 3 | the streaming state names itself and what it is waiting for in one live region, contains **no digits at all** (a skeleton with invented numbers would be fake data on screen), and keeps every shape out of the accessibility tree |
| `src/components/scorecard.test.tsx` (extended) | +3 | the visible one-liner is a clip (`aria-hidden` + `line-clamp`) whose full sentence is the first thing inside the disclosure, all six tiles label their disclosure with an `aria-hidden` chevron, and the assumptions tile is the sixth metric with no invented ring |
| `src/components/analysis-report.test.tsx` (extended) | +2 | severity is a word beside a decorative dot rather than a pill, and every section is a `row-disclosure` with its heading as a direct child of the summary (a navigation row, not a nested card) |
| `src/components/dependency-list.test.tsx` (extended) | +1 | each part of the text list has its own heading level, with the section heading as the summary's own content |

49 tests across those five files; 168 across the fifteen the presentation pass ran. No
existing test was weakened, deleted or bypassed.

### 4. Verification actually performed

```
pnpm db:migrate                        [✓] applied; `select enum_range(null::run_step)` reads back
                                       {discovery,architecture,risk,comparison,finalizing,done};
                                       drizzle.__drizzle_migrations holds 5 rows (0000–0004)
pnpm typecheck                         clean (exit 0)          [run before the report landed]
pnpm lint                              clean (exit 0)          [run before the report landed]
pnpm test (DATABASE_URL set)           655 passed (38 files), 0 failed, 0 skipped
pnpm test:integration                  41 passed (4 files)
pnpm build                             ✓ compiled
pnpm vitest run src/lib/report/builder.test.ts             44 passed
pnpm vitest run src/components/analysis-report.test.tsx    11 passed
pnpm vitest run src/lib/ask-handoff.test.ts                 6 passed
DATABASE_URL=… pnpm vitest run src/lib/report/sources.integration.test.ts   4 passed
DATABASE_URL=… pnpm vitest run src/lib/scoring/scorecard.integration.test.ts 13 passed
```

The second M7 pass ran only its own suites, plus a per-file lint of every file it touched:

```
pnpm vitest run src/lib/report/builder.test.ts                53 passed
pnpm vitest run src/components/analysis-report.test.tsx       15 passed
pnpm vitest run src/components/dependency-list.test.tsx        8 passed
pnpm vitest run src/components/error-notice.test.tsx           4 passed
pnpm vitest run src/lib/page-data.test.ts                      8 passed
pnpm vitest run src/app/actions/projects.test.ts               5 passed
pnpm vitest run src/app/actions/analysis.test.ts               3 passed
pnpm vitest run (the eight suites touched by both passes)    158 passed (8 files)
```

The presentation pass ran its own targeted set, against the live database for the two
integration suites:

```
pnpm vitest run src/components src/app/loading.test.tsx \
  src/app/actions src/lib/report src/lib/page-data.test.ts \
  src/lib/ask-handoff.test.ts src/lib/scoring/scorecard.integration.test.ts \
  src/lib/scoring/sample-fixture.test.ts                     168 passed (15 files)
pnpm exec eslint <every changed file>                         clean (exit 0)
```

**What was actually looked at in a browser.** The dev server that was already running on
the working tree was loaded in a real engine at three widths, and the following was
observed rather than assumed:

- the shared CSS layer compiled and applied (`--border-subtle`, `.panel`, `.eyebrow`,
  `.note` resolved to the expected computed values);
- the home page at 1680px: header, the compact one-row upload card, the empty-state note
  and the environment footer, with **no horizontal overflow** (`scrollWidth` equal to the
  viewport);
- a temporary local-only preview route (since deleted) rendered the scorecard from the
  checked-in sample fixture: **six metrics in one row at 1680px** (six 234px cells, one y
  coordinate), **three columns at 1100px**, **one column at 414px**, again with no
  overflow at any width, the confidence and "Why this number" rows aligned across all six
  tiles, the clipped line ellipsised, and the expanded panel showing the full summary, the
  formula and the restacked contributions;
- `/admin/traces` at 1400px after the vocabulary pass.

**What was looked at in a browser, in order.** Three rounds of browser work are recorded
here, each with what it covered and what it did not.

*Round 1 — report and theme pass (fixture).* A temporary local-only route (since deleted)
rendered the Analysis Report and the scorecard from the checked-in sample fixture — the
fixture's own findings, edges and rubric numbers, with illustrative Discovery/Architecture
prose, because the fixture ships structured data rather than the model's narrative. Observed
rather than assumed: the report column rendered, every section row was present and
expandable, the counts strip / findings / counted evidence disclosures / Ask controls
rendered as intended, and at 414px the report narrowed with no horizontal overflow. Also
noted: the dev server had to be restarted, because the running one did not register newly
added route directories.

*Round 2 — the current composition, on a real project.* The page was loaded at 1680px,
1100px and 414px against the project's own demo owner (`sample-fixture`, created by
`pnpm seed:sample` + `pnpm demo:run`; the user's own session was not touched), i.e. the real
project row, the real persisted run and the real report, not a fixture preview. Observed:
the scorecard masthead, six metric tiles in one row at 1680px (three at 1100px, one at 414px)
with aligned confidence rows; the **Analysis Report at the full 1464px content width** with
its masthead rule, the summary split into two 704px columns, five takeaway cards, all eight
section rows present, 58 disclosures and 16 Ask controls live in the DOM; the dependency text
list in two columns; the refine row, the ask bar and the environment footer; **no horizontal
overflow at any of the three widths** (`scrollWidth` equal to the viewport); and the new
tokens resolving to their intended computed values (page `rgb(7,11,22)`, panel
`rgb(18,26,46)`, tile `rgb(30,39,69)` with border `rgb(36,46,82)`, accent
`rgb(139,150,255)`).

*Round 3 — the graph defect, re-measured.* On the same page: four nodes visible with
labels, risk levels, dependent counts and risk-coloured borders (256px each); three
`.react-flow__edge-path` elements present with correct stroke colours and non-empty `d`
geometry that nevertheless arcs above the node row; a small unstyled control rectangle at
the canvas's left edge; a 200px canvas holding ~40px of content.

**Not looked at in a browser, after all three rounds:** the error and not-found states, the
loading skeleton, the analysis-progress display during a live run, a click-to-expand driven
by hand (the disclosure *structure* is asserted by tests; the interaction has not been
driven), a screen-reader pass, and anything on a project other than the seeded demo one. The
graph was inspected but not interacted with.

`pnpm typecheck`, `pnpm lint` and `pnpm build` were **not** re-run after the report, the
second M7 pass or the presentation pass (they were last run on the analysis-lifecycle
work). The changed files are typechecked by the editor/LSP and lint-clean per file, and
that is not the same claim. This is targeted verification, not full-suite: the whole suite
has not been re-run since the report landed.

### 5. What is still not verified

- **Browser coverage is partial, and the gaps are specific.** Rendered and inspected: the
  home page and its empty state, the upload card, the project row, the scorecard, the
  Analysis Report (all eight section rows, counts strips, findings, evidence disclosures and
  Ask controls), the dependency text list, the dependency graph canvas, the refinements row,
  the ask bar, the environment footer and `/admin/traces` — at 1680px, 1100px and 414px.
  **Not rendered:** the error panel, the not-found page, the loading skeleton, and the
  analysis-progress display while a run is actually in flight.
- **Interaction has not been driven by hand.** The tests run in jsdom, which does not
  implement `<details>` toggling: what they assert is the structure (`<details>` closed by
  default, `<summary>` as the control) and the handoff events, not a real click-to-expand or
  a real Ask handoff in a real engine.
- **The report has been read on one project only** — the seeded demo run. Its width and
  composition were measured there; a project with a much longer service inventory, a larger
  cost figure or a single-paragraph summary is reasoned about in the code, not observed.
- **No live analysis run.** No run has been started in a browser and watched to completion,
  and no narrative has ever been produced by the real model API (see the M6/M4 records).

### 6. M7 work that remains

Every implementation item M7 was reduced to is done: the analysis report (including
per-service findings), the theme and composition passes, the graph text alternative, the
ask handoff, the analysis lifecycle, the error and empty states, owner-scoped not-found, and
the accessibility gaps in those surfaces. Remaining, and all of it browser-driven:

- **the checks that need a real engine and a hand on the mouse**, per §5: expansion and
  focus behaviour, the error / not-found / loading / progress states, and a screen-reader
  pass over the text alternative;
- **a browser-level confirmation of the not-found result**: the action-level tests assert
  that `notFound()` is called and nothing is written; that Next renders the not-found page
  for a client that submitted a server action is framework behaviour, unverified here;
- the interaction and accessibility checks that the jsdom tests can only approximate;
- the graph's visual edge rendering, which is a defect of its own (see the consolidated
  pass) and is deliberately untouched here.

What partially exists from earlier milestones and should be credited rather than
rebuilt: the upload form's pending/disabled submit and `role="status"` result, the
analysis button's pending state, the ask bar's streaming/disabled state and error region,
the refine form's pending states and per-file error list, `/admin/traces`' loading and
empty states, the project list's "no projects yet" panel, and the graph's "no dependency
edges were recorded" explanation.

---

## Final verification state

Every command below was actually executed in this session; the results are the real
output, and the gaps are gaps.

| Command | Result | Covers |
|---|---|---|
| `pnpm typecheck` | clean (run at baseline, after M5, after M6) | whole tree |
| `pnpm lint` | clean (after M5, after M6) | whole tree |
| `pnpm test` (with `DATABASE_URL`) | **520 passed (29 files)** at baseline; **588 passed (33 files)** after the M5 scoring work | all suites |
| `pnpm vitest run src/lib/scoring` | **210 passed (9 files)** | includes all 5 M5 files |
| `pnpm vitest run src/lib/scoring/refine.integration.test.ts` | **9 passed** | M5 against live Postgres |
| `pnpm vitest run src/lib/observability` | **29 passed (3 files)** | includes the 18 M6 waterfall tests |
| `pnpm build` | ✓ compiled; routes `/`, `/api/ask`, `/admin/traces` dynamic, `/_not-found` static | routing, SSR safety |
| `pnpm db:generate` | `0003_rainy_quicksilver.sql` | schema → migration |
| `pnpm db:migrate` | applied; index confirmed in Postgres | live schema |
| `pnpm seed:sample` | `Reused` (idempotent) | ingestion path |
| `pnpm demo:run` (healthy / degraded) | refined scorecards, −11.7 / +13.8 Risk | M5 end to end through the database |

### Measured again after the analysis-lifecycle work

The gaps above were partly closed by a later verification pass, whose real output is
recorded here. It covered the analysis-lifecycle work; it did **not** cover the report
that landed afterwards.

| Command | Result | Covers |
|---|---|---|
| `pnpm db:migrate` | applied; `run_step` read back from Postgres contains `finalizing`; 5 migrations recorded | migration `0004` |
| `pnpm typecheck` | clean (exit 0) | whole tree at that point |
| `pnpm lint` | clean (exit 0) | whole tree at that point |
| `pnpm test` (with `DATABASE_URL`) | **655 passed (38 files), 0 failed, 0 skipped** | all suites, including every database-backed one |
| `pnpm test:integration` | **41 passed (4 files)** | the live-database suites, after the script change |
| `pnpm build` | ✓ compiled; `/`, `/api/ask`, `/admin/traces` dynamic, `/_not-found` static | routing, SSR safety |

Not run, and therefore not certified:

- **the whole suite since the analysis report landed.** The 655/38 figure above predates
  the report, its component, the handoff module and the source-query integration test. The
  work that followed has only ever been run in groups, and those runs are recorded here:
  the eight suites touched by the first two M7 passes together (**158 passed, 8 files**),
  the presentation pass's set (**168 passed, 15 files**, spanning `src/components`,
  `src/app/loading.test.tsx`, `src/app/actions`, `src/lib/report`, `src/lib/page-data.test.ts`,
  `src/lib/ask-handoff.test.ts` and two database-backed scoring suites), the focused
  component set (**68 passed, 7 files**) and the component/actions set (**144 passed,
  12 files**), with `pnpm exec eslint` clean over `src` and over the changed files
  individually. `pnpm typecheck`, `pnpm lint` and `pnpm build` were **not** re-run after the
  report landed. The most recent single test-file edit — the report's layout assertion,
  rewritten when the container stopped being capped at 42rem — has not been re-run either,
  because the pass that made it was documentation-only. So: the suite is green as far as it
  has been run, and "as far as it has been run" is a smaller claim than "green".
- **`pnpm test` without `DATABASE_URL`.** The recorded 488 passed / 32 skipped figure is
  from M4 and has not been re-measured since.
- **any browser session for the states that only appear when something goes wrong.** The
  home page, the upload card, the project row, the scorecard, the analysis report, the
  dependency text list, the graph canvas, the refinements row, the ask bar, the environment
  footer and `/admin/traces` have all been rendered and inspected (see §4, rounds 1–3), but
  the error panel, the not-found page, the loading skeleton and the analysis-progress
  display have not, and no disclosure or Ask control has been clicked.
- **any live model call.** The DeepSeek credential was not re-tested; the recorded
  evidence is still the M4 `401 Unauthorized` that produced a clean persisted `failed`
  run, and no narrative has ever been produced by the real API in this working tree.
- **the analysis lifecycle end to end.** The polling/refresh path is verified by unit tests
  with an injected poll and by the code reading that produced the fix; no run has been
  started in a browser and watched to completion.

## Consolidated defect-fix pass — NOT PERFORMED

The brief's step 9 has not been started. The defects it lists are all still open, and
they are recorded here so the next session does not have to rediscover them:

1. **Dependency graph edges render with wrong geometry** — see §M4 §11 for the current
   observation: nodes visible and correct, three edge paths emitted, but the paths arc above
   the node row instead of joining node to node, a stray control rectangle sits at the
   canvas's left edge, and the canvas keeps unused height. The original hypothesis (unstable
   `nodeTypes` / `edgeTypes` identity defeating React Flow's measurement pass) was formed
   when nodes were `visibility: hidden`; that no longer matches what renders, so the first
   step is to re-measure before re-using it. The graph *model* and its 17 tests are correct —
   this is a rendering-layer defect, and the existing model must not be rewritten to work
   around it.
2. **Live analysis still fails on the invalid API key.** The current behaviour (a
   persisted `failed` run naming the stage) is the correct one and must be preserved; the
   UI treatment of that failure is what the pass should review.
3. **The browser upload path has still never been driven end to end.**
4. **M6's numeric span kind** (see M6 §5) is outstanding — the exporter still stores
   `String(span.kind)`, so a real span would render a numeric kind. **M7's implementation is
   complete** (see the M7 section): the analysis report and per-service findings, the ask
   handoff, the analysis lifecycle, the theme and composition passes, loading/empty/error
   states, owner-scoped not-found, the graph text alternative and the accessibility gaps are
   all built and unit-tested. What M7 still lacks is browser-driven evidence: the error,
   not-found, loading and progress states, hand-driven interaction, and a screen-reader pass.
