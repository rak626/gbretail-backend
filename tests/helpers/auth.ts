import { createApp } from "../../src/app.js";
import { applyEnv } from "../../src/config.js";
import { testDatabaseUrl } from "./db.js";

// Build the Hono app bound to the TEST database (Workers-style env override).
export function testApp() {
  applyEnv({ DATABASE_URL: testDatabaseUrl(), NODE_ENV: "test" } as Record<string, string>);
  return createApp();
}

export async function login(app: ReturnType<typeof createApp>, email: string, password: string): Promise<string> {
  const res = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  return data.accessToken as string;
}

export function authHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...extra };
}
