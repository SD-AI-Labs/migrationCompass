package com.ordervault.inventory;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import javax.ejb.CreateException;
import javax.ejb.EJBHome;
import java.io.Serializable;
import java.rmi.RemoteException;
import java.util.List;

interface InventoryCheckHome extends EJBHome {
    InventoryCheckRemote create() throws CreateException, RemoteException;
}

class StockResult implements Serializable {
    public String sku;
    public int availableQuantity;
    public int reservedQuantity;
    public List<WarehouseStock> warehouseBreakdown;
}

class WarehouseStock implements Serializable {
    public String warehouseId;
    public int quantity;
}

class ReservationResult implements Serializable {
    public String reservationId;
    public boolean success;
    public String failureReason;
}
