-- DB hardening: partial uniques, CHECKs, trgm search, shop code sequence.
-- Squashed baseline follow-up. Safe on fresh dev DB (data disposable).

-- Trigram search for ILIKE %foo% (replaces seq scans)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Shop human-ID sequence (GB-SHOP-1001 seed exists; next = 1002)
CREATE SEQUENCE IF NOT EXISTS shop_code_seq START WITH 1002 INCREMENT BY 1;

-- Active-only uniqueness (soft-delete reuse without races beyond P2002 retry)
CREATE UNIQUE INDEX IF NOT EXISTS "Counter_shopId_name_active_key" ON "Counter"("shopId", "name") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_active_key" ON "User"("email") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Product_shopId_barcode_active_key" ON "Product"("shopId", "barcode") WHERE "deletedAt" IS NULL AND "barcode" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Order_shopId_idem_active_key" ON "Order"("shopId", "idempotencyKey") WHERE "deletedAt" IS NULL AND "idempotencyKey" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Ledger_shopId_idem_active_key" ON "LedgerEntry"("shopId", "idempotencyKey") WHERE "deletedAt" IS NULL AND "idempotencyKey" IS NOT NULL;

-- Trigram extension kept for future manual search optimization.
-- NOTE: Gin/trgm indexes are NOT managed here because Prisma migrate diff
-- auto-drops unknown indexes. Apply them manually post-deploy if needed:
--   CREATE INDEX "Product_name_trgm_idx" ON "Product" USING gin ("name" gin_trgm_ops);
--   CREATE INDEX "Customer_name_trgm_idx" ON "Customer" USING gin ("name" gin_trgm_ops);
--   CREATE INDEX "Order_orderNumber_trgm_idx" ON "Order" USING gin ("orderNumber" gin_trgm_ops);

-- Numeric / business-rule CHECKs
ALTER TABLE "Order" ADD CONSTRAINT "Order_total_nonneg" CHECK ("total" >= 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_discount_range" CHECK ("discount" >= 0 AND "discount" <= "total");
ALTER TABLE "Order" ADD CONSTRAINT "Order_split_tender" CHECK (
  ("paymentMethod"::text <> 'split' AND "cashAmount" IS NULL AND "upiAmount" IS NULL)
  OR ("paymentMethod"::text = 'split' AND "cashAmount" IS NOT NULL AND "upiAmount" IS NOT NULL AND "cashAmount" > 0 AND "upiAmount" > 0)
);

ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_amount_pos" CHECK ("amount" > 0);
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_creditDays_range" CHECK ("creditDays" >= 1 AND "creditDays" <= 365);

ALTER TABLE "Product" ADD CONSTRAINT "Product_price_nonneg" CHECK ("price" IS NULL OR "price" >= 0);
ALTER TABLE "Product" ADD CONSTRAINT "Product_cost_nonneg" CHECK ("costPrice" >= 0);
ALTER TABLE "Product" ADD CONSTRAINT "Product_stock_nonneg" CHECK ("stockQuantity" >= 0);
ALTER TABLE "Product" ADD CONSTRAINT "Product_threshold_nonneg" CHECK ("lowStockThreshold" >= 0);
ALTER TABLE "Product" ADD CONSTRAINT "Product_rate_pos" CHECK ("rate_per_kg" IS NULL OR "rate_per_kg" > 0);

ALTER TABLE "Customer" ADD CONSTRAINT "Customer_balance_nonneg" CHECK ("balance" >= 0);
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_spent_nonneg" CHECK ("totalSpent" >= 0);
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_orders_nonneg" CHECK ("totalOrders" >= 0);
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_credit_nonneg" CHECK ("creditLimit" IS NULL OR "creditLimit" >= 0);

ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_price_nonneg" CHECK ("price" >= 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_total_nonneg" CHECK ("lineTotal" >= 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_qty_pos" CHECK ("quantity" IS NULL OR "quantity" > 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_weight_pos" CHECK ("weight" IS NULL OR "weight" > 0);
