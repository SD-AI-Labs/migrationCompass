package com.ordervault.orderlookup;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import javax.ejb.SessionBean;
import javax.ejb.SessionContext;
import javax.ejb.CreateException;
import java.rmi.RemoteException;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;

/**
 * Stateless session bean implementing OrderLookupService's business logic.
 * Deployed on WebLogic; SOAP endpoint is generated from this bean via
 * JAX-WS annotations processed at build time (see build.xml in this
 * service's root — not included in this snapshot).
 */
public class OrderLookupSessionBean implements SessionBean {

    private static final int DEFAULT_MAX_HISTORY_RESULTS = 50;

    private SessionContext ctx;
    private OrderDAO orderDAO = new OrderDAO();

    public void ejbCreate() throws CreateException {
        // no-op, stateless bean
    }

    public OrderStatusResult getOrderStatus(String orderId, String customerId) throws RemoteException {
        try {
            OrderStatusResult result = orderDAO.findOrderStatus(orderId, customerId);
            if (result == null) {
                throw new RemoteException("Order not found: " + orderId);
            }
            return result;
        } catch (Exception e) {
            // NOTE: all DAO exceptions collapse into RemoteException here,
            // which loses the original exception type. Downstream SOAP
            // clients only ever see a generic fault — this has made
            // production troubleshooting slower than it should be
            // (support team has to check WebLogic logs directly).
            throw new RemoteException("Error retrieving order status", e);
        }
    }

    public List<OrderSummary> getOrderHistory(String customerId, Date fromDate, Date toDate, Integer maxResults)
            throws RemoteException {
        int effectiveMax = (maxResults != null) ? maxResults : DEFAULT_MAX_HISTORY_RESULTS;
        try {
            // NOTE: This default-to-50 behavior is NOT documented anywhere
            // in the WSDL or any client-facing docs. Several legacy
            // integrations assume "no maxResults = all results" and have
            // silently missed older orders as a result. Flagged in
            // architecture-overview.md as a known gotcha.
            List<Object> rawResults = orderDAO.findOrderHistory(customerId, fromDate, toDate, effectiveMax);
            List<OrderSummary> summaries = new ArrayList<>();
            // mapping omitted in this snapshot — real implementation maps
            // ResultSet rows to OrderSummary objects here
            return summaries;
        } catch (Exception e) {
            throw new RemoteException("Error retrieving order history", e);
        }
    }

    public OrderDetailResult getOrderDetail(String orderId) throws RemoteException {
        // Implementation omitted in this snapshot for brevity — follows the
        // same pattern as getOrderStatus: DAO call wrapped in a broad
        // try/catch that collapses to RemoteException.
        throw new UnsupportedOperationException("Not implemented in this snapshot");
    }

    public void setSessionContext(SessionContext ctx) {
        this.ctx = ctx;
    }

    public void ejbRemove() {}
    public void ejbActivate() {}
    public void ejbPassivate() {}
}
