# Project Plan — Legacy API Migration Advisor V2

_Status: planning complete, implementation not started. This document is
the source of truth for the rewrite — read it before writing any V2 code._

## Why a rewrite, not an iteration

V1 (now in `v1/`, see its own README) was built module-by-module to
demonstrate each Spring AI capability in isolation — RAG, tool calling,
multi-agent orchestration, structured output — as five separate Spring
Boot microservices, each with its own port, its own `ChatClient` config,
its own README section.

That was the right way to *build* it, and it's a legitimate, defensible
architecture on its own terms. But it produced the wrong *product*: the
dashboard's navigation ended up mirroring the five backend services
one-to-one (Chat tab, RAG Q&A tab, Tools Chat tab, Agent Pipeline tab,
Reports tab), which means the user has to understand the *backend's*
organizing principle to use the product at all. Specifically:

- **Chat and RAG Q&A are the same job from a user's perspective** ("ask
  something about my code") but `chat-module` has zero RAG or tool
  access — it's a bare conversational agent, so asking it about the
  uploaded project either hallucinates or deflects. Two tabs, one looks
  broken.
- **Agent Pipeline and Reports overlap** — both can trigger a full
  analysis run, both show a view of the same run's output, with no single
  place that represents "the analysis" as one artifact.
- **Tools Chat exposes an implementation technique (function calling) as
  if it were a peer user journey** — nobody wants to "chat with the
  monitoring data"; they want risk scoring that happens to be informed by
  real operational signals.

Root cause: the IA was organized around backend module boundaries
instead of the user's actual jobs-to-be-done. Fixing that is a product
rethink, not a bug fix — hence a rewrite rather than a patch.

## What's NOT changing

The underlying AI engineering — this is still the point of the whole
project — carries forward conceptually, re-architected around a coherent
product instead of five standalone demos:

- RAG over an uploaded codebase (multi-query expansion, reranking,
  code-aware chunking — the techniques from V1's advanced RAG round)
- Multi-agent orchestration with tool calling, self-critique/refinement
  loops, and agents sharing tools with each other
- Structured output extraction (the scoring rubric below is a NEW,
  bigger version of this same idea)
- Operational-data-informed risk assessment (logs, health/traffic,
  incidents — V1's tools-module concept, reframed as a data source
  instead of a chat surface)
- Multi-project support, duplicate detection, everything V1 built around
  "any codebase, not just the bundled example"

## Product vision

**One continuous page per project, not tabs.** The interaction model
serves two personas without making either of them pick a mode:

- **The fast path** ("just tell me"): upload, wait, see five headline
  scores. Done, if that's all they want.
- **The deep path** ("let me dig in"): the analysis report explains what
  the scores are resting on, and every score, section, card, and finding is
  a jumping-off point to expand for detail or ask a follow-up — inline,
  never a page navigation.

Nothing is ever a dead end that forces a destination change. The
assistant (ask bar) is always present, not a tab you go to.

### The five-score scorecard

The headline artifact: **Migration Readiness, Risk, Effort, Cost, Time**
— glanceable the moment analysis completes.

**Scores are rubric-based, computed over the structured findings we
already extract — NOT a separate LLM call producing an opaque number.**
This was a deliberate choice: an LLM-generated score has no traceable
"why," which is fatal for something meant to feel enterprise-credible.
A documented rubric applied to real structured findings (per-service risk
levels, phased-plan length, service count, etc.) means every score has a
decomposable answer to "why is this 62?" — actual math over real data,
not a vibe.

- **Risk** — weighted aggregate of per-service risk levels already in the
  structured report.
- **Effort** — function of service count, phased-plan length, and
  complexity signals from the findings (untested code, tight coupling,
  etc.).
- **Cost / Time** — derived from Effort via documented assumptions (team
  size, rate) — explicitly presented as assumptions the user can see and
  adjust, not hidden constants.
- **Migration Readiness** — a rollup of the above plus data-quality/
  architecture-soundness signals from Discovery's findings.

This is a genuinely new piece of domain logic V1 never had — V1 stopped
at per-service risk levels and a narrative; V2 adds the aggregation layer
that turns findings into a decision-ready summary.

### The analysis report — the explanation layer

The scorecard is the executive summary. Directly beneath it sits the
**analysis report**, which answers the questions a number cannot: what was
discovered, why the scores came out the way they did, and what the migration
considerations are. Scorecard first, report second — the report never displaces
the summary, it explains it.

**The report is composed, not generated.** This is the same credibility argument
the scorecard makes, applied to prose: a second LLM pass over the codebase to
"write up the findings" would produce text that cannot be checked against
anything, and would contradict the whole reason the numbers are rubric-based. So
there is no second analysis. The report is assembled on the server from data the
pipeline has already persisted and validated:

- the four structured outputs (`discovery_output`, `architecture_output`,
  `risk_output`, `comparison_output`) — the agents' own statements, reused
  verbatim where they are quoted;
- the per-service findings: risk levels, the rubric's structured inputs, risk
  factors, recommendations, dependent counts;
- the dependency edges and the *same* graph model the diagram renders, so the
  coupling the report describes and the picture the reader sees cannot disagree;
- the indexed source inventory (file names and document types — never contents);
- the deterministic scorecard and its explanations, formatted through the same
  code the scorecard uses, so a number cannot read two ways.

Eight sections: **Executive Summary** (what was discovered, the migration
posture, the most serious recorded concern, the recorded migration direction),
**System Discovery**, **Architecture Analysis** (most depended-upon services,
longest dependency chain, circular chains, shared-database coupling, unclassified
edges, services with no recorded relationships), **Risk Analysis** (every finding
by severity with its reasoning and the evidence behind it), **Findings by
Service** (the same findings the other way round — one disclosure per service
with its severity, rubric inputs, recommendation, cited evidence and its
dependencies, which is also how a reader reaches findings without the graph),
**Migration Considerations** (straightforward areas, restructuring, coverage
gaps, the recorded phased plan in order), **Effort and Cost Explanation** (the
rubric's own contributors, the assumptions in force, and the operational-data
adjustment when refinement data exists), and **Evidence** (indexed files, cited
risk factors, per-edge static-analysis evidence, evidence quality, and the
Comparison stage's own self-assessment).

The dependency topology is readable without the graph, too: the same
`buildDependencyGraph()` model the canvas draws is rendered as a text list of
edges, services and cycles, so the picture is never the only route to the
structure.

Interaction follows the same progressive-disclosure rule as everything else in
V2: the executive summary and the **key takeaways** are visible, each section expands
in place, a collapsed section still states what it holds, a section with nothing to
say says so, severity is stated in words as well as colour, and evidence is counted
and collapsed rather than printed under every finding. Any section or finding can
hand a composed question to the ask bar — look at the evidence first, then ask about
it, without leaving the page.

Composition, as built: the report is a **chapter of the assessment surface**, not a
narrow document embedded in it. Its container spans the dashboard and each band uses
that width — the masthead carries a subtitle and one metadata line assembled from the
sections' own counts, a rule marks the chapter break after the scorecard, the executive
summary puts its lede beside its supporting paragraphs, the key takeaways are a two-up
grid of compact cards, and findings are rows with their evidence and Ask control in a
right-hand column. Readability is a property of the *text*: prose is capped at a
~79-character measure. Capping the container instead would leave half the dashboard
empty and make the report read as an article rather than part of the product.

Where the analysis genuinely lacks an input, the report states that rather than
filling the gap: no architecture output means no recommended direction; no
recorded operational data means the estimates are described as code-only.

### Dependency graph — service coupling visualization

**New in V2, not carried over from V1.** An interactive node/edge graph
of the uploaded codebase's services/modules, with edges representing
actual call/import relationships extracted by the Discovery Agent (not
inferred from file structure) and nodes colored by that service's risk
level from the existing per-service risk findings.

This isn't just a visualization — it closes a gap the rubric section
already flags: Risk currently uses equal-weighted aggregation across
services "for now," explicitly because "no real dependency graph exists
yet" to weight by. Building this feature means the Discovery Agent's
structured output needs to capture actual dependency edges (which
service calls/imports which), and once that data exists, the Risk
formula's equal-weighting simplification can be revisited — a highly-
depended-on service failing should weigh more than a leaf service. Real
follow-on work for the scoring engine, not just a nice picture.

**Current state:** the model, the typed edges, the deterministic layout and the text
equivalent are implemented and unit-tested, and the graph renders on the page beside the
text list. The **canvas rendering is defective**: node boxes, labels and risk colours are
correct, but the edge paths are emitted with geometry that arcs above the node row
instead of joining node to node, a stray control rectangle sits at the canvas's left edge,
and the canvas keeps unused height. The measured state, and the earlier `visibility:
hidden` failure mode it replaced, are recorded in `PROJECT_STATUS.md` §M4 §11; the model
must not be rewritten to work around a rendering-layer defect.

- **Data source**: Discovery Agent extraction schema gains a
  `dependencies: [{from, to, type}]` field alongside the existing
  per-service structured findings — a schema addition, done in Phase 4
  (Agent orchestration) alongside the other Discovery Agent work.
- **Rendering**: react-flow — interactive pan/zoom, click a node to
  expand into that service's findings inline (consistent with the
  "expand in place, never a page nav" rule), edge styling for
  relationship type (sync call, async/event, shared DB, etc. — as far as
  the Discovery Agent can reliably distinguish from static analysis).
- **IA placement**: an expandable section off the scorecard/findings
  area (Layer 2/3), not a new tab or standalone page — same
  progressive-disclosure model as everything else in V2.
- **Sequencing**: depends on Discovery Agent's dependency-extraction
  work (Phase 4) being in place before the graph UI (Phase 5, alongside
  the scoring engine) can render anything real.

### Code-only vs. refined — operational data enrichment

Every score ships with a visible confidence signal: **"code-only
estimate"** by default. Two clearly separated kinds of enrichment, not
conflated:

- **Operational data** (objective facts about the running system: logs,
  incident reports, performance/health metrics, DB size/stats) —
  sharpens Risk (real failure history beats static code smell) and
  Cost/Effort (DB migration complexity scales with actual data volume).
- **Migration parameters** (business assumptions, not files: target
  environment — cloud vs. on-prem/provider, team size, budget/timeline
  constraints) — a handful of form inputs that directly parameterize the
  Cost/Time conversion math.

**Never gates the fast path.** Offered at two points, both optional:

1. At upload — a collapsed "Add operational data for more accurate
   results" section on the same screen, one click to expand, fully
   ignorable.
2. On the scorecard itself — a "Refine these estimates" action next to
   the confidence tag, for someone who saw the fast result and wants to
   improve it afterward (the more common real pattern).

**Recalculation split**: adding operational data triggers an immediate,
free rubric recalculation (no LLM call — just re-running the formula with
better inputs) for instant feedback. The narrative findings/risk cards
stay as-is until the user explicitly re-runs the full agent pipeline
(the expensive, LLM-driven part) — cheap feedback loop stays instant,
costly work stays an explicit action.

## New tech stack

| Concern | V1 | V2 |
|---|---|---|
| Language/runtime | Java 21 / Spring Boot | TypeScript / Node.js |
| App framework | 5x Spring Boot services | Next.js (single app) |
| AI/agent orchestration | Spring AI | Vercel AI SDK + LangGraph.js |
| API layer | 5x separate REST APIs | tRPC (or Next.js Server Actions) — one app, no cross-service HTTP |
| Database access | Spring Data JPA | Drizzle ORM |
| Vector storage | pgvector via Spring AI's PgVectorStore | pgvector, same Postgres, via Drizzle |
| Tracing instrumentation | Micrometer + hand-rolled correlation-ID filter | OpenTelemetry SDK (trace ID doubles as the correlation ID — no separate mechanism needed) |
| Tracing backend/UI | Zipkin (separate Docker container) | Spans written to the same Postgres DB; a `/admin/traces` route inside the app renders the waterfall — no extra infrastructure |
| Dependency visualization | Not present in V1 | react-flow — interactive service/module dependency graph, risk-colored |
| Deployment shape | 5 containers + Postgres + Ollama + Zipkin | One Next.js app + Postgres (+ Ollama for local embeddings) |

### Why this over the alternatives considered

- **Python/FastAPI** was the other strong contender — clean, dominant
  AI/ML ecosystem language — but it overlaps with the language used
  elsewhere in the existing portfolio (DocRAG, GraphForge,
  Intelli-Market), adding less breadth than a third distinct language.
- **Go** has a thin agent-orchestration ecosystem (no mature
  LangGraph-equivalent) — would mean hand-rolling orchestration that
  comes free elsewhere, for a product that's fundamentally
  orchestration-heavy.
- **Next.js + Vercel AI SDK** won specifically because the *product* we
  designed is streaming- and UI-heavy by nature (always-present ask bar,
  live agent reasoning trace, progressive disclosure) — exactly where
  the AI SDK's primitives (`useChat`, `streamText`, tool-call visibility)
  are purpose-built, and one Next.js app naturally produces the "one
  continuous page" IA instead of fighting against a multi-origin SPA the
  way V1's dashboard had to.

### Honest tradeoff being accepted

V1's "5 independently-deployable microservices with distributed tracing"
interview story goes away. Both agreed this isn't the right architecture
for this *kind* of product anyway — a single cohesive app is a different
engineering story (clean full-stack AI product), not a lesser one, and
it's the more honest fit for what got designed.

### Tracing design detail

OpenTelemetry spans (HTTP request → agent step → individual LLM call →
DB query) get written to Postgres instead of exported to a separate
Zipkin container. A simple `/admin/traces` page in the same Next.js app
reads that table and renders a trace waterfall. Since there's no longer a
cross-service hop to correlate (one process now, not five), Zipkin's core
value proposition mostly doesn't apply here anyway. Structured logging
via `pino`, with the OTel trace ID injected into every log line, so a
trace and its corresponding logs are directly cross-referenceable.

Tradeoff accepted deliberately: losing Zipkin's mature UI (flame graphs,
service maps) in exchange for something simpler and self-contained. Since
OTel is the instrumentation layer regardless, swapping in a real backend
later (Grafana Tempo, Honeycomb) is a config change to the exporter, not
a rewrite of how spans get created — worth a line in interview
conversation as "here's how this scales toward production observability"
even though the simple version is the actual build.

## Architecture (high level)

```
┌─────────────────────────────────────────────────────┐
│                  Next.js app (single)                │
│                                                        │
│  UI: one continuous project page                      │
│    - scorecard (Layer 1)                               │
│    - analysis report, expandable (Layers 2-3)            │
│    - findings/risk cards (Layer 2)                      │
│    - dependency graph, react-flow (Layer 2/3)             │
│    - narrative + phased plan, expandable (Layer 3)       │
│    - persistent ask bar (Layer 4)                          │
│                                                        │
│  tRPC / Server Actions (in-process, no cross-service HTTP)│
│    - project ingestion & RAG (multi-query + rerank)     │
│    - agent orchestration (LangGraph.js)                │
│       - Discovery / Architecture / Risk / Comparison   │
│         agents, tool-sharing + self-critique carried    │
│         forward conceptually from V1                     │
│    - scoring rubric engine (new)                       │
│    - operational-data ingestion + parameter form        │
│                                                        │
│  OTel spans → Postgres  │  pino logs (trace-ID tagged) │
└─────────────────────────────────────────────────────┘
              │                           │
         PostgreSQL                    Ollama
     (app data + pgvector          (local embeddings,
      + trace spans)                 unchanged from V1)
```

## Build phases

Delivered in this order; the milestone breakdown is `v2/IMPLEMENTATION_PLAN.md`, and
what is actually *verified* is `PROJECT_STATUS.md` — read that for status rather than
this list, which records the intended sequence.

1. **Scaffold**: Next.js app, Drizzle schema (projects, analysis runs,
   scores, trace spans), OTel wiring, Postgres/pgvector setup, Ollama
   connection.
2. **Ingestion**: project upload, chunking, embedding, duplicate
   detection — porting V1's proven logic to Drizzle/TS.
3. **RAG + Ask**: retrieval pipeline (multi-query expansion + reranking,
   carried forward from V1's advanced round), the persistent ask-bar UI.
4. **Agent orchestration**: LangGraph.js port of Discovery/Architecture/
   Risk/Comparison, tool-sharing, bounded self-critique. Discovery
   Agent's extraction schema gains a `dependencies` field (which service
   calls/imports which) — new structured output, not just a port of V1's
   logic.
5. **Scoring engine**: the rubric — the genuinely new piece — plus the
   scorecard UI (Layer 1) and drill-down (Layers 2-3). Includes the
   react-flow dependency graph view, rendered from Phase 4's dependency
   data and colored by per-service risk.
6. **Operational data + refinement**: optional enrichment at upload and
   from the scorecard, instant rubric recalculation.
7. **Tracing UI**: `/admin/traces` waterfall page.
8. **Polish**: the continuous-page progressive-disclosure interaction
   details — expand-in-place, inline ask, confidence tags — including the
   analysis report, the explanation layer beneath the scorecard. The report
   has no phase of its own because it introduces no new analysis: it is
   composed from Phase 4's structured outputs, Phase 5's scoring arithmetic
   and the persisted findings, which is also why it needs no extra model
   call and no extra persistence.

This order front-loads the parts that carry the most risk/uncertainty
(agent orchestration in a new framework, the scoring rubric's actual
formula) before the more mechanical UI polish work.

## Scoring rubric — v1 formulas (starting point, expect tuning once real runs exist)

**Prerequisite — extraction schema needs a few new structured fields**,
not text-sniffing existing prose: `hasTestCoverageGap` (bool),
`dataQualityIssueCount` (int), `requiresMajorRestructuring` (bool) per
service/system. Cleaner and more reliable than parsing `riskFactors[]`
strings, and it's a small, contained addition to the existing extraction
prompt, not new agent work.

**Risk (0–100)** — weighted average of per-service risk levels
(Critical=100/High=75/Medium=50/Low=25), equal-weighted across services
in the v1 formula below. **Update**: the dependency graph feature (see
Product vision) means real dependency-count data now exists as of Phase
4/5 — weighting by "how many other services depend on this one" is a
concrete Phase 5 refinement to try once the graph data is flowing,
rather than a someday-maybe. Worth prototyping both (equal-weighted vs.
dependency-weighted) and comparing against a couple of real test runs
before deciding which ships. If operational data is
present, real incident/error signals adjust risk up OR down from the
code-only baseline — deliberately bidirectional, since operational data
can also show a codebase is more stable in practice than its code smells
suggest.

**Effort (1–10)**:
`normalize(serviceCount)×0.3 + normalize(phaseCount)×0.2 + (riskScore/100)×0.3 + restructuringMultiplier×0.2`

**Time** — derived FROM Effort (not independently computed), via a
lookup band:
- Effort 1–2 → 4–8 weeks
- Effort 3–4 → 8–16 weeks
- Effort 5–6 → 3–6 months
- Effort 7–8 → 6–9 months
- Effort 9–10 → 9–12+ months

then adjusted by team size (if provided via migration parameters) with a
sublinear factor — `÷ √(teamSize / defaultTeamSize)` — as a small nod to
Brooks's Law rather than pretending more engineers linearly speeds
things up.

**Cost**:
`effort_in_person_weeks × teamSize × weeklyRateAssumption` (default
blended rate, user-adjustable). Infra cost delta for a cloud target is a
reasonable stretch addition later, not in the v1 formula.

**Migration Readiness (0–100, the rollup)** — inverse-weighted composite:
high Risk pulls it down, `dataQualityIssueCount` and missing-
architecture-docs signals pull it down, an explicit "current architecture
is largely sound" finding from Architecture Agent pulls it up. This is
the score that most directly answers "should we even do this."

**Known open question**: the weights above (0.3/0.2/0.3/0.2 especially)
are a first pass on paper, not tuned against real output yet — expect to
revisit once Phase 5 produces actual scores to sanity-check against.

## Open items to nail down before/during build

- Whether LangGraph.js's tool-sharing pattern maps directly onto V1's
  "give Architecture/Risk the same DiscoveryTools instance" approach, or
  needs a different shape in graph-based orchestration.

### Resolved: Auth/multi-tenancy — session-scoped isolation, not full accounts

Decision: no full multi-tenancy (no orgs, roles, invites, RBAC) — that
scope isn't what's being evaluated here and would dilute the AI
engineering story. But also not fully account-less: if V2 sits at a
public URL as part of the LinkedIn/portfolio presence, concurrent
visitors with zero session isolation could see each other's uploaded
codebases and analyses, which is a real correctness bug, not just
missing polish.

Landed on the lightweight middle ground: a session-scoped `ownerId` on
the `projects` table, scoping visibility without any login/role/org
machinery. Small, contained addition to the Drizzle schema in Phase 1
(Scaffold) — cheaper to include from the start than to retrofit after
Phase 2 (Ingestion) has real project data flowing through it.

Schema implication: `projects` needs an `ownerId` (or `sessionId`)
column from the initial Drizzle schema design in Phase 1, not added
later.

**As implemented:** the anonymous-session-cookie option was taken, and only that option.
`src/lib/session.ts` mints a random `ownerId` on the first create path (`ensureOwnerId()`),
stores it in an httpOnly `mc_owner` cookie with a 30-day max age, and every read path
filters on it. There is **no** Auth.js provider, no OAuth, no magic link, no account
model and no RBAC in the codebase — the id is a visibility scope rather than a
credential, it is not authenticated, and it must not be presented as a security
boundary. `pnpm seed:sample` prints the cookie to set rather than making a fixture
globally visible, and trace spans carry no owner id, which is why `/admin/traces` is
gated behind `ADMIN_TRACES_ENABLED` instead of being session-scoped.
