import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { hashPassword } from "../lib/auth.js";

const users = new Hono();

users.use("*", requireAuth as any);

// GET /api/users?shopId= — SUPER_ADMIN sees all, SHOP_OWNER sees own shop staff/owners
users.get("/", async (c) => {
  const user = (c as any).get("user" as any) as any;
  const queryShopId = c.req.query("shopId");
  try {
    if (user.role === "SUPER_ADMIN") {
      const where: Record<string, unknown> = { deletedAt: null };
      if (queryShopId) (where as any).shopId = queryShopId;
      const items = await prisma.user.findMany({ where, select: { id: true, shopId: true, email: true, name: true, role: true, canManageInventory: true, counterId: true, isActive: true, createdAt: true, shop: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" } });
      return c.json({ users: items });
    }
    if (user.role === "SHOP_OWNER") {
      const items = await prisma.user.findMany({ where: { shopId: user.shopId, deletedAt: null }, select: { id: true, shopId: true, email: true, name: true, role: true, canManageInventory: true, counterId: true, isActive: true, createdAt: true }, orderBy: { createdAt: "desc" } });
      return c.json({ users: items });
    }
    // STAFF can only see themselves? Return self
    const self = await prisma.user.findUnique({ where: { id: user.userId }, select: { id: true, shopId: true, email: true, name: true, role: true, canManageInventory: true, counterId: true, isActive: true, createdAt: true } });
    return c.json({ users: self ? [self] : [] });
  } catch (e) {
    const { toAppError } = await import("../lib/errors.js");
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 401 | 403 | 404 | 409 | 500 | 503);
  }
});

// GET /api/users/:id
users.get("/:id", async (c) => {
  const user = (c as any).get("user" as any) as any;
  const id = c.req.param("id");
  try {
    const target = await prisma.user.findUnique({ where: { id }, select: { id: true, shopId: true, email: true, name: true, role: true, canManageInventory: true, counterId: true, isActive: true, createdAt: true, deletedAt: true, shop: { select: { id: true, name: true } } } });
    if (!target || (target as any).deletedAt) return c.json({ error: "User not found" }, 404);
    if (user.role !== "SUPER_ADMIN" && (target as any).shopId !== user.shopId) return c.json({ error: "Forbidden" }, 403);
    if (user.role === "STAFF" && user.userId !== id) return c.json({ error: "Forbidden" }, 403);
    return c.json({ user: target });
  } catch (e) {
    const { toAppError } = await import("../lib/errors.js");
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 401 | 403 | 404 | 409 | 500 | 503);
  }
});

// POST /api/users — only SUPER_ADMIN and SHOP_OWNER
users.post("/", requireRole("SUPER_ADMIN", "SHOP_OWNER") as any, async (c) => {
  const actor = (c as any).get("user" as any) as any;
  try {
    const body = await c.req.json();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const name = String(body.name ?? "").trim();
    const role = String(body.role ?? "STAFF").toUpperCase(); // STAFF | SHOP_OWNER | SUPER_ADMIN (only super can create super)
    let shopId: string | null = body.shopId ? String(body.shopId) : null;

    if (!email || !password || !name) return c.json({ error: "email, password, name required" }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "Invalid email" }, 400);
    if (password.length < 6) return c.json({ error: "Password must be >=6 chars" }, 400);
    if (name.length > 80) return c.json({ error: "Name too long" }, 400);

    const allowedRoles = actor.role === "SUPER_ADMIN" ? ["SUPER_ADMIN", "SHOP_OWNER", "STAFF"] : ["STAFF"];
    if (!allowedRoles.includes(role)) return c.json({ error: `Role not allowed. Allowed: ${allowedRoles.join(",")}` }, 403);
    if (role === "SHOP_OWNER" || role === "STAFF") {
      if (actor.role === "SHOP_OWNER") {
        shopId = actor.shopId;
      }
      if (!shopId) return c.json({ error: "shopId required for this role" }, 400);
      const shop = await prisma.shop.findUnique({ where: { id: shopId } });
      if (!shop || (shop as any).deletedAt || !(shop as any).isActive) return c.json({ error: "Shop not found or inactive" }, 404);
      if (actor.role === "SHOP_OWNER" && actor.shopId !== shopId) return c.json({ error: "Forbidden — cannot create user for other shop" }, 403);
    } else if (role === "SUPER_ADMIN") {
      shopId = null; // super admin has no shop
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing && !(existing as any).deletedAt) return c.json({ error: "Email already exists" }, 409);
    if (existing && (existing as any).deletedAt) return c.json({ error: "Email belongs to deleted user — restore or use different email" }, 409);

    const passwordHash = await hashPassword(password);
    // Owner-only counter assignment at creation (STAFF of own shop).
    let counterId: string | null = null;
    if (role === "STAFF" && body.counterId) {
      if (actor.role !== "SHOP_OWNER") return c.json({ error: "Only the shop owner can assign counters" }, 403);
      const counter = await prisma.counter.findUnique({ where: { id: String(body.counterId) } });
      if (!counter || (counter as any).deletedAt || !(counter as any).isActive) return c.json({ error: "Counter not found or inactive" }, 404);
      if ((counter as any).shopId !== actor.shopId) return c.json({ error: "Counter does not belong to your shop" }, 403);
      counterId = counter.id;
    }
    const created = await prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
        role,
        shopId,
        // Owner/super can grant inventory access at creation (STAFF only; owner always has it).
        // SUPER_ADMIN cannot grant — only the shop owner can.
        canManageInventory: role === "STAFF" && actor.role === "SHOP_OWNER" ? Boolean(body.canManageInventory) : false,
        counterId,
      },
      select: { id: true, shopId: true, email: true, name: true, role: true, canManageInventory: true, counterId: true, isActive: true, createdAt: true },
    });
    return c.json({ user: created }, 201);
  } catch (e) {
    const { toAppError } = await import("../lib/errors.js");
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 401 | 403 | 404 | 409 | 500 | 503);
  }
});

// PATCH /api/users/:id
users.patch("/:id", async (c) => {
  const actor = (c as any).get("user" as any) as any;
  const id = c.req.param("id");
  try {
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target || (target as any).deletedAt) return c.json({ error: "User not found" }, 404);

    // Permission: super can edit anyone, owner can edit staff in own shop, staff can edit self (name only)
    const isSelf = actor.userId === id;
    if (actor.role === "STAFF" && !isSelf) return c.json({ error: "Forbidden" }, 403);
    if (actor.role === "SHOP_OWNER" && (target as any).shopId !== actor.shopId) return c.json({ error: "Forbidden" }, 403);
    if (actor.role === "SHOP_OWNER" && (target as any).role === "SUPER_ADMIN") return c.json({ error: "Forbidden" }, 403);

    const body = await c.req.json();
    const data: Record<string, unknown> = {};

    if (body.name !== undefined) {
      const n = String(body.name).trim();
      if (!n) return c.json({ error: "Name required" }, 400);
      data.name = n;
    }
    if (body.email !== undefined) {
      if (actor.role === "STAFF" && !isSelf) return c.json({ error: "Forbidden" }, 403);
      const e = String(body.email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return c.json({ error: "Invalid email" }, 400);
      const dup = await prisma.user.findUnique({ where: { email: e } });
      if (dup && dup.id !== id) return c.json({ error: "Email already exists" }, 409);
      data.email = e;
    }
    if (body.password !== undefined) {
      const p = String(body.password);
      if (p.length < 6) return c.json({ error: "Password >=6" }, 400);
      data.passwordHash = await hashPassword(p);
      // Password change revokes all existing sessions instantly.
      data.tokenVersion = { increment: 1 };
    }
    if (body.isActive !== undefined) {
      // Activate/deactivate rules:
      // - STAFF: no permission at all.
      // - SHOP_OWNER: own-shop STAFF only (never self, never owners/supers).
      // - SUPER_ADMIN: SHOP_OWNER only (never staff, never self).
      if (actor.userId === id) return c.json({ error: "Cannot change your own status" }, 403);
      if (actor.role === "STAFF") return c.json({ error: "Forbidden" }, 403);
      const targetRole = String((target as any).role ?? "").toUpperCase();
      if (actor.role === "SHOP_OWNER") {
        if (targetRole !== "STAFF" || (target as any).shopId !== actor.shopId) {
          return c.json({ error: "Owners can only change status of own-shop staff" }, 403);
        }
      } else if (actor.role === "SUPER_ADMIN") {
        if (targetRole !== "SHOP_OWNER") {
          return c.json({ error: "Super admin can only change status of shop owners" }, 403);
        }
      }
      data.isActive = Boolean(body.isActive);
      // Status flip revokes sessions: deactivation kills them now (not at expiry),
      // reactivation starts clean (old tokens stay dead).
      data.tokenVersion = { increment: 1 };
    }
    if (body.role !== undefined) {
      if (actor.role !== "SUPER_ADMIN") return c.json({ error: "Only SUPER_ADMIN can change role" }, 403);
      const r = String(body.role).toUpperCase();
      if (!["SUPER_ADMIN", "SHOP_OWNER", "STAFF"].includes(r)) return c.json({ error: "Invalid role" }, 400);
      data.role = r;
    }
    if (body.shopId !== undefined) {
      if (actor.role !== "SUPER_ADMIN") return c.json({ error: "Only SUPER_ADMIN can change shop" }, 403);
      data.shopId = body.shopId ? String(body.shopId) : null;
    }
    if (body.canManageInventory !== undefined) {
      // Owner-only: only the SHOP_OWNER can grant/revoke inventory access for
      // own-shop STAFF. SUPER_ADMIN never touches shop stock permissions.
      // Only meaningful for STAFF (owners always have access).
      if ((target as any).role !== "STAFF") return c.json({ error: "canManageInventory applies to STAFF only" }, 400);
      if (actor.role !== "SHOP_OWNER") return c.json({ error: "Only the shop owner can change inventory access" }, 403);
      if ((target as any).shopId !== actor.shopId) return c.json({ error: "Forbidden" }, 403);
      data.canManageInventory = Boolean(body.canManageInventory);
    }
    if (body.counterId !== undefined) {
      // Owner-only counter assignment for own-shop STAFF. Null unassigns
      // (staff then falls back to the emptiest counter at next login).
      if ((target as any).role !== "STAFF") return c.json({ error: "counterId applies to STAFF only" }, 400);
      if (actor.role !== "SHOP_OWNER") return c.json({ error: "Only the shop owner can assign counters" }, 403);
      if ((target as any).shopId !== actor.shopId) return c.json({ error: "Forbidden" }, 403);
      if (body.counterId === null || body.counterId === "") {
        data.counterId = null;
      } else {
        const counter = await prisma.counter.findUnique({ where: { id: String(body.counterId) } });
        if (!counter || (counter as any).deletedAt || !(counter as any).isActive) return c.json({ error: "Counter not found or inactive" }, 404);
        if ((counter as any).shopId !== actor.shopId) return c.json({ error: "Counter does not belong to your shop" }, 403);
        data.counterId = counter.id;
      }
    }

    if (Object.keys(data).length === 0) return c.json({ error: "No valid fields" }, 400);
    const updated = await prisma.user.update({ where: { id }, data, select: { id: true, shopId: true, email: true, name: true, role: true, canManageInventory: true, counterId: true, isActive: true, createdAt: true } });
    if ((data as any).tokenVersion) {
      try {
        await prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      } catch {
        // Session table missing — tokenVersion bump already kills all.
      }
    }
    return c.json({ user: updated });
  } catch (e) {
    const { toAppError } = await import("../lib/errors.js");
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 401 | 403 | 404 | 409 | 500 | 503);
  }
});

// DELETE /api/users/:id — soft delete
users.delete("/:id", requireRole("SUPER_ADMIN", "SHOP_OWNER") as any, async (c) => {
  const actor = (c as any).get("user" as any) as any;
  const id = c.req.param("id");
  try {
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target || (target as any).deletedAt) return c.json({ error: "Not found or already deleted" }, 404);
    if (actor.role === "SHOP_OWNER" && (target as any).shopId !== actor.shopId) return c.json({ error: "Forbidden" }, 403);
    if (target.id === actor.userId) return c.json({ error: "Cannot delete self" }, 400);
    const updated = await prisma.user.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    return c.json({ user: { id: updated.id }, softDeleted: true });
  } catch (e) {
    const { toAppError } = await import("../lib/errors.js");
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 401 | 403 | 404 | 409 | 500 | 503);
  }
});

// POST /api/users/:id/restore — SUPER_ADMIN or SHOP_OWNER
users.post("/:id/restore", requireRole("SUPER_ADMIN", "SHOP_OWNER") as any, async (c) => {
  const actor = (c as any).get("user" as any) as any;
  const id = c.req.param("id");
  try {
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) return c.json({ error: "Not found" }, 404);
    if (!(target as any).deletedAt) return c.json({ message: "Already active", user: target });
    if (actor.role === "SHOP_OWNER" && (target as any).shopId !== actor.shopId) return c.json({ error: "Forbidden" }, 403);
    const updated = await prisma.user.update({ where: { id }, data: { deletedAt: null, isActive: true }, select: { id: true, shopId: true, email: true, name: true, role: true, canManageInventory: true, counterId: true, isActive: true } });
    return c.json({ user: updated });
  } catch (e) {
    const { toAppError } = await import("../lib/errors.js");
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 401 | 403 | 404 | 409 | 500 | 503);
  }
});

// POST /api/users/:id/revoke-sessions — kill all sessions now (lost device, staff exit).
// SUPER_ADMIN: anyone. SHOP_OWNER: own-shop STAFF (and self).
users.post("/:id/revoke-sessions", async (c) => {
  const actor = (c as any).get("user" as any) as any;
  const id = c.req.param("id");
  try {
    const target = await prisma.user.findUnique({ where: { id } });
    if (!target || (target as any).deletedAt) return c.json({ error: "User not found" }, 404);
    const isSelf = actor.userId === id;
    if (!isSelf) {
      if (actor.role === "SHOP_OWNER" && ((target as any).role !== "STAFF" || (target as any).shopId !== actor.shopId)) {
        return c.json({ error: "Owners can only revoke own-shop staff sessions" }, 403);
      }
      if (actor.role !== "SUPER_ADMIN" && actor.role !== "SHOP_OWNER") return c.json({ error: "Forbidden" }, 403);
    }
    const updated = await prisma.user.update({ where: { id }, data: { tokenVersion: { increment: 1 } }, select: { id: true, tokenVersion: true } });
    try {
      await prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    } catch {
      // Session table missing during rollout — tokenVersion bump already kills all.
    }
    return c.json({ user: { id: updated.id }, sessionsRevoked: true });
  } catch (e) {
    const { toAppError } = await import("../lib/errors.js");
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 500 | 503);
  }
});

export default users;
