import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createHash, randomUUID } from "node:crypto";
import { config } from "../config.js";

export type JwtPayload = {
  userId: string;
  shopId: string | null;
  counterId?: string | null;
  role: string;
  email: string;
  name: string;
  /** Session version — must match User.tokenVersion (bump revokes all sessions) */
  tv: number;
  /** Per-device session id — revoked on single-device logout, rotated on refresh */
  jti?: string;
};

export async function hashPassword(plain: string): Promise<string> {
  const salt = await bcrypt.genSalt(config.bcryptRounds);
  return bcrypt.hash(plain, salt);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload as object, config.jwtAccessSecret, { expiresIn: config.jwtAccessExpiresIn } as jwt.SignOptions);
}

export function signRefreshToken(payload: Pick<JwtPayload, "userId" | "shopId" | "role" | "tv">): string {
  return jwt.sign(payload as object, config.jwtRefreshSecret, { expiresIn: config.jwtRefreshExpiresIn } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, config.jwtAccessSecret) as JwtPayload;
}

export function verifyRefreshToken(token: string): Pick<JwtPayload, "userId" | "shopId" | "role" | "tv" | "jti"> & { email?: string } {
  return jwt.verify(token, config.jwtRefreshSecret) as any;
}

export function newJti(): string {
  try {
    return randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sanitizeUser(u: { id: string; shopId: string | null; email: string; name: string; role: string; isActive?: boolean; canManageInventory?: boolean; counterId?: string | null; counter?: { id: string; name: string } | null; shop?: { id: string; name: string } | null }) {
  const c = (u as any).counter;
  return { id: u.id, shopId: u.shopId, email: u.email, name: u.name, role: u.role, canManageInventory: Boolean((u as any).canManageInventory), counterId: (u as any).counterId ?? null, counter: c ? { id: c.id, name: c.name } : null, shop: (u as any).shop ?? null };
}
