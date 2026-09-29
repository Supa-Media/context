import { describe, expect, test } from "@jest/globals";

/**
 * `/join/<token>` as state (`features/auth/joinInvite.ts`): which page a token
 * draws, and what the one email field shows for each answer from
 * `waitlist.enter`.
 */

import {
  invitedLine,
  inviterInitial,
  joinScreenFor,
  signInView,
} from "../features/auth/joinInvite";

describe("the page a token draws", () => {
  test("waits for the preview, then shows who invited you", () => {
    expect(joinScreenFor("tok", undefined)).toEqual({ kind: "loading" });
    expect(joinScreenFor("tok", { works: true, inviterHandle: "maya" })).toEqual({
      kind: "invite",
      inviterHandle: "maya",
    });
  });

  test("an unknown, expired, revoked or cancelled invite all read as no longer working", () => {
    expect(joinScreenFor("tok", { works: false, inviterHandle: null })).toEqual({ kind: "expired" });
  });

  test("a link with no token never asks the server and never spins", () => {
    expect(joinScreenFor(undefined, undefined)).toEqual({ kind: "expired" });
    expect(joinScreenFor("  ", undefined)).toEqual({ kind: "expired" });
  });
});

describe("what the field shows", () => {
  const invite = { kind: "invite", inviterHandle: "maya" } as const;
  const expired = { kind: "expired" } as const;

  test("asking and the code are the same everywhere", () => {
    for (const variant of [undefined, invite, expired]) {
      expect(signInView(variant, "request")).toBe("request");
      expect(signInView(variant, "verify")).toBe("verify");
    }
  });

  test("on a working invite, an address not let in is the wrong address, never a waitlist tick", () => {
    expect(signInView(invite, "joined")).toBe("wrongEmail");
    expect(signInView(invite, "already")).toBe("wrongEmail");
  });

  test("on /login and on a dead invite, the waitlist answer stands", () => {
    for (const variant of [undefined, expired]) {
      expect(signInView(variant, "joined")).toBe("waitlist");
      expect(signInView(variant, "already")).toBe("waitlist");
    }
  });
});

describe("the inviter line", () => {
  test("names the handle once, with one @", () => {
    expect(invitedLine("maya")).toBe("@maya invited you");
    expect(invitedLine("@maya")).toBe("@maya invited you");
    expect(inviterInitial("maya")).toBe("M");
  });

  test("still reads without a handle", () => {
    expect(invitedLine(null)).toBe("You were invited");
    expect(invitedLine(" ")).toBe("You were invited");
    expect(inviterInitial(null)).toBe("•");
  });
});
