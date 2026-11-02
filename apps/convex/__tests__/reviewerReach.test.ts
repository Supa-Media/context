/**
 * The reserved reviewer account reaches nothing beyond its own workspace.
 *
 * The directory code and the App Store review phone open this account, and the
 * phone's code was public in this repository's history (kept by the owner,
 * 2026-10-25). So whoever holds it must not be able to connect a Google account,
 * join somebody's workspace, or read anything somebody shared with the address.
 * `isReservedReviewer` in `functions/lib/reviewerAccount.ts` is the one test;
 * each door below calls it.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `isReservedReviewer` always false → every "the reviewer…" test fails.
 *  2. Check removed from `requirePersonalOwnerHandler` → "cannot start a Google connection".
 *  3. Check removed from `joinByInvitation` → "cannot accept an invitation".
 *  4. Check removed from `joinableFor` → "cannot join by its email domain".
 *  5. Check removed from `guestViewOf` → "reads nothing through a grant".
 *  6. Check removed from `shareStillStands` → "a share addressed to it opens nothing".
 *  7. `refuseReservedReviewer` removed from `signInEmails.ts` → "keeps the one address".
 *  8. `GOOGLE_REVIEW_EMAIL` dropped from `isReservedReviewer` → "Google's reviewer
 *     stays in its own workspace". `mayHoldGoogleConnection` made to refuse it →
 *     "Google's reviewer can start a Google connection".
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { GOOGLE_REVIEW_EMAIL, REVIEWER_EMAIL } from "../functions/lib/reviewerAccount";
import { asUser, captureError, createUser, createWorkspace, errorCode, setupTest } from "./fixtures.helpers";
import { grantUser, noteIdOf, PLAN, PLAN_MARKER, readByNoteId, world } from "./grants/outsider.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the reserved reviewer stays in its own workspace", () => {
  test("cannot start a Google connection, while any other owner can", async () => {
    const t = setupTest();
    const reviewer = await createUser(t, REVIEWER_EMAIL);
    const reviewerOwn = await createWorkspace(t, reviewer, "rvw-desk");
    const ana = await createUser(t, "ana@example.invalid");
    const anaOwn = await createWorkspace(t, ana, "ana");

    const may = (workspaceId: typeof anaOwn, userId: typeof ana) =>
      t.query(internal.functions.googleConnect.requirePersonalOwner, { workspaceId, userId });
    expect(await may(anaOwn, ana)).toBe(true);
    expect(await may(reviewerOwn, reviewer)).toBe(false);
  });

  test("cannot accept an invitation, and the invitation stays unspent", async () => {
    const t = setupTest();
    const ana = await createUser(t, "ana@example.invalid");
    const reviewer = await createUser(t, REVIEWER_EMAIL);
    await createWorkspace(t, reviewer, "rvw-desk");
    const atlas = await createWorkspace(t, ana, "atlas", { kind: "shared", displayName: "Atlas" });
    await asUser(t, ana).mutation(api.functions.invitations.inviteMember, {
      workspaceId: atlas,
      invitee: "@rvw-desk",
      role: "member",
    });
    const mine = await asUser(t, reviewer).query(api.functions.invitations.listMyInvitations, {});
    expect(mine).toHaveLength(1);

    const error = await captureError(() =>
      asUser(t, reviewer).mutation(api.functions.invitations.acceptInvitation, { token: mine[0]!.token }),
    );
    expect(errorCode(error)).toBe("INVITATION_NOT_FOUND");
    const member = await t.run((ctx) =>
      ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace_user", (q) => q.eq("workspaceId", atlas).eq("userId", reviewer))
        .first(),
    );
    expect(member).toBeNull();
    const row = await t.run((ctx) => ctx.db.query("workspaceInvitations").first());
    expect(row?.status).toBe("pending");
  });

  test("cannot join by its email domain, while a colleague on the same domain can", async () => {
    const t = setupTest();
    const staff = await createUser(t, "staff@supa.media");
    const team = await createWorkspace(t, staff, "staffteam", { kind: "shared" });
    await asUser(t, staff).mutation(api.functions.workspaceDomains.addWorkspaceDomain, {
      workspaceId: team,
      domain: "supa.media",
    });
    const colleague = await createUser(t, "colleague@supa.media");
    const reviewer = await createUser(t, REVIEWER_EMAIL);

    expect(await asUser(t, reviewer).query(api.functions.workspaceDomains.myDomainWorkspaces, {})).toEqual([]);
    const refused = await captureError(() =>
      asUser(t, reviewer).mutation(api.functions.workspaceDomains.joinWithDomain, { slug: "staffteam" }),
    );
    expect(errorCode(refused)).toBe("WORKSPACE_NOT_FOUND");
    await expect(
      asUser(t, colleague).mutation(api.functions.workspaceDomains.joinWithDomain, { slug: "staffteam" }),
    ).resolves.toMatchObject({ slug: "staffteam" });
  });

  test("reads nothing through a grant in somebody else's workspace", async () => {
    const w = await world();
    const reviewer = await createUser(w.t, REVIEWER_EMAIL);
    await grantUser(w, PLAN, w.kola);
    const noteId = await noteIdOf(w, PLAN);
    // The control: the same grant opens the note for an ordinary outsider.
    expect((await readByNoteId(w, w.kola, noteId)).text).toContain(PLAN_MARKER);

    await grantUser(w, PLAN, reviewer);
    const error = await captureError(() => readByNoteId(w, reviewer, noteId));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
    expect(await asUser(w.t, reviewer).query(api.functions.shares.listSharedWithMe, {})).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ noteId })]),
    );
  });

  test("a share addressed to it opens nothing, while the same share to anyone else does", async () => {
    const t = setupTest();
    const ana = await createUser(t, "ana@example.invalid");
    const anaOwn = await createWorkspace(t, ana, "ana");
    const reviewer = await createUser(t, REVIEWER_EMAIL);
    await createWorkspace(t, reviewer, "rvw-desk");
    const lk = await createUser(t, "lk@example.invalid");
    await createWorkspace(t, lk, "lk");

    const share = (recipient: string) =>
      asUser(t, ana).mutation(api.functions.shares.createShare, {
        workspaceId: anaOwn,
        path: "1-projects/plan.md",
        recipient,
      });
    const toLk = (await share("@lk")).token;
    const toReviewer = (await share("@rvw-desk")).token;
    expect(await asUser(t, lk).query(api.functions.shares.resolveShare, { token: toLk })).not.toBeNull();
    expect(await asUser(t, reviewer).query(api.functions.shares.resolveShare, { token: toReviewer })).toBeNull();
  });

  test("keeps the one address that names it, while a fresh account may add another", async () => {
    const t = setupTest();
    const reviewer = await createUser(t, REVIEWER_EMAIL);
    const ada = await createUser(t, "ada@example.invalid");
    const start = (userId: typeof ada, email: string) =>
      asUser(t, userId).action(api.functions.signInEmails.startAddEmail, { email });

    expect((await start(ada, "ada@work.example.invalid")).status).toBe("sent");
    expect(errorCode(await captureError(() => start(reviewer, "mine@attacker.example.invalid")))).toBe("RESERVED_ACCOUNT");

    // Even with a second address already on it, the mail address cannot move.
    await t.run((ctx) =>
      ctx.db.insert("signInEmails", { userId: reviewer, email: "mine@attacker.example.invalid", addedAt: Date.now() }),
    );
    const swap = await captureError(() =>
      asUser(t, reviewer).mutation(api.functions.signInEmails.setMailEmail, { email: "mine@attacker.example.invalid" }),
    );
    expect(errorCode(swap)).toBe("RESERVED_ACCOUNT");
    expect((await t.run((ctx) => ctx.db.get(reviewer)))?.email).toBe(REVIEWER_EMAIL);
  });
});

describe("Google's reviewer may connect Google, and is otherwise held like the other", () => {
  test("Google's reviewer can start a Google connection; the public-code account still cannot", async () => {
    const t = setupTest();
    const google = await createUser(t, GOOGLE_REVIEW_EMAIL);
    const googleOwn = await createWorkspace(t, google, "gr-desk");
    const reviewer = await createUser(t, REVIEWER_EMAIL);
    const reviewerOwn = await createWorkspace(t, reviewer, "rvw-desk");
    const may = (workspaceId: typeof googleOwn, userId: typeof google) =>
      t.query(internal.functions.googleConnect.requirePersonalOwner, { workspaceId, userId });
    expect(await may(googleOwn, google)).toBe(true);
    expect(await may(reviewerOwn, reviewer)).toBe(false);
  });

  test("Google's reviewer stays in its own workspace: no domain join, no invitation, no grant, one address", async () => {
    const w = await world();
    const google = await createUser(w.t, GOOGLE_REVIEW_EMAIL);
    await createWorkspace(w.t, google, "gr-desk");

    const staff = await createUser(w.t, "staff@supa.media");
    const team = await createWorkspace(w.t, staff, "staffteam", { kind: "shared" });
    await asUser(w.t, staff).mutation(api.functions.workspaceDomains.addWorkspaceDomain, { workspaceId: team, domain: "supa.media" });
    expect(await asUser(w.t, google).query(api.functions.workspaceDomains.myDomainWorkspaces, {})).toEqual([]);

    await asUser(w.t, staff).mutation(api.functions.invitations.inviteMember, { workspaceId: team, invitee: "@gr-desk", role: "member" });
    const [invitation] = await asUser(w.t, google).query(api.functions.invitations.listMyInvitations, {});
    const refused = await captureError(() =>
      asUser(w.t, google).mutation(api.functions.invitations.acceptInvitation, { token: invitation!.token }),
    );
    expect(errorCode(refused)).toBe("INVITATION_NOT_FOUND");

    await grantUser(w, PLAN, google);
    expect(errorCode(await captureError(async () => readByNoteId(w, google, await noteIdOf(w, PLAN))))).toBe("SHARE_UNAVAILABLE");

    const added = await captureError(() =>
      asUser(w.t, google).action(api.functions.signInEmails.startAddEmail, { email: "mine@attacker.example.invalid" }),
    );
    expect(errorCode(added)).toBe("RESERVED_ACCOUNT");
  });
});

describe("what the review accounts already hold, as counts", () => {
  test("names nothing, and counts reach the checks would now refuse", async () => {
    const w = await world();
    const reviewer = await createUser(w.t, REVIEWER_EMAIL);
    await createWorkspace(w.t, reviewer, "rvw-desk");
    // Reach made before the checks existed: a grant and a membership written directly.
    await grantUser(w, PLAN, reviewer);
    await w.t.run((ctx) => ctx.db.insert("workspaceMembers", { workspaceId: w.ws, userId: reviewer, role: "member", joinedAt: 1 } as never));

    const rows = await w.t.query(internal.functions.reviewerReachAudit.counts, {});
    expect(rows.map((row) => row.address)).toEqual([REVIEWER_EMAIL, GOOGLE_REVIEW_EMAIL]);
    expect(rows[0]).toMatchObject({ accounts: 1, ownedWorkspaces: 1, otherMemberships: 1, grantsByAccount: 1, googleConnections: 0 });
    expect(rows[1]).toMatchObject({ accounts: 0, ownedWorkspaces: 0, otherMemberships: 0, grantsByAccount: 0 });
    expect(JSON.stringify(rows)).not.toMatch(/"[a-z0-9]{20,}"/);
  });
});
