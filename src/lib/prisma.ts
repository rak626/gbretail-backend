import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";
import { config } from "../config.js";

// Edge-aware Prisma singleton
// - Local Node (default): PrismaPg + pg TCP
// - Edge CF Workers / Vercel Edge with Neon: PrismaNeon (fetch/websocket)
// - Prisma Accelerate: prisma:// URL (no adapter)

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient() {
  const connectionString = config.databaseUrl;

  if (!connectionString) {
    console.warn("[prisma] DATABASE_URL not set - using dummy adapter (queries will fail gracefully)");
    // Prisma 7 requires adapter — use dummy pg adapter so construction succeeds; queries will 503
    const dummy = new PrismaPg({ connectionString: "postgresql://dummy:dummy@localhost:5432/dummy?schema=public" });
    return new PrismaClient({
      adapter: dummy,
      log: config.nodeEnv === "development" ? ["error", "warn"] : ["error"],
    });
  }

  // Prisma Accelerate (prisma://) — no adapter
  if (connectionString.startsWith("prisma://")) {
    return new PrismaClient({
      log: config.nodeEnv === "development" ? ["error", "warn"] : ["error"],
    });
  }

  // Neon HTTP for edge (fetch) — auto if USE_NEON=1 or URL contains neon.tech (case-insensitive)
  const useNeon = config.useNeon || connectionString.toLowerCase().includes("neon.tech");
  if (useNeon) {
    // ws required for node local; Workers use fetch — both set
    try {
      neonConfig.webSocketConstructor = ws as unknown as typeof WebSocket;
    } catch {
      // ignore in Workers where ws unavailable — fetch path used
    }
    const adapter = new PrismaNeon({ connectionString });
    return new PrismaClient({
      adapter,
      log: config.nodeEnv === "development" ? ["error", "warn"] : ["error"],
    });
  }

  // Default: Node pg
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({
    adapter,
    log: config.nodeEnv === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (config.nodeEnv !== "production") globalForPrisma.prisma = prisma;

export default prisma;
