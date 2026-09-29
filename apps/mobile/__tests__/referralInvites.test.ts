import { describe, expect, test } from "@jest/globals";

/**
 * The Invite friends dialog's words (`features/referrals/invites.ts`): what
 * each invite says, how many dots are filled, and what stops a send.
 */

import {
  blocker,
  describeInvite,
  discordLink,
  dots,
  menuDetail,
  sendError,
  type InviteRow,
  type MyInvites,
} from "../features/referrals/invites";

const row = (over: Partial<InviteRow>): InviteRow => ({
  id: "i1",
  email: "jon@studio.test",
  status: "pending",
  sentAt: Date.UTC(2026, 8, 29, 12),
  expiresAt: Date.UTC(2026, 9, 13, 12),
  cancelledAt: null,
  joinedHandle: null,
  ...over,
});

const mine = (over: Partial<MyInvites>): MyInvites => ({
  off: false,
  locked: null,
  unlocksAt: null,
  total: 3,
  left: 1,
  invites: [],
  ...over,
});

describe("each invite", () => {
  test("a waiting invite says when it runs out", () => {
    const said = describeInvite(row({}));
    expect(said.pill).toBe("Waiting");
    expect(said.sub).toMatch(/^Sent Sep 29 · expires Oct 13$/);
  });

  test("a used one names who joined", () => {
    expect(describeInvite(row({ status: "joined", joinedHandle: "jon" })).sub).toBe("Joined as @jon");
  });

  test("expired and cancelled ones say the invite came back; revoked does not", () => {
    expect(describeInvite(row({ status: "expired" })).sub).toMatch(/back/);
    expect(describeInvite(row({ status: "cancelled" })).sub).toMatch(/back/);
    expect(describeInvite(row({ status: "revoked" })).sub).not.toMatch(/back/);
  });
});

describe("the count", () => {
  test("filled dots are the invites in use", () => {
    expect(dots({ total: 3, left: 1 })).toEqual([true, true, false]);
    expect(dots({ total: 5, left: 5 })).toEqual([false, false, false, false, false]);
  });

  test("the menu says how many are left only when they can be sent", () => {
    expect(menuDetail(mine({ left: 2 }))).toBe("2 left");
    expect(menuDetail(mine({ locked: "setup" }))).toBeUndefined();
    expect(menuDetail(mine({ off: true }))).toBeUndefined();
    expect(menuDetail(null)).toBeUndefined();
  });
});

describe("what stops a send", () => {
  test("in the order a person would need to hear it", () => {
    expect(blocker(mine({ off: true, locked: "setup" }))).toMatch(/paused/);
    expect(blocker(mine({ locked: "setup" }))).toMatch(/Connect Claude/);
    expect(blocker(mine({ locked: "new", unlocksAt: Date.UTC(2026, 9, 6, 12) }))).toMatch(/Oct 6/);
    expect(blocker(mine({ left: 0 }))).toMatch(/used all 3/);
    expect(blocker(mine({ left: 1 }))).toBeNull();
  });

  test("refusals read as sentences, and an unknown one says nothing was used", () => {
    expect(sendError("RATE_LIMITED")).toMatch(/tomorrow/);
    expect(sendError(undefined)).toMatch(/Nothing was used/);
  });
});

test("the Discord link is found among the others", () => {
  expect(discordLink([{ kind: "github", url: "https://g" }, { kind: "discord", url: "https://d" }])?.url).toBe(
    "https://d",
  );
  expect(discordLink([])).toBeNull();
  expect(discordLink(undefined)).toBeNull();
});
