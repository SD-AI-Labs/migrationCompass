# Sample legacy API — fixture

A deliberately small, deterministic legacy system used for local development,
automated tests, demonstrations and screenshots.

**Synthetic, invented for this project.** No employer IP, no real customer data.

## What it is

Three Java EE / WebLogic-era services calling each other synchronously:

```
customer-service
       │  OrderServiceClient  (blocking HTTP, no timeout)
       ▼
order-service
       │  PaymentServiceClient (blocking HTTP, no idempotency key)
       ▼
payment-service
       │  PaymentGatewayClient (external processor)
       ▼
  external gateway
```

Each service is a REST controller over a service class over a JDBC repository —
the shape the migration analysis is built to reason about.

## Why it exists

The analysis pipeline needs *structured* signal: services, dependency edges,
test-coverage gaps, data-quality problems, restructuring needs. A fixture that
only contains tidy code exercises none of it. This one contains exactly the
things the rubric scores:

| Signal | Where |
|---|---|
| Synchronous service-to-service call | `customer-service/.../OrderServiceClient.java`, `order-service/.../PaymentServiceClient.java` |
| External integration | `payment-service/.../PaymentGatewayClient.java` |
| Test-coverage gap | `customer-service` has no test sources at all — see its README |
| Data-quality issue | `order-service/.../CustomerNameCache.java` (denormalized), `payment-service/.../PaymentRepository.java` (`DOUBLE` money) |
| Major restructuring | `payment-service/.../PaymentService.java` (static mutable state, no idempotency) |
| Legacy configuration | `application.properties` with hardcoded hosts per service |

## Deliberate limitations

- **Small on purpose.** Three services and a handful of classes. A fixture that
  looks like a real system is a fixture nobody reads.
- **No ground truth.** `ground-truth/` is excluded from ingestion by design (so the
  pipeline cannot retrieve the answer it is graded against), and this fixture
  ships none — the analysis is expected to *find* the problems listed above.
- **No build files.** There is no `pom.xml`, so nothing here pretends to compile.
  The analysis reads source, configuration and specs, not build output.

## Using it

```bash
# from v2/
pnpm seed:sample
```

See `v2/README`-level documentation in `PROJECT_STATUS.md` for the command's
options and what it reports.
