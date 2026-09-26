-- Allow same barcode across shops: replace global unique with per-shop unique
DROP INDEX IF EXISTS "Product_barcode_key";
CREATE UNIQUE INDEX "Product_shopId_barcode_key" ON "Product"("shopId", "barcode");
