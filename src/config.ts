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
  port: (() => { const v = parseInt(env("PORT", "4000")!, 10); return isNaN(v) ? 4000 : v; })(),
  nodeEnv: env("NODE_ENV", "development")!,
  databaseUrl: env("DATABASE_URL"),
  useNeon: env("USE_NEON") === "1",
  corsOrigins: (env("CORS_ORIGIN", "http://localhost:3000")!).split(",").map((s) => s.trim()).filter(Boolean),
  tz: env("TZ", "Asia/Kolkata")!,
  isProduction: env("NODE_ENV") === "production",
  isWorker: !!env("WORKER"),
  jwtAccessSecret: env("JWT_ACCESS_SECRET", "dev-access-secret-change-me-32chars")!,
  jwtRefreshSecret: env("JWT_REFRESH_SECRET", "dev-refresh-secret-change-me-32chars")!,
  jwtAccessExpiresIn: env("JWT_ACCESS_EXPIRES_IN", "15m")!,
  jwtRefreshExpiresIn: env("JWT_REFRESH_EXPIRES_IN", "7d")!,
  bcryptRounds: parseInt(env("BCRYPT_ROUNDS", "10")!, 10) || 10,
};

export function getCorsOrigins(): string[] {
  return config.corsOrigins;
}

export function validateCorsOrigins(origins: string[]): void {
  if (origins.includes("*") && origins.length > 1) {
    console.warn("[config] CORS_ORIGIN contains '*' with credentials:true — invalid, will block requests");
  }
}
