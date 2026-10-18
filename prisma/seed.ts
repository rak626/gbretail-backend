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
  const deleted = await prisma.user.findFirst({ where: { email: data.email } });
  if (deleted) {
    return prisma.user.update({
      where: { id: deleted.id },
      data: { name: data.name, passwordHash: data.passwordHash, role: data.role, shopId: data.shopId, isActive: true, deletedAt: null },
    });
  }
  return prisma.user.create({ data: { ...data, isActive: true } });
}

async function seedShop(shopIndex: number, code: string, name: string, city: string, address: string) {
  const shop = await prisma.shop.upsert({
    where: { code },
    update: { name, city, address, isActive: true, deletedAt: null },
    create: { id: `shop_${shopIndex}`, code, name, address, city, isOnlineEnabled: shopIndex === 1, isActive: true, avgPrepMinutes: 20 },
  });
  console.log(`[SEED] Shop ${shopIndex}: ${shop.id} — ${shop.name} (${city})`);

  await prisma.shop.updateMany({
    where: { id: shop.id, avgPrepMinutes: null },
    data: { avgPrepMinutes: 20 },
  });

  await prisma.shop.updateMany({
    where: { id: shop.id, receiptName: null },
    data: {
      receiptName: name,
      gstin: `07ABCDE${String(1000 + shopIndex).padStart(4, "0")}F1Z5`,
      upiId: `${name.toLowerCase().replace(/\s+/g, "")}@upi`,
      receiptFooter: "Thank you, visit again",
      phone: `98${String(100000000 + shopIndex * 10000).slice(0, 8)}`,
    },
  });

  await prisma.shopOrderSeq.upsert({
    where: { shopId: shop.id },
    update: {},
    create: { shopId: shop.id, lastNo: 0 },
  });

  const counter1 = await prisma.counter.upsert({
    where: { id: `ctr_${shopIndex}_1` },
    update: { shopId: shop.id, name: "Counter 1", isActive: true, deletedAt: null },
    create: { id: `ctr_${shopIndex}_1`, shopId: shop.id, name: "Counter 1", isActive: true },
  });
  const counter2 = await prisma.counter.upsert({
    where: { id: `ctr_${shopIndex}_2` },
    update: { shopId: shop.id, name: "Counter 2", isActive: true, deletedAt: null },
    create: { id: `ctr_${shopIndex}_2`, shopId: shop.id, name: "Counter 2", isActive: true },
  });

  const ownerHash = await hash(process.env.SEED_OWNER_PASSWORD || "owner123");
  await upsertUserByEmail({
    email: `owner${shopIndex}@shop.local`,
    name: `Owner ${name}`,
    passwordHash: ownerHash,
    role: "SHOP_OWNER",
    shopId: shop.id,
  });
  const staffHash = await hash(process.env.SEED_STAFF_PASSWORD || "staff123");
  await upsertUserByEmail({
    email: `staff${shopIndex}@shop.local`,
    name: `Staff ${name}`,
    passwordHash: staffHash,
    role: "STAFF",
    shopId: shop.id,
  });

  console.log(`[SEED] Shop ${shopIndex} counters: ${counter1.name}, ${counter2.name}`);

  // Seed products with batches for this shop
  let onlineCount = 0;
  for (const p of products) {
    const sell = (p as any).price ?? (p as any).rate_per_kg ?? 0;
    const cost = sell ? Math.round(sell * 0.78 * 100) / 100 : 0;
    const unit = (p as any).unit ?? "pcs";
    const lowStockThreshold = (p as any).lowStockThreshold ?? 10;
    const makeOnline = shopIndex === 1 && onlineCount < 12 && sell > 0;
    const onlinePrice = makeOnline ? Math.round(sell * 1.1 * 100) / 100 : null;
    if (makeOnline) onlineCount++;

    const product = await prisma.product.upsert({
      where: { id: `p${shopIndex}_${p.id}` },
      update: {
        shopId: shop.id,
        name: p.name,
        is_loose: (p as any).is_loose,
        rate_per_kg: (p as any).rate_per_kg ?? null,
        barcode: (p as any).barcode ? `${(p as any).barcode}${shopIndex}` : null,
        price: (p as any).price ?? null,
        costPrice: (p as any).costPrice ?? cost,
        category: (p as any).category,
        unit,
        lowStockThreshold,
        preset_weights: (p as any).preset_weights ?? [],
        preset_prices: (p as any).preset_prices ?? [],
        deletedAt: null,
        isOnline: makeOnline,
        onlinePrice,
      },
      create: {
        id: `p${shopIndex}_${p.id}`,
        shopId: shop.id,
        name: p.name,
        is_loose: (p as any).is_loose,
        rate_per_kg: (p as any).rate_per_kg ?? null,
        barcode: (p as any).barcode ? `${(p as any).barcode}${shopIndex}` : null,
        price: (p as any).price ?? null,
        costPrice: (p as any).costPrice ?? cost,
        category: (p as any).category,
        unit,
        lowStockThreshold,
        preset_weights: (p as any).preset_weights ?? [],
        preset_prices: (p as any).preset_prices ?? [],
        stockQuantity: 100,
        isOnline: makeOnline,
        onlinePrice,
      },
    });

    // Create 2 batches per product with staggered expiry dates
    const now = new Date();
    const soon = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5 days
    const later = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000); // 45 days

    await prisma.productBatch.upsert({
      where: { id: `batch_${shopIndex}_${p.id}_a` },
      update: { batchNo: `BATCH-A-${shopIndex}`, expiryDate: soon, mrp: sell, costPrice: cost, quantity: 50, receivedAt: now },
      create: {
        id: `batch_${shopIndex}_${p.id}_a`,
        productId: product.id,
        shopId: shop.id,
        batchNo: `BATCH-A-${shopIndex}`,
        expiryDate: soon,
        mrp: sell,
        costPrice: cost,
        quantity: 50,
        receivedAt: now,
      },
    });
    await prisma.productBatch.upsert({
      where: { id: `batch_${shopIndex}_${p.id}_b` },
      update: { batchNo: `BATCH-B-${shopIndex}`, expiryDate: later, mrp: sell, costPrice: cost, quantity: 50, receivedAt: now },
      create: {
        id: `batch_${shopIndex}_${p.id}_b`,
        productId: product.id,
        shopId: shop.id,
        batchNo: `BATCH-B-${shopIndex}`,
        expiryDate: later,
        mrp: sell,
        costPrice: cost,
        quantity: 50,
        receivedAt: now,
      },
    });
  }

  console.log(`[SEED] Seeded ${products.length} products + batches for shop ${shop.id}`);
  return shop;
}

async function main() {
  console.log("[SEED] Seeding 3 shops...");

  const superHash = await hash(process.env.SEED_SUPER_PASSWORD || "super123");
  await upsertUserByEmail({ email: "super@gbretail.local", name: "Super Admin", passwordHash: superHash, role: "SUPER_ADMIN", shopId: null });

  // Seed 3 shops
  const shop1 = await seedShop(1, "GB-SHOP-1001", "Main Bazaar Shop", "Central", "Main Road, Central Market");
  const shop2 = await seedShop(2, "GB-SHOP-1002", "East End Grocery", "East", "East Street, East End");
  const shop3 = await seedShop(3, "GB-SHOP-1003", "West Side Mart", "West", "West Avenue, West Side");

  console.log("[SEED] Users: super@gbretail.local / owner1@shop.local / owner2@shop.local / owner3@shop.local / staff1@shop.local / staff2@shop.local / staff3@shop.local (pw: super123 / owner123 / staff123)");
  console.log(`[SEED] Shops: ${shop1.name} (${shop1.code}), ${shop2.name} (${shop2.code}), ${shop3.name} (${shop3.code})`);
}

main()
  .catch((e) => {
    console.error("[SEED] Error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
