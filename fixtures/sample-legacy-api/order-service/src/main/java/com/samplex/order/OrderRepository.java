package com.samplex.order;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

/**
 * JDBC access for orders.
 *
 * Shares the ORDERS table with nothing else, but writes a denormalized copy of
 * the customer name (CUSTOMER_NAME) that duplicates CUSTOMERS.NAME — the two
 * diverge whenever a customer is renamed and the order rows are not refreshed.
 */
public class OrderRepository {

    private Connection connection;

    public Order findById(String orderId) {
        try (Statement statement = connection().createStatement()) {
            ResultSet rows = statement.executeQuery(
                    "SELECT id, customer_id, status FROM orders WHERE id = '" + orderId + "'");
            if (!rows.next()) {
                return null;
            }
            Order order = new Order();
            order.setId(rows.getString("id"));
            order.setCustomerId(rows.getString("customer_id"));
            order.setStatus(rows.getString("status"));
            return order;
        } catch (Exception e) {
            throw new RuntimeException("Failed to load order " + orderId, e);
        }
    }

    public List<String> findIdsByCustomer(String customerId) {
        List<String> ids = new ArrayList<String>();
        try (Statement statement = connection().createStatement()) {
            // No pagination: a large B2B customer returns every order they have
            // ever placed in one response.
            ResultSet rows = statement.executeQuery(
                    "SELECT id FROM orders WHERE customer_id = '" + customerId + "' ORDER BY created_at DESC");
            while (rows.next()) {
                ids.add(rows.getString("id"));
            }
        } catch (Exception e) {
            throw new RuntimeException("Failed to list orders for " + customerId, e);
        }
        return ids;
    }

    public void insert(String orderId, String customerId, String customerName) {
        try (Statement statement = connection().createStatement()) {
            statement.executeUpdate(
                    "INSERT INTO orders (id, customer_id, customer_name, status) VALUES ('"
                            + orderId + "', '" + customerId + "', '" + customerName + "', 'NEW')");
        } catch (Exception e) {
            throw new RuntimeException("Failed to insert order " + orderId, e);
        }
    }

    public void markPaid(String orderId, String paymentId) {
        try (Statement statement = connection().createStatement()) {
            // The payment id is stored without a uniqueness constraint, so two
            // payments for the same order both persist.
            statement.executeUpdate(
                    "UPDATE orders SET status = 'PAID', payment_id = '" + paymentId + "' WHERE id = '" + orderId + "'");
        } catch (Exception e) {
            throw new RuntimeException("Failed to mark order paid " + orderId, e);
        }
    }

    private Connection connection() throws Exception {
        if (connection == null || connection.isClosed()) {
            Class.forName("oracle.jdbc.OracleDriver");
            connection = DriverManager.getConnection(Configuration.get("order.db.url", ""), "orderapp", "");
        }
        return connection;
    }
}
