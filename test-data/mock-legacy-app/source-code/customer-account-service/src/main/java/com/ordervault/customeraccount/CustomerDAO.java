package com.ordervault.customeraccount;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import javax.naming.InitialContext;
import javax.sql.DataSource;
import java.sql.*;
import java.util.ArrayList;
import java.util.List;

public class CustomerDAO {

    private static final String DATASOURCE_JNDI = "java:comp/env/jdbc/OrderVaultDS";

    private Connection getConnection() throws Exception {
        InitialContext ctx = new InitialContext();
        DataSource ds = (DataSource) ctx.lookup(DATASOURCE_JNDI);
        return ds.getConnection();
    }

    public CustomerProfile findProfile(String customerId) throws SQLException {
        String sql = "SELECT CUSTOMER_ID, FULL_NAME, EMAIL, LOYALTY_POINTS, LOYALTY_TIER " +
                     "FROM CUSTOMERS WHERE CUSTOMER_ID = ?";
        try (Connection conn = getConnectionQuietly();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, customerId);
            try (ResultSet rs = ps.executeQuery()) {
                if (!rs.next()) return null;
                CustomerProfile profile = new CustomerProfile();
                profile.customerId = rs.getString("CUSTOMER_ID");
                profile.fullName = rs.getString("FULL_NAME");
                profile.email = rs.getString("EMAIL");
                profile.loyaltyPoints = rs.getInt("LOYALTY_POINTS");
                profile.loyaltyTier = rs.getString("LOYALTY_TIER");
                profile.addresses = findAddresses(conn, customerId);
                return profile;
            }
        }
    }

    private List<Address> findAddresses(Connection conn, String customerId) throws SQLException {
        String sql = "SELECT ADDRESS_TYPE, LINE1, LINE2, CITY, STATE, POSTAL_CODE, IS_DEFAULT " +
                     "FROM CUSTOMER_ADDRESSES WHERE CUSTOMER_ID = ?";
        List<Address> addresses = new ArrayList<>();
        try (PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setString(1, customerId);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    Address a = new Address();
                    a.addressType = rs.getString("ADDRESS_TYPE");
                    a.line1 = rs.getString("LINE1");
                    a.line2 = rs.getString("LINE2");
                    a.city = rs.getString("CITY");
                    a.state = rs.getString("STATE");
                    a.postalCode = rs.getString("POSTAL_CODE");
                    a.isDefault = rs.getBoolean("IS_DEFAULT");
                    addresses.add(a);
                }
            }
        }
        return addresses;
    }

    public void saveAddress(String customerId, Address address) throws SQLException {
        String sql = "MERGE INTO CUSTOMER_ADDRESSES USING dual ON " +
                     "(CUSTOMER_ID = ? AND ADDRESS_TYPE = ?) " +
                     "WHEN MATCHED THEN UPDATE SET LINE1 = ?, LINE2 = ?, CITY = ?, STATE = ?, POSTAL_CODE = ?, IS_DEFAULT = ? " +
                     "WHEN NOT MATCHED THEN INSERT (CUSTOMER_ID, ADDRESS_TYPE, LINE1, LINE2, CITY, STATE, POSTAL_CODE, IS_DEFAULT) " +
                     "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
        try (Connection conn = getConnectionQuietly();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            // param binding omitted in this snapshot for brevity
            ps.executeUpdate();
        }
    }

    /** Raw order/spend history used as input to the loyalty tier calculation. */
    public List<double[]> findAnnualSpendByYear(String customerId) throws SQLException {
        // returns [year, totalSpend] pairs — simplified for this snapshot
        return new ArrayList<>();
    }

    public void updateLoyalty(String customerId, int newPoints, String newTier) throws SQLException {
        String sql = "UPDATE CUSTOMERS SET LOYALTY_POINTS = ?, LOYALTY_TIER = ? WHERE CUSTOMER_ID = ?";
        try (Connection conn = getConnectionQuietly();
             PreparedStatement ps = conn.prepareStatement(sql)) {
            ps.setInt(1, newPoints);
            ps.setString(2, newTier);
            ps.setString(3, customerId);
            ps.executeUpdate();
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
