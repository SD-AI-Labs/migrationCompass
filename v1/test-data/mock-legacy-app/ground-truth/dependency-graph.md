# OrderVault — Service Dependency Graph

**SYNTHETIC data for portfolio project testing.** Describes which client
applications depend on which OrderVault services, and how services depend
on each other internally. Used by the migration-planning Risk Agent to
reason about blast radius before proposing a migration order.

## 1. Client → Service dependencies

| Client application | Depends on | Criticality | Notes |
|---|---|---|---|
| Storefront (web) | OrderLookupService, InventoryCheckService, CustomerAccountService | Critical | Primary revenue-generating surface |
| Mobile app (iOS/Android) | OrderLookupService, CustomerAccountService | Critical | Read-heavy; does not call InventoryCheckService directly (fetches availability via Storefront's cached layer) |
| Internal customer-support tool | OrderLookupService, CustomerAccountService | High | Support agents need order + account lookup; outages here escalate quickly to management |
| Partner B2B client | PartnerCatalogFeed (indirectly depends on InventoryCheckService's underlying DB tables) | Medium | Single external partner; contractual SLA of 99.5% uptime, currently meeting it |
| Nightly batch reconciliation job | OrderLookupService, InventoryCheckService | Medium | Runs 2am-4am; not customer-facing but finance team depends on its output for daily reporting |

## 2. Internal service → service dependencies

- **CustomerAccountService → external postal-verification API**
  (synchronous call, no timeout/circuit breaker configured — see
  architecture-overview.md and health-status.json for the July 2026 incident
  this caused)
- **InventoryCheckService → Oracle primary DB** (direct, no caching layer
  for the legacy SOAP path)
- **PartnerCatalogFeed → Oracle primary DB** (via a separate cache/sync
  layer, refreshed every 2-5 minutes under normal load — this is the
  source of the stock-data staleness issue noted in its OpenAPI spec)
- **OrderLookupService → InventoryCheckService**: NOT a direct call.
  Order status doesn't require live stock data. (Worth confirming this
  assumption still holds before migration — flagged as a "verify" item,
  not a known fact, since original documentation is thin here.)

- **InventoryCheckService → OrderEventPublisher → JMS queues** (fired
  after a successful stock reservation commits; no shared transaction with
  that DB write — see architecture-overview.md's "dual write" note)
- **OrderConfirmationMessageListener → internal EmailService** (consumes
  OrderConfirmationQueue; no idempotency check before sending)
- **WarehousePickListener → external warehouse fulfillment partner API**
  (consumes WarehousePickQueue; no dead-letter queue, so a consistently
  failing message can cycle indefinitely — see that class's javadoc)
- **Checkout flow → PaymentGatewayClient** (external payment processor;
  no idempotency key sent, so timeout-triggered retries risk double-
  charging — see database/seed-data-sample.sql's duplicate PAYMENTS rows
  for a concrete example)
- **Checkout flow → ShippingCarrierClient** (external carrier aggregator
  for rate quotes/labels; no handling for HTTP 429 rate-limit responses)

## 2a. Messaging & external-integration dependents

| Component | Depends on | Criticality | Notes |
|---|---|---|---|
| OrderConfirmationQueue consumer | Internal EmailService | Medium | Customer-facing but not blocking — a delayed/duplicate email is an annoyance, not an outage |
| WarehousePickQueue consumer | External warehouse fulfillment partner API | High | A stuck/poison message here delays real fulfillment, not just a notification |
| Checkout flow | PaymentGatewayClient (external) | Critical | Revenue-critical; the idempotency gap is a real financial risk, not just a technical one |
| Checkout flow | ShippingCarrierClient (external) | High | Missing 429 handling caused orders stuck in PROCESSING during past peak periods |

## 3. Blast radius summary (informal risk ranking)

1. **CustomerAccountService** — highest risk. High dependent count (3 of 5
   client apps), handles PII, minimal test coverage, most complex business
   logic (loyalty tier calculation), and has an unmitigated external
   dependency risk (postal verification, no circuit breaker).
2. **InventoryCheckService** — second highest risk. High traffic
   volatility (up to 8x baseline during flash sales), synchronous blocking
   reservation logic, and the source of a known data-consistency issue with
   PartnerCatalogFeed.
3. **OrderLookupService** — lower risk despite highest traffic volume: it's
   the most stable service (99.95% uptime), mostly read-only, and has the
   simplest internal logic of the three core SOAP services.
4. **PartnerCatalogFeed** — lowest risk in isolation (single partner, low
   volume) but its data-staleness issue is a downstream symptom of
   InventoryCheckService's architecture, so it can't be fully fixed in
   isolation — worth migrating alongside InventoryCheckService rather than
   separately.
5. **PaymentGatewayClient (checkout integration)** — high risk despite
   being "just an integration": the missing idempotency key is a direct
   financial-correctness issue (double-charging), not just a reliability
   one. Should be prioritized early, likely alongside or before
   InventoryCheckService given both sit in the same critical
   order-placement path.
6. **Order messaging (JMS queues)** — medium-high risk. Not customer-
   facing in the same acute way as a checkout failure, but the combination
   of no dead-letter queue, no idempotent consumers, and no transactional
   coordination with the DB means silent data-integrity drift over time
   (missed notifications, duplicate emails) that's hard to detect after
   the fact. A good candidate to redesign properly (e.g. transactional
   outbox pattern) rather than a straight lift-and-shift to a new queue
   technology.

## 4. Open questions for a migration-planning agent to flag

- Does the nightly batch job have any hard-coded assumptions about
  WebLogic-specific behavior (e.g. JNDI lookups, session bean lifecycle)
  that would break if the underlying service moved to Spring Boot?
- Is there an existing SLA or contract clause with the B2B partner that
  constrains how PartnerCatalogFeed's data-sync behavior can change during
  migration?
- No automated integration tests exist for CustomerAccountService — what's
  the minimum test coverage needed before it's safe to touch, given it's
  also the highest-risk service?
