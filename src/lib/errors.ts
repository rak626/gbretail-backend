// Central error handling — maps known errors to status codes and sanitizes leaks

export class AppError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = "AppError";
  }
}

export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const msg = e instanceof Error ? e.message : "Internal Server Error";
  // Prisma unique violation
  if (msg.includes("Unique constraint") || msg.includes("P2002") || msg.includes("already exists") || msg.includes("barcode_key") || msg.includes("phone_key")) {
    return new AppError(409, "Duplicate entry — unique constraint failed", "CONFLICT");
  }
  if (msg.includes("DATABASE_URL") || msg.includes("Can't reach") || msg.includes("connect") || msg.includes("ECONNREFUSED")) {
    return new AppError(503, "Database not configured. Set DATABASE_URL", "DB_NOT_CONFIGURED");
  }
  // Don't leak raw Prisma internals
  const sanitized = msg.length > 500 ? "Internal Server Error" : msg;
  return new AppError(500, sanitized);
}

export function handleRouteError(c: { json: (data: unknown, status: number) => unknown }, e: unknown) {
  const appErr = toAppError(e);
  return c.json({ error: appErr.message, code: appErr.code }, appErr.status as 400 | 401 | 403 | 404 | 409 | 500 | 503);
}

export function isDbNotConfiguredError(msg: string): boolean {
  return msg.includes("DATABASE_URL") || msg.includes("Can't reach") || msg.includes("connect") || msg.includes("ECONNREFUSED");
}
