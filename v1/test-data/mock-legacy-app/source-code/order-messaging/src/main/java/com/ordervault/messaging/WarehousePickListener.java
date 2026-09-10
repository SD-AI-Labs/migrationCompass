package com.ordervault.messaging;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import com.ordervault.shipping.ShippingCarrierClient;

import javax.ejb.MessageDrivenBean;
import javax.ejb.MessageDrivenContext;
import javax.jms.MapMessage;
import javax.jms.Message;
import javax.jms.MessageListener;

/**
 * Message-Driven Bean consuming WAREHOUSE_PICK_QUEUE. Notifies the external
 * warehouse fulfillment partner (a third-party API, not modeled in detail
 * in this snapshot — conceptually similar in shape to
 * {@link ShippingCarrierClient}) that an order is ready to be picked and
 * packed.
 *
 * KNOWN RISK: POISON MESSAGE / NO DEAD-LETTER QUEUE. If the warehouse
 * partner's API is down or returns an error, onMessage() throws, and with
 * no dead-letter queue configured (see
 * deploy/weblogic-jms-descriptor.xml), WebLogic redelivers the same
 * message according to its default retry policy. For a SKU/order
 * combination the partner API consistently rejects (e.g. a discontinued
 * product still referenced by an old cached page — see PRODUCTS.IS_ACTIVE
 * in database/schema.sql), this can cycle indefinitely, consuming consumer
 * threads and delaying processing of genuinely new messages behind it in
 * the queue.
 *
 * This is exactly the kind of failure mode reflected in the seeded
 * NOTIFICATION_LOG row NOTIF-9004 (status FAILED) in
 * database/seed-data-sample.sql — a warehouse notification that failed and,
 * without a dead-letter queue, has no clear resolution path other than
 * manual intervention.
 */
public class WarehousePickListener implements MessageDrivenBean, MessageListener {

    private MessageDrivenContext ctx;

    public void onMessage(Message message) {
        try {
            MapMessage mapMessage = (MapMessage) message;
            String orderId = mapMessage.getString("orderId");
            String sku = mapMessage.getString("sku");
            int quantity = mapMessage.getInt("quantity");

            boolean notified = notifyWarehousePartner(orderId, sku, quantity);
            logNotification(orderId, "WAREHOUSE_PICK_LIST", notified ? "SENT" : "FAILED");

            if (!notified) {
                // NOTE: throwing here is what triggers WebLogic's
                // redelivery — see class javadoc for why this is risky
                // without a dead-letter queue backing this listener.
                throw new RuntimeException("Warehouse partner notification failed for order " + orderId);
            }

        } catch (Exception e) {
            System.err.println("Failed to process warehouse pick message: " + e.getMessage());
            throw new RuntimeException(e); // rethrown to trigger JMS redelivery
        }
    }

    private boolean notifyWarehousePartner(String orderId, String sku, int quantity) {
        // Calls the external warehouse fulfillment partner's API.
        // Implementation omitted in this snapshot — conceptually similar
        // HTTP-client shape to ShippingCarrierClient/PaymentGatewayClient
        // in this codebase.
        return true; // placeholder
    }

    private void logNotification(String orderId, String type, String status) {
        // Writes to NOTIFICATION_LOG — same pattern as
        // OrderConfirmationMessageListener.
    }

    public void setMessageDrivenContext(MessageDrivenContext ctx) {
        this.ctx = ctx;
    }

    public void ejbCreate() {}
    public void ejbRemove() {}
}
