/// <reference types="vite/client" />
/**
 * THE PREMISE THE CONSOLE'S REMEMBERED CONTEXT LIST RESTS ON.
 *
 * `apps/mobile/features/offline` files every cached note and listing under the
 * **clearance it was read at**, because an offline cache cannot re-check
 * authorization — there is nobody to ask. A session at `team` builds a
 * different key from a session at `private`, misses, and takes a round trip;
 * `offlineScope.test.ts` is the proof of that half.
 *
 * Which clearance a session is at comes from the role in `listMyWorkspaces`,
 * and on a launch with no network that list never arrives. So
 * `useRememberedContexts` serves the one this device wrote down on the last
 * load that did — which means a **remembered role** now decides which cached
 * bodies are readable, on a device the server cannot correct.
 *
 * That is only sound because of one fact about this control plane:
 *
 *   **`private` is `role === "owner"`, and the owner role cannot be taken
 *   away.**
 *
 * The first half is `scopeForRole`, and `apps/mobile/__tests__/
 * consoleVisibility.test.ts` already pins the console's copy against it. The
 * second half is the three refusals below. Together they say a remembered role
 * can be *out of date* — a promotion from `member` to `editor` is not seen
 * until the next successful load — but never *wider* than the one the server
 * would give today, and width is the only direction that discloses anything.
 * Both of those roles read at `team` regardless.
 *
 * ## Why this file exists when `membership.test.ts` covers the same refusals
 *
 * Because that file proves them as **administration** rules — a context with
 * no owner is unadministrable forever — and nothing said they were also a
 * **disclosure** rule. Build ownership transfer next year, which
 * `setMemberRole`'s own refusal text already describes as a wanted feature,
 * and every one of those tests gets updated along with it by somebody who is
 * thinking about administration. No test would have failed for the offline
 * cache, and a demoted ex-owner's device would go on serving `private` copies
 * on every launch with no network until the age bound reached them.
 *
 * This is that test. If it goes red because ownership can now be transferred,
 * the fix is not here: `useRememberedContexts` has to stop remembering a role
 * that can narrow, by remembering the clearance as `team` for any context
 * whose ownership is transferable, and this file's header has to stop claiming
 * what is no longer true.
 *
 * ## What it does NOT claim
 *
 * It says nothing about a membership that ends *entirely* — being removed, a
 * context deleted, a grant revoked. Those are not a narrowing of a clearance,
 * they are a departure, and they are handled by taking the cached bodies and
 * the remembered row together: `keysForDepartedContexts` on the first load
 * that sees the context gone, `keysForWorkspace` when somebody presses Leave.
 * `offlineForget.test.ts` owns that.
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";

/**
 * A shared context with an owner and one other member.
 *
 * Deliberately a *shared* context rather than a personal one. A personal
 * context's owner is unarguably permanent — it is their own account's context
 * and it is deleted with them — so proving the rule there would prove the easy
 * half and leave the half the remembered list actually depends on untested:
 * the owner of a context that has other people in it.
 */
async function sharedContext() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.test");
  const other = await createUser(t, "other@example.test");
  const workspaceId = await createWorkspace(t, owner, "acme", { kind: "shared" });
  await addMember(t, workspaceId, other, "editor");
  return { t, owner, other, workspaceId };
}

describe("the owner role is permanent, which is what makes a remembered role safe", () => {
  test("an owner cannot be demoted, so a remembered `private` cannot go stale-wide", async () => {
    const { t, owner, workspaceId } = await sharedContext();

    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.workspaces.setMemberRole, {
        workspaceId,
        userId: owner,
        role: "member",
      }),
    );

    expect(errorCode(error)).toBe("CANNOT_CHANGE_OWNER_ROLE");
  });

  test("an owner cannot be removed", async () => {
    const { t, owner, workspaceId } = await sharedContext();

    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.workspaces.removeMember, {
        workspaceId,
        userId: owner,
      }),
    );

    expect(errorCode(error)).toBe("CANNOT_REMOVE_OWNER");
  });

  test("an owner cannot leave", async () => {
    const { t, owner, workspaceId } = await sharedContext();

    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.workspaces.leaveWorkspace, { workspaceId }),
    );

    expect(errorCode(error)).toBe("OWNER_CANNOT_LEAVE");
  });

  /**
   * The narrower move that would reopen the same hole without touching any of
   * the three refusals above: widening what `setMemberRole` will *accept*.
   *
   * Its validator is `editor | member`, so `owner` is refused by the argument
   * check before the handler's own `CANNOT_CHANGE_OWNER_ROLE` is ever reached.
   * A promotion to `owner` is not itself a disclosure — it widens a clearance,
   * and this cache is only ever wrong in the narrow direction — but a
   * validator that accepts `owner` is the first half of a transfer, and a
   * transfer is the demotion this file exists to rule out. Failing here on the
   * half that is harmless is the point: it is the change that arrives first.
   */
  test("`setMemberRole` will not even take `owner` as an argument", async () => {
    const { t, owner, other, workspaceId } = await sharedContext();

    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.workspaces.setMemberRole, {
        workspaceId,
        userId: other,
        // The point of the test — an argument the validator must keep refusing.
        role: "owner" as "editor" | "member",
      }),
    );

    expect(error).not.toBeNull();
  });

  /**
   * And the other direction of the same premise: a role that is *not* owner
   * reads at `team`, so remembering it can never widen anything. Pinned here
   * rather than assumed, because "every other role is `team`" is the sentence
   * the offline key scheme leans on when it decides a remembered role is safe
   * to keep.
   */
  test("promoting a member to editor changes nothing about what they read at", async () => {
    const { t, owner, other, workspaceId } = await sharedContext();

    await asUser(t, owner).mutation(api.functions.workspaces.setMemberRole, {
      workspaceId,
      userId: other,
      role: "member",
    });
    await asUser(t, owner).mutation(api.functions.workspaces.setMemberRole, {
      workspaceId,
      userId: other,
      role: "editor",
    });

    const listed = await asUser(t, other).query(api.functions.workspaces.listMyWorkspaces, {});
    const row = listed.find((entry) => entry.workspaceId === workspaceId);

    expect(row?.role).toBe("editor");
    // `scopeForRole` narrows everything that is not `owner` to `team`, so both
    // ends of that promotion are the same clearance and a device that missed
    // it missed nothing that matters here.
    expect(row?.role).not.toBe("owner");
  });
});
