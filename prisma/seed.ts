import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { neonConfig } from "@neondatabase/serverless";
import { PrismaNeon } from "@prisma/adapter-neon";
import ws from "ws";
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

async function main() {
  console.log("[SEED] Seeding products...");

  for (const p of products) {
    const sell = (p as any).price ?? (p as any).rate_per_kg ?? 0;
    const cost = sell ? Math.round(sell * 0.78 * 100) / 100 : 0;
    await prisma.product.upsert({
      where: { id: p.id },
      update: {
        name: p.name,
        is_loose: (p as any).is_loose,
        rate_per_kg: (p as any).rate_per_kg ?? null,
        barcode: (p as any).barcode ?? null,
        price: (p as any).price ?? null,
        costPrice: (p as any).costPrice ?? cost,
        category: (p as any).category,
        preset_weights: (p as any).preset_weights ?? [],
        preset_prices: (p as any).preset_prices ?? [],
        stockQuantity: 100,
      },
      create: {
        id: p.id,
        name: p.name,
        is_loose: (p as any).is_loose,
        rate_per_kg: (p as any).rate_per_kg ?? null,
        barcode: (p as any).barcode ?? null,
        price: (p as any).price ?? null,
        costPrice: (p as any).costPrice ?? cost,
        category: (p as any).category,
        preset_weights: (p as any).preset_weights ?? [],
        preset_prices: (p as any).preset_prices ?? [],
        stockQuantity: 100,
      },
    });
  }

  console.log(`[SEED] Seeded ${products.length} products`);
}

main()
  .catch((e) => {
    console.error("[SEED] Error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
