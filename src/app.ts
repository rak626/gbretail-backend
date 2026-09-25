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

export function createApp() {
  const app = new Hono();

  // Global middleware — logger only in non-production to avoid verbose PII
  if (!config.isProduction) app.use("*", logger());

  const origins = config.corsOrigins;
  validateCorsOrigins(origins);

  app.use(
    "*",
    cors({
      origin: origins,
      allowHeaders: ["Content-Type", "Authorization"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      credentials: true,
    })
  );

  // Root — version from package.json would be ideal; keep static but single source intent
  app.get("/", (c) => c.json({ name: "gbretail-backend", status: "ok", version: "1.0.0" }));

  // Mount API
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
