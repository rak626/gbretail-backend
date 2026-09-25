import type { Context, Next } from "hono";
import { verifyAccessToken, type JwtPayload } from "../lib/auth.js";

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
    (c as any).set("user", payload);
    (c as any).set("shopId", payload.shopId ?? null);
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
