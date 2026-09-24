-- Customers soft-delete + extended fields
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "address" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "notes" TEXT;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "creditLimit" DOUBLE PRECISION;
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "firstOrderAt" TIMESTAMP(3);
ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Customer_deletedAt_idx" ON "Customer"("deletedAt");
CREATE INDEX IF NOT EXISTS "Customer_lastOrderAt_idx" ON "Customer"("lastOrderAt");
CREATE INDEX IF NOT EXISTS "Customer_firstOrderAt_idx" ON "Customer"("firstOrderAt");
CREATE INDEX IF NOT EXISTS "Customer_balance_idx" ON "Customer"("balance");
CREATE INDEX IF NOT EXISTS "Customer_totalSpent_idx" ON "Customer"("totalSpent");
