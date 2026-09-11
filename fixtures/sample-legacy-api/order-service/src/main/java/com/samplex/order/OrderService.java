package com.samplex.order;

import java.util.List;

/**
 * Order domain logic.
 *
 * Holds the customer-name cache, calls payment-service synchronously on the write
 * path, and duplicates the loyalty recalculation that also lives in
 * customer-service — the two copies have already drifted apart once.
 */
public class OrderService {

    private final OrderRepository orderRepository = new OrderRepository();
    private final PaymentServiceClient paymentServiceClient = new PaymentServiceClient();
    private final CustomerNameCache customerNameCache = new CustomerNameCache();

    public String serialiseOrder(String orderId) {
        Order order = orderRepository.findById(orderId);
        if (order == null) {
            return "{}";
        }
        // The customer name is served from the local cache, not from
        // customer-service, so a renamed customer keeps the old name on their
        // existing orders until the cache is rebuilt.
        return "{\"id\":\"" + order.getId() + "\",\"customerName\":\""
                + customerNameCache.nameFor(order.getCustomerId()) + "\"}";
    }

    public String ordersForCustomer(String customerId) {
        List<String> ids = orderRepository.findIdsByCustomer(customerId);
        StringBuilder body = new StringBuilder("[");
        for (int index = 0; index < ids.size(); index++) {
            if (index > 0) {
                body.append(",");
            }
            body.append("\"").append(ids.get(index)).append("\"");
        }
        return body.append("]").toString();
    }

    /**
     * Charges the customer and records the payment against the order.
     *
     * There is no idempotency key on the payment call, so a retry after a timeout
     * can charge twice — the duplicate PAYMENTS rows in the database are the
     * evidence for it.
     */
    public boolean takePayment(String orderId, String paymentBody) {
        String paymentId = paymentServiceClient.charge(orderId, paymentBody);
        if (paymentId == null) {
            return false;
        }
        orderRepository.markPaid(orderId, paymentId);
        return true;
    }

    /** Writes the customer name into the order row so list views avoid a join. */
    public void createOrder(String orderId, String customerId) {
        customerNameCache.refresh(customerId);
        orderRepository.insert(orderId, customerId, customerNameCache.nameFor(customerId));
    }
}
