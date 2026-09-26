import type { Context, Next } from "hono";
import { verifyAccessToken, type JwtPayload } from "../lib/auth.js";
import { prisma } from "../lib/prisma.js";

export type AuthEnv = {
  Variables: {
    user: JwtPayload;
    shopId: string | null;
    userId: string;
    role: string;
  };
};

function getTokenFromHeader(c: Context): string | null {
  const auth = c.req.header("authorization") || c.req.header("Authorization");
  if (!auth) return null;
  const parts = auth.split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") return parts[1];
  return null;
}

function getTokenFromCookie(c: Context): string | null {
  const cookie = c.req.header("cookie");
  if (!cookie) return null;
  const m = cookie.match(/(?:^|;\s*)accessToken=([^;]+)/);
  if (m) return decodeURIComponent(m[1]);
  return null;
}

export async function requireAuth(c: Context, next: Next) {
  const token = getTokenFromHeader(c) || getTokenFromCookie(c);
  if (!token) {
    return c.json({ error: "Unauthorized — missing token", code: "UNAUTHORIZED" }, 401);
  }
  try {
    const payload = verifyAccessToken(token);
    if (!payload?.userId || !payload?.role) throw new Error("Invalid payload");
    // Deactivation + revocation take effect immediately — a disabled/deleted
    // account or a bumped tokenVersion cannot keep using unexpired tokens.
    // Disabled shops block their staff/owner on every call (super admin exempt).
    const row = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { isActive: true, deletedAt: true, role: true, shopId: true, tokenVersion: true, shop: { select: { isActive: true, deletedAt: true } } } as any,
    });
    if (!row || (row as any).deletedAt || !(row as any).isActive) {
      return c.json({ error: "Account disabled", code: "ACCOUNT_DISABLED" }, 403);
    }
    if ((payload.tv ?? 0) !== ((row as any).tokenVersion ?? 0)) {
      return c.json({ error: "Session revoked — login again", code: "SESSION_REVOKED" }, 401);
    }
    if ((row as any).role !== "SUPER_ADMIN" && (row as any).shopId) {
      const sh = (row as any).shop;
      if (!sh || (sh as any).deletedAt || !(sh as any).isActive) {
        return c.json({ error: "Shop disabled", code: "SHOP_DISABLED" }, 403);
      }
    }
    (c as any).set("user", payload);
    // SUPER_ADMIN shop impersonation via x-shop-id header (previously only in
    // unenforced enforceShopScope). Merged here so it works on every route
    // without per-router mounting.
    let shopId: string | null = payload.shopId ?? null;
    if (payload.role === "SUPER_ADMIN") {
      const headerShop = c.req.header("x-shop-id") || c.req.header("X-Shop-Id");
      if (headerShop) shopId = headerShop;
    }
    (c as any).set("shopId", shopId);
    (c as any).set("userId", payload.userId);
    (c as any).set("role", payload.role);
    await next();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid token";
    if (msg.includes("expired")) return c.json({ error: "Token expired", code: "TOKEN_EXPIRED" }, 401);
    return c.json({ error: "Unauthorized — invalid token", code: "UNAUTHORIZED" }, 401);
  }
}

export function requireRole(...roles: string[]) {
  return async (c: Context, next: Next) => {
    const role = (c as any).get("role") as string | undefined;
    const user = (c as any).get("user") as JwtPayload | undefined;
    if (!user || !role) return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);
    if (!roles.includes(role)) {
      return c.json({ error: `Forbidden — requires role: ${roles.join(",")}`, code: "FORBIDDEN" }, 403);
    }
    await next();
  };
}

// Allow SUPER_ADMIN to access any shop via x-shop-id header, otherwise enforce shopId from token
export async function enforceShopScope(c: Context, next: Next) {
  const user = (c as any).get("user") as JwtPayload | undefined;
  if (!user) return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);
  // SUPER_ADMIN can impersonate shop via header x-shop-id
  if (user.role === "SUPER_ADMIN") {
    const headerShop = c.req.header("x-shop-id") || c.req.query("shopId");
    if (headerShop) (c as any).set("shopId", headerShop);
    // otherwise leave null -> means all shops (for shop listing)
  }
  await next();
}
