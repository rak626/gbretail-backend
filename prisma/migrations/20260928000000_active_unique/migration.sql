-- Active-only uniqueness for soft-deleted tables.
-- Replaces full unique indexes (which blocked reuse after soft-delete)
-- with partial unique indexes covering only non-deleted rows.
DROP INDEX IF EXISTS "Product_shopId_barcode_key";
DROP INDEX IF EXISTS "Customer_shopId_phone_key";

-- Non-unique lookup indexes (keep query performance for all rows)
CREATE INDEX IF NOT EXISTS "Product_shopId_barcode_idx" ON "Product"("shopId", "barcode");
CREATE INDEX IF NOT EXISTS "Customer_shopId_phone_idx" ON "Customer"("shopId", "phone");

-- Active-only uniqueness: NULL barcodes/phones excluded (multiple NULLs allowed)
CREATE UNIQUE INDEX IF NOT EXISTS "Product_shopId_barcode_active" ON "Product"("shopId", "barcode") WHERE "deletedAt" IS NULL AND "barcode" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Customer_shopId_phone_active" ON "Customer"("shopId", "phone") WHERE "deletedAt" IS NULL AND "phone" IS NOT NULL;
