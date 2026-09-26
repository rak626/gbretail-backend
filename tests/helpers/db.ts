import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/gbretail_test?schema=public";
  if (!url.includes("_test")) {
    throw new Error(`Refusing to run integration tests against non-test DB: ${url}`);
  }
  return url;
}

let client: PrismaClient | null = null;

export function testPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      adapter: new PrismaPg({ connectionString: testDatabaseUrl() }) as never,
    });
  }
  return client;
}

export async function closeTestPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect().catch(() => undefined);
    client = null;
  }
}

/** Wipe all tenant data between tests (dependency order for Restrict FKs). */
export async function truncateAll(): Promise<void> {
  const p = testPrisma();
  await p.$executeRawUnsafe(
    `TRUNCATE "Session","LedgerEntry","OrderItem","Order","Customer","Product","ShopOrderSeq","Counter","User","Shop" RESTART IDENTITY CASCADE`
  );
}

export type Seed = {
  shopId: string;
  ownerId: string;
  staffId: string;
  counterId: string;
  productIds: string[];
};

export async function seedShop(): Promise<Seed> {
  const p = testPrisma();
  const shop = await p.shop.create({ data: { id: "shop_test", code: "GB-TEST-1", name: "Test Shop" } });
  await p.shopOrderSeq.upsert({ where: { shopId: shop.id }, update: { lastNo: 0 }, create: { shopId: shop.id, lastNo: 0 } });
  const counter = await p.counter.create({ data: { id: "ctr_test", shopId: shop.id, name: "Counter 1" } });
  // bcryptjs low rounds for speed
  const { hashPassword } = await import("../../src/lib/auth.js");
  const owner = await p.user.create({
    data: { email: "owner@test.local", name: "Owner", passwordHash: await hashPassword("ownerpass1"), role: "SHOP_OWNER" as any, shopId: shop.id },
  });
  const staff = await p.user.create({
    data: { email: "staff@test.local", name: "Staff", passwordHash: await hashPassword("staffpass1"), role: "STAFF" as any, shopId: shop.id, counterId: counter.id },
  });
  const mk = (id: string, name: string, price: number) =>
    p.product.create({
      data: { id, shopId: shop.id, name, category: "Test", price, costPrice: price * 0.7, stockQuantity: 100, lowStockThreshold: 5 } as any,
    });
  const p1 = await mk("ptest1", "Test Prod 1", 100);
  const p2 = await mk("ptest2", "Test Prod 2", 50);
  const p3 = await mk("ptest3", "Test Prod 3", 25);
  return { shopId: shop.id, ownerId: owner.id, staffId: staff.id, counterId: counter.id, productIds: [p1.id, p2.id, p3.id] };
}
