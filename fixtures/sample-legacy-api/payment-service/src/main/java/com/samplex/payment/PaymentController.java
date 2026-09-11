package com.samplex.payment;

import javax.ws.rs.GET;
import javax.ws.rs.POST;
import javax.ws.rs.Path;
import javax.ws.rs.PathParam;
import javax.ws.rs.Produces;
import javax.ws.rs.QueryParam;
import javax.ws.rs.core.MediaType;

/**
 * REST surface for payments.
 *
 * Three endpoints and three different response shapes: JSON for charge, raw text
 * for refund, and a hand-built JSON string for the lookup. The inconsistency is
 * historical rather than deliberate.
 */
@Path("/payments")
public class PaymentController {

    @POST
    @Path("/charge")
    @Produces(MediaType.APPLICATION_JSON)
    public String charge(@QueryParam("orderId") String orderId, String body) {
        // Delegates to a static method on a class that also holds mutable state.
        String paymentId = PaymentService.charge(orderId, body);
        return "{\"id\":\"" + paymentId + "\"}";
    }

    @GET
    @Path("/{id}")
    @Produces(MediaType.APPLICATION_JSON)
    public String getPayment(@PathParam("id") String paymentId) {
        return PaymentService.serialise(paymentId);
    }

    @POST
    @Path("/{id}/refund")
    @Produces(MediaType.TEXT_PLAIN)
    public String refund(@PathParam("id") String paymentId) {
        // Refunds are not transactional with the order status update in
        // order-service, so a refund can succeed while the order still reads PAID.
        return PaymentService.refund(paymentId);
    }
}
