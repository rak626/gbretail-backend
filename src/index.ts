// Node entry — local dev & Docker only. NOT bundled for Workers (see worker.ts).
import "dotenv/config";
import { serve } from "@hono/node-server";
import app from "./app.js";
import { config, assertProductionSecrets } from "./config.js";
import { disconnectPrisma } from "./lib/prisma.js";

// Only start server when not in Workers env.
if (!config.isWorker) {
  const isWrangler = process.env.WRANGLER === "1";
  if (!isWrangler) {
    assertProductionSecrets();
    console.log(`[gbretail-backend] Starting Hono on :${config.port} (lightweight, CORS: ${config.corsOrigins.join(", ")})`);
    const server = serve({ fetch: app.fetch, port: config.port });
    const shutdown = async (sig: string) => {
      console.log(`[${sig}] shutting down — closing DB pool...`);
      try {
        await disconnectPrisma();
      } catch {
        // ignore
      }
      process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  }
}

export default app;
