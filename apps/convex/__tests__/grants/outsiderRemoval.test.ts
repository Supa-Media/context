/**
 * A member who leaves, or is removed, takes their account grants in that
 * workspace with them.
 *
 * Once they are no longer a member they are an outsider, and an account grant
 * left behind would be a read the owner never meant to keep: the outsider path
 * (`functions/lib/grants/outsider.ts`) would honour it. So `removeMember` and
 * `leaveWorkspace` delete the person's `granteeKind: "user"` rows in that
 * workspace, and write one `access.list` audit row for the change, as every other
 * change to an access list does.
 *
 * Sabotage (run by hand, each must fail a test here): skip
 * `removeUserGrantsIn` in `removeMemberHandler`: "removing a member deletes their
 * account grant" fails.
 */

import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { asUser, captureError, errorCode } from "../fixtures.helpers";
import { grantUser, noteIdOf, PLAN, readByNoteId, world, type World } from "./outsider.helpers";

async function accountGrantsIn(w: World, userId: Id<"users">, workspace = w.ws): Promise<number> {
  return await w.t.run(async (ctx) => {
    const rows = await ctx.db
      .query("nodeAccess")
      .withIndex("by_workspace_user", (q) => q.eq("workspaceId", workspace).eq("granteeUserId", userId))
      .collect();
    return rows.filter((row) => row.granteeKind === "user").length;
  });
}

async function accessListAudits(w: World, workspace = w.ws) {
  return await w.t.run(async (ctx) => {
    const events = await ctx.db.query("auditEvents").collect();
    return events.filter((event) => event.workspaceId === workspace && event.action === "access.list");
  });
}

describe("removing a member takes their account grants with them", () => {
  test("removeMember deletes the user's grants in that workspace and audits the change", async () => {
    const w = await world();
    await grantUser(w, PLAN, w.mia);
    expect(await accountGrantsIn(w, w.mia)).toBe(1);
    const before = (await accessListAudits(w)).length;

    const answer = await asUser(w.t, w.owner).mutation(api.functions.workspaces.removeMember, {
      workspaceId: w.ws,
      userId: w.mia,
    });
    expect(answer).toEqual({ removed: true });

    expect(await accountGrantsIn(w, w.mia)).toBe(0);
    const audits = await accessListAudits(w);
    expect(audits.length).toBe(before + 1);
    const latest = audits[audits.length - 1];
    expect(latest.actorUserId).toBe(w.owner);
    expect(latest.details).toMatchObject({ removedCount: 1 });
    expect(String(latest.details?.removed)).toContain(`user:${w.mia}:view`);
  });

  test("a removed member, now an outsider, reads nothing the grant used to reach", async () => {
    const w = await world();
    await grantUser(w, PLAN, w.mia);
    const noteId = await noteIdOf(w, PLAN);

    await asUser(w.t, w.owner).mutation(api.functions.workspaces.removeMember, { workspaceId: w.ws, userId: w.mia });

    // Outside now, with the grant gone: the outsider path would otherwise honour it.
    const error = await captureError(() => readByNoteId(w, w.mia, noteId));
    expect(errorCode(error)).toBe("SHARE_UNAVAILABLE");
  });

  test("removing one member leaves another member's grant alone", async () => {
    const w = await world();
    await grantUser(w, PLAN, w.mia);
    await grantUser(w, PLAN, w.bob);

    await asUser(w.t, w.owner).mutation(api.functions.workspaces.removeMember, { workspaceId: w.ws, userId: w.mia });
    expect(await accountGrantsIn(w, w.bob)).toBe(1);
  });
});

describe("leaving a workspace takes the leaver's account grants with them", () => {
  test("leaveWorkspace deletes the leaver's grants and audits them under the leaver", async () => {
    const w = await world();
    await grantUser(w, PLAN, w.bob);

    const answer = await asUser(w.t, w.bob).mutation(api.functions.workspaces.leaveWorkspace, { workspaceId: w.ws });
    expect(answer).toEqual({ left: true });

    expect(await accountGrantsIn(w, w.bob)).toBe(0);
    const audits = await accessListAudits(w);
    const latest = audits[audits.length - 1];
    expect(latest.actorUserId).toBe(w.bob);
    expect(String(latest.details?.removed)).toContain(`user:${w.bob}:view`);
  });

  test("a member with no account grant leaves without an access.list row", async () => {
    const w = await world();
    const before = (await accessListAudits(w)).length;
    await asUser(w.t, w.bob).mutation(api.functions.workspaces.leaveWorkspace, { workspaceId: w.ws });
    expect((await accessListAudits(w)).length).toBe(before);
  });
});
