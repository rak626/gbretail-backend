-- Exact money: Float (DOUBLE PRECISION) -> NUMERIC(12,2) for all paise columns.
-- Quantities (stockQuantity, weight, qty, thresholds, preset_weights) stay DOUBLE PRECISION.
-- Existing values rounded to 2dp on cast; transactional tables are seed-flushed so no drift.

ALTER TABLE "Product" ALTER COLUMN "rate_per_kg" TYPE NUMERIC(12,2) USING ROUND("rate_per_kg"::numeric, 2);
ALTER TABLE "Product" ALTER COLUMN "price" TYPE NUMERIC(12,2) USING ROUND("price"::numeric, 2);
ALTER TABLE "Product" ALTER COLUMN "costPrice" TYPE NUMERIC(12,2) USING ROUND("costPrice"::numeric, 2);
ALTER TABLE "Product" ALTER COLUMN "preset_prices" TYPE NUMERIC(12,2)[] USING (SELECT COALESCE(ARRAY_AGG(ROUND(x::numeric, 2)), ARRAY[]::numeric[]) FROM UNNEST("preset_prices") AS x);

ALTER TABLE "Customer" ALTER COLUMN "creditLimit" TYPE NUMERIC(12,2) USING ROUND("creditLimit"::numeric, 2);
ALTER TABLE "Customer" ALTER COLUMN "balance" TYPE NUMERIC(12,2) USING ROUND("balance"::numeric, 2);
ALTER TABLE "Customer" ALTER COLUMN "totalSpent" TYPE NUMERIC(12,2) USING ROUND("totalSpent"::numeric, 2);

ALTER TABLE "Order" ALTER COLUMN "total" TYPE NUMERIC(12,2) USING ROUND("total"::numeric, 2);
ALTER TABLE "Order" ALTER COLUMN "discount" TYPE NUMERIC(12,2) USING ROUND("discount"::numeric, 2);

ALTER TABLE "OrderItem" ALTER COLUMN "price" TYPE NUMERIC(12,2) USING ROUND("price"::numeric, 2);
ALTER TABLE "OrderItem" ALTER COLUMN "lineTotal" TYPE NUMERIC(12,2) USING ROUND("lineTotal"::numeric, 2);
ALTER TABLE "OrderItem" ALTER COLUMN "costPrice" TYPE NUMERIC(12,2) USING ROUND("costPrice"::numeric, 2);

ALTER TABLE "LedgerEntry" ALTER COLUMN "amount" TYPE NUMERIC(12,2) USING ROUND("amount"::numeric, 2);
