/**
 * Privacy writes that are not the console's or the gateway's own, in rows mode
 * (`nodeMigration.accessSource` = `rows`, where the rows are the truth):
 *
 *  - B: a move carries no file rules; a private note moved into a team folder
 *    stays private on its row (`rowMoveBatch`, and the queued folder move).
 *  - C: a new context's folders take their scaffolded defaults once their rows
 *    exist, once, and never clobber what the owner set after.
 *  - D: a website's folder takes `team` only where the row has no base of its own.
 *  - E: a console tier change records the activity line the file path records.
 *
 * Sabotage (run by hand, each must fail its own case):
 *  - B: carry the file rules in `rowMoveBatch` in rows mode: "privacy.md is not carried" fails.
 *  - C: drop the `scaffoldDerived` return in `deriveNewWorkspaceRows`: "does not clobber" fails; drop its
 *    `onlyUnset` option: the pre-empted case clobbers the owner's row and fails.
 *  - D: drop the `base !== undefined` return in `ensureFolderDefault`: "keeps its own base" fails.
 *  - E: drop the `recordRowsVisibilityLine` call in `setNoteVisibilityHandler`: "records the line" fails.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { MutationCtx } from "../../_generated/server";
import { ACTIVITY_PATH } from "../../functions/lib/activity";
import { setAccessRow } from "../../functions/lib/nodes/setAccess";
import { startRowMoveBatch } from "../../functions/lib/nodes/rowMoveBatch";
import { asUser } from "../fixtures.helpers";
import { fixture as filesFixture } from "../files/fixtures.helpers";
import { bodyAtPath } from "../files/keyedNotes.helpers";
import { OWNER, drain, fixture, listed, type Fixture } from "./moveFixture.helpers";
import { keyedFixture, privacyEtag } from "./keyedFixture.helpers";
import { PRIVACY_KEY } from "../../functions/lib/privacy";

async function setRowsMode(f: Fixture): Promise<void> {
  await f.t.run(async (ctx) => {
    const row = await ctx.db.query("nodeMigration").first();
    if (row === null) await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 });
    else await ctx.db.patch(row._id, { accessSource: "rows" });
  });
}

/** Owner sets one row's base, as the console or the gateway would. */
async function setBase(f: Fixture, path: string, base: "private" | "team"): Promise<void> {
  await f.t.run(async (ctx) =>
    setAccessRow(ctx as MutationCtx, {
      workspaceId: f.ws,
      path,
      base,
      grantees: [],
      actor: { userId: f.ownerId, role: "owner" },
    }),
  );
}

async function nodeAt(f: Fixture, path: string) {
  return await f.t.run(async (ctx) =>
    ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws).eq("path", path))
      .unique(),
  );
}

const batch = (f: Fixture, moves: { from: string; to: string }[]) =>
  startRowMoveBatch(f.ctx, { workspaceId: f.ws, store: f.store, moves, clearance: OWNER, now: Date.now() });

describe("B: a move in rows mode carries its rows, not the file's rules", () => {
  test("a private note moved into a team folder stays private, and privacy.md is not carried", async () => {
    const f = await keyedFixture();
    await setRowsMode(f);
    // The note is private by its folder's row; its file rules would carry a narrowing to the new name.
    await setBase(f, "1-projects/secret", "private");
    await setBase(f, "3-resources", "team");
    const before = await privacyEtag(f);
    const bucketBefore = f.store.snapshot()[PRIVACY_KEY];

    await batch(f, [{ from: "1-projects/secret/codes.md", to: "3-resources/codes.md" }]);

    expect(await privacyEtag(f)).toBe(before);
    expect(f.store.snapshot()[PRIVACY_KEY]).toBe(bucketBefore);
    expect((await nodeAt(f, "3-resources/codes.md"))?.access).toEqual({ base: "private" });
    expect(await listed(f.member, f.ws, "3-resources")).not.toContain("3-resources/codes.md");
    expect(await listed(f.owner, f.ws, "3-resources")).toContain("3-resources/codes.md");
  });
});

describe("C: a new context's folders take their scaffolded defaults once, when their rows exist", () => {
  test("the first derivation sets the defaults on the rows; a later one leaves the owner's rows as they are", async () => {
    const f = await fixture();
    await setRowsMode(f);
    await f.t.run(async (ctx) => {
      const state = await ctx.db.query("nodeAccessState").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).unique();
      if (state !== null) await ctx.db.delete(state._id);
    });

    await f.t.mutation(internal.functions.nodesPrivacy.deriveNewWorkspaceRows, { workspaceId: f.ws, attempt: 0 });
    expect((await nodeAt(f, "1-projects"))?.access).toEqual({ base: "team" });
    expect((await nodeAt(f, "1-projects/secret"))?.access).toEqual({ base: "private" });

    // The owner changes a folder; the next run finds an access state and does nothing.
    await setBase(f, "1-projects", "private");
    await f.t.mutation(internal.functions.nodesPrivacy.deriveNewWorkspaceRows, { workspaceId: f.ws, attempt: 0 });
    expect((await nodeAt(f, "1-projects"))?.access).toEqual({ base: "private" });
  });

  test("pre-empted: an owner's write made first leaves a state, and the defaults still come, without clobbering the owner's row", async () => {
    const f = await fixture();
    await setRowsMode(f);
    await f.t.run(async (ctx) => {
      const state = await ctx.db.query("nodeAccessState").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).unique();
      if (state !== null) await ctx.db.delete(state._id);
    });
    // The owner's write comes before the scaffold's derivation: it creates the access state, and sets 1-projects itself.
    await setBase(f, "1-projects", "private");
    const before = await f.t.run(async (ctx) =>
      ctx.db.query("nodeAccessState").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).unique(),
    );
    expect(before?.scaffoldDerived).toBeUndefined();

    await f.t.mutation(internal.functions.nodesPrivacy.deriveNewWorkspaceRows, { workspaceId: f.ws, attempt: 0 });

    // The scaffold's default still lands on the row the owner did not touch, and the owner's choice stands.
    expect((await nodeAt(f, "1-projects/secret"))?.access).toEqual({ base: "private" });
    expect((await nodeAt(f, "1-projects"))?.access).toEqual({ base: "private" });
    const after = await f.t.run(async (ctx) =>
      ctx.db.query("nodeAccessState").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).unique(),
    );
    expect(after?.scaffoldDerived).toBe(true);
  });
});

describe("D: a website's folder in rows mode", () => {
  test("takes team where the row has no base of its own, and keeps a base it already has", async () => {
    const f = await fixture();
    await setRowsMode(f);
    await setBase(f, "1-projects", "private");

    const kept = await f.t.mutation(internal.functions.nodesAccess.ensureFolderDefault, {
      workspaceId: f.ws,
      actorUserId: f.ownerId,
      path: "1-projects",
    });
    expect(kept).toEqual({ ok: true, visibility: "private", changed: false });

    const set = await f.t.mutation(internal.functions.nodesAccess.ensureFolderDefault, {
      workspaceId: f.ws,
      actorUserId: f.ownerId,
      path: "3-resources",
    });
    expect(set).toEqual({ ok: true, visibility: "team", changed: true });
    expect((await nodeAt(f, "3-resources"))?.access).toEqual({ base: "team" });
  });

  test("a folder with no row takes team as pending, and no row is made", async () => {
    const f = await fixture();
    await setRowsMode(f);
    const answer = await f.t.mutation(internal.functions.nodesAccess.ensureFolderDefault, {
      workspaceId: f.ws,
      actorUserId: f.ownerId,
      path: "9-missing",
    });
    expect(answer).toEqual({ ok: true, visibility: "team", changed: true });
    expect(await nodeAt(f, "9-missing")).toBeNull();
  });
});

describe("E: a console tier change in rows mode records the activity line the file path records", () => {
  // Two real console actions through the file path and the id layer: slower than the default 5s on a loaded runner
  // (the same reason `contextMoveEndToEnd.test.ts` sets 30s). No assertion is changed.
  test("a note's and a folder's tier each leave their visibility line in the activity file", { timeout: 30_000 }, async () => {
    const f = await filesFixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 });
    });
    const owner = asUser(f.t, f.owner);
    await owner.action(api.functions.files.setDirectoryVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects",
      visibility: "team",
    });
    await owner.action(api.functions.files.setNoteVisibility, {
      workspaceId: f.workspaceId,
      path: "1-projects/shared.md",
      visibility: "team",
    });
    // The activity file's own words for each line: a team publication of the folder and of the note. In a keyed
    // workspace its bytes sit at its row's key (`notes/<noteId>.md`, notes-by-id.md), so they are read through the
    // row, as `activity.test.ts` reads them; a read of the raw path key finds nothing and proves nothing.
    const activity = (await bodyAtPath(f, ACTIVITY_PATH)) ?? "";
    expect(activity).toContain("gave the team `1-projects`");
    expect(activity).toContain("gave the team `1-projects/shared.md`");
  });
});
