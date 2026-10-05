-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "onlineUserId" TEXT;

-- CreateTable
CREATE TABLE "OnlineUser" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "address" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnlineUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OnlineUser_phone_key" ON "OnlineUser"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "OnlineUser_email_key" ON "OnlineUser"("email");

-- CreateIndex
CREATE INDEX "Order_onlineUserId_idx" ON "Order"("onlineUserId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_onlineUserId_fkey" FOREIGN KEY ("onlineUserId") REFERENCES "OnlineUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
