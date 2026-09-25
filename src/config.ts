// Central configuration — single source for env parsing
import "dotenv/config";

function env(key: string, fallback?: string): string | undefined {
  return process.env[key] ?? fallback;
}

function envRequired(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env: ${key}`);
  return v;
}

export const config = {
  port: parseInt(env("PORT", "4000")!, 10),
  nodeEnv: env("NODE_ENV", "development")!,
  databaseUrl: env("DATABASE_URL"),
  useNeon: env("USE_NEON") === "1",
  corsOrigins: (env("CORS_ORIGIN", "http://localhost:3000")!).split(",").map((s) => s.trim()).filter(Boolean),
  tz: env("TZ", "Asia/Kolkata")!,
  isProduction: env("NODE_ENV") === "production",
  isWorker: !!env("WORKER"),
};

export function getCorsOrigins(): string[] {
  return config.corsOrigins;
}

export function validateCorsOrigins(origins: string[]): void {
  if (origins.includes("*") && origins.length > 1) {
    console.warn("[config] CORS_ORIGIN contains '*' with credentials:true — invalid, will block requests");
  }
}
