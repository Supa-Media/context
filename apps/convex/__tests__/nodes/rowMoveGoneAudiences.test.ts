/**
 * What a keyed row move records for the old path of the note it moved (`convexTable.ts` `logChange`,
 * `rowMove.ts` `followMovedFiles`). A gone entry's `audiences` decide who a device is told the old path
 * existed, so they must never name an audience that could not see the note before the move.
 *
 * The move is the product path (`startRowMove`) on a keyed workspace, as `keyedRowMove.test.ts` runs it. The
 * note has its own exact `private` access inside the `team` folder `1-projects`, so the team audience reaches
 * it only through the folder. The gone entry for its old path must name the owner alone.
 *
 * Two states of the access rules at the moment the log is written (`accessRowsOf`):
 *  - a snapshot is held (`nodeAccessState.snapshot`): it still says what the note was, because it is refreshed
 *    only after the move's rows have moved, so the owner-only answer holds;
 *  - no snapshot is held (a workspace past `SNAPSHOT_MAX_ROWS` or bytes, whose readers scan the rows): the rows
 *    have already moved, the exception at the old path is gone, and the folder's `team` answers for it.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { start, OWNER, type Fixture } from "./moveFixture.helpers";
import { NOTE_ID, keyedFixture, liveAt, rowOf } from "./keyedFixture.helpers";

/** The change log's newest gone entry for `path`. */
async function goneAudiencesOf(f: Fixture, path: string): Promise<string[] | undefined> {
  const rows = await f.t.run(async (ctx) =>
    await ctx.db
      .query("nodeLog")
      .withIndex("by_workspace_seq", (q) => q.eq("workspaceId", f.ws))
      .collect(),
  );
  const entry = rows.filter((row) => row.gone && row.path === path).at(-1);
  expect(entry, `a gone entry for ${path}`).toBeDefined();
  return entry?.audiences;
}

/** A keyed fixture plus a live file `1-projects/secret.md` with its own exact `private` access (as the console sets it). */
async function withSecret(): Promise<Fixture> {
  const f = await keyedFixture();
  const parent = await rowOf(f, "1-projects");
  await f.t.run(async (ctx) => {
    await ctx.db.insert("nodes", {
      workspaceId: f.ws,
      noteId: NOTE_ID(300),
      storageKey: `notes/${NOTE_ID(300)}.md`,
      path: "1-projects/secret.md",
      parentId: parent._id as Id<"nodes">,
      name: "secret.md",
      kind: "file",
      etag: "e-secret",
      observedAt: 1,
    });
  });
  const answer = await f.t.mutation(internal.functions.nodesAccess.consoleAccess, {
    workspaceId: f.ws,
    actorUserId: f.ownerId,
    path: "1-projects/secret.md",
    kind: "note",
    tier: "private",
  });
  expect(answer).toMatchObject({ ok: true, visibility: "private" });
  return f;
}

/** Drop the access snapshot, as a workspace too large to hold one has: the readers scan the rows instead. */
async function dropSnapshot(f: Fixture): Promise<void> {
  await f.t.run(async (ctx) => {
    for (const state of await ctx.db.query("nodeAccessState").collect()) {
      await ctx.db.patch(state._id, { snapshot: undefined });
    }
  });
}

describe("a keyed row move records who could see the old path (snapshot held)", () => {
  test("an exact private note moved out of a team folder is told to its owner only", async () => {
    const f = await withSecret();
    await start(f, "1-projects/secret.md", "1-projects/other/secret.md", OWNER);
    expect(await liveAt(f, "1-projects/other/secret.md")).toBe(true);

    expect(await goneAudiencesOf(f, "1-projects/secret.md")).toEqual(["private"]);
  });

  test("an exact private note moved into a private folder is told to its owner only", async () => {
    const f = await withSecret();
    await start(f, "1-projects/secret.md", "2-areas/secret.md", OWNER);
    expect(await liveAt(f, "2-areas/secret.md")).toBe(true);

    expect(await goneAudiencesOf(f, "1-projects/secret.md")).toEqual(["private"]);
  });

  test("positive control: a team note moved out of a team folder is told to the team", async () => {
    const f = await keyedFixture();
    await start(f, "1-projects/keep.md", "2-areas/keep.md", OWNER);
    expect(await liveAt(f, "2-areas/keep.md")).toBe(true);

    expect(await goneAudiencesOf(f, "1-projects/keep.md")).toEqual(["private", "team"]);
  });
});

describe("a keyed row move records who could see the old path (no snapshot, rows scanned)", () => {
  test("an exact private note moved out of a team folder is not told to the team", async () => {
    const f = await withSecret();
    await dropSnapshot(f);
    await start(f, "1-projects/secret.md", "2-areas/secret.md", OWNER);
    expect(await liveAt(f, "2-areas/secret.md")).toBe(true);

    expect(await goneAudiencesOf(f, "1-projects/secret.md")).toEqual(["private"]);
  });

  test("positive control: a team note moved out of a team folder is told to the team", async () => {
    const f = await keyedFixture();
    await dropSnapshot(f);
    await start(f, "1-projects/keep.md", "2-areas/keep.md", OWNER);

    expect(await goneAudiencesOf(f, "1-projects/keep.md")).toEqual(["private", "team"]);
  });
});
