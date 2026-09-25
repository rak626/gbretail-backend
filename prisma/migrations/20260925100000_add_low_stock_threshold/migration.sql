-- Add per-product low-stock threshold (in the product's own stock unit, e.g. 10 pcs, 2 bags, 5 kg)
ALTER TABLE "Product" ADD COLUMN "lowStockThreshold" DOUBLE PRECISION NOT NULL DEFAULT 10;
