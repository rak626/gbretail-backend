// Central normalization & validation helpers — DRY for phone/email/dueDays

export function normalizePhone(raw: unknown): string | null {
  if (raw == null || String(raw).trim() === "") return null;
  const digits = String(raw).trim().replace(/\D/g, "").slice(0, 10);
  return digits || null;
}

export function validatePhone(phone: string | null): boolean {
  if (!phone) return true; // optional
  return /^\d{10}$/.test(phone);
}

export function normalizeEmail(raw: unknown): string | null {
  if (raw == null || String(raw).trim() === "") return null;
  return String(raw).trim().slice(0, 120).toLowerCase();
}

export function validateEmail(email: string | null): boolean {
  if (!email) return true;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function parseCreditDays(input: unknown, fallback = 30): number {
  let days = Number(input);
  if (isNaN(days) || days <= 0) {
    // also check alternative fields like body.creditTerm handled by caller
    days = fallback;
  }
  days = Math.round(days);
  if (days < 1) days = 1;
  if (days > 365) days = 365;
  return days;
}

export function normalizeCreditTerm(body: Record<string, unknown>, fallback = 30): number {
  // Supports 7/15/30 via body.creditTerm as in ledger POST
  if (body.creditTerm === 7 || body.creditTerm === 15 || body.creditTerm === 30) return Number(body.creditTerm);
  const raw = body.creditDays ?? body.customDays ?? fallback;
  return parseCreditDays(raw, fallback);
}

export function clampCreditLimit(v: unknown): number | null {
  if (v == null || String(v).trim() === "") return null;
  const n = Number(v);
  if (isNaN(n) || n < 0 || n > 1_000_000) throw new Error("Invalid creditLimit (0 - 1000000)");
  return n;
}
