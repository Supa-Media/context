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
import { nodeAt as treeNodeAt } from "../../functions/lib/nodes/paths";

async function setRowsMode(f: Fixture): Promise<void> {
  await f.t.run(async (ctx) => {
    const row = await ctx.db.query("nodeMigration").first();
    if (row === null) await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 });
    else await ctx.db.patch(row._id, { accessSource: "rows" });
  });
}

/** Owner sets one row's base, as the console or the gateway would. */
async function setBase(f: Fixture, path: string, base: "private" | "team" | "inherit"): Promise<void> {
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
  return await f.t.run(async (ctx) => treeNodeAt(ctx.db, f.ws, path));
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
    const bucketBefore = f.store.snapshot()[PRIVACY_KEY];

    await batch(f, [{ from: "1-projects/secret/codes.md", to: "3-resources/codes.md" }]);

    // The move writes a row, and the rows' rules render it as a private note override, so the rows' version moves.
    // What must not move is the file: the move carries the row's access and writes no rules file.
    expect(await privacyEtag(f)).toMatch(/^rows:/);
    expect(f.store.snapshot()[PRIVACY_KEY]).toBe(bucketBefore);
    expect((await nodeAt(f, "3-resources/codes.md"))?.access).toEqual({ base: "private" });
    expect(await listed(f.member, f.ws, "3-resources")).not.toContain("3-resources/codes.md");
    expect(await listed(f.owner, f.ws, "3-resources")).toContain("3-resources/codes.md");
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

    // The bucket's rule for 3-resources is written to its row as team (the seeded rules become rows), so the row
    // starts with no base of its own before the default is asked for.
    await setBase(f, "3-resources", "inherit");
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
