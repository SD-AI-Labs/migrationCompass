# OrderVault Database — Schema & Scale Notes

SYNTHETIC data for portfolio project testing.

## Files

- **`schema.sql`** — full DDL, 14 tables, Oracle 11g dialect. Read this first
  — most of the interesting migration-risk detail is in the inline comments.
- **`seed-data-sample.sql`** — a small representative sample (~40 rows total)
  showing realistic relationships and a few intentional data-quality issues.

## Estimated production scale (for context, not literally seeded)

| Table | Estimated row count |
|---|---|
| CUSTOMERS | ~450,000 |
| ORDERS | ~2,800,000 |
| ORDER_ITEMS | ~7,100,000 |
| STOCK_RESERVATION | ~9,500,000 (grows unbounded — no archival job exists) |
| PRODUCTS | ~18,000 |
| PAYMENTS | ~2,850,000 |
| NOTIFICATION_LOG | ~5,200,000 |
| AUDIT_LOG | ~1,900,000 (despite only ~30% of writes being logged — see schema.sql) |

These numbers are given as context for reasoning about migration approach
(e.g. "can we do a big-bang data migration, or does 9.5M growing
STOCK_RESERVATION rows demand a phased/streaming approach?") — they are not
meant to be literally generated as rows in this repo.

## Known data-quality issues (intentional, for RAG/agent discovery)

1. **Duplicate customer emails** — no UNIQUE constraint on
   `CUSTOMERS.EMAIL`; ~1,200 duplicate rows exist in production from old
   unreconciled account merges.
2. **Inconsistent ORDER.STATUS casing** — free-text column, not a
   constrained enum. At least 11 casing/spelling variants of "CANCELLED"
   alone exist in production.
3. **Orphaned STOCK_RESERVATION.ORDER_ID** — no foreign key to ORDERS
   (the reservation table predates the orders table).
4. **Duplicate PAYMENTS rows** — same `GATEWAY_TXN_ID` appearing twice,
   caused by `PaymentGatewayClient`'s retry behavior without an idempotency
   key (see `source-code/payment-integration/`).
5. **MERGED customers with no successor pointer** — `CUSTOMERS.STATUS =
   'MERGED'` exists as a value, but there's no column recording which
   account absorbed the merged one.

Each of these is the kind of thing a real migration's Discovery Agent
should be able to surface by querying/reasoning over the schema and sample
data — not something that's spelled out for it in a clean report ahead of
time (consistent with how `ground-truth/` is used elsewhere in this
project — see that folder's notes in the parent README).
