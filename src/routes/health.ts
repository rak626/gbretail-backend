import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";

const health = new Hono();

health.get("/", async (c) => {
  try {
    // 2s timeout so load-balancer polls never hang the pool; uncached by design
    // but cheap (SELECT 1) — callers should still poll no more often than 30s.
    const probe = prisma.$queryRaw`SELECT 1`;
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("DB probe timeout")), 2000));
    await Promise.race([probe, timeout]);
    return c.json({ status: "ok", db: "connected", timestamp: new Date().toISOString() });
  } catch (e) {
    // Sanitize — never leak connect strings / driver internals (see lib/errors.ts).
    const { toAppError } = await import("../lib/errors.js");
    const appErr = toAppError(e);
    return c.json(
      {
        status: "error",
        db: "disconnected",
        error: appErr.message,
        code: appErr.code,
        timestamp: new Date().toISOString(),
      },
      503
    );
  }
});

export default health;
