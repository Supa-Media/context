import { describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import {
  canManageShares,
  describeShareFailure,
  shareLifetime,
  shareTone,
} from "../features/console/shares/shares";

describe("who may manage shared links", () => {
  test("only the owner", () => {
    expect(canManageShares("owner")).toBe(true);
    expect(canManageShares("editor")).toBe(false);
    expect(canManageShares("member")).toBe(false);
    expect(canManageShares(undefined)).toBe(false);
  });
});

describe("how far a share reaches", () => {
  test("an unlisted link is the one row worth a second look", () => {
    expect(shareTone("anyone")).toBe("warn");
  });

  test("a named person or a members-only link reads as ordinary", () => {
    expect(shareTone("name")).toBe("neutral");
    expect(shareTone("email")).toBe("neutral");
    expect(shareTone("members")).toBe("neutral");
  });
});

describe("how long a shared link has left", () => {
  const now = 1_000_000;
  const DAY = 24 * 60 * 60 * 1000;

  test("no expiry is its own sentence, not an arithmetic fallthrough", () => {
    expect(shareLifetime(undefined, now)).toBe("no expiry");
  });

  test("already past is expired, not a negative day count", () => {
    expect(shareLifetime(now - 1, now)).toBe("expired");
    expect(shareLifetime(now, now)).toBe("expired");
  });

  test("today and tomorrow are named, not '0 days' and '1 days'", () => {
    expect(shareLifetime(now + 1, now)).toBe("expires today");
    expect(shareLifetime(now + DAY + 1, now)).toBe("expires tomorrow");
  });

  test("further out counts the days", () => {
    expect(shareLifetime(now + 6 * DAY, now)).toBe("expires in 6 days");
  });
});

describe("turning a revoke's refusal into something a person can act on", () => {
  function refusal(code: string) {
    return new ConvexError({ code, message: "irrelevant" });
  }

  test("one sentence for every reason a share id might not resolve", () => {
    // `SHARE_NOT_FOUND` covers "no such share", "not yours" and "already
    // revoked" on the backend deliberately — see `shareNotFound()` in
    // `apps/convex/functions/shares.ts` — so the console gives it one
    // sentence rather than guessing which of the three happened.
    expect(describeShareFailure(refusal("SHARE_NOT_FOUND")).headline).toBe(
      "That link is no longer there",
    );
  });

  test("a non-owner is told who can act, not given a stack trace", () => {
    expect(describeShareFailure(refusal("INSUFFICIENT_ROLE")).headline).toContain("owner");
  });

  test("an unrecognised refusal never repeats the raw error", () => {
    const failure = describeShareFailure(new Error("ECONNRESET at socket.js:42"));
    expect(failure.headline).not.toContain("ECONNRESET");
    expect(failure.headline).not.toContain(".js");
  });
});
