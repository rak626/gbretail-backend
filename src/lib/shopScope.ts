// Hardened shop scoping: shopId comes from the verified JWT (via requireAuth),
// never from query/body for OWNER/STAFF. SUPER_ADMIN may impersonate via
// x-shop-id header (set in requireAuth) or explicit ?shopId (super-only).
export function getShopScope(c: any): { user: any; shopId: string | null } {
  const user = (c as any).get("user") as any;
  const ctxShop = (c as any).get("shopId") as string | null;
  if (!user) return { user, shopId: ctxShop ?? null };
  if (user.role === "SUPER_ADMIN") {
    const q = c.req?.query?.("shopId") as string | undefined;
    return { user, shopId: ctxShop ?? (q || null) };
  }
  // OWNER/STAFF pinned to own shop — query/body shopId ignored (closes shop-hop).
  return { user, shopId: ctxShop ?? user?.shopId ?? null };
}

// SUPER_ADMIN-only explicit shop picker for POST bodies (create-as) and
// super list filters. Returns null for non-super (caller ignores body.shopId).
export function superShopOverride(c: any, body?: Record<string, unknown>): string | null {
  const user = (c as any).get("user") as any;
  if (user?.role !== "SUPER_ADMIN") return null;
  const q = c.req?.query?.("shopId") as string | undefined;
  const b = body?.shopId ? String(body.shopId) : null;
  const ctx = (c as any).get("shopId") as string | null;
  return ctx ?? b ?? q ?? null;
}
