// Simple validators — could be replaced by zod but lightweight for now
import { normalizePhone, validatePhone, normalizeEmail, validateEmail } from "./normalize.js";

export type CustomerInput = {
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  creditLimit: number | null;
  balance: number;
};

export function validateCustomerCreate(body: Record<string, unknown>): CustomerInput {
  const name = String(body.name ?? "").trim();
  if (!name) throw Object.assign(new Error("Customer name is required"), { status: 400 });
  if (name.length > 80) throw Object.assign(new Error("Name too long (max 80)"), { status: 400 });

  const phone = normalizePhone(body.phone);
  if (phone && !validatePhone(phone)) throw Object.assign(new Error("Invalid phone — must be 10 digits"), { status: 400 });

  const email = normalizeEmail(body.email);
  if (email && !validateEmail(email)) throw Object.assign(new Error("Invalid email"), { status: 400 });

  const address = body.address ? String(body.address).trim().slice(0, 500) : null;
  const notes = body.notes ? String(body.notes).trim().slice(0, 1000) : null;

  let creditLimit: number | null = null;
  if (body.creditLimit != null && String(body.creditLimit).trim() !== "") {
    const v = Number(body.creditLimit);
    if (isNaN(v) || v < 0 || v > 1_000_000) throw Object.assign(new Error("Invalid creditLimit (0 - 1000000)"), { status: 400 });
    creditLimit = v;
  }

  const balance = body.balance != null ? Number(body.balance) : 0;

  return { name, phone, email, address, notes, creditLimit, balance };
}

export function validateProductCreate(body: Record<string, unknown>): Record<string, unknown> {
  const { name, category, costPrice, is_loose, rate_per_kg, price, lowStockThreshold } = body as any;
  if (!name || !category) throw Object.assign(new Error("name and category required"), { status: 400 });
  if (costPrice == null || isNaN(Number(costPrice)) || Number(costPrice) < 0) throw Object.assign(new Error("costPrice (buying price) is required and must be >=0"), { status: 400 });
  if (is_loose) {
    if (rate_per_kg == null || isNaN(Number(rate_per_kg)) || Number(rate_per_kg) <= 0) throw Object.assign(new Error("rate_per_kg required for loose"), { status: 400 });
  } else {
    if (price == null || isNaN(Number(price)) || Number(price) < 0) throw Object.assign(new Error("price required for packaged"), { status: 400 });
  }
  if (lowStockThreshold != null && (isNaN(Number(lowStockThreshold)) || Number(lowStockThreshold) < 0)) throw Object.assign(new Error("lowStockThreshold must be >= 0"), { status: 400 });
  return body as Record<string, unknown>;
}
