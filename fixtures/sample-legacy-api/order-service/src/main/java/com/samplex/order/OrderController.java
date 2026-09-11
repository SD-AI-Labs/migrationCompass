package com.samplex.order;

import javax.ws.rs.GET;
import javax.ws.rs.POST;
import javax.ws.rs.Path;
import javax.ws.rs.PathParam;
import javax.ws.rs.Produces;
import javax.ws.rs.core.MediaType;

/**
 * REST surface for orders.
 *
 * Read paths are cache-backed and fast; the write path blocks on payment-service
 * before it returns, so an order request is only as available as the slowest
 * downstream service.
 */
@Path("/orders")
public class OrderController {

    private final OrderService orderService = new OrderService();

    @GET
    @Path("/{id}")
    @Produces(MediaType.APPLICATION_JSON)
    public String getOrder(@PathParam("id") String orderId) {
        return orderService.serialiseOrder(orderId);
    }

    @GET
    @Produces(MediaType.APPLICATION_JSON)
    public String listOrders(@javax.ws.rs.QueryParam("customerId") String customerId) {
        // The list endpoint returns a denormalized view, including the customer
        // name copied into the order row at creation time.
        return orderService.ordersForCustomer(customerId);
    }

    @POST
    @Path("/{id}/pay")
    public String payOrder(@PathParam("id") String orderId, String body) {
        // Blocks on payment-service. See PaymentServiceClient for the missing
        // idempotency handling.
        boolean paid = orderService.takePayment(orderId, body);
        return "{\"paid\":" + paid + "}";
    }
}
