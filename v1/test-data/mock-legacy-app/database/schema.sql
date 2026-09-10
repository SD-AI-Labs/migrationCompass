-- OrderVault :: Database Schema
-- SYNTHETIC data for portfolio project testing. Not a real company's schema.
--
-- Oracle 11g dialect (matches architecture-overview.md's stated DB platform).
-- This is the full legacy schema — no ORM, hand-maintained DDL, evolved over
-- ~12 years by many different engineers. A few intentional legacy quirks are
-- called out inline where they matter for migration risk assessment.

-- ============================================================
-- CUSTOMERS & ACCOUNTS
-- ============================================================

CREATE TABLE CUSTOMERS (
    CUSTOMER_ID       VARCHAR2(20)   PRIMARY KEY,   -- format: CUST-#######, no sequence/UUID — manually zero-padded
    FULL_NAME         VARCHAR2(200)  NOT NULL,
    EMAIL             VARCHAR2(200)  NOT NULL,
    LOYALTY_POINTS    NUMBER(10)     DEFAULT 0,
    LOYALTY_TIER      VARCHAR2(20)   DEFAULT 'BRONZE',
    CREATED_AT        DATE           DEFAULT SYSDATE,
    -- NOTE: no UNIQUE constraint on EMAIL — legacy data has ~1,200 duplicate
    -- email addresses across accounts (old merge/acquisition data never
    -- deduplicated). Flagged as a migration data-quality risk.
    STATUS            VARCHAR2(20)   DEFAULT 'ACTIVE'  -- ACTIVE, INACTIVE, MERGED (no FK to a "merged into" record — see note above)
);

CREATE TABLE CUSTOMER_ADDRESSES (
    ADDRESS_ID        NUMBER(10)     PRIMARY KEY,
    CUSTOMER_ID       VARCHAR2(20)   REFERENCES CUSTOMERS(CUSTOMER_ID),
    ADDRESS_TYPE      VARCHAR2(20)   NOT NULL,  -- SHIPPING, BILLING
    LINE1             VARCHAR2(200),
    LINE2             VARCHAR2(200),
    CITY              VARCHAR2(100),
    STATE             VARCHAR2(50),
    POSTAL_CODE       VARCHAR2(20),
    IS_DEFAULT        NUMBER(1)      DEFAULT 0   -- 0/1 boolean, Oracle 11g predates native BOOLEAN
);

-- ============================================================
-- PRODUCTS & INVENTORY
-- ============================================================

CREATE TABLE PRODUCTS (
    SKU               VARCHAR2(30)   PRIMARY KEY,
    NAME              VARCHAR2(300)  NOT NULL,
    CATEGORY          VARCHAR2(100),
    UNIT_PRICE        NUMBER(10,2)   NOT NULL,
    IS_ACTIVE         NUMBER(1)      DEFAULT 1,
    CREATED_AT        DATE           DEFAULT SYSDATE
);

CREATE TABLE WAREHOUSES (
    WAREHOUSE_ID      VARCHAR2(20)   PRIMARY KEY,
    NAME              VARCHAR2(200),
    REGION            VARCHAR2(100),
    IS_ACTIVE         NUMBER(1)      DEFAULT 1
);

CREATE TABLE STOCK (
    SKU               VARCHAR2(30)   REFERENCES PRODUCTS(SKU),
    WAREHOUSE_ID      VARCHAR2(20)   REFERENCES WAREHOUSES(WAREHOUSE_ID),
    AVAILABLE_QTY     NUMBER(10)     DEFAULT 0,
    RESERVED_QTY      NUMBER(10)     DEFAULT 0,
    LAST_UPDATED      DATE           DEFAULT SYSDATE,
    PRIMARY KEY (SKU, WAREHOUSE_ID)
    -- NOTE: no CHECK constraint preventing AVAILABLE_QTY < 0 — relies
    -- entirely on InventoryDAO's application-level row-lock logic (see
    -- source-code/inventory-check-service). A direct SQL update bypassing
    -- the DAO could still drive this negative.
);

CREATE TABLE STOCK_RESERVATION (
    RESERVATION_ID    VARCHAR2(40)   PRIMARY KEY,
    SKU               VARCHAR2(30)   REFERENCES PRODUCTS(SKU),
    QUANTITY          NUMBER(10)     NOT NULL,
    ORDER_ID          VARCHAR2(30),  -- NOTE: no FK to ORDERS — added before ORDERS table existed, never backfilled
    CREATED_AT        DATE           DEFAULT SYSDATE
);

-- ============================================================
-- ORDERS
-- ============================================================

CREATE TABLE ORDERS (
    ORDER_ID          VARCHAR2(30)   PRIMARY KEY,
    CUSTOMER_ID       VARCHAR2(20)   REFERENCES CUSTOMERS(CUSTOMER_ID),
    STATUS            VARCHAR2(20)   NOT NULL,  -- PLACED, PROCESSING, SHIPPED, DELIVERED, CANCELLED
    ORDER_DATE        DATE           DEFAULT SYSDATE,
    LAST_UPDATED      DATE           DEFAULT SYSDATE,
    TOTAL_AMOUNT      NUMBER(10,2),
    EST_DELIVERY_DATE DATE,
    SHIPPING_ADDRESS_ID NUMBER(10)   REFERENCES CUSTOMER_ADDRESSES(ADDRESS_ID),
    PAYMENT_METHOD    VARCHAR2(50)
    -- NOTE: STATUS is free-text VARCHAR2, not a constrained enum/lookup
    -- table. Production data audit found 11 distinct casing/spelling
    -- variants of "CANCELLED" alone (Cancelled, CANCELED, cancelled, etc.)
    -- accumulated from different integration points writing directly to
    -- this column over the years. A real migration blocker for any status
    -- state-machine validation.
);

CREATE TABLE ORDER_ITEMS (
    ORDER_ITEM_ID     NUMBER(10)     PRIMARY KEY,
    ORDER_ID          VARCHAR2(30)   REFERENCES ORDERS(ORDER_ID),
    SKU               VARCHAR2(30)   REFERENCES PRODUCTS(SKU),
    QUANTITY          NUMBER(10)     NOT NULL,
    UNIT_PRICE        NUMBER(10,2)   NOT NULL   -- price at time of order, intentionally denormalized from PRODUCTS
);

-- ============================================================
-- PAYMENTS & SHIPMENTS (external-integration-adjacent tables)
-- ============================================================

CREATE TABLE PAYMENTS (
    PAYMENT_ID        VARCHAR2(40)   PRIMARY KEY,
    ORDER_ID          VARCHAR2(30)   REFERENCES ORDERS(ORDER_ID),
    GATEWAY_TXN_ID     VARCHAR2(100),  -- ID returned by PaymentGatewayClient's external call
    AMOUNT            NUMBER(10,2),
    STATUS            VARCHAR2(20),   -- PENDING, AUTHORIZED, CAPTURED, FAILED, REFUNDED
    CREATED_AT        DATE           DEFAULT SYSDATE
    -- NOTE: no UNIQUE constraint on GATEWAY_TXN_ID — see
    -- PaymentGatewayClient's javadoc for the retry/idempotency risk this
    -- creates (duplicate PAYMENTS rows possible for a single real charge).
);

CREATE TABLE SHIPMENTS (
    SHIPMENT_ID       VARCHAR2(40)   PRIMARY KEY,
    ORDER_ID          VARCHAR2(30)   REFERENCES ORDERS(ORDER_ID),
    CARRIER           VARCHAR2(50),
    TRACKING_NUMBER   VARCHAR2(100),
    STATUS            VARCHAR2(30),   -- LABEL_CREATED, IN_TRANSIT, DELIVERED, EXCEPTION
    SHIPPED_AT        DATE,
    DELIVERED_AT      DATE
);

-- ============================================================
-- PROMOTIONS (feeds the loyalty-tier calculation's hardcoded
-- campaign branches — see CustomerAccountSessionBean.java)
-- ============================================================

CREATE TABLE PROMOTIONS (
    PROMOTION_ID      VARCHAR2(30)   PRIMARY KEY,
    NAME              VARCHAR2(200),
    START_DATE        DATE,
    END_DATE          DATE,
    POINTS_MULTIPLIER NUMBER(4,2)
    -- NOTE: 15 historical rows here, going back to 2016. Most are expired
    -- (END_DATE in the past) but several are still referenced by hardcoded
    -- logic in CustomerAccountSessionBean.recalculateLoyaltyPoints() rather
    -- than being looked up dynamically — a mismatch between what this table
    -- says is active and what the code actually applies.
);

CREATE TABLE PROMOTION_REDEMPTIONS (
    REDEMPTION_ID     NUMBER(10)     PRIMARY KEY,
    PROMOTION_ID      VARCHAR2(30)   REFERENCES PROMOTIONS(PROMOTION_ID),
    CUSTOMER_ID       VARCHAR2(20)   REFERENCES CUSTOMERS(CUSTOMER_ID),
    ORDER_ID          VARCHAR2(30)   REFERENCES ORDERS(ORDER_ID),
    REDEEMED_AT       DATE           DEFAULT SYSDATE
);

-- ============================================================
-- RETURNS
-- ============================================================

CREATE TABLE RETURNS (
    RETURN_ID         VARCHAR2(30)   PRIMARY KEY,
    ORDER_ID          VARCHAR2(30)   REFERENCES ORDERS(ORDER_ID),
    SKU               VARCHAR2(30)   REFERENCES PRODUCTS(SKU),
    QUANTITY          NUMBER(10),
    REASON            VARCHAR2(500),
    STATUS            VARCHAR2(20),   -- REQUESTED, APPROVED, RECEIVED, REFUNDED, REJECTED
    CREATED_AT        DATE           DEFAULT SYSDATE
);

-- ============================================================
-- MESSAGING / NOTIFICATION AUDIT
-- (see source-code/order-messaging for the JMS producers/consumers
-- that write to this table)
-- ============================================================

CREATE TABLE NOTIFICATION_LOG (
    NOTIFICATION_ID   VARCHAR2(40)   PRIMARY KEY,
    ORDER_ID          VARCHAR2(30)   REFERENCES ORDERS(ORDER_ID),
    NOTIFICATION_TYPE VARCHAR2(30),  -- ORDER_CONFIRMATION_EMAIL, WAREHOUSE_PICK_LIST
    STATUS            VARCHAR2(20),  -- SENT, FAILED
    SENT_AT           DATE
    -- NOTE: this table is written by OrderConfirmationMessageListener and
    -- WarehousePickListener, but neither listener checks it BEFORE sending
    -- — it's a log, not an idempotency guard. See those classes' javadocs
    -- for why duplicate JMS delivery can still cause duplicate emails/pick
    -- lists despite this table's existence.
);

-- ============================================================
-- AUDIT LOG (generic, bolted on ~2017, inconsistently used)
-- ============================================================

CREATE TABLE AUDIT_LOG (
    AUDIT_ID          NUMBER(12)     PRIMARY KEY,
    ENTITY_TYPE       VARCHAR2(50),   -- e.g. 'ORDER', 'CUSTOMER' — free text, not an FK/enum
    ENTITY_ID         VARCHAR2(40),
    ACTION            VARCHAR2(50),
    CHANGED_BY        VARCHAR2(100),
    CHANGED_AT        DATE           DEFAULT SYSDATE
    -- NOTE: only ~30% of write operations across the system actually log
    -- here — it was added service-by-service, never applied uniformly.
    -- Not reliable for reconstructing full change history.
);
