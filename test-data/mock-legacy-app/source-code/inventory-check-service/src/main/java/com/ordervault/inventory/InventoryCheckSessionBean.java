package com.ordervault.inventory;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import com.ordervault.messaging.OrderEventPublisher;

import javax.ejb.SessionBean;
import javax.ejb.SessionContext;
import javax.ejb.CreateException;
import java.rmi.RemoteException;
import java.util.UUID;

public class InventoryCheckSessionBean implements SessionBean {

    private SessionContext ctx;
    private InventoryDAO inventoryDAO = new InventoryDAO();
    private OrderEventPublisher orderEventPublisher = new OrderEventPublisher();

    public void ejbCreate() throws CreateException {}

    public StockResult checkStock(String sku, String warehouseId) throws RemoteException {
        try {
            StockResult result = inventoryDAO.findStock(sku, warehouseId);
            if (result == null) {
                throw new RemoteException("SKU not found: " + sku);
            }
            return result;
        } catch (Exception e) {
            throw new RemoteException("Error checking stock", e);
        }
    }

    public ReservationResult reserveStock(String sku, int quantity, String orderId) throws RemoteException {
        ReservationResult result = new ReservationResult();
        try {
            // NOTE: this call blocks on a DB row lock — see InventoryDAO's
            // javadoc. No timeout is applied at this layer; the only bound
            // is WebLogic's 30s connection timeout. During flash sales this
            // is the single biggest source of elevated p99 latency and, in
            // the August 2026 incident, a node restart.
            boolean success = inventoryDAO.reserveStockRow(sku, quantity, orderId);
            result.success = success;
            result.reservationId = success ? UUID.randomUUID().toString() : null;
            result.failureReason = success ? null : "Insufficient stock";

            if (success) {
                // NOTE: fired AFTER the DB transaction in reserveStockRow()
                // has already committed, with no shared transaction between
                // the two. See OrderEventPublisher's javadoc for the
                // "dual write" risk this creates — a crash between these
                // two lines silently drops the downstream notification.
                // customerId is not tracked at this layer in the current
                // design (a real gap — reserveStock() only receives orderId,
                // not customerId, so OrderEventPublisher's confirmation
                // event is published without it here; see that class for
                // how it's actually invoked in the full call chain, which
                // in production resolves customerId via a separate lookup
                // not shown in this snapshot).
                orderEventPublisher.publishOrderPlaced(orderId, null, sku, quantity);
            }

            return result;
        } catch (Exception e) {
            throw new RemoteException("Error reserving stock", e);
        }
    }

    public void setSessionContext(SessionContext ctx) { this.ctx = ctx; }
    public void ejbRemove() {}
    public void ejbActivate() {}
    public void ejbPassivate() {}
}
