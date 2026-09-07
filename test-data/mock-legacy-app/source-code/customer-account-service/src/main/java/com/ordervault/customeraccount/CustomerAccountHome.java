package com.ordervault.customeraccount;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import javax.ejb.CreateException;
import javax.ejb.EJBHome;
import java.rmi.RemoteException;

interface CustomerAccountHome extends EJBHome {
    CustomerAccountRemote create() throws CreateException, RemoteException;
}
