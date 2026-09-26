import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { prisma } from "../lib/prisma.js";
import { verifyPassword, signAccessToken, signRefreshToken, verifyRefreshToken, verifyAccessToken, sanitizeUser, newJti, hashRefreshToken } from "../lib/auth.js";
import { resolveStaffCounter } from "../lib/staffCounter.js";
import { requireAuth } from "../middleware/auth.js";
import { config } from "../config.js";

const auth = new Hono();

function refreshExpiryDate(): Date {
  const raw = config.jwtRefreshExpiresIn;
  const m = /^(\d+)(ms|s|m|h|d|w)?$/.exec(raw);
  const n = m ? parseInt(m[1], 10) : 7;
  const unit = m?.[2] ?? "d";
  const ms = unit === "ms" ? n : unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : unit === "w" ? n * 7 * 86_400_000 : n * 86_400_000;
  return new Date(Date.now() + ms);
}

async function createSession(userId: string, jti: string, refreshToken: string): Promise<void> {
  try {
    await prisma.session.create({ data: { jti, userId, refreshHash: hashRefreshToken(refreshToken), expiresAt: refreshExpiryDate() } });
  } catch {
    // Table missing during rollout or race — login still succeeds; refresh falls back to legacy tv check.
  }
}

async function revokeSession(jti: string, replacedBy?: string): Promise<void> {
  try {
    await prisma.session.updateMany({ where: { jti, revokedAt: null }, data: { revokedAt: new Date(), ...(replacedBy ? { replacedBy } : {}) } });
  } catch {
    // ignore — table may not exist yet
  }
}

// POST /api/auth/login {email, password, counterId?}
auth.post("/login", async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", code: "INVALID_JSON" }, 400);
  }
  try {
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
      jti: newJti(),
    };

    const accessToken = signAccessToken(payload as any);
    const refreshToken = signRefreshToken({ userId: user.id, shopId: (user as any).shopId ?? null, role: (user as any).role, tv: (user as any).tokenVersion ?? 0, jti: (payload as any).jti } as any);
    await createSession(user.id, (payload as any).jti, refreshToken);

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
    const { toAppError } = await import("../lib/errors.js");
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 401 | 403 | 500 | 503);
  }
});

// POST /api/auth/refresh {refreshToken?} or cookie — single-use rotation with reuse detection
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

    // Per-device rotation: legacy tokens (no jti, issued before sessions) skip the check.
    const incomingJti = decoded.jti as string | undefined;
    if (incomingJti) {
      try {
        const sess = await prisma.session.findUnique({ where: { jti: incomingJti } });
        const hashOk = sess && sess.refreshHash === hashRefreshToken(token);
        if (!sess || sess.revokedAt || (sess as any).userId !== user.id || !hashOk || new Date((sess as any).expiresAt) < new Date()) {
          // Reuse or theft: kill all device sessions now so the attacker can't keep refreshing.
          try {
            await prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
          } catch { /* table missing — fall through */ }
          await prisma.user.update({ where: { id: user.id }, data: { tokenVersion: { increment: 1 } } });
          const code = !sess || (sess as any).revokedAt || !hashOk ? "REUSE_DETECTED" : "TOKEN_EXPIRED";
          return c.json({ error: code === "REUSE_DETECTED" ? "Session reused — all sessions revoked, login again" : "Refresh token expired — login again", code }, 401);
        }
      } catch (e) {
        // If the error is our own reuse-revocation path above, it already returned.
        // prisma.session missing (rollout) → fall through to legacy behavior.
        if (e instanceof Error && (e.message.includes("REUSE") || (e as any).code)) throw e;
      }
    }

    const nextJti = newJti();
    const payload = {
      userId: user.id,
      shopId: (user as any).shopId ?? null,
      role: (user as any).role,
      email: (user as any).email,
      name: (user as any).name,
      tv: (user as any).tokenVersion ?? 0,
      jti: nextJti,
    };
    const accessToken = signAccessToken(payload as any);
    const newRefresh = signRefreshToken({ userId: user.id, shopId: (user as any).shopId ?? null, role: (user as any).role, tv: (user as any).tokenVersion ?? 0, jti: nextJti } as any);
    if (incomingJti) {
      await revokeSession(incomingJti, nextJti);
    }
    await createSession(user.id, nextJti, newRefresh);

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

// POST /api/auth/logout — revokes only this device (jti). Use revoke-sessions for kill-all.
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
        const p = verifyAccessToken(token) as any;
        if (p?.jti) await revokeSession(p.jti);
      } catch {
        // Invalid/expired token — still try refresh below, then clear cookies.
      }
    }
    try {
      const body = await c.req.json().catch(() => ({}));
      const refresh = (body as any)?.refreshToken || getCookie(c, "refreshToken");
      if (refresh) {
        try {
          const rp = verifyRefreshToken(refresh) as any;
          if (rp?.jti) await revokeSession(rp.jti);
        } catch {
          // expired/invalid refresh — nothing to revoke
        }
      }
    } catch {
      // never block logout on body parse errors
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
    if ((p as any).jti) {
      try {
        const sess = await prisma.session.findUnique({ where: { jti: (p as any).jti } });
        if (sess && (sess as any).revokedAt) return c.json({ valid: false, error: "Session revoked" }, 401);
      } catch {
        // ignore — fail open
      }
    }
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
