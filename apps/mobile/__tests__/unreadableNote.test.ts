import { describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import { isServerRefusal } from "../features/console/files/browser";
import {
  UNREADABLE_BODY,
  UNREADABLE_FOOT,
  UNREADABLE_TITLE,
  isUnreadable,
} from "../features/console/files/unreadable";

/**
 * A note that is in storage and can't be opened (Board 6).
 *
 * `isUnreadable` decides which failed reads become that state instead of an
 * ordinary notice. The two codes are the control plane's for a sealed file
 * that won't open and for a workspace key that can't be opened; everything
 * else stays the notice it always was. Both are server refusals, so a cached
 * copy never stands in for them (`isServerRefusal`).
 */
describe("isUnreadable", () => {
  test("ENCRYPTED_UNREADABLE and KEY_UNAVAILABLE are this state", () => {
    expect(
      isUnreadable(new ConvexError({ code: "ENCRYPTED_UNREADABLE", message: "This note can't be opened right now." })),
    ).toBe(true);
    expect(isUnreadable(new ConvexError({ code: "KEY_UNAVAILABLE", message: "x" }))).toBe(true);
  });

  test("every other failure is not", () => {
    for (const thrown of [
      new ConvexError({ code: "FILE_NOT_FOUND", message: "That file does not exist." }),
      new ConvexError({ code: "NOT_AUTHORIZED", message: "No." }),
      new ConvexError("ENCRYPTED_UNREADABLE"),
      new Error("ENCRYPTED_UNREADABLE"),
      { data: { code: "ENCRYPTED_UNREADABLE" } },
      null,
      undefined,
    ]) {
      expect(isUnreadable(thrown)).toBe(false);
    }
  });

  test("it is a refusal, so no cached copy is shown in its place", () => {
    expect(
      isServerRefusal(new ConvexError({ code: "ENCRYPTED_UNREADABLE", message: "This note can't be opened right now." })),
    ).toBe(true);
  });

  test("the words: no Unlock, no em dash", () => {
    expect(UNREADABLE_TITLE).toBe("This note can't be opened right now");
    expect(UNREADABLE_BODY).toBe(
      "It's still in storage, but we can't open it right now. We've been alerted. Try again in a few minutes.",
    );
    for (const line of [UNREADABLE_TITLE, UNREADABLE_BODY, UNREADABLE_FOOT]) {
      expect(line).not.toMatch(/unlock/i);
      expect(line).not.toContain("—");
    }
  });
});
