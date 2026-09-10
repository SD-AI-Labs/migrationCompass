# OrderVault — Mock Legacy System

**OrderVault** is a fictional, entirely synthetic legacy order-management
platform, created as test data for the Legacy API Migration Advisor project.
Nothing here reflects any real company's actual systems, specs, code, or
data — names, endpoints, business logic, and stats are invented.

It's modeled on the *shape* of a typical 12-year-old enterprise Java
monolith (WebLogic app server, EJB 2.1 session beans, JAX-WS/SOAP,
on-prem Oracle DB), including realistic legacy code smells, so the RAG,
tools, and agent modules have something genuine to analyze.

## Directory structure — and why it's split this way

```
mock-legacy-app/
├── source-code/       actual (fictional) legacy Java source — EJBs, DAOs,
│                       deployment descriptors, messaging, integrations,
│                       one newer bolted-on REST service
├── api-specs/          contract specs — 3 legacy WSDLs + 1 newer OpenAPI spec
├── operational-data/    mock traffic + health telemetry (JSON)
├── database/            schema, sample seed data, and scale/data-quality notes
└── ground-truth/        NOT ingested by the app — see below
```

**Only `source-code/`, `api-specs/`, `operational-data/`, and `database/`
are meant to be fed into RAG or read by the agent modules.** These
represent what you'd realistically have on hand at the start of a real
migration project: the code itself, its published contracts, whatever
telemetry your monitoring already captures, and the database schema.

**`ground-truth/` is deliberately kept separate.** It contains
`architecture-overview.md` and `dependency-graph.md` — human-readable
analysis documents. In a real migration, nobody hands you documents like
this on day one; they don't exist yet, because nobody's had time to write
them. Producing exactly this kind of analysis — a coherent architecture
summary and a risk-ranked dependency graph — from raw source code, specs,
and telemetry is the actual job of the **Discovery Agent** and **Risk
Agent** in `agent-module`.

So `ground-truth/` isn't an input — it's an **answer key**, written by hand
ahead of time, that we can compare the agent's own generated analysis
against once `agent-module` exists. That comparison ("did the agent
correctly identify CustomerAccountService as highest-risk? did it catch the
missing timeout in AddressValidationClient?") is itself a good thing to be
able to demo and talk through in an interview.

## What's deliberately embedded in the source code

Each service has a few realistic legacy issues written into the code
itself, meant to be *discoverable* by an AI reading it — not just asserted
in a doc:

- **OrderLookupService** — undocumented default result limit (50) on order
  history; broad exception handling that collapses all DAO errors into a
  generic fault, making production troubleshooting harder than necessary
- **InventoryCheckService** — synchronous, blocking stock reservation using
  `SELECT ... FOR UPDATE` row locks, with no timeout/backoff — the root
  cause of latency spikes during high traffic
- **CustomerAccountService** — an external address-validation call with no
  configured timeout (hangs indefinitely on a slow/down dependency), and a
  loyalty-tier calculation method with hardcoded customer-ID exceptions and
  dead code from an expired campaign (condensed excerpt of a much larger,
  untested real method)
- **PartnerCatalogFeed** (the newer REST service) — an in-memory cache
  synced from the same DB table InventoryCheckService reads/writes
  directly, explaining exactly why the two APIs can disagree on stock
  levels under load
- **Order messaging (JMS)** — fired after stock reservation, with no
  shared transaction with that DB write (a "dual write" gap), no
  dead-letter queue, and no idempotent consumers — concretely reproduced
  as duplicate rows in `database/seed-data-sample.sql`
- **PaymentGatewayClient / ShippingCarrierClient** — external integrations
  with no idempotency key (payment) and no rate-limit handling (shipping),
  added incrementally without the resilience patterns you'd expect in a
  new Spring Boot service
- **Database** — 14-table Oracle schema with several intentional
  data-quality issues (duplicate emails, inconsistent status casing,
  orphaned foreign keys) — see `database/README.md`

None of this code is meant to compile as part of the Gradle build — it's
reference material for RAG ingestion and agent analysis, kept outside
`settings.gradle`'s module list on purpose.

## The fictional scenario

OrderVault has been running in production for ~12 years, handling order
lookup, inventory, and customer accounts for a mid-size retail company.
Engineering leadership wants to migrate off the aging WebLogic cluster onto
Spring Boot microservices, with no unplanned outages — which is exactly
the kind of structured, risk-aware plan the Legacy API Migration Advisor is
meant to help produce.
