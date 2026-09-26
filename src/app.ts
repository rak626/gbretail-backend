import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { config, validateCorsOrigins } from "./config.js";
import { toAppError } from "./lib/errors.js";

import health from "./routes/health.js";
import stats from "./routes/stats.js";
import products from "./routes/products.js";
import customers from "./routes/customers.js";
import orders from "./routes/orders.js";
import ledger from "./routes/ledger.js";
import analytics from "./routes/analytics.js";
import auth from "./routes/auth.js";
import shops from "./routes/shops.js";
import counters from "./routes/counters.js";
import users from "./routes/users.js";

export function createApp() {
  const app = new Hono();

  // Workers bindings (c.env) -> config overrides, per request.
  app.use("*", async (c, next) => {
    try {
      const { applyEnv } = await import("./config.js");
      applyEnv((c.env ?? {}) as Record<string, string | undefined>);
    } catch {
      // Node: c.env empty — process.env already used.
    }
    await next();
  });

  // Global middleware — logger only in non-production to avoid verbose PII
  if (!config.isProduction) app.use("*", logger());

  app.use("*", secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
    strictTransportSecurity: "max-age=31536000; includeSubDomains",
    xFrameOptions: "DENY",
  }));
  // 1MB JSON cap — POS bills are KBs; fail closed with 413 instead of OOM.
  app.use(
    "*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ error: "Payload too large (max 1MB)", code: "PAYLOAD_TOO_LARGE" }, 413),
    })
  );

  // Lightweight auth rate-limit: 30 req/min per IP per auth endpoint.
  // Per-isolate memory on Workers (documented) — real DDoS protection lives at Cloudflare/WAF.
  // Bounded Map (5k keys) with lazy expiry sweep so spoofed x-forwarded-for can't OOM the isolate.
  const authHits = new Map<string, { count: number; reset: number }>();
  const AUTH_WINDOW_MS = 60_000;
  const AUTH_MAX = 30;
  const AUTH_MAX_KEYS = 5_000;
  let lastSweep = 0;
  app.use("/api/auth/*", async (c, next) => {
    // Only throttle credential-bearing writes; verify/me stay unthrottled for header polling.
    if (c.req.method !== "POST") return next();
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("cf-connecting-ip") || "local";
    const key = `${ip}:${c.req.path}`;
    const now = Date.now();
    // Opportunistic sweep at most once per window
    if (now - lastSweep > AUTH_WINDOW_MS) {
      lastSweep = now;
      for (const [k, v] of authHits) if (now > v.reset) authHits.delete(k);
      // Hard cap: drop oldest if still over (Map preserves insertion order)
      while (authHits.size > AUTH_MAX_KEYS) {
        const oldest = authHits.keys().next().value;
        if (!oldest) break;
        authHits.delete(oldest);
      }
    }
    const rec = authHits.get(key);
    if (!rec || now > rec.reset) {
      authHits.set(key, { count: 1, reset: now + AUTH_WINDOW_MS });
      return next();
    }
    rec.count += 1;
    if (rec.count > AUTH_MAX) {
      return c.json({ error: "Too many attempts — try again in a minute", code: "RATE_LIMITED" }, 429);
    }
    return next();
  });

  validateCorsOrigins(config.corsOrigins);

  app.use(
    "*",
    cors({
      // Read origins per-request so Workers [vars] changes apply without restart.
      origin: (origin, c) => {
        const allowed = config.corsOrigins;
        if (allowed.includes("*")) return null;
        if (!origin) return allowed[0] ?? null;
        return allowed.includes(origin) ? origin : null;
      },
      allowHeaders: ["Content-Type", "Authorization", "X-Shop-Id", "Idempotency-Key"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: ["Content-Disposition"],
      maxAge: 600,
      credentials: true,
    })
  );

  // Root — version from package.json would be ideal; keep static but single source intent
  app.get("/", (c) => c.json({ name: "gbretail-backend", status: "ok", version: "1.0.0" }));

  // Mount API — auth is public, shops/counters/users require auth internally
  app.route("/api/auth", auth);
  app.route("/api/shops", shops);
  app.route("/api/counters", counters);
  app.route("/api/users", users);
  app.route("/api/health", health);
  app.route("/api/stats", stats);
  app.route("/api/products", products);
  app.route("/api/customers", customers);
  app.route("/api/orders", orders);
  app.route("/api/ledger", ledger);
  app.route("/api/analytics", analytics);

  // 404
  app.notFound((c) => c.json({ error: "Not Found", path: c.req.path }, 404));

  // Central error handler — sanitizes internal messages
  app.onError((err, c) => {
    console.error("[Hono Error]", err);
    const appErr = toAppError(err);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 500);
  });

  return app;
}

export default createApp();
