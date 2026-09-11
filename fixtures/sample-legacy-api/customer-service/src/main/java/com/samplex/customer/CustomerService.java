package com.samplex.customer;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Customer domain logic.
 *
 * Everything lives in one class: lookup, address validation, loyalty tiering and
 * the call out to order-service. Splitting it was blocked years ago because
 * nothing is covered by tests and the team could not establish what depended on
 * which path.
 */
public class CustomerService {

    // Instance state on a container-managed object. It survives across requests
    // and is not synchronised.
    private final Map<String, Customer> cache = new HashMap<String, Customer>();

    private final OrderServiceClient orderServiceClient = new OrderServiceClient();

    public Customer findCustomer(String customerId) {
        if (cache.containsKey(customerId)) {
            return cache.get(customerId);
        }
        Customer customer = loadFromDatabase(customerId);
        cache.put(customerId, customer);
        return customer;
    }

    /** Fans out to order-service for this customer's order history. */
    public String ordersForCustomer(String customerId) {
        // TODO: this should not be a synchronous call inside a read path. It makes
        // the customer lookup only as available as order-service.
        return orderServiceClient.fetchOrders(customerId);
    }

    public void updateAddress(String customerId, String rawAddress) {
        if (!isValidAddress(rawAddress)) {
            throw new IllegalArgumentException("Invalid address");
        }
        // Legacy: address updates were also sent to the postal verification batch,
        // which no longer exists, so this only writes locally now.
        saveAddress(customerId, rawAddress);
    }

    private boolean isValidAddress(String rawAddress) {
        // TODO: postal validation without the verification API means a regex that
        // rejects every non-US address.
        return rawAddress != null && rawAddress.matches("[0-9]+ [A-Za-z ]+, [A-Z]{2} [0-9]{5}");
    }

    private Customer loadFromDatabase(String customerId) {
        return CustomerRepository.INSTANCE.findById(customerId);
    }

    private void saveAddress(String customerId, String address) {
        CustomerRepository.INSTANCE.updateAddress(customerId, address);
    }

    public List<String> allCustomerIds() {
        return CustomerRepository.INSTANCE.findAllIds();
    }
}
