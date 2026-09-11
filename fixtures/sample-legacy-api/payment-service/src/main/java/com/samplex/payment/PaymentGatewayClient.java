package com.samplex.payment;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Client for the external payment processor.
 *
 * A single configured endpoint, a synchronous POST per authorisation, and no
 * handling for the processor's 429 rate-limit response — the retry storm during
 * the last peak period handed the processor a timeout and left orders stuck in
 * PROCESSING.
 */
public class PaymentGatewayClient {

    private static final String GATEWAY_URL =
            Configuration.get("payment.gateway.url", "https://gateway.example-processor.test/api/v2");

    /**
     * Authorises a charge and returns the processor's transaction id.
     *
     * The id is generated locally if the processor does not return one, which
     * means a failed call can still produce a payment row.
     */
    public String authorise(String orderId, long amountMinor) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(GATEWAY_URL + "/authorise");
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");

            String payload = "{\"reference\":\"" + orderId + "\",\"amount\":" + amountMinor + "}";
            OutputStream out = connection.getOutputStream();
            out.write(payload.getBytes("UTF-8"));
            out.flush();

            // A 429 is not distinguished from any other error: no backoff, no retry
            // policy, no alert.
            if (connection.getResponseCode() != 200) {
                return "local-" + orderId + "-" + System.currentTimeMillis();
            }

            BufferedReader reader =
                    new BufferedReader(new InputStreamReader(connection.getInputStream()));
            String body = reader.readLine();
            reader.close();
            return body == null ? "local-" + orderId : body.trim();
        } catch (Exception e) {
            return "local-" + orderId + "-" + System.currentTimeMillis();
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    public void voidAuthorisation(String paymentId) {
        try {
            URL url = new URL(GATEWAY_URL + "/authorise/" + paymentId + "/void");
            HttpURLConnection connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            // The response is not checked: a failed void is indistinguishable from
            // a successful one from this service's perspective.
            connection.getResponseCode();
            connection.disconnect();
        } catch (Exception e) {
            // Swallowed.
        }
    }
}
