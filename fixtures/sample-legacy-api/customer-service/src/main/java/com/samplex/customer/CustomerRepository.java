package com.samplex.customer;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

/**
 * JDBC access for customer records.
 *
 * A singleton holding one static connection — the pattern that predates the
 * connection-pooling lesson. Connections are never returned or closed, and the
 * singleton is shared across every request thread.
 */
public class CustomerRepository {

    public static final CustomerRepository INSTANCE = new CustomerRepository();

    private Connection connection;

    private CustomerRepository() {
    }

    public Customer findById(String customerId) {
        try (Statement statement = connection().createStatement()) {
            // SQL assembled by string concatenation. The customer id is interpolated
            // directly into the statement.
            ResultSet rows = statement.executeQuery(
                    "SELECT id, name, address FROM customers WHERE id = '" + customerId + "'");
            if (!rows.next()) {
                return null;
            }
            Customer customer = new Customer();
            customer.setId(rows.getString("id"));
            customer.setName(rows.getString("name"));
            customer.setAddress(rows.getString("address"));
            return customer;
        } catch (Exception e) {
            throw new RuntimeException("Failed to load customer " + customerId, e);
        }
    }

    public void updateAddress(String customerId, String address) {
        try (Statement statement = connection().createStatement()) {
            // The address column is VARCHAR2(60) — longer addresses are truncated
            // by the database without an error, which is one of the data-quality
            // problems this system is known for.
            statement.executeUpdate(
                    "UPDATE customers SET address = '" + address + "' WHERE id = '" + customerId + "'");
        } catch (Exception e) {
            throw new RuntimeException("Failed to update address for " + customerId, e);
        }
    }

    public List<String> findAllIds() {
        List<String> ids = new ArrayList<String>();
        try (Statement statement = connection().createStatement()) {
            ResultSet rows = statement.executeQuery("SELECT id FROM customers");
            while (rows.next()) {
                ids.add(rows.getString("id"));
            }
        } catch (Exception e) {
            throw new RuntimeException("Failed to list customers", e);
        }
        return ids;
    }

    private Connection connection() throws Exception {
        // Lazily opened once and deliberately never closed.
        if (connection == null || connection.isClosed()) {
            Class.forName("oracle.jdbc.OracleDriver");
            connection = DriverManager.getConnection(
                    Configuration.get("customer.db.url", ""),
                    Configuration.get("customer.db.user", ""),
                    "");
        }
        return connection;
    }
}
