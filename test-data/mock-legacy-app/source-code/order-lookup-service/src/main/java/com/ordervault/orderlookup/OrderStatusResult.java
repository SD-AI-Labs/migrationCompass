package com.ordervault.orderlookup;

// SYNTHETIC legacy code — fictional portfolio test data, not a real system.

import java.io.Serializable;
import java.math.BigDecimal;
import java.util.Date;
import java.util.List;

public class OrderStatusResult implements Serializable {
    public String orderId;
    public String status; // PLACED, PROCESSING, SHIPPED, DELIVERED, CANCELLED
    public Date lastUpdated;
    public Date estimatedDeliveryDate; // nullable
}

class OrderSummary implements Serializable {
    public String orderId;
    public Date orderDate;
    public String status;
    public BigDecimal totalAmount;
}

class OrderDetailResult implements Serializable {
    public String orderId;
    public List<LineItem> lineItems;
    public String shippingAddress;
    public String paymentMethod;
}

class LineItem implements Serializable {
    public String sku;
    public int quantity;
    public BigDecimal unitPrice;
}
