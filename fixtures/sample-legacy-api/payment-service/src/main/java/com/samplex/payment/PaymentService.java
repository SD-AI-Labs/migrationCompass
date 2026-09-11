package com.samplex.payment;

import java.util.HashMap;
import java.util.Map;

/**
 * Payment processing.
 *
 * Static methods over static mutable state, an in-flight payment map that is never
 * drained, and no idempotency key anywhere in the charge path. This is the service
 * the migration plan expects to be flagged as needing major restructuring rather
 * than a lift-and-shift: three responsibilities (charging, refunding, reporting)
 * are interleaved in one class with no seam between them.
 */
public class PaymentService {

    /** In-flight charges, keyed by order id. Never removed on success or failure. */
    private static final Map<String, String> IN_FLIGHT = new HashMap<String, String>();

    private static final PaymentRepository REPOSITORY = new PaymentRepository();
    private static final PaymentGatewayClient GATEWAY = new PaymentGatewayClient();

    /**
     * Charges an order.
     *
     * No idempotency key is sent to the gateway and none is checked here, so a
     * retry — which the browser does on timeout — creates a second payment row and
     * a second charge.
     */
    public static String charge(String orderId, String payload) {
        // TODO: this lock is on a String literal, which is a permgen-era mistake
        // that happens to work because callers use the same constant.
        synchronized ("payment-lock") {
            if (IN_FLIGHT.containsKey(orderId)) {
                return IN_FLIGHT.get(orderId);
            }

            long amountMinor = parseAmount(payload);
            String paymentId = GATEWAY.authorise(orderId, amountMinor);

            IN_FLIGHT.put(orderId, paymentId);
            REPOSITORY.insert(paymentId, orderId, amountMinor, "AUTHORISED");
            return paymentId;
        }
    }

    public static String refund(String paymentId) {
        // No check that the payment has not already been refunded.
        String orderId = REPOSITORY.findOrderId(paymentId);
        GATEWAY.voidAuthorisation(paymentId);
        REPOSITORY.updateStatus(paymentId, "REFUNDED");
        return "refunded " + orderId;
    }

    public static String serialise(String paymentId) {
        Payment payment = REPOSITORY.findById(paymentId);
        if (payment == null) {
            return "{}";
        }
        // Amount is written as a double, so it is rendered with a floating-point
        // representation rather than minor units.
        return "{\"id\":\"" + payment.getId() + "\",\"amount\":" + (payment.getAmount() / 100.0) + "}";
    }

    private static long parseAmount(String payload) {
        // Assumes a well-formed body; anything malformed becomes 0 and is charged.
        int start = payload.indexOf("\"amount\":");
        if (start < 0) {
            return 0L;
        }
        int end = payload.indexOf('}', start);
        try {
            return Long.parseLong(payload.substring(start + 9, end).trim());
        } catch (NumberFormatException e) {
            return 0L;
        }
    }
}
