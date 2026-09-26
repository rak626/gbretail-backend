-- Split-tender breakdown on split rows only (NULL for cash/upi/khata).
-- cashAmount + upiAmount == total is enforced server-side, not by constraint.

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "cashAmount" NUMERIC(12,2);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "upiAmount" NUMERIC(12,2);
