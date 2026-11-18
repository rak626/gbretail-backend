import { describe, it, expect } from "vitest";
import { createApp } from "../../src/app.js";

const devSecrets = {
  NODE_ENV: "production",
  JWT_ACCESS_SECRET: "dev-access-secret-change-me-32chars",
  JWT_REFRESH_SECRET: "dev-refresh-secret-change-me-32chars",
  DATABASE_URL: "",
};

describe("production secret guard in the mounted API", () => {
  it("refuses API requests when production still uses the dev JWT secrets", async () => {
    const res = await createApp().request("http://localhost/api/health", {}, devSecrets as Record<string, string>);
    expect(res.status).toBe(500);
  });

  it("allows requests outside production", async () => {
    const res = await createApp().request(
      "http://localhost/",
      {},
      { ...devSecrets, NODE_ENV: "test" } as Record<string, string>
    );
    expect(res.status).not.toBe(500);
  });
});
