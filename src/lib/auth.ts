import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "../config.js";

export type JwtPayload = {
  userId: string;
  shopId: string | null;
  counterId?: string | null;
  role: string;
  email: string;
  name: string;
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

export function signRefreshToken(payload: Pick<JwtPayload, "userId" | "shopId" | "role">): string {
  return jwt.sign(payload as object, config.jwtRefreshSecret, { expiresIn: config.jwtRefreshExpiresIn } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, config.jwtAccessSecret) as JwtPayload;
}

export function verifyRefreshToken(token: string): Pick<JwtPayload, "userId" | "shopId" | "role"> & { email?: string } {
  return jwt.verify(token, config.jwtRefreshSecret) as any;
}

export function sanitizeUser(u: { id: string; shopId: string | null; email: string; name: string; role: string; isActive?: boolean; canManageInventory?: boolean; counterId?: string | null; counter?: { id: string; name: string } | null; shop?: { id: string; name: string } | null }) {
  const c = (u as any).counter;
  return { id: u.id, shopId: u.shopId, email: u.email, name: u.name, role: u.role, canManageInventory: Boolean((u as any).canManageInventory), counterId: (u as any).counterId ?? null, counter: c ? { id: c.id, name: c.name } : null, shop: (u as any).shop ?? null };
}
