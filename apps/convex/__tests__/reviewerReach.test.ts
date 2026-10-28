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
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { REVIEWER_EMAIL } from "../functions/lib/reviewerAccount";
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
});
