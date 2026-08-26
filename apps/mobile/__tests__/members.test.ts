import { describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import {
  ASSIGNABLE_ROLES,
  canManageMembers,
  describeMembersFailure,
  describeRole,
  errorCodeOf,
  expiryLabel,
  memberDetail,
  memberLabel,
  oppositeRole,
  type ConsoleMember,
} from "../features/console/members/members";

/**
 * The members section's display logic.
 *
 * Two things are worth pinning here rather than discovering in a screenshot:
 * **which controls exist for which role** — the section's whole safety rule is
 * that an owner-only control is absent rather than disabled, and that decision
 * is one function — and **what a backend refusal is turned into**, because one
 * of those refusals is deliberately the same error for four different
 * situations and the interface must not try to be more helpful than that.
 */

const DAY = 24 * 60 * 60 * 1000;

function member(overrides: Partial<ConsoleMember> = {}): ConsoleMember {
  return {
    userId: "u1",
    role: "member",
    joinedAt: 0,
    isMe: false,
    ...overrides,
  };
}

const convexError = (code: string, message = "nope") =>
  new ConvexError({ code, message });

describe("who may manage members", () => {
  test("only an owner", () => {
    expect(canManageMembers("owner")).toBe(true);
    // An editor can write notes. That is not the same as deciding who reads
    // them, and every members mutation is owner-only on the backend.
    expect(canManageMembers("editor")).toBe(false);
    expect(canManageMembers("member")).toBe(false);
    expect(canManageMembers(undefined)).toBe(false);
    expect(canManageMembers("")).toBe(false);
  });

  test("owner is never an option a control can move somebody to", () => {
    expect(ASSIGNABLE_ROLES.map((option) => option.value)).toEqual([
      "member",
      "editor",
    ]);
    // Absent rather than disabled: transferring a context is not built, and a
    // greyed-out "owner" would advertise a feature that does not exist. Widened
    // to `string` because `AssignableRole` already excludes it at the type
    // level — this asserts the value, so a widened type cannot quietly restore
    // the option.
    const offered: string[] = ASSIGNABLE_ROLES.map((option) => option.value);
    expect(offered).not.toContain("owner");
  });

  test("an owner's row has nothing to switch to", () => {
    expect(oppositeRole("member")).toBe("editor");
    expect(oppositeRole("editor")).toBe("member");
    // `null`, so the row renders no control at all — an owner cannot be demoted.
    expect(oppositeRole("owner")).toBeNull();
    expect(oppositeRole("something-new")).toBeNull();
  });
});

describe("naming a person", () => {
  test("prefers a name, falls back to an address", () => {
    expect(memberLabel(member({ name: "LK", email: "lk@example.com" }))).toBe("LK");
    expect(memberLabel(member({ email: "lk@example.com" }))).toBe("lk@example.com");
  });

  test("never renders a raw user id", () => {
    // An opaque identifier tells the reader nothing and reads as a bug. This
    // list exists to answer "who am I sharing my notes with".
    const label = memberLabel(member({ userId: "kg23abcd0000opaque" }));
    expect(label).not.toContain("kg23abcd0000opaque");
    expect(label).toBe("Someone on this context");
  });

  test("treats whitespace as absent", () => {
    expect(memberLabel(member({ name: "  ", email: "lk@example.com" }))).toBe(
      "lk@example.com",
    );
    expect(memberLabel(member({ name: "  ", email: "   " }))).toBe(
      "Someone on this context",
    );
  });

  test("the second line does not repeat the first", () => {
    expect(memberDetail(member({ name: "LK", email: "lk@example.com" }))).toBe(
      "lk@example.com",
    );
    // The address was already used as the label, so there is nothing left.
    expect(memberDetail(member({ email: "lk@example.com" }))).toBeUndefined();
    expect(memberDetail(member({ name: "LK" }))).toBeUndefined();
  });

  test("each role says what it can actually do", () => {
    expect(describeRole("owner")).toBe("Full control, including storage and access");
    expect(describeRole("editor")).toBe("Can read and write notes");
    expect(describeRole("member")).toBe("Can read notes");
    // A role the app has not heard of renders as itself rather than as a
    // reassuring guess.
    expect(describeRole("auditor")).toBe("auditor");
  });
});

describe("how long an invitation has left", () => {
  test("counts down in whole days", () => {
    const now = 1_000_000_000_000;
    expect(expiryLabel(now + 6 * DAY, now)).toBe("expires in 6 days");
    expect(expiryLabel(now + 2 * DAY, now)).toBe("expires in 2 days");
    expect(expiryLabel(now + 1.5 * DAY, now)).toBe("expires tomorrow");
    expect(expiryLabel(now + 3 * 60 * 60 * 1000, now)).toBe("expires today");
  });

  test("an invitation past its expiry says so rather than going negative", () => {
    const now = 1_000_000_000_000;
    expect(expiryLabel(now, now)).toBe("expired");
    expect(expiryLabel(now - DAY, now)).toBe("expired");
  });
});

describe("turning a refusal into something a person can act on", () => {
  test("reads the code off a ConvexError", () => {
    expect(errorCodeOf(convexError("RATE_LIMITED"))).toBe("RATE_LIMITED");
    expect(errorCodeOf(new Error("boom"))).toBeUndefined();
    expect(errorCodeOf(null)).toBeUndefined();
    expect(errorCodeOf(undefined)).toBeUndefined();
    expect(errorCodeOf({ data: { code: 7 } })).toBeUndefined();
  });

  test("an insufficient role says who to ask", () => {
    expect(describeMembersFailure(convexError("INSUFFICIENT_ROLE"))).toEqual({
      headline: "Only an owner can change who is in this context",
      next: "Ask an owner of this context to make the change.",
    });
  });

  test("a bad invitee shows the backend's own wording, which is about the string", () => {
    const failure = describeMembersFailure(
      new ConvexError({
        code: "INVALID_INVITEE",
        reason: "invalid_email",
        message: "That does not look like an email address.",
      }),
    );
    expect(failure.headline).toBe("That does not look like an email address.");
  });

  test("a dead invitation gets one message, whatever actually happened to it", () => {
    // The backend answers `INVITATION_NOT_FOUND` for four different situations
    // on purpose — answered, withdrawn, expired, never existed. Guessing which,
    // in the interface, would re-open the oracle that single error closes.
    const failure = describeMembersFailure(convexError("INVITATION_NOT_FOUND"));
    expect(failure).toEqual({
      headline: "That invitation is no longer open",
      next: "It may have been answered, withdrawn, or expired. Send a new one.",
    });
    for (const word of ["declined", "refused", "does not exist", "no such"]) {
      expect(`${failure.headline} ${failure.next}`.toLowerCase()).not.toContain(word);
    }
  });

  test("the owner rules explain themselves instead of just refusing", () => {
    const removal = describeMembersFailure(convexError("CANNOT_REMOVE_OWNER"));
    const demotion = describeMembersFailure(convexError("CANNOT_CHANGE_OWNER_ROLE"));
    expect(removal).toEqual(demotion);
    expect(removal.next).toContain("not built yet");
  });

  test("an unknown failure never leaks the raw thrown text", () => {
    // Whatever the runtime produced is not copy, and it is how a stack trace
    // ends up in a screenshot.
    const failure = describeMembersFailure(
      new Error("TypeError: Cannot read properties of undefined (reading 'db')"),
    );
    expect(failure).toEqual({
      headline: "That did not work",
      next: "Try again in a moment.",
    });
    expect(JSON.stringify(failure)).not.toContain("TypeError");
  });

  test("every code the members mutations can throw has copy of its own", () => {
    // The set the backend can produce. A code missing from `describeMembersFailure`
    // falls through to "That did not work", which is correct but useless — this
    // fails if one is added on the backend and forgotten here.
    const codes = [
      "INVALID_INVITEE",
      "INSUFFICIENT_ROLE",
      "WORKSPACE_NOT_FOUND",
      "MEMBER_NOT_FOUND",
      "CANNOT_REMOVE_OWNER",
      "CANNOT_CHANGE_OWNER_ROLE",
      "INVITATION_NOT_FOUND",
      "INVITATION_LIMIT_REACHED",
      "RATE_LIMITED",
      "NOT_AUTHENTICATED",
    ];
    const uncovered = codes.filter(
      (code) => describeMembersFailure(convexError(code)).headline === "That did not work",
    );
    expect(uncovered).toEqual([]);
  });
});
