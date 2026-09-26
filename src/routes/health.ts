import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";

const health = new Hono();

health.get("/", async (c) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
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
