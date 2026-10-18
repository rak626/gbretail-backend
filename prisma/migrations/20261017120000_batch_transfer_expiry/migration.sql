-- Phase 0: Product batches (expiry/MRP tracking) + inter-shop stock transfers

-- TransferStatus enum
CREATE TYPE "TransferStatus" AS ENUM ('requested', 'approved', 'in_transit', 'received', 'rejected');

-- ProductBatch table
CREATE TABLE "ProductBatch" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "batchNo" TEXT NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "mrp" DECIMAL(12,2),
    "costPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductBatch_pkey" PRIMARY KEY ("id")
);

-- StockTransfer table
CREATE TABLE "StockTransfer" (
    "id" TEXT NOT NULL,
    "fromShopId" TEXT NOT NULL,
    "toShopId" TEXT NOT NULL,
    "status" "TransferStatus" NOT NULL DEFAULT 'requested',
    "createdBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- StockTransferItem table
CREATE TABLE "StockTransferItem" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "batchId" TEXT,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unitCost" DECIMAL(12,2),

    CONSTRAINT "StockTransferItem_pkey" PRIMARY KEY ("id")
);

-- Add batchId to OrderItem
ALTER TABLE "OrderItem" ADD COLUMN "batchId" TEXT;

-- Foreign keys
ALTER TABLE "ProductBatch" ADD CONSTRAINT "ProductBatch_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductBatch" ADD CONSTRAINT "ProductBatch_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_fromShopId_fkey" FOREIGN KEY ("fromShopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_toShopId_fkey" FOREIGN KEY ("toShopId") REFERENCES "Shop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ProductBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ProductBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "ProductBatch_productId_idx" ON "ProductBatch"("productId");
CREATE INDEX "ProductBatch_shopId_idx" ON "ProductBatch"("shopId");
CREATE INDEX "ProductBatch_expiryDate_idx" ON "ProductBatch"("expiryDate");
CREATE INDEX "ProductBatch_shopId_expiryDate_idx" ON "ProductBatch"("shopId", "expiryDate");
CREATE INDEX "ProductBatch_deletedAt_idx" ON "ProductBatch"("deletedAt");

CREATE INDEX "StockTransfer_fromShopId_idx" ON "StockTransfer"("fromShopId");
CREATE INDEX "StockTransfer_toShopId_idx" ON "StockTransfer"("toShopId");
CREATE INDEX "StockTransfer_status_idx" ON "StockTransfer"("status");
CREATE INDEX "StockTransfer_deletedAt_idx" ON "StockTransfer"("deletedAt");

CREATE INDEX "StockTransferItem_transferId_idx" ON "StockTransferItem"("transferId");
CREATE INDEX "StockTransferItem_productId_idx" ON "StockTransferItem"("productId");
CREATE INDEX "StockTransferItem_batchId_idx" ON "StockTransferItem"("batchId");

CREATE INDEX "OrderItem_batchId_idx" ON "OrderItem"("batchId");

-- CHECK constraints
ALTER TABLE "ProductBatch" ADD CONSTRAINT "ProductBatch_quantity_nonneg" CHECK ("quantity" >= 0);
ALTER TABLE "ProductBatch" ADD CONSTRAINT "ProductBatch_cost_nonneg" CHECK ("costPrice" >= 0);
ALTER TABLE "ProductBatch" ADD CONSTRAINT "ProductBatch_mrp_nonneg" CHECK ("mrp" IS NULL OR "mrp" >= 0);
ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_quantity_pos" CHECK ("quantity" > 0);
ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_unitCost_nonneg" CHECK ("unitCost" IS NULL OR "unitCost" >= 0);
