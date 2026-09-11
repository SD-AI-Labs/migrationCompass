package com.samplex.customer;

import javax.ws.rs.GET;
import javax.ws.rs.POST;
import javax.ws.rs.Path;
import javax.ws.rs.PathParam;
import javax.ws.rs.Produces;
import javax.ws.rs.core.MediaType;

/**
 * REST surface for customer master data.
 *
 * Deployed on WebLogic 12c as a WAR. The container supplies the JAX-RS runtime,
 * which is why there is no framework configuration in this module.
 */
@Path("/customers")
public class CustomerController {

    private final CustomerService customerService = new CustomerService();

    @GET
    @Path("/{id}")
    @Produces(MediaType.APPLICATION_JSON)
    public String getCustomer(@PathParam("id") String customerId) {
        // TODO: return a real DTO — this hand-builds JSON with string concatenation,
        // which breaks on any customer name containing a quote.
        Customer customer = customerService.findCustomer(customerId);
        return "{\"id\":\"" + customer.getId() + "\",\"name\":\"" + customer.getName() + "\"}";
    }

    @GET
    @Path("/{id}/orders")
    @Produces(MediaType.APPLICATION_JSON)
    public String getCustomerOrders(@PathParam("id") String customerId) {
        // Synchronous, and it fans out to order-service on the request thread.
        return customerService.ordersForCustomer(customerId);
    }

    @POST
    @Path("/{id}/address")
    public String updateAddress(@PathParam("id") String customerId, String body) {
        customerService.updateAddress(customerId, body);
        return "{\"status\":\"ok\"}";
    }
}
