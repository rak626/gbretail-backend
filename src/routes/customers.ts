import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { normalizePhone, normalizeEmail } from "../lib/normalize.js";
import { toAppError } from "../lib/errors.js";
import { startOfDay } from "../lib/utils.js";
import { requireAuth } from "../middleware/auth.js";
import { parseMoney, dec, MAX_MONEY } from "../lib/money.js";

const customers = new Hono();

customers.use("*", requireAuth as any);

// Shop scope: OWNER/STAFF forced to own shop; SUPER_ADMIN may filter by ?shopId / body.shopId or see all.
function getShopScope(c: any) {
  const user = (c as any).get("user") as any;
  const shopId =
    ((c as any).get("shopId") as string | null) || user?.shopId || c.req.query("shopId") || null;
  return { user, shopId: shopId ? String(shopId) : null };
}

// GET /api/customers?q&limit&page&sortBy&sortOrder&hasBalance&includeDeleted&due
// hasBalance: "with" | "without" | ""  (balance >0 vs =0)
// includeDeleted: "1" to show soft-deleted
customers.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const qLower = q.toLowerCase();
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 100);
  const page = Math.max(parseInt(c.req.query("page") ?? "1", 10) || 1, 1);
  const sortByRaw = (c.req.query("sortBy") ?? "").trim();
  const sortOrderRaw = (c.req.query("sortOrder") ?? "desc").toLowerCase();
  const hasBalance = (c.req.query("hasBalance") ?? c.req.query("balance") ?? "").toLowerCase().trim();
  const includeDeleted = c.req.query("includeDeleted") === "1" || c.req.query("include_deleted") === "1";
  const dueFilter = (c.req.query("due") ?? "").toLowerCase().trim(); // "true" or "with"

  const allowedSort = new Set(["name", "createdAt", "updatedAt", "lastOrderAt", "firstOrderAt", "totalSpent", "totalOrders", "balance"]);
  const sortBy = allowedSort.has(sortByRaw) ? sortByRaw : "createdAt";
  const sortOrder = sortOrderRaw === "asc" ? "asc" as const : "desc" as const;
  const { user, shopId } = getShopScope(c);
  if (!shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Shop not assigned" }, 403);
  const shopFilter: Record<string, unknown> = shopId ? { shopId } : {};

  try {
    const where: Record<string, unknown> = { ...shopFilter };
    if (!includeDeleted) (where as any).deletedAt = null;
    if (q) {
      (where as any).OR = [
        { name: { contains: qLower, mode: "insensitive" as const } },
        { phone: { contains: q } },
        // email search if q looks like email-ish; keep cheap
        { email: { contains: qLower, mode: "insensitive" as const } },
      ];
    }
    if (hasBalance === "with" || hasBalance === "true" || hasBalance === "due" || dueFilter === "true" || dueFilter === "1") {
      (where as any).balance = { gt: 0 };
    } else if (hasBalance === "without" || hasBalance === "false" || hasBalance === "no" || hasBalance === "nodue") {
      (where as any).balance = 0;
    }
    // activeWithinDays filter: ?activeWithinDays=30 or ?active=30
    const activeRaw = c.req.query("activeWithinDays") ?? c.req.query("activeWithin") ?? c.req.query("active");
    if (activeRaw) {
      const days = parseInt(String(activeRaw), 10);
      if (!isNaN(days) && days > 0 && days <= 365) {
        const since = new Date();
        since.setHours(0, 0, 0, 0);
        since.setDate(since.getDate() - days);
        (where as any).lastOrderAt = { gte: since };
        // also need deletedAt null already
      }
    }

    const orderBy: Record<string, unknown> = { [sortBy]: sortOrder };
    // secondary sort for stability
    const [items, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        orderBy,
        take: limit,
        skip: (page - 1) * limit,
      }),
      prisma.customer.count({ where }),
    ]);

    // stats for header cards (total non-deleted, active 30d, with dues)
    const now = new Date();
    const thirtyAgo = new Date(now);
    thirtyAgo.setDate(thirtyAgo.getDate() - 30);
    const [totalActive, withDuesAgg, withoutDuesCount, topSpender] = await Promise.all([
      includeDeleted ? Promise.resolve(total) : prisma.customer.count({ where: { ...shopFilter, deletedAt: null, lastOrderAt: { gte: thirtyAgo } } }),
      prisma.customer.aggregate({ where: { ...shopFilter, deletedAt: null, balance: { gt: 0 } }, _count: { _all: true }, _sum: { balance: true } }),
      prisma.customer.count({ where: { ...shopFilter, deletedAt: null, balance: 0 } }),
      prisma.customer.findFirst({ where: { ...shopFilter, deletedAt: null }, orderBy: { totalSpent: "desc" }, select: { id: true, name: true, totalSpent: true } }),
    ]);

    return c.json({
      customers: items,
      total,
      page,
      limit,
      stats: {
        totalCustomers: includeDeleted ? total : await prisma.customer.count({ where: { ...shopFilter, deletedAt: null } }),
        active30d: totalActive,
        withDues: { count: withDuesAgg._count._all, amount: withDuesAgg._sum.balance ?? 0 },
        withoutDues: withoutDuesCount,
        topSpender,
      },
    });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code, customers: [], total: 0, page: 1, limit }, appErr.status as 500 | 503);
  }
});

// GET /api/customers/stats  (must be before /:id)
customers.get("/stats", async (c) => {
  const { user, shopId } = getShopScope(c);
  if (!shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Shop not assigned" }, 403);
  const shopFilter: Record<string, unknown> = shopId ? { shopId } : {};
  try {
    const now = new Date();
    const ago30 = new Date(now); ago30.setDate(ago30.getDate() - 30);
    const [total, active30d, withDuesAgg, withoutDues, topSpenderList] = await Promise.all([
      prisma.customer.count({ where: { ...shopFilter, deletedAt: null } }),
      prisma.customer.count({ where: { ...shopFilter, deletedAt: null, lastOrderAt: { gte: ago30 } } }),
      prisma.customer.aggregate({ where: { ...shopFilter, deletedAt: null, balance: { gt: 0 } }, _count: { _all: true }, _sum: { balance: true } }),
      prisma.customer.count({ where: { ...shopFilter, deletedAt: null, balance: 0 } }),
      prisma.customer.findMany({ where: { ...shopFilter, deletedAt: null }, orderBy: { totalSpent: "desc" }, take: 5, select: { id: true, name: true, phone: true, totalSpent: true, totalOrders: true, balance: true } }),
    ]);
    return c.json({
      total,
      active30d,
      withDues: { count: withDuesAgg._count._all, amount: withDuesAgg._sum.balance ?? 0 },
      withoutDues,
      topSpenders: topSpenderList,
    });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code, total: 0 }, appErr.status as 500 | 503);
  }
});

// GET /api/customers/:id  — detail with computed stats + orders + ledger summary
customers.get("/:id", async (c) => {
  const id = c.req.param("id");
  const includeDeleted = c.req.query("includeDeleted") === "1";
  const ordersPage = Math.max(parseInt(c.req.query("ordersPage") ?? c.req.query("page") ?? "1", 10) || 1, 1);
  const ordersLimit = Math.min(parseInt(c.req.query("ordersLimit") ?? c.req.query("limit") ?? "10", 10) || 10, 50);
  const ledgerFilter = (c.req.query("ledgerFilter") ?? c.req.query("filter") ?? "all").toLowerCase();
  const { user: detailUser, shopId: detailShopId } = getShopScope(c);
  if (!detailShopId && detailUser.role !== "SUPER_ADMIN") return c.json({ error: "Shop not assigned" }, 403);

  try {
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: {
        orders: { orderBy: { createdAt: "desc" }, take: ordersLimit, skip: (ordersPage - 1) * ordersLimit, include: { items: true } },
        ledgerEntries: {
          where: ledgerFilter === "pending" ? { status: "pending" } : ledgerFilter === "settled" ? { status: "settled" } : undefined,
          orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
          take: 20,
          include: { order: { select: { id: true, orderNumber: true } } },
        },
      },
    });
    if (!customer) return c.json({ error: "Not found" }, 404);
    if (detailShopId && (customer as any).shopId !== detailShopId && detailUser.role !== "SUPER_ADMIN") {
      return c.json({ error: "Forbidden — customer belongs to another shop" }, 403);
    }
    if (!includeDeleted && (customer as any).deletedAt) return c.json({ error: "Customer has been deleted", deleted: true }, 410);

    const totalOrdersCount = await prisma.order.count({ where: { customerId: id } });
    const ledgerAgg = await prisma.ledgerEntry.aggregate({
      where: { customerId: id },
      _count: { _all: true },
      _sum: { amount: true },
    });
    const pendingAgg = await prisma.ledgerEntry.aggregate({
      where: { customerId: id, status: "pending" },
      _count: { _all: true },
      _sum: { amount: true },
    });
    const settledAgg = await prisma.ledgerEntry.aggregate({
      where: { customerId: id, status: "settled" },
      _count: { _all: true },
      _sum: { amount: true },
    });
    // overdue: pending where dueDate < today start
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const overdueAgg = await prisma.ledgerEntry.aggregate({
      where: { customerId: id, status: "pending", dueDate: { lt: todayStart } },
      _count: { _all: true },
      _sum: { amount: true },
    });

    const avgOrderValue = (customer.totalOrders && customer.totalOrders > 0) ? dec(customer.totalSpent) / customer.totalOrders : 0;
    const daysSinceLastOrder = customer.lastOrderAt
      ? Math.max(0, Math.floor((Date.now() - new Date(customer.lastOrderAt).getTime()) / (1000 * 60 * 60 * 24)))
      : null;
    const daysSinceFirstOrder = (customer as any).firstOrderAt
      ? Math.floor((Date.now() - new Date((customer as any).firstOrderAt).getTime()) / (1000 * 60 * 60 * 24))
      : null;

    // favourite category + top products for this customer (last 50 orders)
    let favoriteCategory: string | null = null;
    let topProducts: Array<{ name: string; qty: number; spent: number }> = [];
    try {
      const recentOrders = await prisma.order.findMany({
        where: { customerId: id },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { items: { select: { name: true, category: true, quantity: true, weight: true, lineTotal: true } } },
      });
      const catMap = new Map<string, number>();
      const prodMap = new Map<string, { qty: number; spent: number }>();
      for (const o of recentOrders) {
        for (const it of (o.items as any[])) {
          const cat = (it.category ?? "Uncategorized").trim() || "Uncategorized";
          catMap.set(cat, (catMap.get(cat) ?? 0) + Number(it.lineTotal));
          const key = it.name.trim();
          const q = it.weight != null && Number(it.weight) > 0 ? Number(it.weight) : (it.quantity != null ? Number(it.quantity) : 1);
          const cur = prodMap.get(key) ?? { qty: 0, spent: 0 };
          cur.qty += q;
          cur.spent += Number(it.lineTotal);
          prodMap.set(key, cur);
        }
      }
      let maxCat = 0;
      for (const [k, v] of catMap) if (v > maxCat) { maxCat = v; favoriteCategory = k; }
      topProducts = Array.from(prodMap.entries())
        .map(([name, v]) => ({ name, qty: Number(v.qty.toFixed(3)), spent: Number(v.spent.toFixed(2)) }))
        .sort((a, b) => b.spent - a.spent)
        .slice(0, 5);
    } catch {}

    return c.json({
      customer,
      ordersTotal: totalOrdersCount,
      ordersPage,
      ordersLimit,
      ledger: {
        total: { count: ledgerAgg._count._all, amount: ledgerAgg._sum.amount ?? 0 },
        pending: { count: pendingAgg._count._all, amount: pendingAgg._sum.amount ?? 0 },
        settled: { count: settledAgg._count._all, amount: settledAgg._sum.amount ?? 0 },
        overdue: { count: overdueAgg._count._all, amount: overdueAgg._sum.amount ?? 0 },
      },
      stats: {
        avgOrderValue,
        daysSinceLastOrder,
        daysSinceFirstOrder,
        favoriteCategory,
        topProducts,
      },
    });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 500 | 503);
  }
});

// POST /api/customers
customers.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const authUser = (c as any).get("user") as any;
    // OWNER/STAFF forced to own shop; SUPER_ADMIN must supply shopId
    let shopId: string | null =
      ((c as any).get("shopId") as string | null) ||
      authUser?.shopId ||
      (authUser?.role === "SUPER_ADMIN" ? body.shopId ? String(body.shopId) : c.req.query("shopId") : null) ||
      null;
    if (authUser?.role !== "SUPER_ADMIN") shopId = authUser?.shopId || null;
    if (!shopId) {
      return c.json({ error: authUser?.role === "SUPER_ADMIN" ? "shopId required for SUPER_ADMIN" : "Shop not assigned" }, authUser?.role === "SUPER_ADMIN" ? 400 : 403);
    }
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    if (!shop || (shop as any).deletedAt || !(shop as any).isActive) return c.json({ error: "Shop not found or inactive" }, 404);
    const { name, phone, balance, email, address, notes, creditLimit } = body;
    const trimmedName = String(name ?? "").trim();
    const trimmedPhone = normalizePhone(phone);
    const trimmedEmail = normalizeEmail(email);
    const trimmedAddress = address ? String(address).trim().slice(0, 500) : null;
    const trimmedNotes = notes ? String(notes).trim().slice(0, 1000) : null;
    const parsedCreditLimit = creditLimit != null && String(creditLimit).trim() !== "" ? parseMoney(creditLimit) : null;

    if (!trimmedName) return c.json({ error: "Customer name is required" }, 400);
    if (trimmedName.length > 80) return c.json({ error: "Name too long (max 80)" }, 400);
    if (trimmedPhone && !/^\d{10}$/.test(trimmedPhone)) {
      return c.json({ error: "Invalid phone — must be 10 digits" }, 400);
    }
    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      return c.json({ error: "Invalid email" }, 400);
    }
    if (parsedCreditLimit != null && (isNaN(parsedCreditLimit) || parsedCreditLimit < 0 || parsedCreditLimit > 1000000)) {
      return c.json({ error: "Invalid creditLimit (0 - 1000000)" }, 400);
    }

    if (trimmedPhone) {
      const existing = await prisma.customer.findFirst({ where: { shopId, phone: trimmedPhone, deletedAt: null } });
      if (existing) return c.json({ error: "Customer with this phone already exists", code: "PHONE_TAKEN", customer: existing }, 409);
    }

    // Never trust client balance — always 0, modulated via orders/ledger tx
    const customer = await prisma.customer.create({
      data: {
        shopId,
        name: trimmedName,
        phone: trimmedPhone || null,
        email: trimmedEmail,
        address: trimmedAddress,
        notes: trimmedNotes,
        creditLimit: parsedCreditLimit,
        balance: 0,
      },
    });

    return c.json({ customer }, 201);
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 409 | 500 | 503);
  }
});

// PATCH /api/customers/:id  — whitelist only name/phone/email/address/notes/creditLimit (+ restore via body)
customers.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const patchUser = (c as any).get("user") as any;
  const patchShopId = ((c as any).get("shopId") as string | null) || patchUser?.shopId || null;
  try {
    const body = await c.req.json();
    const pre = await prisma.customer.findUnique({ where: { id } });
    if (!pre) return c.json({ error: "Not found" }, 404);
    if (patchShopId && (pre as any).shopId !== patchShopId && patchUser?.role !== "SUPER_ADMIN") {
      return c.json({ error: "Forbidden — customer belongs to another shop" }, 403);
    }
    // restore action via body
    if (body.action === "restore" || body.restore === true) {
      const exists = pre;
      if (!exists) return c.json({ error: "Not found" }, 404);
      if (!(exists as any).deletedAt) return c.json({ customer: exists, message: "Already active" });
      if ((exists as any).phone) {
        const clash = await prisma.customer.findFirst({
          where: { shopId: (exists as any).shopId, phone: (exists as any).phone, deletedAt: null },
        });
        if (clash && clash.id !== id) {
          return c.json({ error: "Phone already used by another active customer", code: "PHONE_TAKEN", customer: clash }, 409);
        }
      }
      const restored = await prisma.customer.update({ where: { id }, data: { deletedAt: null } });
      return c.json({ customer: restored });
    }

    const allowed: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const n = String(body.name).trim();
      if (!n) return c.json({ error: "Name cannot be empty" }, 400);
      if (n.length > 80) return c.json({ error: "Name too long" }, 400);
      allowed.name = n;
    }
    if (body.phone !== undefined) {
      const raw = normalizePhone(body.phone);
      if (raw && !/^\d{10}$/.test(raw)) return c.json({ error: "Invalid phone" }, 400);
      if (raw) {
        const dup = await prisma.customer.findFirst({ where: { shopId: (pre as any).shopId, phone: raw, deletedAt: null } });
        if (dup && dup.id !== id) return c.json({ error: "Phone already used by another customer", code: "PHONE_TAKEN", customer: dup }, 409);
      }
      allowed.phone = raw;
    }
    if (body.email !== undefined) {
      const e = normalizeEmail(body.email);
      if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return c.json({ error: "Invalid email" }, 400);
      allowed.email = e;
    }
    if (body.address !== undefined) {
      const a = body.address == null || String(body.address).trim() === "" ? null : String(body.address).trim().slice(0, 500);
      allowed.address = a;
    }
    if (body.notes !== undefined) {
      const n = body.notes == null || String(body.notes).trim() === "" ? null : String(body.notes).trim().slice(0, 1000);
      allowed.notes = n;
    }
    if (body.creditLimit !== undefined) {
      if (body.creditLimit == null || String(body.creditLimit).trim() === "") allowed.creditLimit = null;
      else {
        const v = parseMoney(body.creditLimit);
        if (isNaN(v) || v < 0 || v > 1000000) return c.json({ error: "Invalid creditLimit (max 2 decimals)" }, 400);
        allowed.creditLimit = v;
      }
    }
    // block direct mutation of denormalized fields — fail closed instead of silently ignoring
    const blocked = ["balance", "totalSpent", "totalOrders", "lastOrderAt", "firstOrderAt", "deletedAt", "createdAt", "updatedAt", "id", "shopId", "shop"];
    const blockedHit = blocked.filter((k) => k in body);
    if (blockedHit.length > 0) {
      return c.json({ error: `Cannot update ${blockedHit.join(", ")} directly`, code: "IMMUTABLE_FIELD" }, 400);
    }

    if (Object.keys(allowed).length === 0) return c.json({ error: "No valid fields to update" }, 400);

    const existing = pre;
    if ((existing as any).deletedAt) return c.json({ error: "Customer is deleted — restore first" }, 410);

    const customer = await prisma.customer.update({ where: { id }, data: allowed });
    return c.json({ customer });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 500 | 503);
  }
});

// DELETE /api/customers/:id  — soft delete only
customers.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const delUser = (c as any).get("user") as any;
  const delShopId = ((c as any).get("shopId") as string | null) || delUser?.shopId || null;
  try {
    const existing = await prisma.customer.findUnique({ where: { id } });
    if (!existing) return c.json({ error: "Not found" }, 404);
    if (delShopId && (existing as any).shopId !== delShopId && delUser?.role !== "SUPER_ADMIN") {
      return c.json({ error: "Forbidden — customer belongs to another shop" }, 403);
    }
    if ((existing as { deletedAt?: Date | null }).deletedAt) return c.json({ error: "Already deleted", customer: existing }, 409);
    const customer = await prisma.customer.update({ where: { id }, data: { deletedAt: new Date() } });
    return c.json({ customer, softDeleted: true });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 500 | 503);
  }
});

// POST /api/customers/:id/restore
customers.post("/:id/restore", async (c) => {
  const id = c.req.param("id");
  const resUser = (c as any).get("user") as any;
  const resShopId = ((c as any).get("shopId") as string | null) || resUser?.shopId || null;
  try {
    const existing = await prisma.customer.findUnique({ where: { id } });
    if (!existing) return c.json({ error: "Not found" }, 404);
    if (resShopId && (existing as any).shopId !== resShopId && resUser?.role !== "SUPER_ADMIN") {
      return c.json({ error: "Forbidden — customer belongs to another shop" }, 403);
    }
    if (!(existing as { deletedAt?: Date | null }).deletedAt) return c.json({ customer: existing, message: "Already active" });
    if ((existing as any).phone) {
      const clash = await prisma.customer.findFirst({
        where: { shopId: (existing as any).shopId, phone: (existing as any).phone, deletedAt: null },
      });
      if (clash && clash.id !== id) {
        return c.json({ error: "Phone already used by another active customer", code: "PHONE_TAKEN", customer: clash }, 409);
      }
    }
    const customer = await prisma.customer.update({ where: { id }, data: { deletedAt: null } });
    return c.json({ customer });
  } catch (e) {
    const appErr = toAppError(e);
    if (appErr.code === "CONFLICT") return c.json({ error: "Phone already used by another active customer", code: "PHONE_TAKEN" }, 409);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 500 | 503);
  }
});

export default customers;
