// Cloudflare Workers entry — no @hono/node-server import here.
// Wrangler `main` should point here so Node server code is never bundled.
import app from "./app.js";
import { applyEnv, assertProductionSecrets } from "./config.js";

export default {
  async fetch(request: Request, env: Record<string, string>, ctx: unknown) {
    applyEnv(env as Record<string, string | undefined>);
    try {
      assertProductionSecrets();
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    return app.fetch(request, env, ctx as never);
  },
};
