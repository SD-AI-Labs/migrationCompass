# OrderVault — Architecture Overview (Legacy State)

**Status:** Production, in place since 2014. Candidate for modernization.

## 1. System summary

OrderVault is a monolithic Java EE application handling order lookup,
inventory checks, and customer account management for a mid-size retail
company. It was originally built to support a single storefront and has
since been extended to serve a mobile app, a partner B2B integration, and
an internal customer-support tool — none of which were part of the
original design.

## 2. Current tech stack

| Layer | Technology |
|---|---|
| App server | Oracle WebLogic Server 11g, 12-node cluster |
| Language / framework | Java 8, EJB 2.1 (session beans), JAX-WS |
| Web services | SOAP, WS-Security (username token) |
| Database | Oracle 11g, single primary instance, on-prem data center |
| Messaging | WebLogic built-in JMS — two queues (order confirmation, warehouse pick notification), no dead-letter queue configured |
| Build / deploy | Ant build scripts, manual WAR/EAR deployment via WebLogic console |
| Monitoring | Custom in-house logging to flat files, no centralized APM |

## 3. Service inventory

OrderVault exposes three SOAP services (see `api-specs/` for full WSDLs):

1. **OrderLookupService** — order status, order history, order detail lookup
2. **InventoryCheckService** — real-time stock levels, warehouse allocation
3. **CustomerAccountService** — account profile, address book, loyalty points

A fourth service, **PartnerCatalogFeed**, was added in 2020 as a newer-style
REST/OpenAPI service for a B2B partner integration — it was bolted on
without touching the core SOAP services, and duplicates some logic from
InventoryCheckService.

**Two external integrations** sit alongside the core services (see
`source-code/payment-integration/` and `source-code/shipping-integration/`):
a payment gateway (`PaymentGatewayClient`) called during checkout, and a
shipping carrier aggregator (`ShippingCarrierClient`) for rate quotes and
label creation. Both were added incrementally, outside the original design,
and neither has robust failure handling — see section 4.

**Asynchronous messaging** (see `source-code/order-messaging/`) was added
around 2017 to decouple two side effects of order placement — customer
confirmation emails and warehouse pick-list notifications — from the
synchronous checkout path. `OrderEventPublisher` fires after a successful
stock reservation in InventoryCheckService, publishing to two JMS queues
consumed by dedicated message-driven beans. This was a reasonable idea
executed with several gaps — see section 4.

## 3a. Database

Oracle 11g, 14 tables (orders, customers, products, stock, payments,
shipments, promotions, returns, notification/audit logs). Full schema and
estimated production row counts are in `database/schema.sql` and
`database/README.md`. Several known data-quality issues exist (duplicate
customer emails, inconsistent order-status casing, orphaned foreign keys) —
see `database/README.md` for the full list. These matter for migration
planning: a data-quality issue that's tolerable in the current system
(loosely-typed legacy code, forgiving queries) may not survive a move to a
more strictly-typed Spring Boot / JPA data layer without explicit handling.

## 4. Known pain points (why migration is being considered)

- **Tight coupling to WebLogic**: EJB session beans reference WebLogic-specific
  JNDI lookups throughout the codebase, making the app effectively
  non-portable to another app server without significant rewrite.
- **Single point of failure on the DB**: no read replicas; all 12 WebLogic
  nodes hit the same Oracle primary directly, causing contention during
  peak order volume (holiday season).
- **No API gateway**: clients call WebLogic nodes directly through a
  hardware load balancer. No centralized auth, rate limiting, or usage
  monitoring per client.
- **CustomerAccountService is the riskiest to touch**: it has the most
  downstream dependents (see `dependency-graph.md`) and the original
  authors are no longer with the company. Test coverage is minimal —
  mostly manual QA scripts, no automated integration tests.
- **InventoryCheckService duplication**: logic is now partially duplicated
  between the original SOAP service and the newer PartnerCatalogFeed
  REST API, creating a risk of the two returning inconsistent stock levels
  under high load.
- **Deployment risk**: deployments require a maintenance window, since
  WebLogic cluster restarts drop in-flight sessions. No blue-green or
  canary deployment capability exists today.
- **Messaging has no dead-letter queue.** `OrderConfirmationQueue` and
  `WarehousePickQueue` have no `<error-destination>` configured (see
  `source-code/order-messaging/src/main/deploy/weblogic-jms-descriptor.xml`).
  A message that consistently fails processing cycles as a "poison
  message" or is silently dropped on expiry — no alerting either way.
- **No transactional coordination between DB writes and JMS publishes.**
  `OrderEventPublisher` fires after the stock-reservation DB transaction
  has already committed, with no shared transaction. A crash between the
  two silently drops the downstream notification — a classic "dual write"
  gap.
- **Neither JMS consumer is idempotent.** At-least-once JMS delivery plus
  no dedup check means duplicate messages cause duplicate customer emails
  and duplicate warehouse notifications — concretely reproduced in
  `database/seed-data-sample.sql`'s `NOTIFICATION_LOG` rows.
- **External integrations lack resilience patterns.** `PaymentGatewayClient`
  sends no idempotency key, so timeout-triggered retries can double-charge
  a customer. `ShippingCarrierClient` has no handling for HTTP 429
  (rate-limited) responses from the carrier aggregator, and no
  backoff/retry — both integrations were added without the kind of
  resilience patterns (circuit breakers, retries with backoff, idempotency
  keys) that would be considered standard for a new Spring Boot service.

## 5. Traffic profile

- **OrderLookupService**: highest volume, ~65% of total API traffic,
  heavily read-oriented
- **InventoryCheckService**: second highest, spikes sharply during flash
  sales and holiday promotions (up to 8x baseline)
- **CustomerAccountService**: lower volume but higher sensitivity (PII),
  and the most complex business logic (loyalty point calculations, address
  validation rules)

See `operational-data/traffic-stats.json` for detailed numbers.

## 6. Migration goals (informal, from engineering leadership)

- Move to independently deployable services (no more "one deploy = whole
  app restarts")
- Introduce an API gateway for centralized auth, rate limiting, and
  client onboarding
- Eliminate the InventoryCheckService/PartnerCatalogFeed duplication —
  single source of truth for stock data
- De-risk CustomerAccountService specifically, given its low test coverage
  and high blast radius
- No unplanned production outages during migration — phased approach
  strongly preferred over big-bang rewrite
- Add a proper dead-letter queue and idempotent consumers for the
  order-confirmation and warehouse-pick messaging flows
- Add idempotency keys to the payment gateway integration, and
  backoff/retry handling to the shipping carrier integration
- Resolve or explicitly accept the known data-quality issues in the
  database (see `database/README.md`) before/during data migration
