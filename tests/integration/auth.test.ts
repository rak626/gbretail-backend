import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { testApp, login, authHeaders } from "../helpers/auth.js";
import { truncateAll, seedShop, closeTestPrisma } from "../helpers/db.js";

let app: ReturnType<typeof testApp>;

beforeAll(() => {
  app = testApp();
});
afterAll(async () => {
  await closeTestPrisma();
});
beforeEach(async () => {
  await truncateAll();
  await seedShop();
});

describe("auth", () => {
  it("logs in with dev-style creds and returns accessToken", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(20);
  });

  it("rejects bad password with 401", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@test.local", password: "wrongpass1" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects short passwords on user create (>=8)", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    const res = await app.request("/api/users", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ email: "n@n.co", password: "short", name: "N", role: "STAFF", shopId: "shop_test" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toMatch(/>=8/);
  });

  it("blocks disabled shop at login", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    // super must exist to disable shop — create one directly
    const { testPrisma } = await import("../helpers/db.js");
    const { hashPassword } = await import("../../src/lib/auth.js");
    await testPrisma().user.create({
      data: { email: "super@test.local", name: "S", passwordHash: await hashPassword("superpass1"), role: "SUPER_ADMIN" as any, shopId: null },
    });
    const superToken = await login(app, "super@test.local", "superpass1");
    await app.request("/api/shops/shop_test", {
      method: "PATCH",
      headers: authHeaders(superToken),
      body: JSON.stringify({ isActive: false }),
    });
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "staff@test.local", password: "staffpass1" }),
    });
    expect(res.status).toBe(403);
  });

  it("refresh rotation is single-use: replay → REUSE_DETECTED + kill-all", async () => {
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "owner@test.local", password: "ownerpass1" }),
    });
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const refreshCookie = setCookies.find((c) => c.startsWith("refreshToken="))?.split(";")[0];
    expect(refreshCookie).toBeTruthy();
    const first = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: refreshCookie! },
    });
    expect(first.status).toBe(200);
    // replay the same (now rotated) refresh cookie
    const replay = await app.request("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: refreshCookie! },
    });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as any).code).toBe("REUSE_DETECTED");
  });

  it("/verify fails closed on revoked session", async () => {
    const token = await login(app, "owner@test.local", "ownerpass1");
    const me = await app.request("/api/auth/me", { headers: authHeaders(token) });
    expect(me.status).toBe(200);
    // revoke all, then the same token must fail
    const { testPrisma } = await import("../helpers/db.js");
    const user = await testPrisma().user.findFirst({ where: { email: "owner@test.local" } });
    await testPrisma().user.update({ where: { id: user!.id }, data: { tokenVersion: { increment: 1 } } });
    const verify = await app.request("/api/auth/verify", { headers: authHeaders(token) });
    expect([401, 403]).toContain(verify.status);
  });
});
