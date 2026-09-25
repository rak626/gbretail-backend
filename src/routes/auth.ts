import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { prisma } from "../lib/prisma.js";
import { verifyPassword, signAccessToken, signRefreshToken, verifyRefreshToken, verifyAccessToken, sanitizeUser } from "../lib/auth.js";
import { requireAuth } from "../middleware/auth.js";

const auth = new Hono();

// POST /api/auth/login {email, password, counterId?}
auth.post("/login", async (c) => {
  try {
    const body = await c.req.json();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const counterId = body.counterId ? String(body.counterId) : null;

    if (!email || !password) return c.json({ error: "Email and password required" }, 400);

    const user = await prisma.user.findUnique({ where: { email }, include: { shop: { select: { id: true, name: true } } } });
    if (!user || (user as any).deletedAt) return c.json({ error: "Invalid credentials" }, 401);
    if (!(user as any).isActive) return c.json({ error: "Account disabled" }, 403);

    const ok = await verifyPassword(password, (user as any).passwordHash);
    if (!ok) return c.json({ error: "Invalid credentials" }, 401);

    // Validate counter belongs to same shop if provided
    let resolvedCounterId: string | null = null;
    if (counterId) {
      const counter = await prisma.counter.findUnique({ where: { id: counterId } });
      if (!counter || (counter as any).deletedAt || !(counter as any).isActive) return c.json({ error: "Counter not found or inactive" }, 404);
      if (user.role !== "SUPER_ADMIN" && (counter as any).shopId !== (user as any).shopId) {
        return c.json({ error: "Counter does not belong to your shop" }, 403);
      }
      resolvedCounterId = counterId;
    }

    const payload = {
      userId: user.id,
      shopId: (user as any).shopId ?? null,
      counterId: resolvedCounterId,
      role: (user as any).role,
      email: (user as any).email,
      name: (user as any).name,
    };

    const accessToken = signAccessToken(payload as any);
    const refreshToken = signRefreshToken({ userId: user.id, shopId: (user as any).shopId ?? null, role: (user as any).role });

    // Set httpOnly cookies for refresh + optional access fallback
    const isProduction = process.env.NODE_ENV === "production";
    setCookie(c, "refreshToken", refreshToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: "Lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
    });
    setCookie(c, "accessToken", accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: "Lax",
      path: "/",
      maxAge: 15 * 60,
    });

    // Also return accessToken for SPA header usage
    return c.json({
      accessToken,
      refreshToken,
      user: sanitizeUser(user as any),
      shop: (user as any).shop ?? null,
      counterId: resolvedCounterId,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Login failed";
    return c.json({ error: msg }, 500);
  }
});

// POST /api/auth/refresh {refreshToken?} or cookie
auth.post("/refresh", async (c) => {
  try {
    let token: string | undefined;
    const body = await c.req.json().catch(() => ({}));
    token = body.refreshToken || getCookie(c, "refreshToken");
    if (!token) return c.json({ error: "Refresh token required" }, 401);

    const decoded = verifyRefreshToken(token) as any;
    const user = await prisma.user.findUnique({ where: { id: decoded.userId }, include: { shop: { select: { id: true, name: true } } } });
    if (!user || (user as any).deletedAt || !(user as any).isActive) return c.json({ error: "User not found or disabled" }, 401);

    const payload = {
      userId: user.id,
      shopId: (user as any).shopId ?? null,
      role: (user as any).role,
      email: (user as any).email,
      name: (user as any).name,
    };
    const accessToken = signAccessToken(payload as any);
    const newRefresh = signRefreshToken({ userId: user.id, shopId: (user as any).shopId ?? null, role: (user as any).role });

    const isProduction = process.env.NODE_ENV === "production";
    setCookie(c, "refreshToken", newRefresh, {
      httpOnly: true,
      secure: isProduction,
      sameSite: "Lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
    });
    setCookie(c, "accessToken", accessToken, {
      httpOnly: true,
      secure: isProduction,
      sameSite: "Lax",
      path: "/",
      maxAge: 15 * 60,
    });

    return c.json({ accessToken, refreshToken: newRefresh, user: sanitizeUser(user as any) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Refresh failed";
    if (msg.includes("expired")) return c.json({ error: "Refresh token expired — login again", code: "TOKEN_EXPIRED" }, 401);
    return c.json({ error: "Invalid refresh token" }, 401);
  }
});

// POST /api/auth/logout
auth.post("/logout", async (c) => {
  deleteCookie(c, "refreshToken", { path: "/" });
  deleteCookie(c, "accessToken", { path: "/" });
  return c.json({ success: true });
});

// GET /api/auth/me — requires auth
auth.get("/me", requireAuth as any, async (c) => {
  const payload = (c as any).get("user" as any) as any;
  try {
    const user = await prisma.user.findUnique({ where: { id: payload.userId }, include: { shop: { select: { id: true, name: true } } } });
    if (!user || (user as any).deletedAt) return c.json({ error: "User not found" }, 404);
    // Return fresh shop/counter list for POS header
    let counters: unknown[] = [];
    if ((user as any).shopId) {
      counters = await prisma.counter.findMany({ where: { shopId: (user as any).shopId, deletedAt: null, isActive: true }, orderBy: { name: "asc" } });
    } else if (payload.role === "SUPER_ADMIN") {
      // For super admin, return all shops counters? Just shops list
      const shops = await prisma.shop.findMany({ where: { deletedAt: null, isActive: true }, select: { id: true, name: true } });
      return c.json({ user: sanitizeUser(user as any), shop: (user as any).shop ?? null, shops, counters: [] });
    }
    return c.json({ user: sanitizeUser(user as any), shop: (user as any).shop ?? null, counters });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
  }
});

// GET /api/auth/verify — lightweight token check
auth.get("/verify", async (c) => {
  const authHeader = c.req.header("authorization") || c.req.header("Authorization") || "";
  const cookie = c.req.header("cookie") || "";
  let token: string | null = null;
  if (authHeader) {
    const parts = authHeader.split(" ");
    if (parts.length === 2) token = parts[1];
  }
  if (!token) {
    const m = cookie.match(/(?:^|;\s*)accessToken=([^;]+)/);
    if (m) token = decodeURIComponent(m[1]);
  }
  if (!token) return c.json({ valid: false, error: "No token" }, 401);
  try {
    const p = verifyAccessToken(token);
    return c.json({ valid: true, payload: p });
  } catch (e) {
    return c.json({ valid: false, error: e instanceof Error ? e.message : "Invalid" }, 401);
  }
});

export default auth;
