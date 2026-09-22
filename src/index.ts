import "dotenv/config";
import { serve } from "@hono/node-server";
import app from "./app.js";

const port = Number(process.env.PORT || 4000);

// Edge export (Cloudflare Workers / Vercel Edge / Bun)
export default app;

// Node server for local dev & Docker
if (process.env.NODE_ENV !== "production" || !process.env.WORKER) {
  // Only start server when not in Workers env
  // Wrangler imports this but does not auto-execute serve; Workers use `export default app`
  const isWrangler = process.env.WRANGLER === "1";
  if (!isWrangler) {
    console.log(`[gbretail-backend] Starting Hono on :${port} (lightweight, CORS: ${process.env.CORS_ORIGIN || "http://localhost:3000"})`);
    serve({ fetch: app.fetch, port });
  }
}
