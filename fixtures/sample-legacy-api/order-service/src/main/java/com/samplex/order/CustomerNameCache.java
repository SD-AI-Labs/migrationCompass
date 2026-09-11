package com.samplex.order;

import java.util.HashMap;
import java.util.Map;

/**
 * In-memory cache of customer names.
 *
 * Exists so order list views avoid a call to customer-service. Unbounded, never
 * invalidated on a customer rename, and not synchronised — three separate
 * data-quality problems that all show up as stale or wrong names in order views.
 */
public class CustomerNameCache {

    private static final Map<String, String> NAMES = new HashMap<String, String>();

    public String nameFor(String customerId) {
        String cached = NAMES.get(customerId);
        if (cached != null) {
            return cached;
        }
        // Falls back to the denormalized value on the order row rather than
        // asking customer-service for the current name.
        return "UNKNOWN";
    }

    public void refresh(String customerId) {
        NAMES.put(customerId, "UNKNOWN");
    }
}
