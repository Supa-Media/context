import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { hashOneTimeCode } from "../functions/lib/oneTimeCodes";

/**
 * One-time codes are kept as a keyed hash (CASA 1.1.3, 2026-11-11). A plain
 * SHA-256 of a six-digit code is one of a million values, so a copy of the
 * table gave the codes back; without the deployment's key it gives nothing.
 */
const env = { JWT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----" };

describe("hashOneTimeCode", () => {
  test("is deterministic, so a code can be found by it", async () => {
    expect(await hashOneTimeCode("phone-sign-in", "123456", env)).toBe(await hashOneTimeCode("phone-sign-in", "123456", env));
  });

  test("is not the plain SHA-256 of the code, with or without its purpose", async () => {
    const stored = await hashOneTimeCode("email-proof", "123456", env);
    for (const plain of ["123456", "email-proof:123456", "context-one-time-code:v1:email-proof:123456"]) {
      expect(stored).not.toBe(createHash("sha256").update(plain).digest("hex"));
    }
  });

  test("a table without the key recovers nothing: every code hashes differently under another key", async () => {
    const other = { JWT_PRIVATE_KEY: "a different key" };
    expect(await hashOneTimeCode("phone-sign-in", "123456", env)).not.toBe(await hashOneTimeCode("phone-sign-in", "123456", other));
  });

  test("AUTH_CODE_HASH_KEY wins over the signing key when set", async () => {
    const own = { ...env, AUTH_CODE_HASH_KEY: "own key" };
    expect(await hashOneTimeCode("phone-sign-in", "1", own)).toBe(await hashOneTimeCode("phone-sign-in", "1", { AUTH_CODE_HASH_KEY: "own key" }));
    expect(await hashOneTimeCode("phone-sign-in", "1", own)).not.toBe(await hashOneTimeCode("phone-sign-in", "1", env));
  });

  test("each store's purpose keeps its values apart", async () => {
    expect(await hashOneTimeCode("email-proof", "123456", env)).not.toBe(await hashOneTimeCode("email-recovery", "123456", env));
  });

  test("refuses to hash at all without a key, rather than fall back to a plain digest", async () => {
    await expect(hashOneTimeCode("phone-sign-in", "123456", {})).rejects.toThrow(/AUTH_CODE_HASH_KEY or JWT_PRIVATE_KEY/);
  });
});
