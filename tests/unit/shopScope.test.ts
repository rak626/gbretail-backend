import { describe, it, expect } from "vitest";
import { getShopScope, superShopOverride } from "../../src/lib/shopScope.js";

function fakeCtx(user: any, shopId: string | null, queryShop?: string) {
  return {
    get: (k: string) => (k === "user" ? user : k === "shopId" ? shopId : undefined),
    req: { query: (_k: string) => queryShop },
  };
}

describe("getShopScope", () => {
  it("pins OWNER/STAFF to JWT shop, ignoring ?shopId", () => {
    const c = fakeCtx({ role: "STAFF", shopId: "shop_a" }, null, "shop_evil");
    expect(getShopScope(c as any).shopId).toBe("shop_a");
  });
  it("prefers ctx shop over JWT", () => {
    const c = fakeCtx({ role: "SHOP_OWNER", shopId: "shop_a" }, "shop_ctx", "shop_q");
    expect(getShopScope(c as any).shopId).toBe("shop_ctx");
  });
  it("lets SUPER_ADMIN use ?shopId", () => {
    const c = fakeCtx({ role: "SUPER_ADMIN", shopId: null }, null, "shop_q");
    expect(getShopScope(c as any).shopId).toBe("shop_q");
  });
  it("handles missing user", () => {
    const c = fakeCtx(undefined, "shop_ctx");
    expect(getShopScope(c as any).shopId).toBe("shop_ctx");
  });
});

describe("superShopOverride", () => {
  it("returns null for non-super", () => {
    const c = fakeCtx({ role: "STAFF", shopId: "a" }, null);
    expect(superShopOverride(c as any, { shopId: "b" })).toBeNull();
  });
  it("prefers ctx, then body, then query for super", () => {
    expect(superShopOverride(fakeCtx({ role: "SUPER_ADMIN" }, "ctx", "q") as any, { shopId: "b" })).toBe("ctx");
    expect(superShopOverride(fakeCtx({ role: "SUPER_ADMIN" }, null, "q") as any, { shopId: "b" })).toBe("b");
    expect(superShopOverride(fakeCtx({ role: "SUPER_ADMIN" }, null, "q") as any, {})).toBe("q");
    expect(superShopOverride(fakeCtx({ role: "SUPER_ADMIN" }, null, undefined) as any, {})).toBeNull();
  });
});
