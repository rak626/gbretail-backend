-- Owner-assigned counter for staff (auto-attached at login)
ALTER TABLE "User" ADD COLUMN "counterId" TEXT;

-- Backfill existing staff to their shop's first active counter (by name).
-- Staff in shops with no active counter stay unassigned (login fallback covers them).
UPDATE "User" u SET "counterId" = (
  SELECT c."id" FROM "Counter" c
  WHERE c."shopId" = u."shopId" AND c."deletedAt" IS NULL AND c."isActive" = true
  ORDER BY c."name" ASC LIMIT 1
)
WHERE u."role" = 'STAFF' AND u."counterId" IS NULL AND u."deletedAt" IS NULL
AND EXISTS (
  SELECT 1 FROM "Counter" c2
  WHERE c2."shopId" = u."shopId" AND c2."deletedAt" IS NULL AND c2."isActive" = true
);

ALTER TABLE "User" ADD CONSTRAINT "User_counterId_fkey" FOREIGN KEY ("counterId") REFERENCES "Counter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
