import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";

const health = new Hono();

health.get("/", async (c) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return c.json({ status: "ok", db: "connected", timestamp: new Date().toISOString() });
  } catch (e) {
    return c.json(
      {
        status: "error",
        db: "disconnected",
        error: e instanceof Error ? e.message : "unknown",
        timestamp: new Date().toISOString(),
      },
      503
    );
  }
});

export default health;
