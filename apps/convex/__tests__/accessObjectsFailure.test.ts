/**
 * The words an access copy's failure is reported in (`functions/lib/accessObjects/failure.ts`). The workflow's log is
 * public, so a refusal keeps its message only when it is plain words, and nothing id-like ever passes. Fake values only.
 *
 * Sabotage, confirmed to fail here: return every refusal's message as it came.
 */

import { describe, expect, test } from "vitest";
import { TexObjectRefused } from "../../mcp/src/texStore/objects.js";
import { accessFailureKind, tally } from "../functions/lib/accessObjects/failure";

describe("accessFailureKind", () => {
  test("a contract refusal keeps its fixed words", () => {
    expect(accessFailureKind(new TexObjectRefused("a connection carries its refresh token's sha256"))).toBe("refused: a connection carries its refresh token's sha256");
    expect(accessFailureKind(new TexObjectRefused("a page carries at most 2000 rows"))).toBe("refused: a page carries at most 2000 rows");
  });

  test("a refusal carrying anything id-like, a handle or an address says only refused", () => {
    expect(accessFailureKind(new TexObjectRefused("no row k57abc123def for this workspace"))).toBe("refused");
    expect(accessFailureKind(new TexObjectRefused(`hash ${"a".repeat(64)}`))).toBe("refused");
    expect(accessFailureKind(new TexObjectRefused("invite to someone@example.com"))).toBe("refused");
    expect(accessFailureKind(new TexObjectRefused("@acme is not here"))).toBe("refused");
  });

  test("an object's other answer is its operation and status", () => {
    expect(accessFailureKind(new Error("Tex store person.connections.snapshot failed (500)"))).toBe("object_person.connections.snapshot_500");
  });

  test("anything else is the closed error name and reason", () => {
    const aborted = new Error("The operation was aborted");
    aborted.name = "AbortError";
    expect(accessFailureKind(aborted)).toBe("AbortError:other");
    expect(accessFailureKind(new Error(`opaque ${"b".repeat(40)}`))).toBe("Error:other");
  });
});

describe("tally", () => {
  test("counts each kind, and past the cap counts the rest as other", () => {
    const failures: { kind: string; count: number }[] = [];
    tally(failures, "a", 2);
    tally(failures, "a", 2);
    tally(failures, "b", 2);
    tally(failures, "c", 2);
    tally(failures, "d", 2);
    tally(failures, "b", 2);
    expect(failures).toEqual([
      { kind: "a", count: 2 },
      { kind: "b", count: 2 },
      { kind: "other", count: 2 },
    ]);
  });
});
