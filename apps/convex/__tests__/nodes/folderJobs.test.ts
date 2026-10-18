import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { canonicalJobPath, folderJobsOf } from "../../functions/lib/nodes/folderJobs";
import { followedPath } from "../../functions/lib/nodes/settingsFollow";
import { listed, start } from "./moveFixture.helpers";
import { NOTE_ID, keyedFixture, liveAt, rowOf } from "./keyedFixture.helpers";
import type { Fixture } from "./moveFixture.helpers";

// Built-in folders keep their job through a rename or a move (owner, 2026-10-18,
// `docs/decisions/app-and-console/folder-jobs.md`).

async function roleAt(f: Fixture, path: string): Promise<string | undefined> {
  return ((await rowOf(f, path)) as { role?: string }).role;
}

async function jobs(f: Fixture) {
  return await f.t.run(async (ctx) => await folderJobsOf(ctx.db, f.ws));
}

describe("folder jobs on rows", () => {
  test("a root folder made under a job's name takes the job on its row; an own folder does not", async () => {
    const f = await keyedFixture();
    // The sweep made these rows (`convexNodeTable.insert`).
    expect(await roleAt(f, "1-projects")).toBe("projects");
    expect(await roleAt(f, "3-resources")).toBe("resources");
    expect(await roleAt(f, "1-projects/launch")).toBeUndefined();
  });

  test("renaming the Projects folder keeps its job, and the job is found at the new name", async () => {
    const f = await keyedFixture();
    const before = await rowOf(f, "1-projects");
    const moved = await start(f, "1-projects", "Work");
    expect(moved).toMatchObject({ rowed: true });
    const after = await rowOf(f, "Work");
    expect(after._id).toBe(before._id);
    expect(await roleAt(f, "Work")).toBe("projects");
    expect((await jobs(f)).jobs.projects).toBe("Work");
  });

  test("a folder whose row predates jobs writes its job down before its first move", async () => {
    const f = await keyedFixture();
    // As every row made before `role` existed.
    const resources = await rowOf(f, "3-resources");
    await f.t.run(async (ctx) => await ctx.db.patch(resources._id, { role: undefined }));
    expect((await jobs(f)).jobs.resources).toBe("3-resources");

    await start(f, "3-resources", "1-projects/Library");
    expect(await roleAt(f, "1-projects/Library")).toBe("resources");
    expect((await jobs(f)).jobs.resources).toBe("1-projects/Library");
  });

  test("a default name written after a rename lands in the renamed folder, not a new one", async () => {
    const f = await keyedFixture();
    await start(f, "1-projects", "Work");
    const path = await f.t.run(async (ctx) => await canonicalJobPath(ctx.db, f.ws, "1-projects/new.md"));
    expect(path).toBe("Work/new.md");

    // A write the gateway makes under the old name adopts its row in the renamed folder.
    const answer = await f.t.mutation(internal.functions.noteIdsKeyed.adoptKeyed, {
      workspaceId: f.ws,
      path: "1-projects/new.md",
      noteId: NOTE_ID(77),
      key: `notes/${NOTE_ID(77)}.md`,
      etag: "e1",
      at: Date.now(),
    });
    expect(answer).toEqual({ adopted: true });
    expect(await liveAt(f, "Work/new.md")).toBe(true);
    expect(await liveAt(f, "1-projects")).toBe(false);

    // And reading it back by either name finds the same note.
    const found = await f.t.query(internal.functions.noteIdsKeyed.notesFor, {
      workspaceId: f.ws,
      paths: ["1-projects/new.md", "Work/new.md"],
    });
    expect(found.notes.map((note) => note.path).sort()).toEqual(["1-projects/new.md", "Work/new.md"]);
    expect(new Set(found.notes.map((note) => (note as { noteId?: string }).noteId))).toEqual(new Set([NOTE_ID(77)]));
  });

  test("a folder that really has the name wins over the rule", async () => {
    const f = await keyedFixture();
    // `projects` is an ordinary folder beside the real one, made before the twin guard.
    await f.t.run(async (ctx) => {
      await ctx.db.insert("nodes", { workspaceId: f.ws, noteId: NOTE_ID(90), path: "projects", name: "projects", kind: "folder", observedAt: 1 });
    });
    expect(await roleAt(f, "projects")).toBeUndefined();
    const path = await f.t.run(async (ctx) => await canonicalJobPath(ctx.db, f.ws, "projects/a.md"));
    expect(path).toBe("projects/a.md");
  });

  test("an emptied built-in folder stays; an emptied own folder goes", async () => {
    const f = await keyedFixture();
    await start(f, "3-resources/r.md", "1-projects/r.md");
    expect(await liveAt(f, "3-resources")).toBe(true);
    await start(f, "1-projects/secret/codes.md", "1-projects/codes.md");
    expect(await liveAt(f, "1-projects/secret")).toBe(false);
  });

  test("the root listing carries each folder's job, and a renamed one keeps its place", async () => {
    const f = await keyedFixture();
    await start(f, "1-projects", "Zebra work");
    const listing = await f.owner.query(api.functions.nodesListing.listFolder, { workspaceId: f.ws, path: "" });
    const folders = listing!.entries.filter((entry: { kind: string }) => entry.kind === "folder");
    expect(folders.map((entry: { name: string; role?: string }) => [entry.name, entry.role])).toEqual([
      ["Zebra work", "projects"],
      ["3-resources", "resources"],
    ]);
  });

  test("an order set on rows decides the drawing order", async () => {
    const f = await keyedFixture();
    const written = await f.t.mutation(internal.functions.folderOrder.write, {
      workspaceId: f.ws,
      parent: "",
      folders: ["3-resources", "1-projects"],
    });
    expect(written).toBe(2);
    const listing = await f.owner.query(api.functions.nodesListing.listFolder, { workspaceId: f.ws, path: "" });
    const names = listing!.entries.filter((entry: { kind: string }) => entry.kind === "folder").map((entry: { name: string }) => entry.name);
    expect(names).toEqual(["3-resources", "1-projects"]);
    // A folder that is not directly under the parent is not ordered there.
    expect(
      await f.t.mutation(internal.functions.folderOrder.write, { workspaceId: f.ws, parent: "", folders: ["1-projects/launch"] }),
    ).toBe(0);
  });

  test("settings that name a folder follow it when it moves", async () => {
    const f = await keyedFixture();
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.ws, { meetingsFolder: "1-projects/meetings" });
      await ctx.db.insert("ingestionSettings", {
        workspaceId: f.ws,
        targetFolder: "1-projects/",
        allowedSenders: [],
        allowedDomains: [],
        allowAnySender: false,
        updatedBy: f.ownerId,
        createdAt: 1,
        updatedAt: 1,
      } as never);
    });
    await start(f, "1-projects", "Work");
    const after = await f.t.run(async (ctx) => ({
      meetings: (await ctx.db.get(f.ws as Id<"workspaces">))?.meetingsFolder,
      target: (await ctx.db.query("ingestionSettings").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).unique())?.targetFolder,
    }));
    expect(after).toEqual({ meetings: "Work/meetings", target: "Work/" });
  });
});

describe("followedPath", () => {
  test("rewrites the folder and paths under it, keeping a trailing slash, and nothing else", () => {
    expect(followedPath("0-inbox/", "0-inbox", "Capture")).toBe("Capture/");
    expect(followedPath("0-inbox/meetings", "0-inbox", "Capture")).toBe("Capture/meetings");
    expect(followedPath("0-inbox", "0-inbox", "Capture")).toBe("Capture");
    expect(followedPath("0-inbox-old/x", "0-inbox", "Capture")).toBeNull();
    expect(followedPath(undefined, "0-inbox", "Capture")).toBeNull();
  });
});
