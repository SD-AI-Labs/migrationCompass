package com.samplex.payment;

/**
 * Payment record.
 *
 * `amount` is a double because the column is a DOUBLE — the money-as-float
 * mistake that shows up as off-by-a-cent rounding after refunds.
 */
public class Payment {

    private String id;
    private String orderId;
    private double amount;
    private String status;

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getOrderId() {
        return orderId;
    }

    public void setOrderId(String orderId) {
        this.orderId = orderId;
    }

    public double getAmount() {
        return amount;
    }

    public void setAmount(double amount) {
        this.amount = amount;
    }

    public String getStatus() {
        return status;
    }

    public void setStatus(String status) {
        this.status = status;
    }
}
