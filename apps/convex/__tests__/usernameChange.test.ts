/**
 * Changing a username (decided by the owner, 2026-11-22: "only allow people to change twice in a lifetime, and let
 * them keep their old name"; `docs/decisions/identity-and-access/username-changes.md`).
 *
 * What is proved: a change moves the personal workspace's slug and nothing else; the old name keeps its row, still
 * pointing at the same workspace, so it stays theirs (nobody else can claim it) and everything that resolves a name
 * (capture mail, invitations and shares by name, a session's workspace list) still reaches them by it; the third
 * change is refused; a change back to a former name needs no new claim and still counts; and deleting the account
 * frees every name it held.
 *
 * ## Sabotage record
 *
 * Temporary local edits, reverted. Counts are failing tests in this file, as measured.
 *
 *   the limit check removed                                                       1
 *   the old name's row deleted on change (the name released)                      4
 *   `identifiersForUser` lists the current name only                              1
 *   `reachOf` leaves the former names off its rows                                 1
 *   no rename job queued for a workspace on `object`                               1
 *   the emailed-code check removed from `changeMyUsername`                         1
 */

import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { asPhoneOnly, asUser, captureError, createUser, createWorkspace, errorCode, setupTest, type TestConvex } from "./fixtures.helpers";
import { findName } from "../functions/lib/nameClaims";
import { identifiersForUser, resolveAddressedUser } from "../functions/lib/identities";
import { resolvePersonalContextForIngestion } from "../functions/lib/ingestionStore";
import { reachOf } from "../functions/lib/accessObjects/expected";
import { deleteAccountFor } from "../functions/account";
import { runTakeAway, type OpenObject } from "../functions/accessTakeAway";

async function person(t: TestConvex, email: string, slug: string) {
  const userId = await createUser(t, email);
  const workspaceId = await createWorkspace(t, userId, slug, { kind: "personal" });
  return { userId, workspaceId };
}

const change = (t: TestConvex, userId: Id<"users">, name: string) =>
  asUser(t, userId).mutation(api.functions.names.changeMyUsername, { name });

describe("changing a username", () => {
  test("moves the slug, keeps the old name pointing at the same workspace, and counts the change", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t, "kemi@example.invalid", "kemi");
    const state = await change(t, userId, "kemi-ade");
    expect(state).toEqual({ username: "kemi-ade", formerNames: ["kemi"], changesLeft: 1 });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(workspaceId))?.slug).toBe("kemi-ade");
      expect((await findName(ctx, "kemi"))?.workspaceId).toBe(workspaceId);
      expect((await findName(ctx, "kemi-ade"))?.workspaceId).toBe(workspaceId);
      const audit = await ctx.db.query("auditEvents").collect();
      expect(audit.some((row) => row.action === "username.changed" && row.details?.from === "kemi" && row.details?.to === "kemi-ade")).toBe(true);
    });
    expect(await asUser(t, userId).query(api.functions.names.myUsername, {})).toEqual(state);
  });

  test("the old name stays theirs: nobody else can claim it, and it is not offered as free", async () => {
    const t = setupTest();
    const { userId } = await person(t, "kemi@example.invalid", "kemi");
    await change(t, userId, "kemi-ade");
    const other = await createUser(t, "other@example.invalid");
    const check = await asUser(t, other).query(api.functions.names.checkNameAvailable, { name: "kemi" });
    expect(check.available).toBe(false);
    const error = await captureError(() => createWorkspace(t, other, "kemi", { kind: "personal" }));
    expect(errorCode(error)).toBe("NAME_UNAVAILABLE");
    const second = await person(t, "second@example.invalid", "second");
    expect(errorCode(await captureError(() => change(t, second.userId, "kemi")))).toBe("NAME_UNAVAILABLE");
  });

  test("mail, invitations and sessions still reach them by the old name", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t, "kemi@example.invalid", "kemi");
    await change(t, userId, "kemi-ade");
    await t.run(async (ctx) => {
      expect((await resolvePersonalContextForIngestion(ctx, "kemi"))?.workspace._id).toBe(workspaceId);
      expect(await resolveAddressedUser(ctx, { kind: "name", value: "kemi" })).toBe(userId);
      const names = (await identifiersForUser(ctx, userId)).filter((row) => row.kind === "name").map((row) => row.value);
      expect(names.sort()).toEqual(["kemi", "kemi-ade"]);
      const reach = await reachOf(ctx, userId, Date.now());
      const own = reach.rows.find((row) => row.workspaceId === String(workspaceId));
      expect(own).toMatchObject({ slug: "kemi-ade", aliases: ["kemi"] });
    });
    // The app's workspace list carries the old name, so a link to /console/@kemi lands on @kemi-ade.
    const listed = await asUser(t, userId).query(api.functions.workspaces.listMyWorkspaces, {});
    expect(listed.find((row) => row.workspaceId === workspaceId)).toMatchObject({ slug: "kemi-ade", aliases: ["kemi"] });
  });

  test("twice in a lifetime: a change back to a former name needs no new claim and still counts, and a third is refused", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t, "kemi@example.invalid", "kemi");
    await change(t, userId, "kemi-ade");
    const back = await change(t, userId, "kemi");
    expect(back).toEqual({ username: "kemi", formerNames: ["kemi-ade"], changesLeft: 0 });
    await t.run(async (ctx) => {
      expect((await ctx.db.query("names").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect()).length).toBe(2);
    });
    expect(errorCode(await captureError(() => change(t, userId, "kemi-three")))).toBe("USERNAME_CHANGES_USED");
    await t.run(async (ctx) => {
      expect(await findName(ctx, "kemi-three")).toBeNull();
    });
  });

  test("refuses the same name, a malformed or reserved one, and a person with no workspace of their own", async () => {
    const t = setupTest();
    const { userId } = await person(t, "kemi@example.invalid", "kemi");
    expect(errorCode(await captureError(() => change(t, userId, "kemi")))).toBe("USERNAME_UNCHANGED");
    expect(errorCode(await captureError(() => change(t, userId, "Bad Name!")))).toBe("NAME_UNAVAILABLE");
    expect(errorCode(await captureError(() => change(t, userId, "support")))).toBe("NAME_UNAVAILABLE");
    const guest = await createUser(t, "guest@example.invalid");
    expect(errorCode(await captureError(() => change(t, guest, "guesty")))).toBe("NO_PERSONAL_WORKSPACE");
    expect(await asUser(t, guest).query(api.functions.names.myUsername, {})).toBeNull();
    await t.run(async (ctx) => {
      expect(await findName(ctx, "guesty")).toBeNull();
    });
  });

  test("a phone-only device is asked for the emailed code first, and changes nothing", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t, "kemi@example.invalid", "kemi");
    const { view } = await asPhoneOnly(t, userId);
    expect(errorCode(await captureError(() => view.mutation(api.functions.names.changeMyUsername, { name: "kemi-ade" })))).toBe("EMAIL_PROOF_REQUIRED");
    await t.run(async (ctx) => {
      expect((await ctx.db.get(workspaceId))?.slug).toBe("kemi");
      expect(await findName(ctx, "kemi-ade")).toBeNull();
    });
  });

  test("deleting the account frees every name it held, old ones included", async () => {
    const t = setupTest();
    const { userId } = await person(t, "kemi@example.invalid", "kemi");
    await change(t, userId, "kemi-ade");
    await t.run(async (ctx) => deleteAccountFor(ctx, userId));
    await t.run(async (ctx) => {
      expect(await findName(ctx, "kemi")).toBeNull();
      expect(await findName(ctx, "kemi-ade")).toBeNull();
    });
  });

  test("a workspace whose object decides its members is told its new name and former names, with every member", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await person(t, "kemi@example.invalid", "kemi");
    await t.run(async (ctx) => {
      await ctx.db.insert("workspaceObjectHomes", { workspaceId, home: "bucket", since: 0, access: "object", personAccess: "object" });
    });
    await change(t, userId, "kemi-ade");
    const jobs = await t.run((ctx) => ctx.db.query("accessTakeAways").collect());
    expect(jobs.map((job) => job.kind)).toEqual(["rename"]);
    const puts: { workspaceId: string; users: string[]; workspace: unknown }[] = [];
    const open: OpenObject = (id) => ({
      members: {
        remove: async () => ({ removed: 0 }),
        put: async (rows, extra) => {
          puts.push({ workspaceId: String(id), users: rows.map((row) => String((row as { userId: string }).userId)), workspace: extra.workspace });
          return { kept: rows.length };
        },
      },
      invites: { remove: async () => ({ removed: 0 }) },
      access: { connections: { revoke: async () => ({ revoked: true }) } },
    });
    const ran = await t.action(async (ctx) => await runTakeAway(ctx, jobs[0]._id, open));
    expect(ran).toBe("done");
    expect(puts).toEqual([{ workspaceId: String(workspaceId), users: [String(userId)], workspace: { slug: "kemi-ade", kind: "personal", aliases: ["kemi"] } }]);
    expect(await t.run((ctx) => ctx.db.query("accessTakeAways").collect())).toEqual([]);
  });
});
