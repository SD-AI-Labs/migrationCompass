package com.ordervault.orderlookup;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import javax.ejb.EJBObject;
import java.rmi.RemoteException;
import java.util.Date;
import java.util.List;

/**
 * Remote interface for OrderLookupService, callable via RMI/IIOP or wrapped
 * by the SOAP endpoint generated from OrderLookupService.wsdl.
 */
public interface OrderLookupRemote extends EJBObject {

    OrderStatusResult getOrderStatus(String orderId, String customerId) throws RemoteException;

    List<OrderSummary> getOrderHistory(String customerId, Date fromDate, Date toDate, Integer maxResults)
            throws RemoteException;

    OrderDetailResult getOrderDetail(String orderId) throws RemoteException;
}
