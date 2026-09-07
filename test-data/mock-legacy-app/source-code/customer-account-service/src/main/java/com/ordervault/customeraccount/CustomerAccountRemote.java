package com.ordervault.customeraccount;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import javax.ejb.EJBObject;
import java.io.Serializable;
import java.rmi.RemoteException;
import java.util.List;

public interface CustomerAccountRemote extends EJBObject {
    CustomerProfile getCustomerProfile(String customerId) throws RemoteException;
    AddressUpdateResult updateAddress(String customerId, Address address) throws RemoteException;
    LoyaltyRecalcResult recalculateLoyaltyPoints(String customerId) throws RemoteException;
}

class CustomerProfile implements Serializable {
    public String customerId;
    public String fullName;
    public String email;
    public int loyaltyPoints;
    public String loyaltyTier;
    public List<Address> addresses;
}

class Address implements Serializable {
    public String addressType; // SHIPPING, BILLING
    public String line1;
    public String line2;
    public String city;
    public String state;
    public String postalCode;
    public boolean isDefault;
}

class AddressUpdateResult implements Serializable {
    public boolean success;
    public List<String> validationErrors;
}

class LoyaltyRecalcResult implements Serializable {
    public String customerId;
    public int newPointsBalance;
    public String newTier;
}
