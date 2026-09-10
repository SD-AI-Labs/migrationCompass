package com.ordervault.orderlookup;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import javax.ejb.CreateException;
import javax.ejb.EJBHome;
import java.rmi.RemoteException;

/**
 * Home interface — legacy EJB 2.1 pattern. Clients look this up via JNDI
 * (see deploy/jndi-names.txt) and call create() to get a working reference
 * to the session bean. This JNDI coupling is one of the reasons the app is
 * hard to port off WebLogic — see architecture-overview.md.
 */
public interface OrderLookupHome extends EJBHome {
    OrderLookupRemote create() throws CreateException, RemoteException;
}
