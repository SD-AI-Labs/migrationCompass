package com.samplex.order;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Synchronous client for payment-service.
 *
 * Sends the charge request and reads the payment id back from the response body.
 * No idempotency key is included, and the timeout is whatever the JVM default
 * happens to be.
 */
public class PaymentServiceClient {

    private static final String PAYMENT_SERVICE_BASE_URL =
            Configuration.get("payment.service.base.url", "http://legacy-payments.internal:8080");

    /**
     * Charges an order and returns the payment id, or null on failure.
     *
     * FIXME: retries are handled by the caller re-invoking the endpoint from the
     * browser. Because no idempotency key is sent, a user who resubmits after a
     * timeout is charged twice.
     */
    public String charge(String orderId, String payload) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(PAYMENT_SERVICE_BASE_URL + "/payments/charge?orderId=" + orderId);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");

            OutputStream out = connection.getOutputStream();
            out.write(payload.getBytes("UTF-8"));
            out.flush();

            if (connection.getResponseCode() != 200) {
                return null;
            }
            return readPaymentId(connection);
        } catch (Exception e) {
            // Logged and swallowed: the order stays unpaid and the customer retries.
            return null;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private String readPaymentId(HttpURLConnection connection) throws Exception {
        java.io.BufferedReader reader =
                new java.io.BufferedReader(new java.io.InputStreamReader(connection.getInputStream()));
        String body = reader.readLine();
        reader.close();
        if (body == null) {
            return null;
        }
        int start = body.indexOf("\"id\":\"");
        if (start < 0) {
            return null;
        }
        int end = body.indexOf('"', start + 6);
        return end < 0 ? null : body.substring(start + 6, end);
    }
}
