package com.ordervault.payment;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.
//
// Called during OrderVault's checkout flow (the checkout/order-placement
// orchestration itself lives in a separate module not included in this
// snapshot — this client represents the payment-gateway integration point
// specifically).

import java.io.OutputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.UUID;

/**
 * Integrates with OrderVault's external payment processor.
 *
 * KNOWN RISK: charge() does not send an idempotency key to the gateway.
 * When a request times out (the gateway's own p99 has been observed above
 * 4s during peak periods) callers retry — see the checkout orchestrator's
 * retry logic, not included in this snapshot — and a timed-out request
 * that actually succeeded server-side gets charged AGAIN on retry, since
 * the gateway has no way to recognize it as a duplicate of the original.
 *
 * This is the direct cause of the duplicate PAYMENTS rows sharing a
 * GATEWAY_TXN_ID described in database/schema.sql and seeded in
 * database/seed-data-sample.sql (PAY-88340-A / PAY-88341-A).
 *
 * A production-grade fix would generate a client-side idempotency key per
 * checkout attempt and send it as a header — the gateway's own docs support
 * this, it was simply never implemented here.
 */
public class PaymentGatewayClient {

    private static final String CHARGE_ENDPOINT =
            "https://payments.external-processor.example.com/v1/charges";

    public ChargeResult charge(String orderId, double amount, String paymentMethodToken) {
        try {
            URL url = new URL(CHARGE_ENDPOINT);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(8000);
            // NOTE: no "Idempotency-Key" header sent — see class javadoc.

            String payload = String.format(
                    "{\"order_id\":\"%s\",\"amount\":%.2f,\"payment_method\":\"%s\"}",
                    orderId, amount, paymentMethodToken);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload.getBytes("UTF-8"));
            }

            int responseCode = conn.getResponseCode();
            if (responseCode == 200) {
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(conn.getInputStream()))) {
                    String txnId = parseTxnId(reader.readLine());
                    return ChargeResult.success(txnId);
                }
            } else {
                return ChargeResult.failure("Gateway returned HTTP " + responseCode);
            }
        } catch (java.net.SocketTimeoutException e) {
            // NOTE: this is the dangerous case — we don't know if the
            // charge actually went through on the gateway's side. Current
            // behavior is to surface this as a generic failure, which
            // upstream retry logic treats the same as "definitely didn't
            // charge" — leading to the duplicate-charge risk above.
            return ChargeResult.failure("Timeout — charge status unknown, do not blindly retry");
        } catch (Exception e) {
            return ChargeResult.failure("Unexpected error: " + e.getMessage());
        }
    }

    private String parseTxnId(String responseBody) {
        // Simplified parsing for this snapshot — real implementation uses
        // a JSON library. Returns a synthetic transaction ID shape matching
        // what's seeded in database/seed-data-sample.sql.
        return "gw_txn_" + UUID.randomUUID().toString().substring(0, 6);
    }

    public static class ChargeResult {
        public final boolean success;
        public final String gatewayTransactionId;
        public final String failureReason;

        private ChargeResult(boolean success, String gatewayTransactionId, String failureReason) {
            this.success = success;
            this.gatewayTransactionId = gatewayTransactionId;
            this.failureReason = failureReason;
        }

        static ChargeResult success(String txnId) {
            return new ChargeResult(true, txnId, null);
        }

        static ChargeResult failure(String reason) {
            return new ChargeResult(false, null, reason);
        }
    }
}
