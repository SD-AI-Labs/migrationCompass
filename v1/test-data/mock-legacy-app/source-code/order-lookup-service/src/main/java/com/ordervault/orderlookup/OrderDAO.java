package com.ordervault.orderlookup;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import javax.naming.InitialContext;
import javax.sql.DataSource;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
 * Direct JDBC data access — no ORM, hand-written SQL, connection pulled
 * from a JNDI-bound DataSource configured in WebLogic's console.
 * No connection pooling tuning has been touched since ~2016 (see
 * architecture-overview.md re: DB contention during peak volume).
 */
public class OrderDAO {

    private static final String DATASOURCE_JNDI = "java:comp/env/jdbc/OrderVaultDS";

    private Connection getConnection() throws Exception {
        InitialContext ctx = new InitialContext();
        DataSource ds = (DataSource) ctx.lookup(DATASOURCE_JNDI);
        return ds.getConnection();
    }

    public OrderStatusResult findOrderStatus(String orderId, String customerId) throws SQLException {
        String sql = "SELECT ORDER_ID, STATUS, LAST_UPDATED, EST_DELIVERY_DATE " +
                     "FROM ORDERS WHERE ORDER_ID = ? AND CUSTOMER_ID = ?";
        try (Connection conn = getConnectionQuietly();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, orderId);
            ps.setString(2, customerId);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) {
                    return null;
                }
                OrderStatusResult result = new OrderStatusResult();
                result.orderId = rs.getString("ORDER_ID");
                result.status = rs.getString("STATUS");
                result.lastUpdated = rs.getTimestamp("LAST_UPDATED");
                result.estimatedDeliveryDate = rs.getDate("EST_DELIVERY_DATE");
                return result;
            }
        }
    }

    /**
     * NOTE: no LIMIT applied at the SQL level when maxResults is null —
     * relies entirely on the caller passing a sane maxResults. This matches
     * the "undocumented behavior" comment in OrderLookupService.wsdl:
     * legacy clients that omit maxResults sometimes get back far more rows
     * than expected, or (on very old accounts) time out.
     */
    public List<Object> findOrderHistory(String customerId, Date fromDate, Date toDate, Integer maxResults)
            throws SQLException {
        StringBuilder sql = new StringBuilder(
                "SELECT ORDER_ID, ORDER_DATE, STATUS, TOTAL_AMOUNT FROM ORDERS WHERE CUSTOMER_ID = ?");
        if (fromDate != null) sql.append(" AND ORDER_DATE >= ?");
        if (toDate != null) sql.append(" AND ORDER_DATE <= ?");
        sql.append(" ORDER BY ORDER_DATE DESC");
        if (maxResults != null) {
            sql.append(" FETCH FIRST ").append(maxResults).append(" ROWS ONLY");
        }
        // ^ maxResults defaults to 50 in the session bean layer if the
        // caller passes null — see OrderLookupSessionBean.getOrderHistory()

        List<Object> results = new ArrayList<>();
        try (Connection conn = getConnectionQuietly();
             PreparedStatement ps = conn.prepareStatement(sql.toString())) {
            int idx = 1;
            ps.setString(idx++, customerId);
            if (fromDate != null) ps.setDate(idx++, new java.sql.Date(fromDate.getTime()));
            if (toDate != null) ps.setDate(idx++, new java.sql.Date(toDate.getTime()));
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    // mapped to OrderSummary in the session bean layer
                    results.add(rs);
                }
            }
        }
        return results;
    }

    private Connection getConnectionQuietly() {
        try {
            return getConnection();
        } catch (Exception e) {
            // NOTE: swallowed and rethrown as unchecked — a known anti-pattern
            // flagged during code review but never fixed due to backward-
            // compatibility concerns with existing exception handling upstream.
            throw new RuntimeException("Failed to obtain DB connection", e);
        }
    }
}
