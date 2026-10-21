/**
 * The one-time rename that takes the sort numbers off built-in folders
 * (`0-inbox` → `inbox`, `1-projects` → `projects`, …; owner, 2026-10-21:
 * "need to get rid of the 1- 2- prefixes we've been putting on folders").
 *
 * It renames through the same file operation the console's rename uses, at
 * the owner's clearance, so a renamed folder keeps its rows, ids, rules,
 * job and Archive twin. What it may not do is guess: a folder whose plain
 * name is already taken is left alone, an unkeyed workspace is left alone
 * (its rename would be a byte move), and a dry run changes nothing.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   rename even when a sibling already has the plain name          2
 *   plan renames in an unkeyed workspace                           1
 *   move in a dry run                                              1
 *   drop the job rows from the plan (root folders only)            1
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { runMoveOperation } from "../../functions/lib/nodes/moveBarrier";
import { dropFolderNumbersIn } from "../../functions/lib/nodes/folderNumbers";
import { fixture, type Fixture } from "./moveFixture.helpers";
import { keyedFixture, liveAt, rowOf } from "./keyedFixture.helpers";

const moveFor = (f: Fixture) => async (from: string, to: string) =>
  await runMoveOperation(f.ctx, { workspaceId: f.ws, scope: "private", operation: { kind: "nodesMoveStart", from, to } }, f.store);

const run = (f: Fixture, dryRun = false) => dropFolderNumbersIn(f.ctx, f.ws, moveFor(f), dryRun);

async function folder(f: Fixture, path: string, parent?: string, role?: string): Promise<Id<"nodes">> {
  const parentId = parent === undefined ? undefined : (await rowOf(f, parent))._id;
  return await f.t.run(async (ctx) =>
    await ctx.db.insert("nodes", {
      workspaceId: f.ws,
      path,
      name: path.slice(path.lastIndexOf("/") + 1),
      kind: "folder",
      observedAt: 1,
      ...(parentId === undefined ? {} : { parentId }),
      ...(role === undefined ? {} : { role }),
    } as never),
  );
}

async function roleAt(f: Fixture, path: string): Promise<string | undefined> {
  const id = (await rowOf(f, path))._id;
  return (await f.t.run(async (ctx) => await ctx.db.get(id)))?.role;
}

describe("taking the numbers off built-in folders", () => {
  test("a keyed workspace's numbered folders get their plain names, and keep their notes and ids", async () => {
    const f = await keyedFixture();
    const before = await rowOf(f, "1-projects/launch/brief.md");

    const counts = await run(f);

    expect(counts).toMatchObject({ keyed: true, renamed: 2, twins: 0, refused: {} });
    expect(await liveAt(f, "projects")).toBe(true);
    expect(await liveAt(f, "resources")).toBe(true);
    expect(await liveAt(f, "1-projects")).toBe(false);
    const after = await rowOf(f, "projects/launch/brief.md");
    expect(after.noteId).toBe(before.noteId);
    expect(after.storageKey).toBe(before.storageKey);
  });

  test("the folder keeps its job, so writers naming the old spelling still land in it", async () => {
    const f = await keyedFixture();
    const role = await roleAt(f, "1-projects");
    expect(role).toBe("projects");
    await run(f);
    expect(await roleAt(f, "projects")).toBe(role);
  });

  test("an Archive twin follows its folder", async () => {
    const f = await keyedFixture();
    await folder(f, "9-archive", undefined, "archive");
    await folder(f, "9-archive/1-projects", "9-archive");

    await run(f);

    expect(await liveAt(f, "archive")).toBe(true);
    expect(await liveAt(f, "archive/projects")).toBe(true);
    expect(await liveAt(f, "archive/1-projects")).toBe(false);
  });

  test("a folder whose plain name is already taken is left alone and counted", async () => {
    const f = await keyedFixture();
    await folder(f, "Projects");

    const counts = await run(f);

    expect(counts).toMatchObject({ renamed: 1, twins: 1 });
    expect(await liveAt(f, "1-projects")).toBe(true);
    expect(await liveAt(f, "Projects")).toBe(true);
    expect(await liveAt(f, "resources")).toBe(true);
  });

  test("two numbered spellings of one job: the folder doing the job takes the name, the other stays", async () => {
    const f = await keyedFixture();
    await folder(f, "4-archive");
    await folder(f, "9-archive", undefined, "archive");

    const counts = await run(f);

    expect(counts.twins).toBe(1);
    expect((await rowOf(f, "archive")).goneAt).toBeUndefined();
    expect(await roleAt(f, "archive")).toBe("archive");
    expect(await liveAt(f, "4-archive")).toBe(true);
  });

  test("a built-in nested somewhere loses its number where it is", async () => {
    const f = await keyedFixture();
    await folder(f, "work");
    await folder(f, "work/0-inbox", "work", "inbox");

    await run(f);

    expect(await liveAt(f, "work/inbox")).toBe(true);
    expect(await liveAt(f, "work/0-inbox")).toBe(false);
  });

  test("folders that only look numbered are not touched", async () => {
    const f = await keyedFixture();
    await folder(f, "2026-plans");
    await folder(f, "1-plan");
    await folder(f, "3-resources/1-projects", "3-resources");

    await run(f);

    expect(await liveAt(f, "2026-plans")).toBe(true);
    expect(await liveAt(f, "1-plan")).toBe(true);
    // Not a job's row and not at the root: a folder of that name inside Resources is somebody's own.
    expect(await liveAt(f, "resources/1-projects")).toBe(true);
  });

  test("a dry run counts and changes nothing", async () => {
    const f = await keyedFixture();
    const counts = await run(f, true);
    expect(counts).toMatchObject({ keyed: true, renamed: 0, wouldRename: 2 });
    expect(await liveAt(f, "1-projects")).toBe(true);
    expect(await liveAt(f, "projects")).toBe(false);
  });

  test("running it again changes nothing", async () => {
    const f = await keyedFixture();
    await run(f);
    const again = await run(f);
    expect(again).toMatchObject({ renamed: 0, wouldRename: 0, twins: 0 });
  });

  test("an unkeyed workspace is left alone: its rename would be a byte move", async () => {
    const f = await fixture();
    const counts = await run(f);
    expect(counts).toMatchObject({ keyed: false, renamed: 0, wouldRename: 0 });
    expect(await liveAt(f, "1-projects")).toBe(true);
  });

  test("a private subfolder the team cannot see moves with its folder", async () => {
    const f = await keyedFixture();
    await run(f);
    expect(await liveAt(f, "projects/secret/codes.md")).toBe(true);
    expect(await liveAt(f, "1-projects/secret/codes.md")).toBe(false);
  });

  test("the pass answers with counts and never a path", async () => {
    const f = await keyedFixture();
    await folder(f, "Projects");
    const counts = await run(f);
    expect(JSON.stringify(counts)).not.toMatch(/projects|resources|archive|inbox/i);
  });

  test("the page reads keyed workspaces in order and says where to resume", async () => {
    const f = await keyedFixture();
    const page = await f.t.query(internal.functions.folderNumbers.workspacePage, { limit: 10 });
    expect(page.workspaceIds).toContain(f.ws);
    expect(page.done).toBe(true);
  });
});
