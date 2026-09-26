// Exact-money helpers. DB stores NUMERIC(12,2); API speaks plain numbers rounded to 2dp.
// Quantities (stock/weight/qty) are NUMERIC(12,3) in DB, plain numbers on the API.

export function round2(n: number): number {
  if (typeof n !== "number" || !isFinite(n)) return NaN;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Parse + round an incoming money value. Returns NaN when invalid.
export function parseMoney(v: unknown): number {
  const n = typeof v === "string" ? Number(v.trim()) : Number(v as number);
  if (typeof n !== "number" || !isFinite(n)) return NaN;
  return round2(n);
}

// Prisma Decimal (or string/number) -> number for JSON responses + arithmetic.
export function dec(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  const d = v as { toNumber?: () => number };
  if (typeof d.toNumber === "function") {
    try {
      return d.toNumber();
    } catch {
      return Number(String(v));
    }
  }
  return Number(v as number);
}

export const MAX_MONEY = 10000000; // 1 crore cap per field
