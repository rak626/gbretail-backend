-- Owner-granted inventory access for STAFF (default off; owner enables per user)
ALTER TABLE "User" ADD COLUMN "canManageInventory" BOOLEAN NOT NULL DEFAULT false;
