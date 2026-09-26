// Cursor pagination helper (opaque base64 `createdAt|id`).
// List endpoints support BOTH modes:
// - legacy offset: ?page&limit (deprecated, kept for compat until POS migrates)
// - cursor: ?cursor&limit → { nextCursor } (preferred, stable, no OFFSET skip cost)
export type CursorPayload = { createdAt: string; id: string };

export function encodeCursor(createdAt: Date | string, id: string): string {
  const ts = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
  return Buffer.from(`${ts}|${id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string | undefined | null): CursorPayload | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(String(cursor), "base64url").toString("utf8");
    const sep = raw.lastIndexOf("|");
    if (sep < 0) return null;
    const createdAt = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    if (!createdAt || !id || isNaN(new Date(createdAt).getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

// Build Prisma cursor where-clause for (createdAt desc, id desc) ordering.
// Returns additional AND condition, or null when no cursor.
export function cursorWhere(decoded: CursorPayload | null): Record<string, unknown> | null {
  if (!decoded) return null;
  const ts = new Date(decoded.createdAt);
  return {
    OR: [
      { createdAt: { lt: ts } },
      { createdAt: ts, id: { lt: decoded.id } },
    ],
  };
}

export function parseLimit(raw: unknown, fallback = 50, max = 100): number {
  const n = parseInt(String(raw ?? fallback), 10);
  if (isNaN(n)) return fallback;
  return Math.min(Math.max(n, 1), max);
}
