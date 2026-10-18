-- Phase: Common Inventory — Master Catalog + Per-Shop Stock
-- Adds MasterProduct (global catalog), ShopProduct (per-shop listing),
-- ShopProductBatch (per-shop batch tracking), and links OrderItem to ShopProduct.

-- MasterProduct table
CREATE TABLE "MasterProduct" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "brand" TEXT,
    "barcode" TEXT,
    "is_loose" BOOLEAN NOT NULL DEFAULT false,
    "unit" TEXT NOT NULL DEFAULT 'pcs',
    "basePrice" DECIMAL(12,2),
    "imageUrl" TEXT,
    "preset_weights" DECIMAL(12,3)[] DEFAULT ARRAY[]::DECIMAL(12,3)[],
    "preset_prices" DECIMAL(12,2)[] DEFAULT ARRAY[]::DECIMAL(12,2)[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MasterProduct_pkey" PRIMARY KEY ("id")
);

-- ShopProduct table
CREATE TABLE "ShopProduct" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "masterProductId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "shopPrice" DECIMAL(12,2),
    "costPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "stockQuantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "lowStockThreshold" DECIMAL(12,3) NOT NULL DEFAULT 10,
    "shopBarcode" TEXT,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "onlinePrice" DECIMAL(12,2),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopProduct_pkey" PRIMARY KEY ("id")
);

-- ShopProductBatch table
CREATE TABLE "ShopProductBatch" (
    "id" TEXT NOT NULL,
    "shopProductId" TEXT NOT NULL,
    "batchNo" TEXT NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "mrp" DECIMAL(12,2),
    "costPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopProductBatch_pkey" PRIMARY KEY ("id")
);

-- Add shopProductId and shopProductBatchId to OrderItem
ALTER TABLE "OrderItem" ADD COLUMN "shopProductId" TEXT;
ALTER TABLE "OrderItem" ADD COLUMN "shopProductBatchId" TEXT;

-- Foreign keys
ALTER TABLE "MasterProduct" ADD CONSTRAINT "MasterProduct_barcode_key" UNIQUE ("barcode");

ALTER TABLE "ShopProduct" ADD CONSTRAINT "ShopProduct_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ShopProduct" ADD CONSTRAINT "ShopProduct_masterProductId_fkey" FOREIGN KEY ("masterProductId") REFERENCES "MasterProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ShopProductBatch" ADD CONSTRAINT "ShopProductBatch_shopProductId_fkey" FOREIGN KEY ("shopProductId") REFERENCES "ShopProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_shopProductId_fkey" FOREIGN KEY ("shopProductId") REFERENCES "ShopProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_shopProductBatchId_fkey" FOREIGN KEY ("shopProductBatchId") REFERENCES "ShopProductBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "MasterProduct_barcode_idx" ON "MasterProduct"("barcode");
CREATE INDEX "MasterProduct_category_idx" ON "MasterProduct"("category");
CREATE INDEX "MasterProduct_name_idx" ON "MasterProduct"("name");
CREATE INDEX "MasterProduct_brand_idx" ON "MasterProduct"("brand");
CREATE INDEX "MasterProduct_isActive_idx" ON "MasterProduct"("isActive");
CREATE INDEX "MasterProduct_deletedAt_idx" ON "MasterProduct"("deletedAt");

CREATE INDEX "ShopProduct_shopId_idx" ON "ShopProduct"("shopId");
CREATE INDEX "ShopProduct_masterProductId_idx" ON "ShopProduct"("masterProductId");
CREATE INDEX "ShopProduct_shopId_masterProductId_idx" ON "ShopProduct"("shopId", "masterProductId");
CREATE INDEX "ShopProduct_shopId_isEnabled_idx" ON "ShopProduct"("shopId", "isEnabled");
CREATE INDEX "ShopProduct_shopId_deletedAt_idx" ON "ShopProduct"("shopId", "deletedAt");
CREATE INDEX "ShopProduct_shopBarcode_idx" ON "ShopProduct"("shopBarcode");

CREATE INDEX "ShopProductBatch_shopProductId_idx" ON "ShopProductBatch"("shopProductId");
CREATE INDEX "ShopProductBatch_expiryDate_idx" ON "ShopProductBatch"("expiryDate");
CREATE INDEX "ShopProductBatch_deletedAt_idx" ON "ShopProductBatch"("deletedAt");

CREATE INDEX "OrderItem_shopProductId_idx" ON "OrderItem"("shopProductId");
CREATE INDEX "OrderItem_shopProductBatchId_idx" ON "OrderItem"("shopProductBatchId");

-- CHECK constraints
ALTER TABLE "ShopProduct" ADD CONSTRAINT "ShopProduct_stock_nonneg" CHECK ("stockQuantity" >= 0);
ALTER TABLE "ShopProduct" ADD CONSTRAINT "ShopProduct_threshold_nonneg" CHECK ("lowStockThreshold" >= 0);
ALTER TABLE "ShopProductBatch" ADD CONSTRAINT "ShopProductBatch_quantity_nonneg" CHECK ("quantity" >= 0);
ALTER TABLE "ShopProductBatch" ADD CONSTRAINT "ShopProductBatch_cost_nonneg" CHECK ("costPrice" >= 0);
ALTER TABLE "ShopProductBatch" ADD CONSTRAINT "ShopProductBatch_mrp_nonneg" CHECK ("mrp" IS NULL OR "mrp" >= 0);

-- Unique constraint on (shopId, masterProductId)
CREATE UNIQUE INDEX "ShopProduct_shopId_masterProductId_key" ON "ShopProduct"("shopId", "masterProductId");
