package com.ordervault.shipping;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import java.io.OutputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Integrates with OrderVault's shipping carrier aggregator (rate quotes and
 * label creation across UPS/FedEx/USPS through one external API).
 *
 * KNOWN RISK: no handling for HTTP 429 (rate limited) responses. The
 * carrier aggregator enforces a request-per-second cap that OrderVault
 * exceeds during high-order-volume periods (same sales events that spike
 * InventoryCheckService traffic — see operational-data/traffic-stats.json).
 * When rate-limited, this client currently treats a 429 the same as any
 * other non-200 response: a generic failure surfaced to the caller, with
 * no automatic backoff-and-retry. During the November 2025 peak (not
 * modeled elsewhere in this dataset, referenced here for narrative
 * context), this caused a spike in orders stuck in PROCESSING status
 * because label creation failed and was never automatically retried.
 */
public class ShippingCarrierClient {

    private static final String RATE_QUOTE_ENDPOINT =
            "https://ship.external-carrier-aggregator.example.com/v2/rates";
    private static final String CREATE_LABEL_ENDPOINT =
            "https://ship.external-carrier-aggregator.example.com/v2/labels";

    public RateQuoteResult getRateQuote(String originWarehouseId, String destinationPostalCode, double weightKg) {
        try {
            URL url = new URL(RATE_QUOTE_ENDPOINT);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(6000);

            String payload = String.format(
                    "{\"origin\":\"%s\",\"destination_postal\":\"%s\",\"weight_kg\":%.2f}",
                    originWarehouseId, destinationPostalCode, weightKg);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload.getBytes("UTF-8"));
            }

            int responseCode = conn.getResponseCode();
            if (responseCode == 200) {
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(conn.getInputStream()))) {
                    return RateQuoteResult.success(parseRate(reader.readLine()));
                }
            } else if (responseCode == 429) {
                // NOTE: this is the risk described in the class javadoc —
                // no Retry-After header parsing, no backoff, just a
                // generic failure passed straight up to the caller.
                return RateQuoteResult.failure("Rate limited by carrier aggregator (HTTP 429)");
            } else {
                return RateQuoteResult.failure("Carrier aggregator returned HTTP " + responseCode);
            }
        } catch (Exception e) {
            return RateQuoteResult.failure("Unexpected error: " + e.getMessage());
        }
    }

    public LabelResult createLabel(String orderId, String carrier, String originWarehouseId) {
        // Implementation follows the same pattern as getRateQuote() — HTTP
        // POST to CREATE_LABEL_ENDPOINT with the same missing 429 handling.
        // Omitted in this snapshot for brevity; the risk is identical.
        throw new UnsupportedOperationException("Not implemented in this snapshot");
    }

    private double parseRate(String responseBody) {
        // Simplified parsing for this snapshot.
        return 8.99;
    }

    public static class RateQuoteResult {
        public final boolean success;
        public final Double rate;
        public final String failureReason;

        private RateQuoteResult(boolean success, Double rate, String failureReason) {
            this.success = success;
            this.rate = rate;
            this.failureReason = failureReason;
        }

        static RateQuoteResult success(double rate) {
            return new RateQuoteResult(true, rate, null);
        }

        static RateQuoteResult failure(String reason) {
            return new RateQuoteResult(false, null, reason);
        }
    }

    public static class LabelResult {
        public boolean success;
        public String trackingNumber;
        public String failureReason;
    }
}
