import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { neonConfig } from "@neondatabase/serverless";
import { PrismaNeon } from "@prisma/adapter-neon";
import ws from "ws";
import bcrypt from "bcryptjs";
import { products } from "../src/data/products";

// Edge vs Node driver selection mirrors src/lib/prisma.ts
function createPrisma() {
  const cs = process.env.DATABASE_URL!;
  if (!cs) throw new Error("DATABASE_URL not set");
  if (cs.startsWith("prisma://")) {
    // Accelerate — no adapter needed, URL is prisma://
    return new PrismaClient();
  }
  if (process.env.USE_NEON === "1" || cs.includes("neon.tech")) {
    neonConfig.webSocketConstructor = ws;
    const adapter = new PrismaNeon({ connectionString: cs });
    return new PrismaClient({ adapter });
  }
  const adapter = new PrismaPg({ connectionString: cs });
  return new PrismaClient({ adapter });
}

const prisma = createPrisma();

async function hash(pw: string) {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(pw, salt);
}

async function main() {
  console.log("[SEED] Seeding shops, counters, users...");

  // Create default shop
  const defaultShop = await prisma.shop.upsert({
    where: { id: "shop_default" },
    update: { name: "Main Shop", isActive: true, deletedAt: null },
    create: { id: "shop_default", name: "Main Shop", address: "Main Bazaar", isActive: true },
  });
  console.log(`[SEED] Shop: ${defaultShop.id} — ${defaultShop.name}`);

  // Backfill legacy receipt identity once (never clobber owner edits on reseed)
  await prisma.shop.updateMany({
    where: { id: defaultShop.id, receiptName: null },
    data: { receiptName: "GB Retail", gstin: "07ABCDE1234F1Z5", upiId: "store@upi", receiptFooter: "Thank you, visit again" },
  });

  // Counters
  const counter1 = await prisma.counter.upsert({
    where: { id: "counter_1" },
    update: { shopId: defaultShop.id, name: "Counter 1", isActive: true, deletedAt: null },
    create: { id: "counter_1", shopId: defaultShop.id, name: "Counter 1", isActive: true },
  });
  const counter2 = await prisma.counter.upsert({
    where: { id: "counter_2" },
    update: { shopId: defaultShop.id, name: "Counter 2", isActive: true, deletedAt: null },
    create: { id: "counter_2", shopId: defaultShop.id, name: "Counter 2", isActive: true },
  });
  console.log(`[SEED] Counters: ${counter1.name}, ${counter2.name}`);

  // Users: SUPER_ADMIN, SHOP_OWNER, STAFF
  const superHash = await hash("super123");
  await prisma.user.upsert({
    where: { email: "super@gbretail.local" },
    update: { name: "Super Admin", passwordHash: superHash, role: "SUPER_ADMIN", shopId: null, isActive: true, deletedAt: null },
    create: { email: "super@gbretail.local", name: "Super Admin", passwordHash: superHash, role: "SUPER_ADMIN", shopId: null, isActive: true },
  });
  const ownerHash = await hash("owner123");
  await prisma.user.upsert({
    where: { email: "owner@shop.local" },
    update: { name: "Shop Owner", passwordHash: ownerHash, role: "SHOP_OWNER", shopId: defaultShop.id, isActive: true, deletedAt: null },
    create: { email: "owner@shop.local", name: "Shop Owner", passwordHash: ownerHash, role: "SHOP_OWNER", shopId: defaultShop.id, isActive: true },
  });
  const staffHash1 = await hash("staff123");
  await prisma.user.upsert({
    where: { email: "staff1@shop.local" },
    update: { name: "Staff 1", passwordHash: staffHash1, role: "STAFF", shopId: defaultShop.id, isActive: true, deletedAt: null },
    create: { email: "staff1@shop.local", name: "Staff 1", passwordHash: staffHash1, role: "STAFF", shopId: defaultShop.id, isActive: true },
  });
  const staffHash2 = await hash("staff123");
  await prisma.user.upsert({
    where: { email: "staff2@shop.local" },
    update: { name: "Staff 2", passwordHash: staffHash2, role: "STAFF", shopId: defaultShop.id, isActive: true, deletedAt: null },
    create: { email: "staff2@shop.local", name: "Staff 2", passwordHash: staffHash2, role: "STAFF", shopId: defaultShop.id, isActive: true },
  });
  console.log("[SEED] Users: super@gbretail.local / owner@shop.local / staff1@shop.local / staff2@shop.local (pw: super123 / owner123 / staff123)");

  console.log("[SEED] Seeding products...");

  for (const p of products) {
    const sell = (p as any).price ?? (p as any).rate_per_kg ?? 0;
    const cost = sell ? Math.round(sell * 0.78 * 100) / 100 : 0;
    const unit = (p as any).unit ?? "pcs";
    const lowStockThreshold = (p as any).lowStockThreshold ?? 10;
    await prisma.product.upsert({
      where: { id: p.id },
      update: {
        shopId: defaultShop.id,
        name: p.name,
        is_loose: (p as any).is_loose,
        rate_per_kg: (p as any).rate_per_kg ?? null,
        barcode: (p as any).barcode ?? null,
        price: (p as any).price ?? null,
        costPrice: (p as any).costPrice ?? cost,
        category: (p as any).category,
        unit,
        lowStockThreshold,
        preset_weights: (p as any).preset_weights ?? [],
        preset_prices: (p as any).preset_prices ?? [],
        stockQuantity: 100,
        deletedAt: null,
      },
      create: {
        id: p.id,
        shopId: defaultShop.id,
        name: p.name,
        is_loose: (p as any).is_loose,
        rate_per_kg: (p as any).rate_per_kg ?? null,
        barcode: (p as any).barcode ?? null,
        price: (p as any).price ?? null,
        costPrice: (p as any).costPrice ?? cost,
        category: (p as any).category,
        unit,
        lowStockThreshold,
        preset_weights: (p as any).preset_weights ?? [],
        preset_prices: (p as any).preset_prices ?? [],
        stockQuantity: 100,
      },
    });
  }

  console.log(`[SEED] Seeded ${products.length} products for shop ${defaultShop.id}`);

  // Backfill existing products without shopId (old data)
  const orphanCount = await prisma.product.count({ where: { shopId: null, deletedAt: null } });
  if (orphanCount > 0) {
    await prisma.product.updateMany({ where: { shopId: null }, data: { shopId: defaultShop.id } });
    console.log(`[SEED] Backfilled ${orphanCount} orphan products to default shop`);
  }
}

main()
  .catch((e) => {
    console.error("[SEED] Error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
