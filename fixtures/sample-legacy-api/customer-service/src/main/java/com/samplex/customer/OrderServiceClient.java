package com.samplex.customer;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Synchronous client for order-service.
 *
 * Calls the order-service REST API over plain HTTP. The base URL comes from a
 * property file rather than service discovery, and the connection has no timeout,
 * so a stalled order-service stalls this WebLogic worker thread indefinitely.
 */
public class OrderServiceClient {

    private static final String ORDER_SERVICE_BASE_URL =
            Configuration.get("order.service.base.url", "http://legacy-orders.internal:8080");

    /**
     * Fetches a customer's orders from order-service.
     *
     * FIXME: no connect or read timeout. This is the call that took the whole
     * customer-service down during the last peak period.
     */
    public String fetchOrders(String customerId) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(ORDER_SERVICE_BASE_URL + "/orders?customerId=" + customerId);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("GET");

            BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream()));
            StringBuilder body = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                body.append(line);
            }
            reader.close();
            return body.toString();
        } catch (Exception e) {
            // Swallowed on purpose years ago to keep the customer page rendering.
            // It is why order-service outages looked like empty order lists.
            return "[]";
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }
}
