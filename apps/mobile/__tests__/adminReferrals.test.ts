/**
 * The "Invited by friends" view's words and arithmetic, and the community
 * link form's defaults — `features/admin/referrals.ts`, with no renderer.
 */

import { describe, expect, test } from "@jest/globals";
import {
  byLine,
  filterCount,
  filterReferrals,
  grantedSentence,
  kindDefaults,
  onwardLine,
  revokeQuestion,
  revokedSentence,
  statusPill,
  totalReferrals,
  traceSteps,
  type ReferralRow,
} from "../features/admin/referrals";

const counts = { pending: 2, joined: 3, expired: 1, cancelled: 0, revoked: 1 };

function row(id: string, status: ReferralRow["status"]): ReferralRow {
  return {
    id,
    email: `${id}@example.test`,
    inviterUserId: "u1",
    inviterHandle: "maya",
    inviterUsed: 2,
    inviterTotal: 3,
    sentAt: Date.UTC(2026, 8, 29),
    expiresAt: Date.UTC(2026, 9, 13),
    status,
    joinedHandle: status === "joined" ? "jon" : null,
  };
}

describe("referral counts and filters", () => {
  test("the total is every state added up", () => {
    expect(totalReferrals(counts)).toBe(7);
    expect(totalReferrals(undefined)).toBe(0);
    expect(filterCount(counts, "all")).toBe(7);
    expect(filterCount(counts, "pending")).toBe(2);
  });

  test("a filter keeps its own state, and All keeps everything", () => {
    const rows = [row("a", "pending"), row("b", "joined"), row("c", "revoked")];
    expect(filterReferrals(rows, "all").map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(filterReferrals(rows, "joined").map((r) => r.id)).toEqual(["b"]);
    expect(filterReferrals(rows, "expired")).toEqual([]);
  });
});

describe("referral words", () => {
  test("status pills", () => {
    expect(statusPill("pending", null)).toEqual({ label: "Not used yet", tone: "warn" });
    expect(statusPill("joined", "jon")).toEqual({ label: "Joined @jon", tone: "ok" });
    expect(statusPill("expired", null).tone).toBe("neutral");
    expect(statusPill("cancelled", null).tone).toBe("neutral");
    expect(statusPill("revoked", null)).toEqual({ label: "Revoked", tone: "crit" });
  });

  test("by line, and a sender with no username", () => {
    expect(byLine(row("a", "pending"))).toBe("@maya · 2 used of 3");
    expect(byLine({ inviterHandle: null, inviterUsed: 0, inviterTotal: 3 })).toBe(
      "someone without a username · 0 used of 3",
    );
  });

  test("the revoke question says nobody is emailed and the invite is not returned", () => {
    expect(revokeQuestion(row("x", "pending"))).toBe(
      "Revoke the invite to x@example.test? The link stops working now. @maya doesn't get it back. Nobody is emailed.",
    );
    expect(revokedSentence(true, "x@example.test")).toBe("Revoked the invite to x@example.test.");
    expect(revokedSentence(false, "x@example.test")).toContain("already");
  });

  test("a grant says no email is sent", () => {
    expect(grantedSentence(1, "maya")).toBe("Gave @maya 1 more invite. Their count goes up. No email is sent.");
    expect(grantedSentence(3, "maya")).toContain("3 more invites");
  });

  test("onward line", () => {
    expect(onwardLine("jon", 2)).toBe("@jon has invited 2 people");
    expect(onwardLine("jon", 0)).toBe("@jon has not invited anyone yet");
  });
});

describe("trace timeline", () => {
  const base = {
    inviterHandle: "maya",
    sentAt: Date.UTC(2026, 8, 20),
    expiresAt: Date.UTC(2026, 9, 4),
    cancelledAt: null,
    revokedAt: null,
    joinedAt: null,
    joinedHandle: null,
  };

  test("joined ends with who they joined as", () => {
    const steps = traceSteps({ ...base, status: "joined", joinedAt: Date.UTC(2026, 8, 22), joinedHandle: "jon" });
    expect(steps.map((s) => s.label)).toEqual(["Invited by @maya", "Joined as @jon"]);
    expect(steps[1]?.at).toBe(Date.UTC(2026, 8, 22));
  });

  test("each ending has its own step", () => {
    expect(traceSteps({ ...base, status: "revoked", revokedAt: 1 })[1]).toEqual({ label: "Revoked", at: 1, tone: "crit" });
    expect(traceSteps({ ...base, status: "cancelled", cancelledAt: 2 })[1]?.label).toBe("Cancelled");
    expect(traceSteps({ ...base, status: "expired" })[1]?.at).toBe(base.expiresAt);
    expect(traceSteps({ ...base, status: "pending" })[1]?.label).toBe("Not used yet · expires 4 Oct");
  });
});

describe("community link defaults", () => {
  test("Discord is for signed-in people, the rest for everyone", () => {
    expect(kindDefaults("discord")).toEqual({ label: "Discord", audience: "members" });
    expect(kindDefaults("github")).toEqual({ label: "GitHub", audience: "everyone" });
    expect(kindDefaults("other")).toEqual({ label: "", audience: "everyone" });
  });
});
