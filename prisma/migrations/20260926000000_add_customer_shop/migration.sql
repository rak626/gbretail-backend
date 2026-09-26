-- Per-shop Customer isolation: Customer.shopId required, phone unique per shop.
-- Seed data is transactional only, so flush transactional tables before enforcing NOT NULL.
TRUNCATE "LedgerEntry", "OrderItem", "Order", "Customer" CASCADE;

-- Drop global phone uniqueness (allows same phone in different shops)
DROP INDEX IF EXISTS "Customer_phone_key";

-- Add shop scope (IF NOT EXISTS for dev DBs already synced via db push)
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "shopId" TEXT;

-- Backfill safety: if any rows survived (non-flushed envs), attach to first shop instead of failing.
-- No-op when table is empty (seed-flush case).
DO $$
DECLARE _shop TEXT;
BEGIN
  SELECT id INTO _shop FROM "Shop" ORDER BY "createdAt" ASC LIMIT 1;
  IF _shop IS NOT NULL THEN
    EXECUTE 'UPDATE "Customer" SET "shopId" = $1 WHERE "shopId" IS NULL' USING _shop;
  END IF;
END $$;

-- Enforce NOT NULL now that table is flushed/backfilled
DO $$
BEGIN
  BEGIN
    ALTER TABLE "Customer" ALTER COLUMN "shopId" SET NOT NULL;
  EXCEPTION WHEN others THEN
    -- already NOT NULL on synced DBs
    NULL;
  END;
END $$;

-- FK to Shop (cascade: deleting a shop wipes its customers)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Customer_shopId_fkey') THEN
    ALTER TABLE "Customer" ADD CONSTRAINT "Customer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Per-shop phone uniqueness: same phone reusable across shops, unique within a shop.
-- Multiple NULL phones allowed (Postgres treats NULLs as distinct).
CREATE UNIQUE INDEX IF NOT EXISTS "Customer_shopId_phone_key" ON "Customer"("shopId", "phone");

-- Lookup indexes for scoped queries
CREATE INDEX IF NOT EXISTS "Customer_shopId_idx" ON "Customer"("shopId");
CREATE INDEX IF NOT EXISTS "Customer_shopId_deletedAt_idx" ON "Customer"("shopId", "deletedAt");
CREATE INDEX IF NOT EXISTS "Customer_shopId_balance_idx" ON "Customer"("shopId", "balance");
