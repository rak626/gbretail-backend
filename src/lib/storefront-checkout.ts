// Server-side cart resolution for POST /api/store/orders.
// Each line resolves against the ShopProduct catalog first — the storefront
// listing serves ShopProduct ids — and falls back to the legacy Product row
// so older carts keep working. Validation messages/codes and price precedence
// mirror gbretail-catalog's OnlineStoreService (shopProductLine / legacyLine)
// so monolith and microservice stay behaviourally equal.
import { prisma } from "./prisma.js";
import { round2, dec, MAX_MONEY } from "./money.js";
import { AppError } from "./errors.js";

type LineBase = { ref: string; qty: number; unitPrice: number; lineTotal: number };

/** A validated cart line: `ref` is the row id that owns the stock. */
export type CheckoutLine = LineBase &
  ({ kind: "shop"; sp: any; mp: any } | { kind: "legacy"; p: any });

export type ResolvedCart = { lines: CheckoutLine[]; gross: number };

/** Legacy price precedence: onlinePrice ?? price ?? rate_per_kg (NaN when none). */
function effectivePrice(p: any): number {
  const online = p.onlinePrice != null ? dec(p.onlinePrice) : NaN;
  if (!isNaN(online) && online >= 0) return round2(online);
  if (p.price != null) return round2(dec(p.price));
  if (p.rate_per_kg != null) return round2(dec(p.rate_per_kg));
  return NaN;
}

/** ShopProduct price precedence: onlinePrice ?? shopPrice ?? master basePrice. */
function shopProductPrice(sp: any, mp: any): number {
  if (sp.onlinePrice != null) return round2(dec(sp.onlinePrice));
  if (sp.shopPrice != null) return round2(dec(sp.shopPrice));
  if (mp.basePrice != null) return round2(dec(mp.basePrice));
  return NaN;
}

function validPrice(unitPrice: number, name: string): number {
  if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > MAX_MONEY) {
    throw new AppError(409, `Bad price: ${name}`);
  }
  return unitPrice;
}

function shopLine(shopId: string, sp: any, qty: number): CheckoutLine {
  if (sp.deletedAt) throw new AppError(409, "Product not available", "PRODUCT_UNAVAILABLE");
  if (sp.shopId !== shopId) throw new AppError(403, "Product belongs to another shop");
  const mp = sp.masterProduct;
  const name = mp?.name ?? sp.id;
  if (!sp.isEnabled) throw new AppError(409, `Not enabled at this shop: ${name}`, "NOT_ENABLED");
  if (!sp.isOnline) throw new AppError(409, `Not available online: ${name}`, "NOT_ONLINE");
  if (!mp || !mp.isActive || mp.deletedAt) throw new AppError(409, `Product not active: ${name}`, "NOT_ACTIVE");
  const unitPrice = validPrice(shopProductPrice(sp, mp), name);
  return { kind: "shop", ref: sp.id, sp, mp, qty, unitPrice, lineTotal: round2(unitPrice * qty) };
}

function legacyLine(shopId: string, it: any, pById: Map<string, any>, qty: number): CheckoutLine {
  const pid = String(it.productId ?? it.shopProductId ?? "");
  const p: any = pById.get(pid);
  if (!p || p.deletedAt) throw new AppError(409, "Product not available", "PRODUCT_UNAVAILABLE");
  if (p.shopId !== shopId) throw new AppError(403, "Product belongs to another shop");
  if (!p.isOnline) throw new AppError(409, `Not available online: ${p.name}`, "NOT_ONLINE");
  const unitPrice = validPrice(effectivePrice(p), p.name);
  return { kind: "legacy", ref: p.id, p, qty, unitPrice, lineTotal: round2(unitPrice * qty) };
}

/**
 * Validates every cart line and computes prices server-side.
 * Throws AppError (400/403/409) — the route's catch maps it to the envelope.
 */
export async function resolveCheckoutLines(items: any[], shopId: string): Promise<ResolvedCart> {
  const refs = items.map((it) => String(it?.shopProductId ?? it?.productId ?? ""));
  if (refs.some((r) => !r) || new Set(refs).size !== items.length) {
    throw new AppError(400, "Duplicate productId in items");
  }
  const spIds = [...new Set(items.map((it) => (it.shopProductId ? String(it.shopProductId) : "")).filter(Boolean))];
  const pIds = [...new Set(items.map((it) => (it.productId ? String(it.productId) : "")).filter(Boolean))];
  const [dbSp, dbProds] = await Promise.all([
    prisma.shopProduct.findMany({ where: { id: { in: spIds } }, include: { masterProduct: true } }),
    prisma.product.findMany({ where: { id: { in: pIds } } }),
  ]);
  const spById = new Map<string, any>(dbSp.map((s: any) => [s.id, s]));
  const pById = new Map<string, any>(dbProds.map((p: any) => [p.id, p]));

  const lines: CheckoutLine[] = [];
  let gross = 0;
  for (const it of items) {
    const qty = Number(it.qty ?? it.quantity ?? it.weight ?? 0);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 999) throw new AppError(400, "Invalid qty for item");
    const sp = it.shopProductId ? spById.get(String(it.shopProductId)) : undefined;
    const line = sp ? shopLine(shopId, sp, qty) : legacyLine(shopId, it, pById, qty);
    gross = round2(gross + line.lineTotal);
    lines.push(line);
  }
  return { lines, gross };
}
