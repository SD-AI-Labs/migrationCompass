package com.ordervault.inventory;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import javax.ejb.EJBObject;
import java.rmi.RemoteException;

public interface InventoryCheckRemote extends EJBObject {
    StockResult checkStock(String sku, String warehouseId) throws RemoteException;
    ReservationResult reserveStock(String sku, int quantity, String orderId) throws RemoteException;
}
