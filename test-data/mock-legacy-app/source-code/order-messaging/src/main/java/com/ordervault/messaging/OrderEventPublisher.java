package com.ordervault.messaging;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import javax.jms.*;
import javax.naming.InitialContext;

/**
 * Publishes order-related events onto two legacy JMS queues, hosted on
 * WebLogic's built-in JMS server:
 *
 *   - ORDER_CONFIRMATION_QUEUE — consumed by OrderConfirmationMessageListener,
 *     triggers a customer confirmation email
 *   - WAREHOUSE_PICK_QUEUE — consumed by WarehousePickListener, notifies the
 *     external warehouse fulfillment partner to start pick/pack
 *
 * Called from InventoryCheckSessionBean.reserveStock() immediately after a
 * successful stock reservation — see that class for the call site.
 *
 * KNOWN RISKS (the core "legacy messaging" pain points for this system):
 *
 * 1. NO TRANSACTIONAL COORDINATION WITH THE DB WRITE. The stock reservation
 *    (a DB transaction in InventoryDAO) and this JMS publish are two
 *    separate operations with no shared transaction (no XA/JTA
 *    coordination configured). If the JVM crashes or the connection drops
 *    between the DB commit and the JMS send, the reservation succeeds but
 *    no event is ever published — the customer's stock is reserved but no
 *    confirmation email or warehouse notification ever fires. This is the
 *    classic "dual write" problem.
 *
 * 2. AT-LEAST-ONCE DELIVERY, NO IDEMPOTENT CONSUMERS. JMS queues here are
 *    configured for at-least-once delivery (standard WebLogic default).
 *    Neither downstream listener de-duplicates by order ID before acting —
 *    see NOTIFICATION_LOG's seeded duplicate rows in
 *    database/seed-data-sample.sql for a concrete example of the resulting
 *    duplicate-email symptom.
 *
 * 3. HARDCODED JNDI QUEUE NAMES, tightly coupled to WebLogic's JMS
 *    provider — another instance of the vendor lock-in pattern already
 *    noted for EJB lookups elsewhere in this codebase.
 */
public class OrderEventPublisher {

    private static final String CONNECTION_FACTORY_JNDI = "java:comp/env/jms/OrderVaultConnectionFactory";
    private static final String ORDER_CONFIRMATION_QUEUE_JNDI = "java:comp/env/jms/OrderConfirmationQueue";
    private static final String WAREHOUSE_PICK_QUEUE_JNDI = "java:comp/env/jms/WarehousePickQueue";

    public void publishOrderPlaced(String orderId, String customerId, String sku, int quantity) {
        // NOTE: both sends below happen in sequence, outside any shared
        // transaction with the caller's DB work. If the first send
        // succeeds and the second throws, the order ends up with a
        // confirmation email queued but no warehouse pick-list notification
        // — a partial-failure state nothing currently detects or reconciles.
        sendOrderConfirmationEvent(orderId, customerId);
        sendWarehousePickEvent(orderId, sku, quantity);
    }

    private void sendOrderConfirmationEvent(String orderId, String customerId) {
        try {
            InitialContext ctx = new InitialContext();
            ConnectionFactory cf = (ConnectionFactory) ctx.lookup(CONNECTION_FACTORY_JNDI);
            Queue queue = (Queue) ctx.lookup(ORDER_CONFIRMATION_QUEUE_JNDI);

            try (Connection connection = cf.createConnection()) {
                Session session = connection.createSession(false, Session.AUTO_ACKNOWLEDGE);
                MessageProducer producer = session.createProducer(queue);

                MapMessage message = session.createMapMessage();
                message.setString("orderId", orderId);
                message.setString("customerId", customerId);
                // NOTE: no message ID / dedup key set beyond JMS's own
                // built-in JMSMessageID, which the consumer doesn't check.
                producer.send(message);
            }
        } catch (Exception e) {
            // NOTE: swallowed — a failed publish here does not roll back
            // the stock reservation that already committed, and does not
            // surface any alert. This is the "silent partial failure"
            // risk described in the class javadoc.
            System.err.println("Failed to publish order confirmation event: " + e.getMessage());
        }
    }

    private void sendWarehousePickEvent(String orderId, String sku, int quantity) {
        try {
            InitialContext ctx = new InitialContext();
            ConnectionFactory cf = (ConnectionFactory) ctx.lookup(CONNECTION_FACTORY_JNDI);
            Queue queue = (Queue) ctx.lookup(WAREHOUSE_PICK_QUEUE_JNDI);

            try (Connection connection = cf.createConnection()) {
                Session session = connection.createSession(false, Session.AUTO_ACKNOWLEDGE);
                MessageProducer producer = session.createProducer(queue);

                MapMessage message = session.createMapMessage();
                message.setString("orderId", orderId);
                message.setString("sku", sku);
                message.setInt("quantity", quantity);
                producer.send(message);
            }
        } catch (Exception e) {
            System.err.println("Failed to publish warehouse pick event: " + e.getMessage());
        }
    }
}
