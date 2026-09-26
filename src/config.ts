// Central configuration — single source for env parsing
// Works in Node (process.env) and Workers (c.env bindings via applyEnv).
import "dotenv/config";

export type EnvBindings = Record<string, string | undefined>;

const workerEnv: EnvBindings = {};

export function applyEnv(env?: EnvBindings): void {
  if (!env) return;
  for (const [k, v] of Object.entries(env)) {
    if (v != null) workerEnv[k] = String(v);
  }
}

function env(key: string, fallback?: string): string | undefined {
  return workerEnv[key] ?? process.env[key] ?? fallback;
}

function envRequired(key: string): string {
  const v = workerEnv[key] ?? process.env[key];
  if (!v) throw new Error(`Missing required env: ${key}`);
  return v;
}

function parsePort(): number {
  const v = parseInt(env("PORT", "4000")!, 10);
  return isNaN(v) ? 4000 : v;
}

function parseOrigins(): string[] {
  return (env("CORS_ORIGIN", "http://localhost:3000")!).split(",").map((s) => s.trim()).filter(Boolean);
}

const DEV_ACCESS = "dev-access-secret-change-me-32chars";
const DEV_REFRESH = "dev-refresh-secret-change-me-32chars";

// Use getters so applyEnv(c.env) per-request is reflected live in Workers.
export const config = {
  get port() { return parsePort(); },
  get nodeEnv() { return env("NODE_ENV", "development")!; },
  get databaseUrl() { return env("DATABASE_URL"); },
  get useNeon() { return env("USE_NEON") === "1"; },
  get corsOrigins() { return parseOrigins(); },
  get tz() { return env("TZ", "Asia/Kolkata")!; },
  get isProduction() { return env("NODE_ENV") === "production"; },
  get isWorker() { return env("WORKER") === "1" || env("CF_WORKER") === "1"; },
  get jwtAccessSecret() { return env("JWT_ACCESS_SECRET", DEV_ACCESS)!; },
  get jwtRefreshSecret() { return env("JWT_REFRESH_SECRET", DEV_REFRESH)!; },
  get jwtAccessExpiresIn() { return env("JWT_ACCESS_EXPIRES_IN", "15m")!; },
  get jwtRefreshExpiresIn() { return env("JWT_REFRESH_EXPIRES_IN", "7d")!; },
  get bcryptRounds() { return parseInt(env("BCRYPT_ROUNDS", "10")!, 10) || 10; },
};

export function getCorsOrigins(): string[] {
  return config.corsOrigins;
}

export function validateCorsOrigins(origins: string[]): void {
  if (origins.includes("*")) {
    console.warn("[config] CORS_ORIGIN contains '*' with credentials:true — browsers will block credentialed requests. Use explicit origins.");
  }
}

export function assertProductionSecrets(): void {
  if (!config.isProduction) return;
  if (config.jwtAccessSecret === DEV_ACCESS || config.jwtRefreshSecret === DEV_REFRESH) {
    throw new Error("JWT_ACCESS_SECRET/JWT_REFRESH_SECRET must be set in production (dev defaults are insecure)");
  }
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL must be set in production");
  }
}

export { envRequired };
