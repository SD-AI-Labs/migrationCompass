# Migration Compass — V2

The V2 application: Next.js (App Router) + Drizzle/Postgres (pgvector) +
LangGraph.js. This directory is the product; `../v1/` is the earlier
Java/Spring implementation, kept as a reference.

Read `../PROJECT_PLAN_V2.md` before changing anything here — it is the
design source of truth. `IMPLEMENTATION_PLAN.md` breaks the plan into
milestones, and `../PROJECT_STATUS.md` records what is actually built and
verified (as opposed to planned), including what has **not** been run.

## Prerequisites

- Node 20+ and pnpm
- Docker (Postgres with pgvector, and Ollama for embeddings)

## Setup

```bash
cp .env.example .env          # then fill in DATABASE_URL and DEEPSEEK_API_KEY
docker compose up -d postgres
docker compose up -d ollama
docker compose exec ollama ollama pull nomic-embed-text
pnpm install
pnpm db:migrate
pnpm dev                      # http://localhost:3000
```

`DATABASE_URL` is required for anything that touches project data.
`DEEPSEEK_API_KEY` is required only for the narrative agent paths — the
scorecard's arithmetic never calls a model, so scores work without it.
`EMBEDDING_DIMENSIONS` must match the `vector(...)` width in
`src/db/schema.ts`.

## Routes

| Route | What it is |
| --- | --- |
| `/` | The continuous project page: upload, project list, run state and persisted stages, scorecard, analysis report, dependency graph, "Refine these estimates", ask bar |
| `/admin/traces` | OpenTelemetry span waterfalls, read from this app's Postgres. Gated by `ADMIN_TRACES_ENABLED`; an operations surface, not a per-session view |
| `POST /api/ask` | The streaming retrieval + answer endpoint behind the ask bar |

There is no per-project route. A project is one continuous page and everything about
it expands in place — scorecard, report, graph, refinement. A project action aimed at
a project this session cannot see ends in `notFound()` and renders
`src/app/not-found.tsx`, which deliberately does not distinguish "deleted" from
"another session's".

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server |
| `pnpm build` / `pnpm start` | Production build / serve |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest. Database-backed suites skip themselves unless `DATABASE_URL` is set |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm test:integration` | The live-database suites (all `*.integration.test.ts`) |
| `pnpm db:generate` | Generate a migration from `src/db/schema.ts` |
| `pnpm db:migrate` | Apply migrations |
| `pnpm seed:sample` | Load `../fixtures/sample-legacy-api` through the real ingestion pipeline |
| `pnpm demo:run` | Produce a completed run for the seeded fixture from its checked-in expectation (no model call); `--operational healthy\|degraded\|none` |

To run the database-backed suites:

```bash
docker compose up -d postgres
DATABASE_URL='postgres://compass:***@localhost:5432/compass' pnpm test
```

## What is implemented

Everything below is implemented; whether it has been *verified* is stated
separately, because the difference matters.

- **Ingestion** — zip upload with traversal/zip-bomb guards, an extension
  allowlist, ground-truth exclusion, code-aware chunking, content-hash
  duplicate detection, Ollama embeddings (768-dim), all scoped to a session
  `ownerId`.
- **Agent analysis** — a LangGraph state graph: Discovery → Architecture ∥ Risk
  → Comparison, with shared tools, a bounded one-round self-critique, structured
  output validated by zod, and step-by-step run persistence.
- **Deterministic scoring** — five scores (readiness, risk, effort, cost, time)
  computed by pure functions in `src/lib/scoring/`, with per-score explanations,
  both risk weightings, evidence quality, and a `code-only estimate` /
  `refined with operational data` label. No model produces a number.
- **Dependency graph** — built from the persisted `service_dependencies` rows,
  typed edges, risk-coloured nodes, deterministic layout. **Its rendering is
  defective** — node boxes, labels and risk colours are correct, but the edge paths
  arc above the node row instead of joining node to node, a stray control rectangle
  sits at the canvas's left edge and the canvas keeps unused height (see
  `../PROJECT_STATUS.md` §M4 §11 for the measured state). The model and its tests are
  correct; the defect is in the rendering layer, and the presentation work changed only
  the surrounding chrome.
- **Operational data refinement (M5)** — attach logs, health/traffic JSON or
  incident reports at upload or from the scorecard; the metrics move **Risk**
  bidirectionally, bounded to ±15 points, and nothing else about the analysis
  changes. `recomputeScorecard()` is synchronous, deterministic, LLM-free,
  network-free and vector-free.
- **Migration parameters (M5)** — target environment, provider, team size,
  blended weekly rate, budget and timeline. Team size and rate feed the existing
  cost/time formulas; budget and timeline are compared against the estimate
  rather than folded into it.
- **Ask** — multi-query expansion, pgvector retrieval, fail-open reranking and a
  streamed, cited answer, in a persistent bar on the same page.
- **Analysis lifecycle** — a run is created `pending`, then advances through
  persisted stages (`discovery` → `architecture`/`risk` → `comparison` →
  `finalizing` → `done`), with structured lifecycle logging. The page polls the
  run's persisted state and re-renders itself when it reaches `complete` or
  `failed`, so scores appear without a reload or a restart.
- **Analysis report** — the explanation layer beneath the scorecard, composed on
  the server from the already-persisted analysis (the four validated structured
  outputs, findings, dependency edges, the indexed source inventory and the
  rubric's own arithmetic). Eight sections — executive summary, system discovery,
  architecture analysis, risk analysis, findings by service, migration
  considerations, effort and cost explanation, evidence — behind progressive
  disclosure, with an Ask handoff from any section or finding into the existing ask
  bar. `src/lib/report/builder.ts` is a pure function; it imports no model client
  and performs no fetch.
- **Findings by service** — the report's per-service view: one disclosure per
  service with its severity, rubric inputs, the Discovery stage's recommendation,
  cited risk factors, the evidence source behind the rating and what it calls and
  is called by. Services that appear only in the edges are listed as unrated rather
  than omitted. Reachable without the dependency graph, which is also why they are
  duplicated nowhere.
- **Dependencies as text** — `src/components/dependency-list.tsx` renders the same
  graph model the canvas draws as edges, services and cycles in sentences and
  lists: a screen reader, a copy-paste and a fallback view that does not depend on
  SVG edge rendering.
- **Error states** — page reads distinguish "nothing is there" from "I could not
  read it": an unreadable project list renders an explicit error panel instead of
  the empty-state claim, a failed per-project assessment read renders on that row,
  and the analysis failure and the ask bar announce themselves as alerts. No
  database message is ever shown to a reader.
- **Owner-scoped not-found** — a project action aimed at a project the session
  cannot see ends in `notFound()` and a rendered not-found page that does not
  distinguish a deleted project from another session's.
- **Traces (M6)** — OTel spans written to the app's own Postgres, rendered as
  waterfalls at `/admin/traces`, with credential-shaped attributes redacted
  before rendering and a labelled fixture trace so the page is demonstrable with
  an empty database.

## Presentation and theme

One vocabulary, defined in `src/app/globals.css` and consumed through CSS custom
properties — there are **no colour literals in `src/components` or `src/app`**, so a
theme change is a token change.

| Role | Token | Value |
| --- | --- | --- |
| Page | `--background` | `#070b16` (deep navy, not black) |
| Panel | `--surface` | `#121a2e` |
| Raised tile | `--surface-raised` | `#1e2745` (scorecard metrics, takeaway cards, graph nodes) |
| Inset well | `--surface-inset` | `#0b1120` (code blocks, the graph canvas) |
| Border | `--border` / `--border-subtle` | `#2f3b61` / `#242e52` |
| Text | `--foreground` / `--muted` | `#eef1fb` / `#a4adcb` |
| Primary | `--accent` / `--accent-ink` | `#8b96ff` indigo, with dark ink on it |
| Secondary | `--accent-cyan` | `#63c9dd` (asynchronous edges — nowhere else) |
| Risk | `--risk-critical` … `--risk-unknown` | `#f56a72`, `#f08a4b`, `#e6bd5c`, `#5cb87f`, `#8b95b3` |

Adjacent surfaces differ by ≈6.5 points of CIE L* (page 3 → panel 10 → tile 16, the well
at 5), which is what makes the hierarchy visible rather than nominal. Four surfaces and
nothing nests deeper. The `--risk-*` ramp is the *only* semantic palette — success,
warning, error and "unrated" all resolve to it. Every text colour clears WCAG AA on the
surface it is used on (muted 7.8:1 on a panel and 6.6:1 on a tile; the accent 6.5:1 as
text and 7.4:1 as ink-on-accent).

Shared primitives, named by intent: `.panel` / `.panel-quiet` / `.panel-bare` / `.tile` /
`.well`, `.eyebrow` / `.caption` / `.meta` / `.measure` / `.report-measure` /
`.report-prose` / `.report-lede`, `.btn` with `primary` / `secondary` / `ghost` /
`quiet-danger`, `.chip-accent`, `.row-disclosure` with its rotating `.marker`,
`.masthead-rule`, `.note`, and a global `:focus-visible` outline.

**The report is a chapter of the assessment, not an article inside it.** Its container
spans the dashboard; the bands inside use that width (an executive summary split
lede-beside-support, key takeaways as a two-up card grid, findings as rows with their
evidence in a right column) and readability is enforced on the text by a ~79-character
measure. Width and measure are separate decisions — an earlier version capped the
*container*, which left half the dashboard empty.

## Session and ownership

Anonymous, session-scoped isolation, implemented in `src/lib/session.ts`:

- a random `ownerId` in an httpOnly cookie (`mc_owner`, 30-day max age), minted by
  `ensureOwnerId()` on the first create path and read by `getOwnerId()` everywhere else;
- `projects.ownerId` is written on every create path and applied as a filter on every read
  path, so one session cannot see another's projects, runs, findings or operational data;
- **there is no account model, no login, no OAuth provider, no magic link and no RBAC.**
  The id is a visibility scope, not a credential: it is not authenticated, it must not be
  presented as a security boundary, and `pnpm seed:sample` prints the cookie to set rather
  than making a fixture globally visible;
- trace spans carry no owner id, which is why `/admin/traces` is gated behind
  `ADMIN_TRACES_ENABLED` rather than scoped per session.

## Verification state

From `../PROJECT_STATUS.md`, measured on this working tree:

- `pnpm db:migrate` — applied; migration `0004` (which adds the `finalizing` run
  step the progress display uses) is present in `run_step`, confirmed by reading
  the enum back out of Postgres.
- `pnpm typecheck`, `pnpm lint` — clean.
- `pnpm test` with `DATABASE_URL` — **655 passed across 38 files, 0 failed,
  0 skipped**, measured after the analysis-lifecycle work landed.
- `pnpm test:integration` — **41 passed across 4 files**.
- `pnpm build` — succeeds; `/`, `/api/ask` and `/admin/traces` are dynamic,
  `/_not-found` is static.
- `pnpm demo:run` against real Postgres — code-only risk 83.3 refined to 71.6
  with the `healthy` operational fixture and to 97.1 with the `degraded` one.
- The report's own suites, run in isolation: `src/lib/report/builder.test.ts`
  (53), `src/components/analysis-report.test.tsx` (20), `src/lib/ask-handoff.test.ts`
  (6), `src/lib/report/sources.integration.test.ts` (4, against real Postgres), plus
  the later M7 passes' `dependency-list.test.tsx` (8), `error-notice.test.tsx` (4),
  `page-data.test.ts` (8), `actions/projects.test.ts` (5) and `actions/analysis.test.ts`
  (3). Run in groups rather than as a suite: the eight suites of the first two M7
  passes together (**158 passed, 8 files**), the presentation pass's set
  (**168 passed, 15 files**, including two database-backed scoring suites), and the
  focused component sets (**68 passed, 7 files**; **144 passed, 12 files**), each with
  `eslint` clean over the files it touched.

**The whole suite has not been re-run since the analysis report landed**, and the most
recent single test-file edit — the report's layout assertion, rewritten when its container
stopped being width-capped — has not been re-run at all. No live model call has ever
completed. The M5 refinement path *has* been exercised against real Postgres
(`pnpm demo:run` moved code-only risk 83.3 to 71.6 with the `healthy` operational fixture
and 97.1 with the `degraded` one).

**Browser coverage, and its gaps.** Rendered and inspected in a real engine at 1680px,
1100px and 414px, on the seeded demo project (`pnpm seed:sample` + `pnpm demo:run`, owner
`sample-fixture`): the home page and its empty state, the upload card, the project row
with its run state, the scorecard (six metrics in one row at 1680px, three at 1100px, one
at 414px, confidence rows aligned), the Analysis Report at the full content width with its
masthead rule, two-column summary, takeaway grid and all eight section rows, the
dependency text list, the dependency graph canvas, the refinements row, the ask bar, the
environment footer and `/admin/traces`. No horizontal overflow at any of the three widths.

**Not** rendered or driven: the error panel, the not-found page, the loading skeleton, the
analysis-progress display while a run is in flight, any click-to-expand or Ask handoff by
hand, a screen-reader pass, and anything on a project other than the demo one. The graph
canvas was inspected but not interacted with, and its rendering defect (see the dependency
graph bullet above) is unresolved: node boxes, labels and risk colours are right, edge
paths are emitted with wrong geometry, and the canvas keeps unused height.

## Where the logs are

Development logging is pino JSON on stdout, so the four places a problem shows up are:

| Where | What is there |
| --- | --- |
| The terminal running `pnpm dev` | The application log: one line per analysis stage with `projectId`, `runId`, `stage`, `durationMs` and counts, plus ingestion and retrieval, and errors. This is the server-side console |
| `/admin/traces` | The same runs as OpenTelemetry span waterfalls, read from this app's Postgres (`ADMIN_TRACES_ENABLED`) — the place to look for *where* a slow stage spent its time |
| The Ollama container (`docker compose logs -f ollama`) | Embedding requests. An analysis that never retrieves is usually visible here first |
| The browser's DevTools console/network | Client-side problems: hydration errors, and the `POST` calls to the analysis-progress and ask actions. A run that stays "Analysing" while the terminal says it finished is a client problem, so start here |

An analysis is one `analysis.run` span; its lines share a trace id, so
`docker compose`-less `grep` on the terminal output is enough to follow a single
run end to end:

```bash
pnpm dev | grep '"runId"'        # every lifecycle line, with the stage and duration
pnpm dev | grep "Evidence retrieval"   # what the agents asked the codebase and how much came back
```

Set `LOG_LEVEL=debug` in `.env` to include the lines that mark a rejected
analysis run, and `LOG_LEVEL=warn` to see only failures. Nothing logs source
contents, prompts, or credentials — the logger redacts them, and the lifecycle
lines carry counts and durations only.

## The sample fixtures

`pnpm seed:sample` packs `../fixtures/sample-legacy-api` into an archive
and submits it exactly as an upload would — same extraction guards, same
chunker, same duplicate detection, same embeddings, same store. It is
idempotent (the archive is packed reproducibly, so a second run is
recognised as the same upload and reports `Reused`), it needs no LLM, and
it preserves the session model: the project belongs to an owner id, and
the command prints the cookie to set so a browser session can see it.

```bash
pnpm seed:sample                        # owner "sample-fixture"
pnpm seed:sample --owner <sessionId>    # a different owner
pnpm seed:sample --override             # ingest a second copy anyway
```

`../fixtures/sample-legacy-api.operational/{healthy,degraded}/` are the
operational data attachments — ordinary `app.log`, `health.json` and
`incidents.json` files that a user would upload. `pnpm demo:run` attaches the
`healthy` set by default, so the browser shows a refined scorecard; use
`--operational degraded` or `--operational none` for the other two states.

After seeding, open the app, set the printed cookie in the browser
console, and reload — the project appears with a **Run analysis** button.
Once a run completes — the row shows the persisted stage while it runs, and
switches to the scores by itself when it finishes — the project row expands into
the scorecard, the analysis report, the dependency graph and the refinement
form.
