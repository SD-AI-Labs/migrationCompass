# customer-service

Customer master data and address handling. Deployed as a WAR on WebLogic 12c.

## Status

**No automated tests.** There has never been a test source tree in this module —
it predates the team's adoption of JUnit, and the code has been considered too
fragile to add tests around retroactively.

## Known issues

- `OrderServiceClient` performs a blocking HTTP call with no connect or read
  timeout configured. A slow order-service response holds the WebLogic worker
  thread until the OS gives up.
- Address validation is inlined in the service class rather than tested.
