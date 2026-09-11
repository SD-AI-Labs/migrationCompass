# V2 Implementation Plan

Derived from `../PROJECT_PLAN_V2.md`. That document is the source of truth for
product design and rationale; this one is the build breakdown — what gets
written, in what order, and how each milestone is proven done.

Nothing here re-litigates the plan's decisions (Next.js single app, Drizzle,
pgvector, OTel-into-Postgres, session-scoped `ownerId`, rubric-based scoring).

## Ground rules for this build

1. **The fast path must never require a running LLM or vector store to render
   its shell.** Pages, schema, and the rubric engine must build and unit-test
   with no Ollama, no DeepSeek key, no Postgres. Anything that needs infra is
   isolated behind a module boundary and covered by (skip-if-unavailable)
   integration tests instead.
2. **Scores are computed, not generated.** Every number the scorecard shows
   comes from `src/lib/scoring/*` — pure functions over structured findings.
   No LLM call ever produces a headline number. This is the plan's central
   credibility claim, so the rubric lives in its own dependency-free module.
3. **Nothing is a dead end.** Any UI affordance added must expand in place or
   open the ask bar. No new top-level routes for user journeys (the only
   non-page routes allowed are `/admin/traces` and the API surface).
4. **Verify, then document.** A milestone is only "complete" once its
   verification commands have actually run and their real output is recorded
   in `PROJECT_STATUS.md`. No checkmarks before a green run.
5. **No commits.** Work stays in the working tree.

## Milestones

Each milestone lists: deliverables, the new/changed surface, and its
acceptance criteria (the exact commands that must pass).

---

### M0 — Scaffold

**Goal:** a Next.js + Drizzle + OTel + pino app that boots, typechecks, builds,
and has its full database schema defined — including the session-scoped
`ownerId` the plan requires from the start.

Deliverables:
- `v2/package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`,
  `eslint.config.mjs`, `vitest.config.ts`, `.env.example`
- `src/lib/env.ts` — zod-validated environment, with explicit `OPTIONAL` vs
  `REQUIRED` split so the fast path can run with nothing configured
- `src/db/schema.ts` — Drizzle schema: `projects` (with `ownerId`),
  `analysisRuns`, `findings`, `serviceDependencies`, `scorecards`,
  `operationalData`, `traceSpans`, `chunks` (pgvector)
- `src/db/client.ts` — lazy postgres.js + Drizzle client
- `drizzle.config.ts` + `src/db/migrations/`
- `src/lib/observability/` — OTel SDK bootstrap writing spans into Postgres via
  a custom span processor; `src/lib/observability/logger.ts` — pino with trace-id
  injection (the plan's "trace ID doubles as the correlation ID")
- `docker-compose.yml` — Postgres (pgvector image) + Ollama
- Public shell route that renders "no analysis yet" against the schema types

Acceptance:
- `pnpm typecheck` clean
- `pnpm test` green
- `pnpm build` succeeds
- `pnpm db:generate` produces a migration from the schema

---

### M1 — Ingestion

**Goal:** port V1's proven ingestion behavior to TypeScript/Drizzle: upload,
safe extraction, code-aware chunking, embedding, duplicate detection,
multi-project coexistence.

Deliverables:
- `src/lib/ingestion/chunking.ts` — pure, code-aware chunker (larger token
  budget for source files than prose). No I/O, fully unit-tested.
- `src/lib/ingestion/extract.ts` — zip extraction with path-traversal and
  zip-bomb guards
- `src/lib/ingestion/scan.ts` — file walk + extension allowlist + include-dir
  filtering (the bundled-example path must exclude ground truth)
- `src/lib/ingestion/hash.ts` — sha256 content hash for duplicate detection
- `src/lib/embeddings/ollama.ts` — embeddings client behind an interface with a
  deterministic stub for tests
- `src/lib/ingestion/persist.ts` — transactional Drizzle writes: project row,
  chunk rows, all tagged with `projectId`
- Server action + route handler for upload, scoped to `ownerId`

Acceptance:
- chunker unit tests (boundaries, code vs prose, empty input, oversized input)
- extraction tests (traversal attempt rejected, nested dirs, symlink ignored)
- duplicate detection test (same bytes → conflict; `override` → new project)
- `pnpm typecheck && pnpm test && pnpm build` green

---

### M2 — RAG + Ask

**Goal:** retrieval that actually retrieves: multi-query expansion, per-query
vector search, join/dedupe, LLM reranking with fail-open behavior, then answer.

Deliverables:
- `src/lib/rag/multiQuery.ts` — expansion with a deterministic fallback
- `src/lib/rag/rerank.ts` — parse-model-ranking module (pure, tested for the
  fail-open path and for unparseable/garbage responses)
- `src/lib/rag/retrieve.ts` — pgvector similarity search scoped by `projectId`
- `src/lib/rag/ask.ts` — the pipeline, injectable LLM/vector deps
- `POST /api/ask` — streaming response; ask-bar UI wired to it

Acceptance:
- rerank tests cover: happy path ordering, garbage response → original order,
  fewer candidates than keepTop → untouched
- pipeline test with stubbed LLM/retriever asserting call counts (1 expansion +
  N retrievals + 1 rerank + 1 answer)
- `pnpm typecheck && pnpm test && pnpm build` green

---

### M3 — Agent orchestration (LangGraph.js)

**Goal:** Discovery → Architecture ∥ Risk → Comparison as a graph, with tool
sharing and the bounded one-round self-critique carried forward conceptually.

Deliverables:
- `src/lib/agents/graph.ts` — LangGraph state graph; Architecture and Risk
  fan out from Discovery and fan in at Comparison
- `src/lib/agents/critique.ts` — pure "is this critique COMPLETE?" parser
  (exact-match semantics; a critique starting with "Complete except…" must NOT
  count as complete)
- `src/lib/agents/tools/` — `knowledgeBase` (RAG), `checkApiHealth`,
  `getTrafficStats`, shared instances handed to more than one agent
- Discovery extraction schema — **including the new
  `dependencies: [{from, to, type}]` field** the dependency graph feature needs
- Step-by-step run persistence so status is pollable

Acceptance:
- critique parser tests incl. the false-negative trap
- graph structural test with fake model: order, fan-out, fan-in, single
  refinement round max, run row transitions on failure
- dependency extraction validated against the rubric's needs (typed edges)
- `pnpm typecheck && pnpm test && pnpm build` green

---

### M4 — Scoring engine + scorecard + dependency graph

**Goal:** the genuinely new piece. Findings → five scores, with every score
decomposable, plus the react-flow graph colored by per-service risk.

Deliverables:
- `src/lib/scoring/rubric.ts` — Risk / Effort / Cost / Time / Readiness
- `src/lib/scoring/assumptions.ts` — team size, weekly rate, default team size
  as *visible* adjustable assumptions, not hidden constants
- `src/lib/scoring/explain.ts` — per-score contribution breakdown ("why 62?")
- `src/lib/scoring/weights.ts` — equal-weighted vs dependency-weighted Risk
  behind one flag, so both can be compared on real runs
- Scorecard UI (Layer 1), drill-down (Layers 2–3)
- `src/components/graph/DependencyGraph.tsx` — react-flow rendering of M3's
  edges, nodes colored by per-service risk, click expands findings inline
- Confidence tag (`code-only estimate`) on every score

Acceptance:
- rubric tests: band boundaries, monotonicity (more services ⇒ never lower
  Effort), clamping to 0–100 / 1–10, empty-findings input, both Risk weightings
- explain test: contributions sum to the reported score
- build green with the graph route rendering from fixture data

---

### M5 — Operational data + refinement

**Goal:** optional enrichment at upload and from the scorecard; instant rubric
recalculation, expensive re-run stays explicit.

Deliverables:
- Operational data ingestion (logs, health/traffic JSON, incident reports)
- Migration parameters form (target environment, team size, budget/timeline)
- `recomputeScorecard()` — pure rubric re-run, no LLM, synchronous
- Bidirectional operational Risk adjustment (data can lower risk too)
- UI: collapsed "Add operational data" at upload + "Refine these estimates" on
  the scorecard

Acceptance:
- tests proving recalculation is LLM-free (asserted via a call-counting stub)
- tests that the narrative findings are NOT touched by recalculation
- bidirectional risk test (better ops data → lower risk; worse → higher)

---

### M6 — Tracing UI

**Goal:** `/admin/traces` renders span waterfalls from Postgres.

Deliverables:
- `src/lib/observability/waterfall.ts` — pure parent/child tree building +
  duration math
- `/admin/traces` page + trace detail

Acceptance:
- waterfall tests: nesting, orphan spans, out-of-order arrival
- page renders a fixture trace

---

### M7 — Polish + the Analysis Report

**Goal:** progressive disclosure done consistently, and the explanation layer
beneath the scorecard: the scorecard states the numbers, the report states what
they rest on.

Deliverables:
- **Analysis report** — `src/lib/report/builder.ts`, a pure composer over data the
  pipeline already persists: the four validated structured outputs, findings,
  dependency edges, the graph model, the indexed source inventory, and the
  scorecard's own explanations. No second model pass, no new persistence.
  Rendered by `src/components/analysis-report.tsx` in eight sections behind
  `<details>` — the executive summary and the **key takeaways** visible, everything else
  expanding in place, severity stated in words as well as colour, evidence counted and
  collapsed per item, and the per-service section giving one disclosure per service
  (severity, rubric inputs, recommendation, evidence, and what it calls and is called by).
- **Report composition must not duplicate the pipeline.** Coupling statements read
  the same `buildDependencyGraph()` model the diagram renders; score strings come
  from one shared formatter (`src/lib/scoring/format.ts`) used by both the
  scorecard and the report; per-edge evidence is read from the validated Discovery
  output rather than re-extracted.
- **Ask handoff** — `src/lib/ask-handoff.ts` publishes a composed question from a
  report section or finding into the *existing* ask bar (`/api/ask`). No second
  conversational surface: the handoff prefills the box and takes focus, and the
  reader still presses Ask.
- **Report-state coverage** — an explicit empty report state (a run that recorded
  no structured output says so), per-section empty notes, elision notes on capped
  lists, and a loader that fails soft so an unavailable source list never costs a
  reader the rest of the report.
- **Graph text alternative** — `src/components/dependency-list.tsx` renders the same
  `buildDependencyGraph()` model as text: edges as sentences, services with their
  risk and counts, circular chains, suppressed edges. The canvas is not the only way
  to read the topology, and the visual edge layer's known defect cannot hide it.
- **Error states, and a failed read that is not an empty result** — page loads return
  outcomes, so a failure to read the project list renders an error panel rather than
  the "no projects yet" claim; a per-project assessment failure renders on its row;
  the ask bar and the analysis failure state announce themselves as alerts; no
  database message reaches a reader.
- **Owner-scoped not-found** — project actions end in `notFound()` for a project the
  session cannot see, with a rendered not-found page that does not distinguish
  "deleted" from "another session's".
- **Analysis lifecycle** — persisted stages (`discovery` → `architecture`/`risk` →
  `comparison` → `finalizing` → `done`), structured lifecycle logging with
  `projectId`/`runId`/`stage`/durations/counts, and client polling that re-renders
  the page when the run reaches `complete` or `failed`.
- expand-in-place everywhere, inline ask from any card, confidence tags,
  empty/loading/error states, `ownerId`-scoped not-found handling
- accessibility pass on the interactive surfaces
- **Report composition and the visual system** — the report is a chapter of the
  assessment surface, not a narrow document inside it: the container spans the dashboard,
  the masthead carries a subtitle and one metadata line assembled from the sections' own
  counts, a `.masthead-rule` marks the chapter break after the scorecard, the executive
  summary splits the lede beside its supporting paragraphs, the key takeaways are a two-up
  card grid, and findings are rows with their counted evidence and Ask control in a right
  column. Readability comes from a measure on the prose (~79 characters), never from
  capping the container — an earlier version capped the container and left half the
  dashboard empty.
- **Theme** — one token vocabulary in `src/app/globals.css` (page / panel / raised tile /
  inset well; indigo primary, muted cyan secondary; the `--risk-*` ramp as the only
  semantic palette), consumed through custom properties so that **no component contains a
  colour literal**. Adjacent surfaces are separated by ≈6.5 points of CIE L* so the
  hierarchy is visible rather than nominal, and every text colour clears WCAG AA on the
  surface it is used on.
- **Remaining after this workstream:** the browser checks for the error, not-found,
  loading and in-flight progress states, hand-driven interaction and a screen-reader pass;
  and the React Flow rendering defect, which is not an M7 item (see `PROJECT_STATUS.md`
  §M4 §11). The main surfaces — page, scorecard, report, dependency text list, graph canvas
  and `/admin/traces` — have been rendered and inspected at 1680 / 1100 / 414px.

Acceptance:
- report tests: composition from structured data (every section), executive
  summary, findings and severity rendering, evidence rendering, effort/cost
  explanation, the empty state, progressive disclosure, the ask handoff, and
  consistency between the scorecard's values and the report's — all without a
  model, an API key or a database
- the source-listing query verified against live Postgres, including that a
  foreign session gets nothing and that no chunk content is returned
- interaction tests for expand/collapse state and ask-bar handoff
- full suite green

**Implementation is not verification.** The report and its tests can be complete
with no browser having loaded a page: the acceptance criteria above include the
interaction and accessibility behaviour *as rendered*, and until a page has
actually been loaded and driven, M7 is implemented and test-verified rather than
verified. `PROJECT_STATUS.md` records which of the two applies.

Where the criteria above stand today, as recorded in `PROJECT_STATUS.md`:

- **met** — the report composition tests (every section, executive summary, findings and
  severity, evidence, effort/cost explanation, the empty state, progressive disclosure,
  the ask handoff, and scorecard/report consistency), without a model, key or database;
- **met** — the source-listing query verified against live Postgres, including that a
  foreign session gets nothing and that no chunk content is returned;
- **written, not driven** — the interaction tests assert the disclosure *structure* and
  the handoff events; jsdom does not implement `<details>` toggling, so no
  click-to-expand or Ask handoff has been exercised by hand;
- **not met** — "full suite green" since the report landed. The suite was last green in
  full *before* the report (655 passed / 38 files); everything after it has been run in
  groups, and the totals are in `PROJECT_STATUS.md`;
- **partly met** — browser coverage. The page, scorecard, report, dependency text list,
  graph canvas and `/admin/traces` have been rendered and inspected at 1680 / 1100 /
  414px; the error, not-found, loading and in-flight progress states have not.

---

## Sequencing rationale

M0→M2 are prerequisites. M3 and M4 are the two risky pieces and are deliberately
adjacent (M4 consumes M3's `dependencies` output), front-loading the uncertainty
before the UI work in M5–M7. M5's recalculation depends on M4's rubric being
split from its inputs — that split is an M4 design requirement, not an M5
discovery.

## Cross-milestone design rules

- **Pure core, injected edges.** Chunking, reranking, critique parsing, rubric,
  waterfall: pure functions, no I/O, no framework imports. LLM/vector/DB access
  is injected. This is what makes the suite runnable with zero infrastructure.
- **One schema, one owner.** `projects.ownerId` is written on every create path
  and applied as a filter on every read path. A read path that forgets it is a
  bug, not a missing feature.
- **Assumptions are data.** Team size, rate, and band table live in
  `assumptions.ts` and are surfaced in the UI, per the plan's explicit
  "presented as assumptions the user can see and adjust".
