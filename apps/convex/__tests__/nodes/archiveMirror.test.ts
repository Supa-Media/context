import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { executeOperation } from "../../functions/lib/filesFns/executeOperation";
import { attachQueueMove } from "../../functions/lib/nodes/moveBarrier";
import { attachTreeListing } from "../../functions/lib/nodes/treeNames";
import { attachWorkspaceKeyed } from "../../functions/lib/noteIds/keyedStore";
import { NOTE_ID, keyedFixture, liveAt, rowOf } from "./keyedFixture.helpers";
import { OWNER, TEAM, start, type Fixture } from "./moveFixture.helpers";

// Archive keeps the workspace's shape (owner, 2026-10-18; `lib/nodes/archiveTwins.ts`,
// `archiveMirror.cjs`): each built-in folder has a marked twin in Archive that follows its
// renames and moves, Archive itself stays at the top, and no built-in folder goes into it.
//
// Sabotage, each run as a temporary local edit and reverted, and each failing here:
//  - drop `withArchive` from `startRowMove`: the twin stays at the old name (rename, nest, merge cases);
//  - name every carried file in the answer, whatever the caller may see: the team rename lists the private archive;
//  - drop "archiveTidy" from the barrier's `QUEUEING`: the keyed tidy moves nothing (the old path move is refused);
//  - drop `markArchiveTwins`' patch: no twin is marked;
//  - drop the `archive_stays` / `built_in_archived` returns from `archiveMoveRefusal`: the guard cases move.

async function withArchive(): Promise<Fixture> {
  const f = await keyedFixture();
  await f.t.run(async (ctx) => {
    await ctx.db.insert("nodes", { workspaceId: f.ws, noteId: NOTE_ID(500), path: "9-archive", name: "9-archive", kind: "folder", observedAt: 1, role: "archive" });
  });
  return f;
}

async function archiveOf(f: Fixture, path: string): Promise<string | undefined> {
  return ((await rowOf(f, path)) as { archiveOf?: string }).archiveOf;
}

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("the move was not refused");
}

describe("Archive mirrors the built-in folders", () => {
  test("archiving a project lands it under Archive's Projects, and that folder is marked as Projects' twin", async () => {
    const f = await withArchive();
    const brief = await rowOf(f, "1-projects/launch/brief.md");

    await start(f, "1-projects/launch", "9-archive/1-projects/launch");

    expect(await archiveOf(f, "9-archive/1-projects")).toBe("projects");
    // The project itself is not a twin, and its notes are the same notes.
    expect(await archiveOf(f, "9-archive/1-projects/launch")).toBeUndefined();
    expect((await rowOf(f, "9-archive/1-projects/launch/brief.md"))._id).toBe(brief._id);
  });

  test("renaming the Projects folder renames its twin, which keeps its id, its mark and what is in it", async () => {
    const f = await withArchive();
    await start(f, "1-projects/launch", "9-archive/1-projects/launch");
    const twin = await rowOf(f, "9-archive/1-projects");

    const moved = await start(f, "1-projects", "Projects");

    expect((await rowOf(f, "9-archive/Projects"))._id).toBe(twin._id);
    expect(await archiveOf(f, "9-archive/Projects")).toBe("projects");
    expect(await liveAt(f, "9-archive/Projects/launch/brief.md")).toBe(true);
    expect(await liveAt(f, "9-archive/1-projects")).toBe(false);
    // The files the twin carried are in the answer, so links to them follow.
    expect((moved as { moved?: { to: string }[] }).moved?.map((pair) => pair.to)).toContain("9-archive/Projects/launch/brief.md");
  });

  test("moving Projects into a new folder gives Archive the same folder, with the twin inside it", async () => {
    const f = await withArchive();
    await start(f, "1-projects/launch", "9-archive/1-projects/launch");

    await start(f, "1-projects", "Work/Projects");

    expect(await archiveOf(f, "9-archive/Work/Projects")).toBe("projects");
    expect(await liveAt(f, "9-archive/Work/Projects/launch/plan.md")).toBe(true);
    // The new Work inside Archive is an ordinary folder.
    expect(await archiveOf(f, "9-archive/Work")).toBeUndefined();

    // And moving the folder holding Projects carries the twin too.
    await start(f, "Work", "Desk/Work");
    expect(await archiveOf(f, "9-archive/Desk/Work/Projects")).toBe("projects");
  });

  test("a member who moves Projects moves its twin too, and is not told what the private Archive holds", async () => {
    const f = await withArchive();
    await start(f, "1-projects/launch", "9-archive/1-projects/launch");
    // The member may see all that is left in Projects, so may move it into a shared folder.
    await start(f, "1-projects/secret", "9-archive/1-projects/secret");

    const moved = await start(f, "1-projects", "3-resources/Projects", TEAM);

    expect(await archiveOf(f, "9-archive/3-resources/Projects")).toBe("projects");
    expect(await liveAt(f, "9-archive/3-resources/Projects/secret/codes.md")).toBe(true);
    const named = (moved as { moved?: { from: string; to: string }[] }).moved ?? [];
    expect(named.map((pair) => pair.to)).toContain("3-resources/Projects/keep.md");
    expect(named.some((pair) => pair.to.startsWith("9-archive/") || pair.from.startsWith("9-archive/"))).toBe(false);
  });

  test("a twin that moves onto a folder already in Archive merges into it, a taken note numbered", async () => {
    const f = await withArchive();
    await start(f, "1-projects/launch/brief.md", "9-archive/1-projects/launch/brief.md");
    // Somebody already filed an older brief under the new name.
    await start(f, "1-projects/keep.md", "9-archive/Projects/launch/brief.md");

    await start(f, "1-projects", "Projects");

    expect(await liveAt(f, "9-archive/Projects/launch/brief.md")).toBe(true);
    expect(await liveAt(f, "9-archive/Projects/launch/brief (2).md")).toBe(true);
    expect(await liveAt(f, "9-archive/1-projects")).toBe(false);
  });

  test("an ordinary folder renamed after its things were archived keeps its old name in Archive", async () => {
    const f = await withArchive();
    await start(f, "1-projects/launch/plan.md", "9-archive/1-projects/launch/plan.md");

    await start(f, "1-projects/launch", "1-projects/kickoff");

    expect(await liveAt(f, "9-archive/1-projects/launch/plan.md")).toBe(true);
    expect(await liveAt(f, "9-archive/1-projects/kickoff")).toBe(false);
  });
});

describe("Archive stays put, and built-in folders stay out of it", () => {
  test("Archive can be renamed at the top level, but not moved inside another folder", async () => {
    const f = await withArchive();
    expect(await refusalOf(start(f, "9-archive", "1-projects/9-archive"))).toMatch(/Archive stays at the top level/);
    expect(await liveAt(f, "9-archive")).toBe(true);

    await start(f, "9-archive", "Done");
    expect(((await rowOf(f, "Done")) as { role?: string }).role).toBe("archive");
  });

  test("a built-in folder, or a folder holding one, cannot go into Archive; what is inside it can", async () => {
    const f = await withArchive();
    expect(await refusalOf(start(f, "1-projects", "9-archive/1-projects"))).toMatch(/Built-in folders can't go into Archive/);
    await start(f, "1-projects", "Work/Projects");
    expect(await refusalOf(start(f, "Work", "9-archive/Work"))).toMatch(/Built-in folders can't go into Archive/);
    expect(await liveAt(f, "Work/Projects/keep.md")).toBe(true);

    await start(f, "Work/Projects/keep.md", "9-archive/Work/Projects/keep.md");
    expect(await liveAt(f, "9-archive/Work/Projects/keep.md")).toBe(true);
  });
});

describe("the hourly tidy finds the workspaces that still have date folders", () => {
  async function scheduledTidies(f: Fixture): Promise<number> {
    return await f.t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.name.includes("archiveTidy:tidyWorkspace")).length,
    );
  }

  test("a date folder in Archive schedules a tidy; an Archive without one does not", async () => {
    const f = await withArchive();
    await f.t.mutation(internal.functions.archiveTidy.catchUp, {});
    expect(await scheduledTidies(f)).toBe(0);

    await f.t.run(async (ctx) => {
      const archive = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws).eq("path", "9-archive")).unique();
      await ctx.db.insert("nodes", {
        workspaceId: f.ws,
        noteId: NOTE_ID(501),
        path: "9-archive/2026-10-15T22-16-49-545Z",
        name: "2026-10-15T22-16-49-545Z",
        parentId: archive!._id,
        kind: "folder",
        observedAt: 1,
      });
    });
    await f.t.mutation(internal.functions.archiveTidy.catchUp, {});
    expect(await scheduledTidies(f)).toBe(1);
  });
});

describe("the tidy, in a workspace that keeps its notes by id", () => {
  /** Run one operation through the barrier's seams, as `fileOperationBarrier.ts` attaches them. */
  function operate(f: Fixture, operation: Parameters<typeof executeOperation>[2]) {
    const args = { workspaceId: f.ws, scope: OWNER.scope, operation: { kind: operation.kind } };
    attachQueueMove(f.ctx, args, f.store, f.store);
    attachWorkspaceKeyed(f.ctx, f.ws, f.store);
    attachTreeListing(f.ctx, f.ws, f.store);
    return executeOperation(f.store, OWNER, operation, Date.now());
  }

  test("empties a date folder into Archive's shape as row moves, each note keeping its id", async () => {
    const f = await withArchive();
    const stamp = "9-archive/2026-10-15T22-16-49-545Z";
    await start(f, "1-projects/launch", `${stamp}/1-projects/launch`);
    const brief = await rowOf(f, `${stamp}/1-projects/launch/brief.md`);

    const answer = (await operate(f, { kind: "archiveTidy" })) as { paths?: string[]; queued?: number };

    expect(answer.paths?.length ?? 0).toBeGreaterThan(0);
    expect((await rowOf(f, "9-archive/1-projects/launch/brief.md"))._id).toBe(brief._id);
    expect(await liveAt(f, `${stamp}/1-projects/launch/brief.md`)).toBe(false);
    expect(await archiveOf(f, "9-archive/1-projects")).toBe("projects");
  });
});
