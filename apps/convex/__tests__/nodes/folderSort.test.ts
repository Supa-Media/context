import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { keyedFixture, rowOf } from "./keyedFixture.helpers";
import { withSession } from "../session.helpers";

// A folder's Sort setting and notes in custom order (owner, 2026-11-04;
// `docs/decisions/app-and-console/folder-sort.md`).

type Entry = { kind: string; name: string; path: string; order?: number; createdAt?: number; sort?: string };

async function listing(f: Awaited<ReturnType<typeof keyedFixture>>, path: string, who = f.owner) {
  const answer = await who.query(api.functions.nodesListing.listFolder, { workspaceId: f.ws, path });
  expect(answer).not.toBeNull();
  return answer as { sort?: string; entries: Entry[] };
}

async function editor(f: Awaited<ReturnType<typeof keyedFixture>>) {
  const id = await f.t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email: "editor@example.test", emailVerificationTime: Date.now() } as never);
    await ctx.db.insert("workspaceMembers", { workspaceId: f.ws, userId, role: "editor", joinedAt: Date.now() });
    return userId;
  });
  return withSession(f.t, id);
}

describe("folder Sort setting", () => {
  test("a folder's setting is on its row, listed on it, and drawn by the folders beneath it", async () => {
    const f = await keyedFixture();
    await f.owner.action(api.functions.folderSort.set, { workspaceId: f.ws, folder: "1-projects", sort: "edited-desc" });
    expect(((await rowOf(f, "1-projects")) as { sort?: string }).sort).toBe("edited-desc");

    const root = await listing(f, "");
    expect(root.entries.find((entry) => entry.path === "1-projects")?.sort).toBe("edited-desc");
    expect((await listing(f, "1-projects")).sort).toBe("edited-desc");
    // `launch` has none of its own, so it draws by the nearest folder above it.
    expect((await listing(f, "1-projects/launch")).sort).toBe("edited-desc");

    // Custom order is what was dragged in that one folder: it is never passed down.
    await f.owner.action(api.functions.folderSort.set, { workspaceId: f.ws, folder: "1-projects/launch", sort: "custom" });
    expect((await listing(f, "1-projects/launch")).sort).toBe("custom");
    expect((await listing(f, "1-projects/launch/sub")).sort).toBe("edited-desc");
  });

  test("every row says when it was made", async () => {
    const f = await keyedFixture();
    const entries = (await listing(f, "1-projects")).entries;
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(typeof entry.createdAt).toBe("number");
  });

  test("the top level's setting is the workspace's, read by its members only", async () => {
    const f = await keyedFixture();
    expect(await f.member.query(api.functions.folderSort.workspaceSort, { workspaceId: f.ws })).toBeNull();
    await f.owner.action(api.functions.folderSort.set, { workspaceId: f.ws, folder: "", sort: "name-desc" });
    expect(await f.member.query(api.functions.folderSort.workspaceSort, { workspaceId: f.ws })).toBe("name-desc");
    const stranger = await f.t.run(async (ctx) => await ctx.db.insert("users", { email: "x@example.test", emailVerificationTime: 1 } as never));
    expect(await withSession(f.t, stranger).query(api.functions.folderSort.workspaceSort, { workspaceId: f.ws })).toBeNull();
    // Cleared with null: back to the order with no setting.
    await f.owner.action(api.functions.folderSort.set, { workspaceId: f.ws, folder: "", sort: null });
    expect(await f.owner.query(api.functions.folderSort.workspaceSort, { workspaceId: f.ws })).toBeNull();
  });

  test("Apply to folders inside clears the settings beneath, and only the ones the caller can see", async () => {
    const f = await keyedFixture();
    for (const folder of ["1-projects/launch", "1-projects/launch/sub", "1-projects/secret"]) {
      const id = (await rowOf(f, folder))._id as Id<"nodes">;
      await f.t.run(async (ctx) => await ctx.db.patch(id, { sort: "name-desc" }));
    }
    const writer = await editor(f);
    await writer.action(api.functions.folderSort.set, { workspaceId: f.ws, folder: "1-projects", sort: "created-asc", inside: true });
    expect(((await rowOf(f, "1-projects/launch")) as { sort?: string }).sort).toBeUndefined();
    expect(((await rowOf(f, "1-projects/launch/sub")) as { sort?: string }).sort).toBeUndefined();
    // The private folder is not the editor's to see: it keeps its own.
    expect(((await rowOf(f, "1-projects/secret")) as { sort?: string }).sort).toBe("name-desc");
    expect((await listing(f, "1-projects/launch/sub")).sort).toBe("created-asc");
  });

  test("a member cannot change it, an unknown sort is refused, and a hidden folder answers as absent", async () => {
    const f = await keyedFixture();
    await expect(f.member.action(api.functions.folderSort.set, { workspaceId: f.ws, folder: "1-projects", sort: "custom" })).rejects.toThrow();
    await expect(f.owner.action(api.functions.folderSort.set, { workspaceId: f.ws, folder: "1-projects", sort: "size-desc" })).rejects.toThrow(
      /not a way to sort/,
    );
    const writer = await editor(f);
    await expect(writer.action(api.functions.folderSort.set, { workspaceId: f.ws, folder: "1-projects/secret", sort: "custom" })).rejects.toThrow(
      /not there/,
    );
    expect(((await rowOf(f, "1-projects/secret")) as { sort?: string }).sort).toBeUndefined();
    expect(((await rowOf(f, "1-projects")) as { sort?: string }).sort).toBeUndefined();
  });

  test("a listing of a hidden folder says nothing of its setting", async () => {
    const f = await keyedFixture();
    await f.owner.action(api.functions.folderSort.set, { workspaceId: f.ws, folder: "1-projects/secret", sort: "custom" });
    const writer = await editor(f);
    const hidden = await listing(f, "1-projects/secret", writer);
    expect(hidden.sort).toBeUndefined();
    expect(hidden.entries).toEqual([]);
  });
});

describe("notes in custom order", () => {
  test("notes and folders take an order on their rows, and the listing carries it", async () => {
    const f = await keyedFixture();
    await f.owner.action(api.functions.folderOrder.set, {
      workspaceId: f.ws,
      parent: "1-projects",
      folders: ["1-projects/keep.md", "1-projects/launch"],
    });
    const entries = (await listing(f, "1-projects")).entries;
    expect(entries.find((entry) => entry.path === "1-projects/keep.md")?.order).toBe(0);
    expect(entries.find((entry) => entry.path === "1-projects/launch")?.order).toBe(10);
  });

  test("an editor's order never touches a row they cannot see", async () => {
    const f = await keyedFixture();
    const writer = await editor(f);
    await writer.action(api.functions.folderOrder.set, {
      workspaceId: f.ws,
      parent: "1-projects",
      folders: ["1-projects/secret", "1-projects/keep.md"],
    });
    expect(((await rowOf(f, "1-projects/secret")) as { order?: number }).order).toBeUndefined();
    // Positions are counted among the rows written: the hidden one keeps the place it had.
    expect(((await rowOf(f, "1-projects/keep.md")) as { order?: number }).order).toBe(0);
  });

  test("the internal write keeps a note only when it was judged visible as a note", async () => {
    const f = await keyedFixture();
    const written = await f.t.mutation(internal.functions.folderOrder.write, {
      workspaceId: f.ws,
      parent: "1-projects",
      folders: ["1-projects/keep.md", "1-projects/launch"],
      notes: [],
      visibleFolders: ["1-projects/launch", "1-projects/keep.md"],
    });
    expect(written).toBe(1);
    expect(((await rowOf(f, "1-projects/keep.md")) as { order?: number }).order).toBeUndefined();
  });
});
