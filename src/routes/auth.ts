import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { prisma } from "../lib/prisma.js";
import { verifyPassword, signAccessToken, signRefreshToken, verifyRefreshToken, verifyAccessToken, sanitizeUser } from "../lib/auth.js";
import { resolveStaffCounter } from "../lib/staffCounter.js";
import { requireAuth } from "../middleware/auth.js";
import { config } from "../config.js";

const auth = new Hono();

// POST /api/auth/login {email, password, counterId?}
auth.post("/login", async (c) => {
  try {
    const body = await c.req.json();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const counterId = body.counterId ? String(body.counterId) : null;

    if (!email || !password) return c.json({ error: "Email and password required" }, 400);

    const user = await prisma.user.findUnique({ where: { email }, include: { shop: { select: { id: true, code: true, name: true, address: true, receiptName: true, gstin: true, upiId: true, phone: true, receiptFooter: true, isActive: true, deletedAt: true } }, counter: { select: { id: true, name: true } } } });
    if (!user || (user as any).deletedAt) return c.json({ error: "Invalid credentials" }, 401);
    if (!(user as any).isActive) return c.json({ error: "Account disabled" }, 403);
    // Deactivated shop blocks its staff/owner at login, refresh, and every
    // authenticated call (requireAuth re-checks). Super admin unaffected.
    if ((user as any).role !== "SUPER_ADMIN" && (user as any).shopId) {
      const sh = (user as any).shop;
      if (!sh || (sh as any).deletedAt || !(sh as any).isActive) return c.json({ error: "Shop disabled" }, 403);
    }

    const ok = await verifyPassword(password, (user as any).passwordHash);
    if (!ok) return c.json({ error: "Invalid credentials" }, 401);

    // Counter resolution:
    // - STAFF: owner-assigned counter auto-attaches (request value ignored);
    //   unassigned staff fall back to the emptiest active counter (session-only).
    // - OWNER/SUPER: explicit choice as before.
    let resolvedCounterId: string | null = null;
    let resolvedCounterName: string | null = null;
    if ((user as any).role === "STAFF") {
      const shopId = (user as any).shopId;
      if (!shopId) return c.json({ error: "Shop not assigned — contact admin" }, 403);
      const sc = await resolveStaffCounter(user.id, shopId);
      if (!sc) return c.json({ error: "No counter assigned — contact owner" }, 403);
      resolvedCounterId = sc.id;
      resolvedCounterName = sc.name;
    } else if (counterId) {
      const counter = await prisma.counter.findUnique({ where: { id: counterId } });
      if (!counter || (counter as any).deletedAt || !(counter as any).isActive) return c.json({ error: "Counter not found or inactive" }, 404);
      if (user.role !== "SUPER_ADMIN" && (counter as any).shopId !== (user as any).shopId) {
        return c.json({ error: "Counter does not belong to your shop" }, 403);
      }
      resolvedCounterId = counterId;
      resolvedCounterName = (counter as any).name ?? null;
    }

    const payload = {
      userId: user.id,
      shopId: (user as any).shopId ?? null,
      counterId: resolvedCounterId,
      role: (user as any).role,
      email: (user as any).email,
      name: (user as any).name,
      tv: (user as any).tokenVersion ?? 0,
    };

    const accessToken = signAccessToken(payload as any);
    const refreshToken = signRefreshToken({ userId: user.id, shopId: (user as any).shopId ?? null, role: (user as any).role, tv: (user as any).tokenVersion ?? 0 });

    // Set httpOnly cookies for refresh + optional access fallback
    const isProduction = config.isProduction;
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
      counter: resolvedCounterId ? { id: resolvedCounterId, name: resolvedCounterName } : null,
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
    const user = await prisma.user.findUnique({ where: { id: decoded.userId }, include: { shop: { select: { id: true, code: true, name: true, address: true, receiptName: true, gstin: true, upiId: true, phone: true, receiptFooter: true, isActive: true, deletedAt: true } } } });
    if (!user || (user as any).deletedAt || !(user as any).isActive) return c.json({ error: "User not found or disabled", code: "ACCOUNT_DISABLED" }, 401);
    // Revoked sessions stop here (password change, deactivate, revoke-sessions).
    if ((decoded.tv ?? 0) !== ((user as any).tokenVersion ?? 0)) {
      return c.json({ error: "Session revoked — login again", code: "SESSION_REVOKED" }, 401);
    }
    // Disabled/deleted shop blocks refresh too (was login-only before).
    if ((user as any).role !== "SUPER_ADMIN" && (user as any).shopId) {
      const sh = (user as any).shop;
      if (!sh || (sh as any).deletedAt || !(sh as any).isActive) return c.json({ error: "Shop disabled", code: "SHOP_DISABLED" }, 403);
    }

    const payload = {
      userId: user.id,
      shopId: (user as any).shopId ?? null,
      role: (user as any).role,
      email: (user as any).email,
      name: (user as any).name,
      tv: (user as any).tokenVersion ?? 0,
    };
    const accessToken = signAccessToken(payload as any);
    const newRefresh = signRefreshToken({ userId: user.id, shopId: (user as any).shopId ?? null, role: (user as any).role, tv: (user as any).tokenVersion ?? 0 });

    const isProduction = config.isProduction;
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

// POST /api/auth/logout — bumps tokenVersion to revoke stolen access tokens immediately.
auth.post("/logout", async (c) => {
  try {
    const authHeader = c.req.header("authorization") || c.req.header("Authorization") || "";
    let token: string | null = null;
    if (authHeader) {
      const parts = authHeader.split(" ");
      if (parts.length === 2) token = parts[1];
    }
    if (!token) {
      const cookie = c.req.header("cookie") || "";
      const m = cookie.match(/(?:^|;\s*)accessToken=([^;]+)/);
      if (m) token = decodeURIComponent(m[1]);
    }
    if (token) {
      try {
        const p = verifyAccessToken(token);
        await prisma.user.update({
          where: { id: (p as any).userId },
          data: { tokenVersion: { increment: 1 } },
        });
      } catch {
        // Invalid/expired token — still clear cookies below.
      }
    }
  } catch {
    // never block logout on DB errors
  }
  deleteCookie(c, "refreshToken", { path: "/" });
  deleteCookie(c, "accessToken", { path: "/" });
  return c.json({ success: true });
});

// GET /api/auth/me — requires auth
auth.get("/me", requireAuth as any, async (c) => {
  const payload = (c as any).get("user" as any) as any;
  try {
    const user = await prisma.user.findUnique({ where: { id: payload.userId }, include: { shop: { select: { id: true, code: true, name: true, address: true, receiptName: true, gstin: true, upiId: true, phone: true, receiptFooter: true } }, counter: { select: { id: true, name: true } } } });
    if (!user || (user as any).deletedAt) return c.json({ error: "User not found" }, 404);
    // Return fresh shop/counter list for POS header
    let counters: unknown[] = [];
    if ((user as any).shopId) {
      counters = await prisma.counter.findMany({ where: { shopId: (user as any).shopId, deletedAt: null, isActive: true }, orderBy: { name: "asc" } });
    } else if (payload.role === "SUPER_ADMIN") {
      // For super admin, return all shops counters? Just shops list
      const shops = await prisma.shop.findMany({ where: { deletedAt: null, isActive: true }, select: { id: true, code: true, name: true } });
      return c.json({ user: sanitizeUser(user as any), shop: (user as any).shop ?? null, shops, counters: [] });
    }
    return c.json({ user: sanitizeUser(user as any), shop: (user as any).shop ?? null, counters });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "Failed" }, 500);
  }
});

// GET /api/auth/verify — token check with live account/shop/session state
// (signature-only is not enough: disabled users/shops and revoked sessions read invalid).
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
    const row = await prisma.user.findUnique({
      where: { id: (p as any).userId },
      select: { isActive: true, deletedAt: true, role: true, shopId: true, tokenVersion: true, shop: { select: { isActive: true, deletedAt: true } } } as any,
    });
    if (!row || (row as any).deletedAt || !(row as any).isActive) return c.json({ valid: false, error: "Account disabled" }, 403);
    if (((p as any).tv ?? 0) !== ((row as any).tokenVersion ?? 0)) return c.json({ valid: false, error: "Session revoked" }, 401);
    if ((row as any).role !== "SUPER_ADMIN" && (row as any).shopId) {
      const sh = (row as any).shop;
      if (!sh || (sh as any).deletedAt || !(sh as any).isActive) return c.json({ valid: false, error: "Shop disabled" }, 403);
    }
    return c.json({ valid: true, payload: p });
  } catch (e) {
    return c.json({ valid: false, error: e instanceof Error ? e.message : "Invalid" }, 401);
  }
});

export default auth;
