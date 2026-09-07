package com.ordervault.messaging;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import javax.ejb.MessageDrivenBean;
import javax.ejb.MessageDrivenContext;
import javax.jms.MapMessage;
import javax.jms.Message;
import javax.jms.MessageListener;

/**
 * Message-Driven Bean consuming ORDER_CONFIRMATION_QUEUE. Sends a
 * confirmation email to the customer via an internal EmailService (not
 * included in this snapshot — a thin wrapper around an SMTP relay).
 *
 * KNOWN RISK: NO IDEMPOTENCY CHECK. This listener does not check
 * NOTIFICATION_LOG (or anywhere else) before sending, despite that table
 * existing specifically to record what's been sent — see
 * database/schema.sql's note on NOTIFICATION_LOG. Combined with at-least-
 * once JMS delivery (see OrderEventPublisher's javadoc), a single order can
 * — and in production sometimes does — trigger more than one confirmation
 * email. Concrete example seeded in
 * database/seed-data-sample.sql (NOTIF-9001 / NOTIF-9002, same order,
 * both marked SENT).
 *
 * NO DEAD-LETTER QUEUE is configured for ORDER_CONFIRMATION_QUEUE either
 * — see deploy/weblogic-jms-descriptor.xml. A message that repeatedly
 * fails processing (e.g. EmailService is down) will be redelivered
 * according to WebLogic's default redelivery policy and eventually
 * discarded silently, with no record of the failure.
 */
public class OrderConfirmationMessageListener implements MessageDrivenBean, MessageListener {

    private MessageDrivenContext ctx;

    public void onMessage(Message message) {
        try {
            MapMessage mapMessage = (MapMessage) message;
            String orderId = mapMessage.getString("orderId");
            String customerId = mapMessage.getString("customerId");

            // NOTE: no check against NOTIFICATION_LOG here — see class
            // javadoc. A production-grade fix would look up
            // (orderId, 'ORDER_CONFIRMATION_EMAIL') before sending and
            // skip if already SENT, ideally within the same transaction
            // as marking it sent to close the race condition entirely.
            sendConfirmationEmail(orderId, customerId);
            logNotification(orderId, "ORDER_CONFIRMATION_EMAIL", "SENT");

        } catch (Exception e) {
            // NOTE: exception handling here does not distinguish between
            // "transient failure, safe to redirect to a retry queue" and
            // "permanent failure, should go straight to a dead-letter
            // queue for manual review" — everything falls through to
            // WebLogic's default redelivery behavior.
            System.err.println("Failed to process order confirmation message: " + e.getMessage());
        }
    }

    private void sendConfirmationEmail(String orderId, String customerId) {
        // Delegates to an internal EmailService (SMTP relay wrapper), not
        // included in this snapshot.
    }

    private void logNotification(String orderId, String type, String status) {
        // Writes to NOTIFICATION_LOG. Implementation omitted in this
        // snapshot — the important fact is WHEN this runs relative to the
        // send (after, not as a guard before), which is what allows
        // duplicates through despite the table's existence.
    }

    public void setMessageDrivenContext(MessageDrivenContext ctx) {
        this.ctx = ctx;
    }

    public void ejbCreate() {}
    public void ejbRemove() {}
}
