import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import { products } from "../src/data/products";

function createPrisma() {
  const cs = process.env.DATABASE_URL!;
  if (!cs) throw new Error("DATABASE_URL not set");
  if (cs.startsWith("prisma://")) {
    return new PrismaClient();
  }
  // Local dev is always plain pg TCP (Neon/edge only in Workers runtime).
  const adapter = new PrismaPg({ connectionString: cs });
  return new PrismaClient({ adapter });
}

const prisma = createPrisma();

async function hash(pw: string) {
  const rounds = parseInt(process.env.BCRYPT_ROUNDS ?? "10", 10) || 10;
  const salt = await bcrypt.genSalt(rounds);
  return bcrypt.hash(pw, salt);
}

async function upsertUserByEmail(data: {
  email: string;
  name: string;
  passwordHash: string;
  role: "SUPER_ADMIN" | "SHOP_OWNER" | "STAFF";
  shopId: string | null;
}) {
  const existing = await prisma.user.findFirst({ where: { email: data.email, deletedAt: null } });
  if (existing) {
    return prisma.user.update({
      where: { id: existing.id },
      data: { name: data.name, passwordHash: data.passwordHash, role: data.role, shopId: data.shopId, isActive: true, deletedAt: null },
    });
  }
  // Also revive soft-deleted row with same email to respect active-only uniqueness
  const deleted = await prisma.user.findFirst({ where: { email: data.email } });
  if (deleted) {
    return prisma.user.update({
      where: { id: deleted.id },
      data: { name: data.name, passwordHash: data.passwordHash, role: data.role, shopId: data.shopId, isActive: true, deletedAt: null },
    });
  }
  return prisma.user.create({ data: { ...data, isActive: true } });
}

async function main() {
  console.log("[SEED] Seeding shops, counters, users...");

  const defaultShop = await prisma.shop.upsert({
    where: { id: "shop_default" },
    update: { code: "GB-SHOP-1001", name: "Main Shop", isActive: true, deletedAt: null },
    create: { id: "shop_default", code: "GB-SHOP-1001", name: "Main Shop", address: "Main Bazaar", isActive: true },
  });
  console.log(`[SEED] Shop: ${defaultShop.id} — ${defaultShop.name}`);

  await prisma.shop.updateMany({
    where: { id: defaultShop.id, receiptName: null },
    data: { receiptName: "GB Retail", gstin: "07ABCDE1234F1Z5", upiId: "store@upi", receiptFooter: "Thank you, visit again" },
  });

  // Per-shop order counter for collision-free bill numbers
  await prisma.shopOrderSeq.upsert({
    where: { shopId: defaultShop.id },
    update: {},
    create: { shopId: defaultShop.id, lastNo: 0 },
  });

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

  const superHash = await hash(process.env.SEED_SUPER_PASSWORD || "super123");
  await upsertUserByEmail({ email: "super@gbretail.local", name: "Super Admin", passwordHash: superHash, role: "SUPER_ADMIN", shopId: null });
  const ownerHash = await hash(process.env.SEED_OWNER_PASSWORD || "owner123");
  await upsertUserByEmail({ email: "owner@shop.local", name: "Shop Owner", passwordHash: ownerHash, role: "SHOP_OWNER", shopId: defaultShop.id });
  const staffHash1 = await hash(process.env.SEED_STAFF_PASSWORD || "staff123");
  await upsertUserByEmail({ email: "staff1@shop.local", name: "Staff 1", passwordHash: staffHash1, role: "STAFF", shopId: defaultShop.id });
  const staffHash2 = await hash(process.env.SEED_STAFF_PASSWORD || "staff123");
  await upsertUserByEmail({ email: "staff2@shop.local", name: "Staff 2", passwordHash: staffHash2, role: "STAFF", shopId: defaultShop.id });
  if (process.env.NODE_ENV === "production" && !(process.env.SEED_SUPER_PASSWORD && process.env.SEED_OWNER_PASSWORD)) {
    console.warn("[SEED] WARNING: using default dev passwords in production — set SEED_SUPER_PASSWORD/SEED_OWNER_PASSWORD/SEED_STAFF_PASSWORD");
  }
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
}

main()
  .catch((e) => {
    console.error("[SEED] Error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
