import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Manual DB extensions NOT managed by Prisma migrate (migrate diff auto-drops
// unknown Gin indexes). Run after `db:deploy`: `npm run db:extensions`.
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

const STATEMENTS = [
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
  `CREATE INDEX IF NOT EXISTS "Product_name_trgm_idx" ON "Product" USING gin ("name" gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS "Customer_name_trgm_idx" ON "Customer" USING gin ("name" gin_trgm_ops)`,
  `CREATE INDEX IF NOT EXISTS "Order_orderNumber_trgm_idx" ON "Order" USING gin ("orderNumber" gin_trgm_ops)`,
];

async function main() {
  for (const sql of STATEMENTS) {
    try {
      await prisma.$executeRawUnsafe(sql);
      console.log("[extensions] ok:", sql.slice(0, 60));
    } catch (e) {
      console.error("[extensions] failed:", sql, e);
    }
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
