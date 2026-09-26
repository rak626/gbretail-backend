-- Per-shop receipt identity (replaces hardcoded GB RETAIL / GST / UPI in the POS).
-- All nullable: NULL falls back to shop name / omitted lines.

ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "receiptName" TEXT;
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "gstin" TEXT;
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "upiId" TEXT;
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "receiptFooter" TEXT;
