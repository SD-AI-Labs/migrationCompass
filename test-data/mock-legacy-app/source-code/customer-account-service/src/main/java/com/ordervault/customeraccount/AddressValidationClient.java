package com.ordervault.customeraccount;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import java.net.HttpURLConnection;
import java.net.URL;
import java.io.OutputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;

/**
 * Calls an external postal-verification service to validate addresses on
 * update. This is the dependency flagged in dependency-graph.md and
 * architecture-overview.md as an unmitigated operational risk:
 *
 *   - No connect/read timeout is configured (HttpURLConnection defaults
 *     to infinite wait if neither is set — which is exactly the case here).
 *   - No circuit breaker — if the external service is slow or down, every
 *     UpdateAddress call hangs until the underlying OS socket timeout
 *     eventually fires (platform-dependent, observed as long as several
 *     minutes in production).
 *   - No retry logic, no fallback behavior (e.g. "accept address unvalidated
 *     and flag for manual review") if the external call fails.
 *
 * This caused the July 2026 incident recorded in
 * operational-data/health-status.json (~15 min of elevated error rate).
 */
public class AddressValidationClient {

    private static final String VALIDATION_ENDPOINT =
            "https://postal-verify.external-vendor.example.com/v2/validate";

    public boolean validate(Address address) {
        try {
            URL url = new URL(VALIDATION_ENDPOINT);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            // NOTE: no conn.setConnectTimeout(...) or conn.setReadTimeout(...)
            // — this is the root cause of the risk described above.

            String payload = buildPayload(address);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload.getBytes("UTF-8"));
            }

            int responseCode = conn.getResponseCode();
            if (responseCode != 200) {
                return false;
            }

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(conn.getInputStream()))) {
                String response = reader.readLine();
                return response != null && response.contains("\"valid\":true");
            }
        } catch (Exception e) {
            // Any failure (including a hang that eventually times out at
            // the OS level) is treated as "validation failed" — no
            // distinction is made between "address is invalid" and
            // "we couldn't reach the validator," which also makes this
            // hard to alert on correctly.
            return false;
        }
    }

    private String buildPayload(Address address) {
        return String.format(
                "{\"line1\":\"%s\",\"city\":\"%s\",\"state\":\"%s\",\"postalCode\":\"%s\"}",
                address.line1, address.city, address.state, address.postalCode);
    }
}
