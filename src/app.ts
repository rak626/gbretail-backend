import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
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
