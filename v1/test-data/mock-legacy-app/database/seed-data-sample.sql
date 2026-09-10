-- OrderVault :: Sample Seed Data
-- SYNTHETIC data for portfolio project testing.
--
-- This is a SMALL REPRESENTATIVE SAMPLE, not a full production dump.
-- See README.md in this directory for estimated real-world scale.
-- Enough rows here to exercise realistic relationships and a few of the
-- data-quality issues called out in schema.sql (duplicate emails,
-- inconsistent status casing) without bloating the repo.

-- ============================================================
-- WAREHOUSES
-- ============================================================
INSERT INTO WAREHOUSES VALUES ('WH-EAST-01', 'Newark Distribution Center', 'US-EAST', 1);
INSERT INTO WAREHOUSES VALUES ('WH-WEST-01', 'Reno Distribution Center', 'US-WEST', 1);
INSERT INTO WAREHOUSES VALUES ('WH-CENTRAL-01', 'Dallas Distribution Center', 'US-CENTRAL', 1);

-- ============================================================
-- PRODUCTS (sample of ~10, real catalog is much larger — see README)
-- ============================================================
INSERT INTO PRODUCTS VALUES ('SKU-100001', 'Wireless Mouse - Black', 'Electronics', 19.99, 1, SYSDATE - 900);
INSERT INTO PRODUCTS VALUES ('SKU-100002', 'Mechanical Keyboard - RGB', 'Electronics', 79.99, 1, SYSDATE - 850);
INSERT INTO PRODUCTS VALUES ('SKU-100003', '27in Monitor - 4K', 'Electronics', 349.99, 1, SYSDATE - 700);
INSERT INTO PRODUCTS VALUES ('SKU-200001', 'Running Shoes - Size 10', 'Footwear', 89.99, 1, SYSDATE - 600);
INSERT INTO PRODUCTS VALUES ('SKU-200002', 'Yoga Mat - Purple', 'Fitness', 24.99, 1, SYSDATE - 500);
INSERT INTO PRODUCTS VALUES ('SKU-300001', 'Coffee Maker - 12 Cup', 'Home', 59.99, 1, SYSDATE - 400);
INSERT INTO PRODUCTS VALUES ('SKU-300002', 'Blender - 1000W', 'Home', 89.99, 0, SYSDATE - 1200); -- discontinued, IS_ACTIVE=0
INSERT INTO PRODUCTS VALUES ('SKU-400001', 'Desk Lamp - LED', 'Home Office', 34.99, 1, SYSDATE - 300);
INSERT INTO PRODUCTS VALUES ('SKU-400002', 'Standing Desk Converter', 'Home Office', 199.99, 1, SYSDATE - 250);
INSERT INTO PRODUCTS VALUES ('SKU-500001', 'Backpack - Laptop 15in', 'Bags', 49.99, 1, SYSDATE - 800);

-- ============================================================
-- STOCK (spread across warehouses)
-- ============================================================
INSERT INTO STOCK VALUES ('SKU-100001', 'WH-EAST-01', 450, 30, SYSDATE);
INSERT INTO STOCK VALUES ('SKU-100001', 'WH-WEST-01', 210, 15, SYSDATE);
INSERT INTO STOCK VALUES ('SKU-100002', 'WH-EAST-01', 85, 40, SYSDATE);   -- low stock, high reservation — realistic flash-sale snapshot
INSERT INTO STOCK VALUES ('SKU-100003', 'WH-CENTRAL-01', 32, 5, SYSDATE);
INSERT INTO STOCK VALUES ('SKU-200001', 'WH-WEST-01', 600, 20, SYSDATE);
INSERT INTO STOCK VALUES ('SKU-300001', 'WH-EAST-01', 150, 0, SYSDATE);

-- ============================================================
-- CUSTOMERS (includes an intentional duplicate email — see schema.sql note)
-- ============================================================
INSERT INTO CUSTOMERS VALUES ('CUST-0000481', 'Maria Chen', 'maria.chen@example.com', 8420, 'PLATINUM', SYSDATE - 2100, 'ACTIVE'); -- hardcoded VIP, see CustomerAccountSessionBean.java
INSERT INTO CUSTOMERS VALUES ('CUST-0002210', 'James Okafor', 'jokafor@example.com', 6150, 'PLATINUM', SYSDATE - 1800, 'ACTIVE'); -- hardcoded VIP, see CustomerAccountSessionBean.java
INSERT INTO CUSTOMERS VALUES ('CUST-0010045', 'Priya Sharma', 'priya.sharma@example.com', 1240, 'SILVER', SYSDATE - 900, 'ACTIVE');
INSERT INTO CUSTOMERS VALUES ('CUST-0010892', 'David Kim', 'dkim@example.com', 340, 'BRONZE', SYSDATE - 450, 'ACTIVE');
INSERT INTO CUSTOMERS VALUES ('CUST-0011203', 'David Kim', 'dkim@example.com', 90, 'BRONZE', SYSDATE - 60, 'ACTIVE'); -- duplicate name+email, different account — the ~1,200-row data-quality issue noted in schema.sql
INSERT INTO CUSTOMERS VALUES ('CUST-0009981', 'Old Account Corp', 'legacy-merge@example.com', 0, 'BRONZE', SYSDATE - 3200, 'MERGED'); -- MERGED status, no FK pointing to surviving record — see schema.sql note

-- ============================================================
-- CUSTOMER_ADDRESSES
-- ============================================================
INSERT INTO CUSTOMER_ADDRESSES VALUES (1, 'CUST-0000481', 'SHIPPING', '742 Evergreen Terrace', NULL, 'Springfield', 'IL', '62704', 1);
INSERT INTO CUSTOMER_ADDRESSES VALUES (2, 'CUST-0010045', 'SHIPPING', '19 Birchwood Ave', 'Apt 3B', 'Austin', 'TX', '73301', 1);
INSERT INTO CUSTOMER_ADDRESSES VALUES (3, 'CUST-0010892', 'SHIPPING', '88 Harbor View Rd', NULL, 'Seattle', 'WA', '98101', 1);

-- ============================================================
-- ORDERS (note the inconsistent STATUS casing — intentional, see schema.sql)
-- ============================================================
INSERT INTO ORDERS VALUES ('ORD-5001923', 'CUST-0000481', 'DELIVERED', SYSDATE - 45, SYSDATE - 40, 99.98, SYSDATE - 40, 1, 'CREDIT_CARD');
INSERT INTO ORDERS VALUES ('ORD-5002104', 'CUST-0010045', 'SHIPPED', SYSDATE - 5, SYSDATE - 4, 24.99, SYSDATE + 2, 2, 'CREDIT_CARD');
INSERT INTO ORDERS VALUES ('ORD-5002211', 'CUST-0010892', 'PROCESSING', SYSDATE - 1, SYSDATE - 1, 349.99, SYSDATE + 6, 3, 'PAYPAL');
INSERT INTO ORDERS VALUES ('ORD-4998210', 'CUST-0000481', 'Cancelled', SYSDATE - 300, SYSDATE - 299, 79.99, NULL, 1, 'CREDIT_CARD'); -- inconsistent casing #1
INSERT INTO ORDERS VALUES ('ORD-4995102', 'CUST-0010045', 'CANCELED', SYSDATE - 500, SYSDATE - 499, 19.99, NULL, 2, 'CREDIT_CARD'); -- inconsistent casing #2 (missing an L)

-- ============================================================
-- ORDER_ITEMS
-- ============================================================
INSERT INTO ORDER_ITEMS VALUES (1, 'ORD-5001923', 'SKU-100001', 1, 19.99);
INSERT INTO ORDER_ITEMS VALUES (2, 'ORD-5001923', 'SKU-200002', 1, 24.99);
INSERT INTO ORDER_ITEMS VALUES (3, 'ORD-5001923', 'SKU-400001', 1, 34.99);
INSERT INTO ORDER_ITEMS VALUES (4, 'ORD-5002104', 'SKU-200002', 1, 24.99);
INSERT INTO ORDER_ITEMS VALUES (5, 'ORD-5002211', 'SKU-100003', 1, 349.99);

-- ============================================================
-- PAYMENTS
-- ============================================================
INSERT INTO PAYMENTS VALUES ('PAY-88213-A', 'ORD-5001923', 'gw_txn_7f3a9c', 99.98, 'CAPTURED', SYSDATE - 45);
INSERT INTO PAYMENTS VALUES ('PAY-88340-A', 'ORD-5002104', 'gw_txn_1b8e21', 24.99, 'CAPTURED', SYSDATE - 5);
INSERT INTO PAYMENTS VALUES ('PAY-88341-A', 'ORD-5002104', 'gw_txn_1b8e21', 24.99, 'CAPTURED', SYSDATE - 5); -- duplicate row, same GATEWAY_TXN_ID — the retry/idempotency issue noted in schema.sql and PaymentGatewayClient.java

-- ============================================================
-- SHIPMENTS
-- ============================================================
INSERT INTO SHIPMENTS VALUES ('SHIP-71029', 'ORD-5001923', 'UPS', '1Z999AA10123456784', 'DELIVERED', SYSDATE - 42, SYSDATE - 40);
INSERT INTO SHIPMENTS VALUES ('SHIP-71284', 'ORD-5002104', 'FEDEX', '789012345678', 'IN_TRANSIT', SYSDATE - 4, NULL);

-- ============================================================
-- PROMOTIONS (mix of expired and — nominally — active)
-- ============================================================
INSERT INTO PROMOTIONS VALUES ('PROMO-2021-HOLIDAY', '2021 Holiday Bonus Points', DATE '2021-11-20', DATE '2021-12-31', 1.5); -- expired, but still hardcoded/referenced in CustomerAccountSessionBean's dead code
INSERT INTO PROMOTIONS VALUES ('PROMO-2024-SUMMER', '2024 Summer Sale', DATE '2024-06-01', DATE '2024-08-31', 1.2);
INSERT INTO PROMOTIONS VALUES ('PROMO-2026-SPRING', '2026 Spring Loyalty Boost', DATE '2026-03-01', DATE '2026-05-31', 1.3); -- table says expired (past END_DATE relative to Aug 2026) but worth checking if code still applies it

-- ============================================================
-- NOTIFICATION_LOG (shows the duplicate-send pattern from JMS redelivery)
-- ============================================================
INSERT INTO NOTIFICATION_LOG VALUES ('NOTIF-9001', 'ORD-5002104', 'ORDER_CONFIRMATION_EMAIL', 'SENT', SYSDATE - 5);
INSERT INTO NOTIFICATION_LOG VALUES ('NOTIF-9002', 'ORD-5002104', 'ORDER_CONFIRMATION_EMAIL', 'SENT', SYSDATE - 5); -- duplicate send, same order — see OrderConfirmationMessageListener.java javadoc
INSERT INTO NOTIFICATION_LOG VALUES ('NOTIF-9003', 'ORD-5002104', 'WAREHOUSE_PICK_LIST', 'SENT', SYSDATE - 5);
INSERT INTO NOTIFICATION_LOG VALUES ('NOTIF-9004', 'ORD-5002211', 'WAREHOUSE_PICK_LIST', 'FAILED', SYSDATE - 1); -- see WarehousePickListener.java javadoc re: no dead-letter handling
