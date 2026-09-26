import { describe, it, expect } from "vitest";
import { toAppError, AppError } from "../../src/lib/errors.js";

describe("toAppError", () => {
  it("passes AppError through", () => {
    const e = new AppError(422, "limit", "CREDIT_LIMIT_EXCEEDED");
    expect(toAppError(e)).toBe(e);
  });
  it("maps unique violations to 409", () => {
    expect(toAppError(new Error("Unique constraint failed (P2002)")).status).toBe(409);
    expect(toAppError(new Error("barcode_key exists")).status).toBe(409);
  });
  it("maps DB connectivity to 503 without leaking strings", () => {
    const e = toAppError(new Error("Can't reach database server at localhost:5432"));
    expect(e.status).toBe(503);
    expect(e.code).toBe("DB_NOT_CONFIGURED");
  });
  it("sanitizes marathon messages", () => {
    const e = toAppError(new Error("x".repeat(600)));
    expect(e.message).toBe("Internal Server Error");
    expect(e.status).toBe(500);
  });
});
