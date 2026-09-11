package com.samplex.payment;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;

/**
 * JDBC access for payments.
 *
 * Stores amounts as a DOUBLE column, which is the canonical money-as-float
 * mistake: repeated refunds and partial captures accumulate rounding error, and
 * the seed data already contains two rows whose stored amount differs from the
 * gateway's record by a cent.
 */
public class PaymentRepository {

    private Connection connection;

    public Payment findById(String paymentId) {
        try (Statement statement = connection().createStatement()) {
            ResultSet rows = statement.executeQuery(
                    // SELECT * — the column list has changed three times and the
                    // reader below depends on the current order.
                    "SELECT * FROM payments WHERE id = '" + paymentId + "'");
            if (!rows.next()) {
                return null;
            }
            Payment payment = new Payment();
            payment.setId(rows.getString("id"));
            payment.setOrderId(rows.getString("order_id"));
            payment.setAmount(rows.getDouble("amount"));
            payment.setStatus(rows.getString("status"));
            return payment;
        } catch (Exception e) {
            throw new RuntimeException("Failed to load payment " + paymentId, e);
        }
    }

    public String findOrderId(String paymentId) {
        Payment payment = findById(paymentId);
        return payment == null ? null : payment.getOrderId();
    }

    public void insert(String paymentId, String orderId, long amountMinor, String status) {
        try (Statement statement = connection().createStatement()) {
            // No unique constraint on order_id, which is how duplicate payments for
            // one order become possible at all.
            statement.executeUpdate(
                    "INSERT INTO payments (id, order_id, amount, status, created_at) VALUES ('"
                            + paymentId + "', '" + orderId + "', " + amountMinor + ", '" + status + "', SYSDATE)");
        } catch (Exception e) {
            throw new RuntimeException("Failed to insert payment " + paymentId, e);
        }
    }

    public void updateStatus(String paymentId, String status) {
        try (Statement statement = connection().createStatement()) {
            statement.executeUpdate(
                    "UPDATE payments SET status = '" + status + "' WHERE id = '" + paymentId + "'");
        } catch (Exception e) {
            throw new RuntimeException("Failed to update payment " + paymentId, e);
        }
    }

    private Connection connection() throws Exception {
        if (connection == null || connection.isClosed()) {
            Class.forName("oracle.jdbc.OracleDriver");
            connection = DriverManager.getConnection(Configuration.get("payment.db.url", ""), "payapp", "");
        }
        return connection;
    }
}
