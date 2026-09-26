import { PrismaClient, Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import { config } from "../config.js";

// API contract speaks plain numbers (frontend expects number, formats with toFixed(2)).
// DB stays exact NUMERIC(12,2); only the JSON boundary converts Decimal -> number.
// Guard against double-patching in dev reloads.
try {
  const proto = Prisma.Decimal.prototype as unknown as { toJSON?: () => number };
  if (!proto.toJSON || proto.toJSON.name !== "prismaDecimalToNumber") {
    const prismaDecimalToNumber = function (this: InstanceType<typeof Prisma.Decimal>) {
      return this.toNumber();
    };
    Object.defineProperty(proto, "toJSON", { value: prismaDecimalToNumber, configurable: true, writable: true });
  }
} catch {
  // Prisma internals unavailable (edge stub) — JSON serialization falls back to default.
}

// Edge-aware Prisma singleton
// - Local Node (default): PrismaPg + pg TCP
// - Edge CF Workers / Vercel Edge with Neon: PrismaNeon (fetch/websocket)
// - Prisma Accelerate: prisma:// URL (no adapter)

type GlobalForPrisma = {
  prisma?: PrismaClient;
  prismaUrl?: string;
};

const globalForPrisma = globalThis as unknown as GlobalForPrisma;

function getWebSocketCtor(): typeof WebSocket | undefined {
  const g = globalThis as unknown as { WebSocket?: typeof WebSocket };
  if (typeof g.WebSocket !== "undefined") return g.WebSocket;
  // Node fallback: lazy-require ws only when global WebSocket is missing.
  // Avoids bundling ws into Workers (where the global exists).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const req = (globalThis as unknown as { require?: (id: string) => unknown }).require;
    if (typeof req === "function") {
      const wsMod = req("ws") as { default?: typeof WebSocket } & typeof WebSocket;
      return (wsMod.default ?? wsMod) as unknown as typeof WebSocket;
    }
  } catch {
    // ignore — Neon fetch path works without ws in Workers
  }
  return undefined;
}

function createPrismaClient(): PrismaClient {
  const connectionString = config.databaseUrl;

  if (!connectionString) {
    // Fail fast with a message that toAppError() maps to 503 DB_NOT_CONFIGURED.
    throw new Error("DATABASE_URL not set — set it in .env (Node) or wrangler secret (Workers)");
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
    const wsCtor = getWebSocketCtor();
    if (wsCtor) {
      try {
        neonConfig.webSocketConstructor = wsCtor;
      } catch {
        // ignore in Workers where assignment is unnecessary — fetch path used
      }
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

function getPrisma(): PrismaClient {
  const url = config.databaseUrl ?? "";
  // Recreate when DATABASE_URL changes (Workers per-request env via applyEnv).
  if (!globalForPrisma.prisma || globalForPrisma.prismaUrl !== url) {
    globalForPrisma.prisma = createPrismaClient();
    globalForPrisma.prismaUrl = url;
  }
  return globalForPrisma.prisma;
}

// Lazy proxy so Workers bindings applied per-request (applyEnv) are honored,
// and missing DATABASE_URL fails at query time (503) instead of import time.
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getPrisma();
    const value = Reflect.get(client as unknown as Record<PropertyKey, unknown>, prop, receiver);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(client) : value;
  },
});

export default prisma;
