import { serve } from "@hono/node-server";
import app from "./app.js";
import { config } from "./config.js";

// Edge export (Cloudflare Workers / Vercel Edge / Bun)
export default app;

// Node server for local dev & Docker
if (!config.isProduction || !config.isWorker) {
  // Only start server when not in Workers env
  const isWrangler = process.env.WRANGLER === "1";
  if (!isWrangler) {
    console.log(`[gbretail-backend] Starting Hono on :${config.port} (lightweight, CORS: ${config.corsOrigins.join(", ")})`);
    serve({ fetch: app.fetch, port: config.port });
  }
}
