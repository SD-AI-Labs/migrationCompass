package com.ordervault.inventory;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import javax.naming.InitialContext;
import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

/**
 * Handles stock reads and reservations against the shared Oracle primary.
 *
 * KNOWN BOTTLENECK: reserveStockRow() uses SELECT ... FOR UPDATE, which
 * takes an exclusive row lock on the STOCK table for the duration of the
 * transaction. Under normal traffic this resolves in milliseconds. During
 * flash sales, when hundreds of ReserveStock calls hit the same popular
 * SKU concurrently, requests queue up waiting for the row lock — this is
 * the root cause of the p99 latency spikes documented in
 * operational-data/traffic-stats.json and the August 2026 incident in
 * operational-data/health-status.json.
 */
public class InventoryDAO {

    private static final String DATASOURCE_JNDI = "java:comp/env/jdbc/OrderVaultDS";

    private Connection getConnection() throws Exception {
        InitialContext ctx = new InitialContext();
        DataSource ds = (DataSource) ctx.lookup(DATASOURCE_JNDI);
        return ds.getConnection();
    }

    public StockResult findStock(String sku, String warehouseId) throws SQLException {
        String sql = (warehouseId != null)
                ? "SELECT SKU, AVAILABLE_QTY, RESERVED_QTY FROM STOCK WHERE SKU = ? AND WAREHOUSE_ID = ?"
                : "SELECT SKU, SUM(AVAILABLE_QTY) AS AVAILABLE_QTY, SUM(RESERVED_QTY) AS RESERVED_QTY " +
                  "FROM STOCK WHERE SKU = ? GROUP BY SKU";
        try (Connection conn = getConnectionQuietly();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, sku);
            if (warehouseId != null) ps.setString(2, warehouseId);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) return null;
                StockResult result = new StockResult();
                result.sku = rs.getString("SKU");
                result.availableQuantity = rs.getInt("AVAILABLE_QTY");
                result.reservedQuantity = rs.getInt("RESERVED_QTY");
                return result;
            }
        }
    }

    /**
     * Synchronous, blocking reservation. This method is called directly
     * inline from InventoryCheckSessionBean.reserveStock() — there is no
     * async queue, no retry-with-backoff, and no circuit breaker. If the
     * DB is under heavy row-lock contention, the calling SOAP request just
     * blocks until it either succeeds or the WebLogic connection timeout
     * (30s, configured at the app-server level) is hit.
     */
    public boolean reserveStockRow(String sku, int quantity, String orderId) throws SQLException {
        String selectForUpdate = "SELECT AVAILABLE_QTY FROM STOCK WHERE SKU = ? FOR UPDATE";
        String updateStock = "UPDATE STOCK SET AVAILABLE_QTY = AVAILABLE_QTY - ?, RESERVED_QTY = RESERVED_QTY + ? WHERE SKU = ?";
        String insertReservation = "INSERT INTO STOCK_RESERVATION (SKU, QUANTITY, ORDER_ID, CREATED_AT) VALUES (?, ?, ?, SYSDATE)";

        try (Connection conn = getConnectionQuietly()) {
            conn.setAutoCommit(false);
            try (PreparedStatement lockPs = conn.prepareStatement(selectForUpdate)) {
                // <-- row lock acquired here; held until commit/rollback below
                lockPs.setString(1, sku);
                try (ResultSet rs = lockPs.executeQuery()) {
                    if (!rs.next() || rs.getInt("AVAILABLE_QTY") < quantity) {
                        conn.rollback();
                        return false;
                    }
                }
            }
            try (PreparedStatement updatePs = conn.prepareStatement(updateStock)) {
                updatePs.setInt(1, quantity);
                updatePs.setInt(2, quantity);
                updatePs.setString(3, sku);
                updatePs.executeUpdate();
            }
            try (PreparedStatement insertPs = conn.prepareStatement(insertReservation)) {
                insertPs.setString(1, sku);
                insertPs.setInt(2, quantity);
                insertPs.setString(3, orderId);
                insertPs.executeUpdate();
            }
            conn.commit();
            return true;
        }
    }

    private Connection getConnectionQuietly() {
        try {
            return getConnection();
        } catch (Exception e) {
            throw new RuntimeException("Failed to obtain DB connection", e);
        }
    }
}
