import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import app from "../../src/app.js";

describe("package contract", () => {
  it("exposes the Hono app without starting a server", () => {
    expect(typeof app.fetch).toBe("function");
  });

  it("declares the ./app export and ships the prisma schema", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.name).toBe("@gbretail/backend");
    expect(pkg.exports["./app"].import).toBe("./dist/app.js");
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("prisma");
    expect(pkg.private).toBeUndefined();
  });
});
