-- Idempotency keys: client-generated per bill (Idempotency-Key header).
-- Replays return the original record instead of double-billing. NULL = pre-idempotency rows.

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "idempotencyFingerprint" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Order_shopId_idempotencyKey_key" ON "Order"("shopId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "Order_idempotencyKey_idx" ON "Order"("idempotencyKey");

ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
ALTER TABLE "LedgerEntry" ADD COLUMN IF NOT EXISTS "idempotencyFingerprint" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "LedgerEntry_shopId_idempotencyKey_key" ON "LedgerEntry"("shopId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "LedgerEntry_idempotencyKey_idx" ON "LedgerEntry"("idempotencyKey");
