import { describe, expect, test } from "vitest";
import { failureCode } from "../functions/texHistoryMigration";

/**
 * The history migration's log is public (a GitHub workflow), so a failed
 * workspace is counted by a fixed code, never by its message, which could
 * carry a key or a path (`functions/texHistoryMigration.ts`).
 */
describe("a failed workspace is counted by a fixed code", () => {
  test("the error's own code, else its name", () => {
    expect(failureCode(Object.assign(new Error("x"), { code: "TexStoreUnavailable" }))).toBe("TexStoreUnavailable");
    expect(failureCode(new TypeError("cannot read notes/abc.md"))).toBe("TypeError");
  });

  test("a bucket's refusal as its operation and status, without the key", () => {
    expect(failureCode(new Error("S3 GET .context/agent/events/x.json failed with 403: Access Denied"))).toBe("S3_GET_403");
  });

  test("never a message or a value that is not a plain word", () => {
    expect(failureCode(Object.assign(new Error("secret"), { code: "a/b c", name: "notes/abc.md" }))).toBe("unknown");
    expect(failureCode("a string")).toBe("unknown");
    expect(failureCode(null)).toBe("unknown");
  });
});
