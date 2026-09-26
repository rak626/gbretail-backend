// Idempotency-Key handling for POST /orders + POST /ledger.
// Client generates one key per bill; replays (network retry, double-tap, token-refresh
// retry) return the original record instead of double-billing. Edge-safe: no node:crypto.

const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

// Header wins, body.idempotencyKey is the fallback (offline queue / older clients).
// Returns null when absent. Malformed present keys are rejected by the caller (400).
export function getIdempotencyKey(c: { req: { header: (n: string) => string | undefined } }, body: Record<string, unknown>): string | null {
  const h = (c.req.header("Idempotency-Key") ?? c.req.header("idempotency-key") ?? "").trim();
  const b = body.idempotencyKey != null ? String(body.idempotencyKey).trim() : "";
  const key = h || b || "";
  return key ? key : null;
}

export function isValidIdempotencyKey(key: string): boolean {
  return KEY_RE.test(key);
}

// Stable, order-independent fingerprint of the bill for replay-mismatch detection
// (same key + different payload -> 422, so keys can't be reused across bills).
export function fingerprint(v: unknown): string {
  const s = stableStringify(v);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ch, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

function stableStringify(v: unknown): string {
  if (v == null) return "null";
  if (typeof v !== "object") return JSON.stringify(v) ?? "";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}
