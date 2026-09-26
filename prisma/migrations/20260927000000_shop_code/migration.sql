-- Proper human shop ID: GB-SHOP-1001, 1002… (auto-only, immutable).
-- Keeps cuid `id` as the internal PK; `code` is the display identity.

ALTER TABLE "Shop" ADD COLUMN IF NOT EXISTS "code" TEXT;

-- Backfill existing shops oldest-first so the default shop gets GB-SHOP-1001.
WITH ranked AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, "id" ASC) AS rn
  FROM "Shop" WHERE "code" IS NULL
)
UPDATE "Shop" s SET "code" = 'GB-SHOP-' || (1000 + r.rn)
FROM ranked r WHERE s."id" = r."id";

-- Fail loudly if a NULL slipped through (e.g. concurrent insert mid-migrate).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Shop" WHERE "code" IS NULL) THEN
    RAISE EXCEPTION 'Shop code backfill incomplete — NULL codes remain';
  END IF;
END $$;

ALTER TABLE "Shop" ALTER COLUMN "code" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Shop_code_key" ON "Shop"("code");

-- Sequence for future shops. Starts after the highest backfilled number.
DO $$
DECLARE max_n INT;
BEGIN
  SELECT COALESCE(MAX((regexp_replace("code", '^GB-SHOP-', '')::INT)), 1000) INTO max_n FROM "Shop";
  EXECUTE format('CREATE SEQUENCE IF NOT EXISTS shop_code_seq START WITH %s', GREATEST(max_n + 1, 1001));
  PERFORM setval('shop_code_seq', GREATEST(max_n + 1, 1001), false);
END $$;
