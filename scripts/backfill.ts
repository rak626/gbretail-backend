import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";

// Backfill legacy NULL shopId rows to the default shop.
// Run via `npm run db:backfill`.
async function main() {
  const shop = await prisma.shop.findFirst({ where: { id: "shop_default" } });
  if (!shop) {
    console.log("no default shop");
    return;
  }
  const targets = [
    { name: "orders", model: prisma.order },
    { name: "ledger", model: prisma.ledgerEntry },
    { name: "products", model: prisma.product },
    { name: "customers", model: prisma.customer },
  ] as const;
  for (const t of targets) {
    const count = await (t.model as unknown as { count(a: unknown): Promise<number> }).count({ where: { shopId: null } as never });
    console.log(`${t.name} null shopId`, count);
    if (count > 0) {
      const r = await (t.model as unknown as { updateMany(a: unknown): Promise<{ count: number }> }).updateMany({
        where: { shopId: null },
        data: { shopId: shop.id },
      } as never);
      console.log(`backfilled ${t.name}`, r.count);
    }
  }
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
