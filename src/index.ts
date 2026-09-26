// Node entry — local dev & Docker only. NOT bundled for Workers (see worker.ts).
import { serve } from "@hono/node-server";
import app from "./app.js";
import { config, assertProductionSecrets } from "./config.js";

// Only start server when not in Workers env.
if (!config.isWorker) {
  const isWrangler = process.env.WRANGLER === "1";
  if (!isWrangler) {
    assertProductionSecrets();
    console.log(`[gbretail-backend] Starting Hono on :${config.port} (lightweight, CORS: ${config.corsOrigins.join(", ")})`);
    serve({ fetch: app.fetch, port: config.port });
  }
}

export default app;
