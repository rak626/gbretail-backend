import { Hono } from "hono";
import { getShopScope } from "../lib/shopScope.js";
import { prisma } from "../lib/prisma.js";
import { addDays, endOfDay, startOfDay, computeDueDate } from "../lib/utils.js";
import { normalizePhone, parseCreditDays, normalizeCreditTerm } from "../lib/normalize.js";
import { toAppError } from "../lib/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { parseMoney, MAX_MONEY } from "../lib/money.js";
import { getIdempotencyKey, isValidIdempotencyKey, fingerprint } from "../lib/idempotency.js";

const ledger = new Hono();

ledger.use("*", requireAuth as any);

// GET /api/ledger/due-today?q&includeOverdue  (must be before /:id)
ledger.get("/due-today", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  const includeOverdue = c.req.query("includeOverdue") === "1" || c.req.query("overdue") === "1";
  const { user, shopId } = getShopScope(c);
  if (!shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Shop not assigned" }, 403);

  try {
    const todayStart = startOfDay(new Date());
    const todayEnd = endOfDay(new Date());

    const where: Record<string, unknown> = {
      status: "pending" as const,
      deletedAt: null,
    };
    if (shopId) (where as any).shopId = shopId;

    if (includeOverdue) {
      (where as Record<string, unknown>).dueDate = { lte: todayEnd };
    } else {
      (where as Record<string, unknown>).dueDate = { gte: todayStart, lte: todayEnd };
    }

    if (q) {
      const customers = await prisma.customer.findMany({
        where: {
          ...(shopId ? { shopId } : {}),
          deletedAt: null,
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { phone: { contains: q } },
          ],
        },
        select: { id: true },
        take: 50,
      });
      const ids = customers.map((x: { id: string }) => x.id);
      if (ids.length === 0) return c.json({ entries: [], total: 0, count: 0, amount: 0 });
      (where as Record<string, unknown>).customerId = { in: ids };
    }

    const [entries, agg] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where: where as any,
        include: { customer: { select: { id: true, name: true, phone: true, balance: true } }, order: { select: { id: true, orderNumber: true } }, shop: { select: { id: true, name: true } }, counter: { select: { id: true, name: true } } },
        orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
        take: 100,
      }),
      prisma.ledgerEntry.aggregate({ where: where as any, _count: { _all: true }, _sum: { amount: true } }),
    ]);

    return c.json({ entries, total: agg._count._all, count: agg._count._all, amount: agg._sum.amount ?? 0 });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code, entries: [], total: 0 }, 500);
  }
});

// GET /api/ledger?filter&q&customerId&page&limit&due
// Pagination: legacy ?page (deprecated) OR ?cursor → { nextCursor }
// (cursor mode uses createdAt desc and skips header stats for speed).
ledger.get("/", async (c) => {
  const rawLimit = parseInt(c.req.query("limit") ?? "50", 10);
  const limit = isNaN(rawLimit) ? 50 : Math.min(rawLimit, 100);
  const rawPage = parseInt(c.req.query("page") ?? "1", 10);
  const page = isNaN(rawPage) ? 1 : Math.max(rawPage, 1);
  const filter = (c.req.query("filter") ?? "all").toLowerCase();
  const q = (c.req.query("q") ?? "").trim();
  const customerId = c.req.query("customerId") ?? "";
  const dueToday = c.req.query("due") === "today" || filter === "duetoday" || filter === "due_today" || filter === "due-today";
  const { user, shopId } = getShopScope(c);
  if (!shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Shop not assigned" }, 403);

  try {
    const where: Record<string, unknown> = { deletedAt: null };
    if (shopId) (where as any).shopId = shopId;

    if (customerId) where.customerId = customerId;

    if (filter === "pending") where.status = "pending";
    else if (filter === "settled") where.status = "settled";
    else if (filter === "overdue") {
      const nowStart = startOfDay(new Date());
      where.status = "pending";
      (where as Record<string, unknown>).dueDate = { lt: nowStart };
    } else if (dueToday) {
      const todayStart = startOfDay(new Date());
      const todayEnd = endOfDay(new Date());
      where.status = "pending";
      (where as Record<string, unknown>).dueDate = { gte: todayStart, lte: todayEnd };
    }

    let idsFromSearch: string[] | null = null;
    if (q) {
      const customers = await prisma.customer.findMany({
        where: {
          ...(shopId ? { shopId } : {}),
          deletedAt: null,
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { phone: { contains: q } },
          ],
        },
        select: { id: true },
        take: 50,
      });
      idsFromSearch = customers.map((x: { id: string }) => x.id);
      if (idsFromSearch!.length === 0) {
        return c.json({ entries: [], total: 0, page, limit, stats: { dueToday: { count: 0, amount: 0 }, overdue: { count: 0, amount: 0 }, pending: { count: 0, amount: 0 } } });
      }
      (where as Record<string, unknown>).customerId = { in: idsFromSearch };
    }

    const cursorParamEarly = c.req.query("cursor") ?? null;
    if (cursorParamEarly) {
      const { decodeCursor: ldc, encodeCursor: lec, cursorWhere: lcw } = await import("../lib/pagination.js");
      const dec0 = ldc(cursorParamEarly);
      if (!dec0) return c.json({ error: "Invalid cursor", code: "INVALID_CURSOR" }, 400);
      const rows = await prisma.ledgerEntry.findMany({
        where: { AND: [where, lcw(dec0)] } as any,
        include: { customer: { select: { id: true, name: true, phone: true, balance: true } }, order: { select: { id: true, orderNumber: true, total: true } }, shop: { select: { id: true, name: true } }, counter: { select: { id: true, name: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
      });
      const hasMore = rows.length > limit;
      const page0 = hasMore ? rows.slice(0, limit) : rows;
      const last: any = page0[page0.length - 1];
      return c.json({ entries: page0, nextCursor: hasMore && last ? lec(last.createdAt, last.id) : null, limit });
    }

    const [entries, total] = await Promise.all([
      prisma.ledgerEntry.findMany({
        where: where as any,
        include: { customer: { select: { id: true, name: true, phone: true, balance: true } }, order: { select: { id: true, orderNumber: true, total: true } }, shop: { select: { id: true, name: true } }, counter: { select: { id: true, name: true } } },
        orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
        take: limit,
        skip: (page - 1) * limit,
      }),
      prisma.ledgerEntry.count({ where: where as any }),
    ]);

    const todayStart = startOfDay(new Date());
    const todayEnd = endOfDay(new Date());
    const shopFilter: Record<string, unknown> = shopId ? { shopId } : {};
    const [dueTodayAgg, overdueAgg, pendingAgg] = await Promise.all([
      prisma.ledgerEntry.aggregate({ where: { status: "pending", deletedAt: null, dueDate: { gte: todayStart, lte: todayEnd }, ...shopFilter } as any, _count: { _all: true }, _sum: { amount: true } }),
      prisma.ledgerEntry.aggregate({ where: { status: "pending", deletedAt: null, dueDate: { lt: todayStart }, ...shopFilter } as any, _count: { _all: true }, _sum: { amount: true } }),
      prisma.ledgerEntry.aggregate({ where: { status: "pending", deletedAt: null, ...shopFilter } as any, _count: { _all: true }, _sum: { amount: true } }),
    ]);

    return c.json({
      entries,
      total,
      page,
      limit,
      stats: {
        dueToday: { count: dueTodayAgg._count._all, amount: dueTodayAgg._sum.amount ?? 0 },
        overdue: { count: overdueAgg._count._all, amount: overdueAgg._sum.amount ?? 0 },
        pending: { count: pendingAgg._count._all, amount: pendingAgg._sum.amount ?? 0 },
      },
    });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code, entries: [], total: 0 }, 500);
  }
});

// POST /api/ledger
ledger.post("/", async (c) => {
  let ledgerIdemKey: string | null = null;
  let ledgerFingerprint: string | null = null;
  let findIdempotentEntry: (() => Promise<unknown>) | null = null;
  try {
    const body = await c.req.json();
    const user = (c as any).get("user") as any;
    const { shopId: ctxShop } = getShopScope(c);
    let shopId: string | null = ctxShop ?? user?.shopId ?? null;
    // Only SUPER_ADMIN may target another shop via body.shopId — OWNER/STAFF pinned.
    if (user.role === "SUPER_ADMIN" && (body as any).shopId) shopId = String((body as any).shopId);
    if (!shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Shop not assigned" }, 403);
    if (user.role === "SUPER_ADMIN" && !shopId) return c.json({ error: "shopId required" }, 400);
    if (shopId) {
      const shop = await prisma.shop.findUnique({ where: { id: shopId } });
      if (!shop || (shop as any).deletedAt) return c.json({ error: "Shop not found" }, 404);
    }
    // Counter: STAFF always re-resolved fresh (never trust JWT/body — prevents stale/forged attribution).
    // OWNER/SUPER: explicit body.counterId validated, else first active counter.
    let counterId: string | null = null;
    if (user.role === "STAFF") {
      const { resolveStaffCounter } = await import("../lib/staffCounter.js");
      const sc = await resolveStaffCounter(user.userId, shopId!);
      if (!sc) return c.json({ error: "No counter assigned — contact owner" }, 403);
      counterId = sc.id;
    } else {
      counterId = (body as any).counterId ? String((body as any).counterId) : null;
    }
    // validate counter belongs to shop if provided
    if (counterId) {
      const counter = await prisma.counter.findUnique({ where: { id: counterId } });
      if (!counter || (counter as any).deletedAt || !(counter as any).isActive) return c.json({ error: "Counter not found or inactive" }, 404);
      if ((counter as any).shopId !== shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Counter does not belong to shop" }, 403);
    } else {
      // auto-pick first counter if available
      const first = await prisma.counter.findFirst({ where: { shopId: shopId!, deletedAt: null, isActive: true } });
      if (first) counterId = first.id;
    }

    const { customerId, customerName, customerPhone, amount, creditDays, customDays, note, orderId } = body;

    const parsedAmount = parseMoney(amount);
    if (!parsedAmount || isNaN(parsedAmount) || parsedAmount <= 0) {
      return c.json({ error: "Valid amount required (>0, max 2 decimals)" }, 400);
    }
    if (parsedAmount > 1000000) return c.json({ error: "Amount too large (max 10,00,000)" }, 400);

    const days = parseCreditDays(creditDays ?? customDays ?? (body as Record<string, unknown>).creditTerm ?? 30);
    const effectiveDays = normalizeCreditTerm(body as Record<string, unknown>, days);

    let resolvedCustomerId = customerId ? String(customerId) : null;

    if (!resolvedCustomerId) {
      const name = customerName ? String(customerName).trim() : "";
      const phone = normalizePhone(customerPhone);

      if (!name && !phone) {
        return c.json({ error: "Customer name or phone required" }, 400);
      }

      if (phone && !/^\d{10}$/.test(phone)) return c.json({ error: "Invalid phone — must be 10 digits" }, 400);

      if (phone) {
        const existing = await prisma.customer.findFirst({ where: { shopId: shopId!, phone } });
        if (existing) {
          if ((existing as any).deletedAt) return c.json({ error: "Customer is deleted — restore first" }, 410);
          resolvedCustomerId = existing.id;
        } else {
          const created = await prisma.customer.create({
            data: {
              shopId: shopId!,
              name: name || `Customer ${phone.slice(-4)}`,
              phone,
              balance: 0,
            },
          });
          resolvedCustomerId = created.id;
        }
      } else if (name) {
        const created = await prisma.customer.create({
          data: {
            shopId: shopId!,
            name,
            balance: 0,
          },
        });
        resolvedCustomerId = created.id;
      }
    } else {
      const exists = await prisma.customer.findUnique({ where: { id: resolvedCustomerId } });
      if (!exists || (exists as any).deletedAt) return c.json({ error: "Customer not found" }, 404);
      if ((exists as any).shopId !== shopId && user.role !== "SUPER_ADMIN") {
        return c.json({ error: "Customer belongs to another shop" }, 403);
      }
    }

    const orderRef = orderId ? String(orderId) : null;
    if (orderRef) {
      const o = await prisma.order.findUnique({ where: { id: orderRef } });
      if (!o || (o as any).deletedAt) return c.json({ error: "Order not found for orderId" }, 404);
      if (shopId && (o as any).shopId && (o as any).shopId !== shopId) return c.json({ error: "Order belongs to different shop" }, 403);
    }

    const dueDateNormalized = computeDueDate(effectiveDays);

    // Idempotency: same key + same due -> return original; same key + different due -> 422.
    ledgerIdemKey = getIdempotencyKey(c, body as Record<string, unknown>);
    if (ledgerIdemKey && !isValidIdempotencyKey(ledgerIdemKey)) {
      return c.json({ error: "Invalid Idempotency-Key (8-128 chars: A-Z a-z 0-9 _ -)", code: "INVALID_IDEMPOTENCY_KEY" }, 400);
    }
    ledgerFingerprint = ledgerIdemKey
      ? fingerprint({
          amount: parsedAmount,
          customer: resolvedCustomerId ?? `${normalizePhone(customerPhone) || ""}|${customerName ? String(customerName).trim() : ""}`,
          orderId: orderRef,
          creditDays: effectiveDays,
          note: note ? String(note).trim().slice(0, 300) : null,
          counterId,
        })
      : null;
    findIdempotentEntry = async () => {
      if (!ledgerIdemKey) return null;
      return prisma.ledgerEntry.findFirst({
        where: { shopId: shopId!, idempotencyKey: ledgerIdemKey },
        include: { customer: { select: { id: true, name: true, phone: true, balance: true } }, order: { select: { id: true, orderNumber: true } } },
      });
    };
    if (ledgerIdemKey) {
      const dup = (await findIdempotentEntry()) as any;
      if (dup) {
        if ((dup as any).deletedAt) return c.json({ error: "Duplicate — this entry was already deleted", code: "IDEMPOTENT_REPLAY_VOIDED" }, 409);
        if ((dup as any).idempotencyFingerprint && (dup as any).idempotencyFingerprint !== ledgerFingerprint) {
          return c.json({ error: "Idempotency-Key already used for a different entry", code: "IDEMPOTENCY_KEY_REUSED" }, 422);
        }
        const customer = await prisma.customer.findUnique({ where: { id: (dup as any).customerId }, select: { id: true, name: true, phone: true, balance: true } });
        return c.json({ entry: { ...dup, customer }, idempotentReplay: true });
      }
    }

    // Transaction: ledger + balance increment + shop/counter/user tracking
    // Credit-limit enforced here (inside tx to avoid check-then-act race).
    const entry = await prisma.$transaction(async (tx) => {
      const cust = await tx.customer.findUnique({ where: { id: resolvedCustomerId! }, select: { balance: true, creditLimit: true } });
      if (!cust) throw new (await import("../lib/errors.js")).AppError(404, "Customer not found");
      const canOverride = (body as any)?.overrideLimit === true && (user.role === "SHOP_OWNER" || user.role === "SUPER_ADMIN");
      if (!canOverride && (cust as any).creditLimit != null) {
        const { dec: decMoney } = await import("../lib/money.js");
        const bal = decMoney((cust as any).balance);
        const lim = decMoney((cust as any).creditLimit);
        if (bal + parsedAmount > lim) {
          throw new (await import("../lib/errors.js")).AppError(422, `Credit limit exceeded (balance ${bal.toFixed(2)} + due ${parsedAmount.toFixed(2)} > limit ${lim.toFixed(2)})`, "CREDIT_LIMIT_EXCEEDED");
        }
      }
      const e = await tx.ledgerEntry.create({
        data: {
          shopId: shopId!,
          counterId,
          userId: user.userId,
          customerId: resolvedCustomerId!,
          orderId: orderRef,
          amount: parsedAmount,
          creditDays: effectiveDays,
          dueDate: dueDateNormalized,
          status: "pending",
          note: note ? String(note).trim().slice(0, 300) : null,
          ...(ledgerIdemKey ? { idempotencyKey: ledgerIdemKey, idempotencyFingerprint: ledgerFingerprint } : {}),
        },
        include: { customer: { select: { id: true, name: true, phone: true, balance: true } }, order: { select: { id: true, orderNumber: true } } },
      });
      await tx.customer.update({
        where: { id: resolvedCustomerId! },
        data: { balance: { increment: parsedAmount } },
      });
      return e;
    });

    const updatedCustomer = await prisma.customer.findUnique({ where: { id: resolvedCustomerId! }, select: { id: true, name: true, phone: true, balance: true } });

    return c.json({ entry: { ...entry, customer: updatedCustomer } }, 201);
  } catch (e) {
    // Race fallback: same-key concurrent posts — return the winner (see orders.ts).
    if (ledgerIdemKey) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes("P2002") || msg.includes("Unique constraint") || msg.includes("idempotency")) {
        try {
          const winner = (await findIdempotentEntry!()) as any;
          if (winner && !(winner as any).deletedAt) {
            if ((winner as any).idempotencyFingerprint && (winner as any).idempotencyFingerprint !== ledgerFingerprint) {
              return c.json({ error: "Idempotency-Key already used for a different entry", code: "IDEMPOTENCY_KEY_REUSED" }, 422);
            }
            const customer = await prisma.customer.findUnique({ where: { id: (winner as any).customerId }, select: { id: true, name: true, phone: true, balance: true } });
            return c.json({ entry: { ...winner, customer }, idempotentReplay: true });
          }
        } catch {
          // fall through to normal error
        }
      }
    }
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 409 | 422 | 500 | 503);
  }
});

// GET /api/ledger/:id
ledger.get("/:id", async (c) => {
  const id = c.req.param("id");
  const { user, shopId } = getShopScope(c);
  try {
    const entry = await prisma.ledgerEntry.findUnique({
      where: { id },
      include: { customer: { select: { id: true, name: true, phone: true, balance: true } }, order: { select: { id: true, orderNumber: true, total: true } }, shop: { select: { id: true, name: true } }, counter: { select: { id: true, name: true } } },
    });
    if (!entry || (entry as any).deletedAt) return c.json({ error: "Not found" }, 404);
    if (shopId && (entry as any).shopId && (entry as any).shopId !== shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Forbidden" }, 403);
    return c.json({ entry });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, 500);
  }
});

// PATCH /api/ledger/:id {action: settle|reopen}
ledger.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const { user, shopId } = getShopScope(c);
  try {
    const body = await c.req.json().catch(() => ({}));
    const action = (body.action ?? "settle").toLowerCase();

    const entry = await prisma.ledgerEntry.findUnique({ where: { id }, include: { customer: true } });
    if (!entry || (entry as any).deletedAt) return c.json({ error: "Ledger entry not found" }, 404);
    if (shopId && (entry as any).shopId && (entry as any).shopId !== shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Forbidden" }, 403);

    if (action === "settle" || action === "paid" || action === "collect") {
      if (entry.status === "settled") {
        return c.json({ entry, message: "Already settled" });
      }
      // Idempotent conditional transition: only pending -> settled decrements balance once.
      // Negative balances are allowed (overpay = advance) and surfaced to the UI.
      const result = await prisma.$transaction(async (tx) => {
        const upd = await tx.ledgerEntry.updateMany({
          where: { id, status: "pending", deletedAt: null },
          data: { status: "settled", settledAt: new Date() },
        });
        if (upd.count === 0) {
          const fresh = await tx.ledgerEntry.findUnique({
            where: { id },
            include: { customer: { select: { id: true, name: true, phone: true, balance: true } }, order: { select: { id: true, orderNumber: true } } },
          });
          return { updated: fresh, finalCustomer: (fresh as any)?.customer ?? null, already: true };
        }
        await tx.customer.update({
          where: { id: entry.customerId },
          data: { balance: { decrement: entry.amount } },
        });
        const updated = await tx.ledgerEntry.findUnique({
          where: { id },
          include: { customer: { select: { id: true, name: true, phone: true, balance: true } }, order: { select: { id: true, orderNumber: true } } },
        });
        const finalCustomer = await tx.customer.findUnique({ where: { id: entry.customerId }, select: { id: true, name: true, phone: true, balance: true } });
        return { updated, finalCustomer, already: false };
      });
      if ((result as any).already) return c.json({ entry: (result as any).updated, message: "Already settled" });
      return c.json({ entry: { ...(result as any).updated, customer: (result as any).finalCustomer } });
    }

    if (action === "reopen" || action === "undo") {
      if (entry.status !== "settled") {
        return c.json({ error: "Only settled entries can be reopened" }, 400);
      }
      // Idempotent conditional transition: only settled -> pending increments balance once.
      const result = await prisma.$transaction(async (tx) => {
        const upd = await tx.ledgerEntry.updateMany({
          where: { id, status: "settled", deletedAt: null },
          data: { status: "pending", settledAt: null },
        });
        if (upd.count === 0) {
          const fresh = await tx.ledgerEntry.findUnique({
            where: { id },
            include: { customer: { select: { id: true, name: true, phone: true, balance: true } } },
          });
          return { updated: fresh, finalCustomer: (fresh as any)?.customer ?? null, already: true };
        }
        await tx.customer.update({ where: { id: entry.customerId }, data: { balance: { increment: entry.amount } } });
        const updated = await tx.ledgerEntry.findUnique({
          where: { id },
          include: { customer: { select: { id: true, name: true, phone: true, balance: true } } },
        });
        const finalCustomer = await tx.customer.findUnique({ where: { id: entry.customerId }, select: { id: true, name: true, phone: true, balance: true } });
        return { updated, finalCustomer, already: false };
      });
      return c.json({ entry: { ...(result as any).updated, customer: (result as any).finalCustomer } });
    }

    return c.json({ error: "Unknown action. Use settle or reopen" }, 400);
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, 500);
  }
});

// DELETE /api/ledger/:id — transactional soft delete (idempotent, allows negative balance)
ledger.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const { user, shopId } = getShopScope(c);
  try {
    const entry = await prisma.ledgerEntry.findUnique({ where: { id } });
    if (!entry || (entry as any).deletedAt) return c.json({ error: "Not found" }, 404);
    if (shopId && (entry as any).shopId && (entry as any).shopId !== shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Forbidden" }, 403);
    await prisma.$transaction(async (tx) => {
      const upd = await tx.ledgerEntry.updateMany({
        where: { id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (upd.count === 0) return;
      if (entry.status === "pending") {
        // Negative allowed (over-delete = advance); no clamp to 0.
        await tx.customer.update({ where: { id: entry.customerId }, data: { balance: { decrement: entry.amount } } });
      }
    });
    return c.json({ success: true, softDeleted: true });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 404 | 500 | 503);
  }
});

// POST /api/ledger/:id/restore (idempotent — re-increments only once)
ledger.post("/:id/restore", async (c) => {
  const id = c.req.param("id");
  const { user, shopId } = getShopScope(c);
  try {
    const entry = await prisma.ledgerEntry.findUnique({ where: { id } });
    if (!entry) return c.json({ error: "Not found" }, 404);
    if (!(entry as any).deletedAt) return c.json({ entry, message: "Already active" });
    if (shopId && (entry as any).shopId && (entry as any).shopId !== shopId && user.role !== "SUPER_ADMIN") return c.json({ error: "Forbidden" }, 403);
    // restore also re-increment balance if pending — conditional so double-restore can't double-count
    await prisma.$transaction(async (tx) => {
      const upd = await tx.ledgerEntry.updateMany({ where: { id, deletedAt: { not: null } }, data: { deletedAt: null } });
      if (upd.count === 0) return;
      if (entry.status === "pending") {
        await tx.customer.update({ where: { id: entry.customerId }, data: { balance: { increment: entry.amount } } });
      }
    });
    const restored = await prisma.ledgerEntry.findUnique({ where: { id }, include: { customer: { select: { id: true, name: true, phone: true, balance: true } } } });
    return c.json({ entry: restored });
  } catch (e) {
    const appErr = toAppError(e);
    return c.json({ error: appErr.message, code: appErr.code }, 500);
  }
});

export default ledger;
