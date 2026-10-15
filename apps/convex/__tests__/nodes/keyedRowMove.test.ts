import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { startQueuedMove } from "../../functions/lib/nodes/moveStart";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { OWNER, TEAM, fixture, listed, start } from "./moveFixture.helpers";
import { NOTE_ID, bytesOf, keyedFixture, liveAt, logOf, privacyEtag, rowOf, treeOf } from "./keyedFixture.helpers";

describe("a keyed workspace moves rows, not bytes", () => {
  test("renaming a file changes its row's path and leaves its id, key, etag and bytes where they were", async () => {
    const f = await keyedFixture();
    const before = await rowOf(f, "1-projects/keep.md");
    const bytesBefore = bytesOf(f);

    const moved = await start(f, "1-projects/keep.md", "1-projects/kept.md");

    expect(moved).toMatchObject({ from: "1-projects/keep.md", to: "1-projects/kept.md", rowed: true, queued: 1 });
    // The gateway renames each moved note's collaboration history, so the answer names every file that moved.
    expect(moved).toMatchObject({ moved: [{ from: "1-projects/keep.md", to: "1-projects/kept.md" }] });
    const after = await rowOf(f, "1-projects/kept.md");
    expect(after).toMatchObject({ _id: before._id, noteId: before.noteId, storageKey: before.storageKey, etag: before.etag, name: "kept.md" });
    expect(await liveAt(f, "1-projects/keep.md")).toBe(false);
    // Nothing was copied, deleted or queued: every object the bucket held is still exactly there.
    expect(bytesOf(f)).toEqual(bytesBefore);
    expect(await f.t.query(internal.functions.nodeMoves.active, { workspaceId: f.ws })).toEqual([]);
    expect(await listed(f.owner, f.ws, "1-projects")).toContain("1-projects/kept.md");
    expect(await listed(f.owner, f.ws, "1-projects")).not.toContain("1-projects/keep.md");
  });

  test("renaming a folder moves every row beneath it, keeping each folder row's identity and the children's parents", async () => {
    const f = await keyedFixture();
    const launch = await rowOf(f, "1-projects/launch");
    const sub = await rowOf(f, "1-projects/launch/sub");
    const deep = await rowOf(f, "1-projects/launch/sub/deep.md");
    const destination = await rowOf(f, "3-resources");

    const moved = await start(f, "1-projects/launch", "3-resources/launch");

    expect(moved).toMatchObject({ rowed: true, queued: 4 });
    expect(moved?.moved).toHaveLength(4);
    expect(moved?.moved).toContainEqual({ from: "1-projects/launch/sub/deep.md", to: "3-resources/launch/sub/deep.md" });
    const tree = await treeOf(f);
    const live = tree.filter((row) => row.live).map((row) => `${row.kind}:${row.path}`);
    expect(live).toEqual(
      expect.arrayContaining([
        "folder:3-resources/launch",
        "folder:3-resources/launch/sub",
        "file:3-resources/launch/brief.md",
        "file:3-resources/launch/plan.md",
        "file:3-resources/launch/pic.png",
        "file:3-resources/launch/sub/deep.md",
      ]),
    );
    expect(live.some((entry) => entry.startsWith("folder:1-projects/launch") || entry.startsWith("file:1-projects/launch"))).toBe(false);

    const launchAfter = await rowOf(f, "3-resources/launch");
    expect(launchAfter._id).toBe(launch._id);
    expect(launchAfter.parentId).toBe(destination._id);
    expect(launchAfter.name).toBe("launch");
    // The subfolder keeps its own row, and still hangs off the moved folder.
    const subAfter = await rowOf(f, "3-resources/launch/sub");
    expect(subAfter._id).toBe(sub._id);
    expect(subAfter.parentId).toBe(launch._id);
    const deepAfter = await rowOf(f, "3-resources/launch/sub/deep.md");
    expect(deepAfter).toMatchObject({ _id: deep._id, noteId: deep.noteId, storageKey: deep.storageKey });
  });

  test("a folder the move empties is retired, and the destination folders it needed are made", async () => {
    const f = await keyedFixture();
    // `3-resources` holds only `r.md`, so moving it away empties the folder; `2-areas` does not exist yet.
    await start(f, "3-resources/r.md", "2-areas/deep/r.md");

    const tree = await treeOf(f);
    const live = (path: string) => tree.some((row) => row.path === path && row.live);
    expect(live("3-resources")).toBe(false);
    expect(live("2-areas")).toBe(true);
    expect(live("2-areas/deep")).toBe(true);
    expect(tree.find((row) => row.path === "2-areas/deep/r.md")).toMatchObject({ live: true, name: "r.md", parent: "2-areas/deep" });
    expect(tree.find((row) => row.path === "2-areas/deep")).toMatchObject({ parent: "2-areas" });
  });

  test("a tombstone at the destination is replaced by the moved row, which keeps its own id", async () => {
    const f = await keyedFixture();
    const keep = await rowOf(f, "1-projects/keep.md");
    await f.t.run(async (ctx) => {
      await ctx.db.insert("nodes", {
        workspaceId: f.ws,
        noteId: NOTE_ID(255),
        path: "1-projects/gone.md",
        name: "gone.md",
        kind: "file",
        observedAt: 1,
        goneAt: 2,
      });
    });

    const moved = await start(f, "1-projects/keep.md", "1-projects/gone.md");

    expect(moved).toMatchObject({ rowed: true });
    const landed = await rowOf(f, "1-projects/gone.md");
    expect(landed.goneAt).toBeUndefined();
    expect(landed.noteId).toBe(keep.noteId);
  });
});

describe("a keyed move refuses what it cannot make true, and changes nothing", () => {
  test("a destination held by a live file is refused as taken, and the rows and rules are as they were", async () => {
    const f = await keyedFixture();
    const treeBefore = await treeOf(f);
    const rulesBefore = f.store.snapshot()[PRIVACY_KEY];

    await expect(start(f, "1-projects/keep.md", "3-resources/r.md")).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });

    expect(await treeOf(f)).toEqual(treeBefore);
    expect(f.store.snapshot()[PRIVACY_KEY]).toBe(rulesBefore);
  });

  test("a folder onto an existing folder is refused, never merged", async () => {
    const f = await keyedFixture();
    const treeBefore = await treeOf(f);

    await expect(start(f, "1-projects/launch", "3-resources")).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });

    expect(await treeOf(f)).toEqual(treeBefore);
  });

  test("a live row beneath the destination refuses the move, though nothing sits at the destination itself", async () => {
    const f = await keyedFixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("nodes", {
        workspaceId: f.ws,
        noteId: NOTE_ID(254),
        path: "3-resources/launch/orphan.md",
        name: "orphan.md",
        kind: "file",
        storageKey: `notes/${NOTE_ID(254)}.md`,
        observedAt: 1,
      });
    });

    await expect(start(f, "1-projects/launch", "3-resources/launch")).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });
  });

  test("a note with no key yet in the subtree is refused, and nothing moves", async () => {
    const f = await keyedFixture();
    const plan = await rowOf(f, "1-projects/launch/plan.md");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(plan._id, { storageKey: undefined });
    });
    const treeBefore = await treeOf(f);

    await expect(start(f, "1-projects/launch", "3-resources/launch")).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await treeOf(f)).toEqual(treeBefore);
  });

  test("a queued byte move still pending in the workspace makes the keyed move wait", async () => {
    const f = await keyedFixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("moveQueue", {
        workspaceId: f.ws,
        from: "1-projects/old",
        to: "3-resources/old",
        kind: "folder",
        state: "moving",
        scope: "private",
        grantedNames: [],
        total: 1,
        moved: 0,
        added: { folders: [], notes: [] },
        attempts: 0,
        nextAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
    });

    await expect(start(f, "1-projects/keep.md", "1-projects/kept.md")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await liveAt(f, "1-projects/keep.md")).toBe(true);
  });

  test("a file asked against an out-of-date version is refused, and the current version moves", async () => {
    const f = await keyedFixture();
    const row = await rowOf(f, "1-projects/keep.md");
    const run = (expectedEtag: string) =>
      startQueuedMove(f.ctx, {
        workspaceId: f.ws,
        store: f.store,
        from: "1-projects/keep.md",
        to: "1-projects/kept.md",
        clearance: OWNER,
        now: Date.now(),
        expectedEtag,
      });

    await expect(run("not-the-etag")).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await liveAt(f, "1-projects/keep.md")).toBe(true);

    const moved = await run(row.etag as string);
    expect(moved).toMatchObject({ rowed: true, etag: row.etag });
  });

  test("a folder holding a note the caller cannot see is refused, so no note moves without its rule", async () => {
    const f = await keyedFixture();
    // `1-projects/secret` is private: a team caller cannot see the codes note under it.
    const treeBefore = await treeOf(f);

    await expect(
      startQueuedMove(f.ctx, { workspaceId: f.ws, store: f.store, from: "1-projects", to: "3-resources/projects", clearance: TEAM, now: Date.now() }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(await treeOf(f)).toEqual(treeBefore);
  });

  test("a folder of more than the row cap is refused as too large, at the real limit", async () => {
    const f = await keyedFixture();
    await f.t.run(async (ctx) => {
      const folder = await ctx.db.insert("nodes", {
        workspaceId: f.ws,
        noteId: NOTE_ID(253),
        path: "2-areas/big",
        name: "big",
        kind: "folder",
        observedAt: 1,
      });
      for (let index = 0; index < 501; index += 1) {
        await ctx.db.insert("nodes", {
          workspaceId: f.ws,
          noteId: NOTE_ID(1000 + index),
          path: `2-areas/big/n${index}.md`,
          parentId: folder,
          name: `n${index}.md`,
          kind: "file",
          etag: "e",
          observedAt: 1,
          storageKey: `notes/${NOTE_ID(1000 + index)}.md`,
        });
      }
    });

    await expect(start(f, "2-areas/big", "3-resources/big")).rejects.toMatchObject({ code: "FOLDER_TOO_LARGE" });
    expect(await liveAt(f, "2-areas/big/n0.md")).toBe(true);
  });

  test("a note that arrived under the folder after the caller judged it is refused as changed, and nothing moves", async () => {
    const f = await keyedFixture();
    const judged = await f.t.query(internal.functions.nodeRowMoves.plan, { workspaceId: f.ws, from: "1-projects/launch" });
    await f.t.run(async (ctx) => {
      const launch = await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws).eq("path", "1-projects/launch"))
        .unique();
      await ctx.db.insert("nodes", {
        workspaceId: f.ws,
        noteId: NOTE_ID(900),
        path: "1-projects/launch/late.md",
        parentId: launch?._id,
        name: "late.md",
        kind: "file",
        observedAt: 1,
        storageKey: `notes/${NOTE_ID(900)}.md`,
      });
    });
    const treeBefore = await treeOf(f);

    const answer = await f.t.mutation(internal.functions.nodeRowMoves.rowMove, {
      workspaceId: f.ws,
      from: "1-projects/launch",
      to: "3-resources/launch",
      privacyEtag: await privacyEtag(f),
      plannedFiles: judged.files,
      now: Date.now(),
    });

    expect(answer).toEqual({ ok: false, reason: "changed" });
    expect(await treeOf(f)).toEqual(treeBefore);
  });

  test("the mutation itself refuses an unkeyed note under the name, whatever the caller checked first", async () => {
    const f = await keyedFixture();
    const plan = await rowOf(f, "1-projects/launch/plan.md");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(plan._id, { storageKey: undefined });
    });
    const treeBefore = await treeOf(f);

    const answer = await f.t.mutation(internal.functions.nodeRowMoves.rowMove, {
      workspaceId: f.ws,
      from: "1-projects/launch",
      to: "3-resources/launch",
      privacyEtag: await privacyEtag(f),
      now: Date.now(),
    });

    expect(answer).toEqual({ ok: false, reason: "unkeyed" });
    expect(await treeOf(f)).toEqual(treeBefore);
  });

  test("the mutation counts the cap itself, the name included: one row too many is too_large, the exact cap moves", async () => {
    const f = await keyedFixture();
    // `1-projects/launch` holds six live rows: the folder itself, its sub folder and four files.
    const privacy = await privacyEtag(f);
    const tooSmall = await f.t.mutation(internal.functions.nodeRowMoves.rowMove, {
      workspaceId: f.ws,
      from: "1-projects/launch",
      to: "3-resources/launch",
      privacyEtag: privacy,
      now: Date.now(),
      maxRows: 5,
    });
    expect(tooSmall).toEqual({ ok: false, reason: "too_large" });
    expect(await liveAt(f, "1-projects/launch")).toBe(true);

    const exact = await f.t.mutation(internal.functions.nodeRowMoves.rowMove, {
      workspaceId: f.ws,
      from: "1-projects/launch",
      to: "3-resources/launch",
      privacyEtag: privacy,
      now: Date.now(),
      maxRows: 6,
    });
    expect(exact).toMatchObject({ ok: true, kind: "folder", rows: 6 });
  });

  test("a row move of a non-keyed workspace is refused as not keyed, and changes nothing", async () => {
    const f = await fixture();
    const answer = await f.t.mutation(internal.functions.nodeRowMoves.rowMove, {
      workspaceId: f.ws,
      from: "1-projects/keep.md",
      to: "1-projects/kept.md",
      privacyEtag: null,
      now: Date.now(),
    });
    expect(answer).toEqual({ ok: false, reason: "not_keyed" });
    expect(await liveAt(f, "1-projects/keep.md")).toBe(true);
  });
});

describe("what a keyed move carries with it", () => {
  test("the change log says the file left its old path and appeared at the new one", async () => {
    const f = await keyedFixture();
    const before = (await logOf(f)).length;

    await start(f, "1-projects/keep.md", "1-projects/kept.md");

    expect((await logOf(f)).slice(before)).toEqual(
      expect.arrayContaining([
        { path: "1-projects/keep.md", gone: true },
        { path: "1-projects/kept.md", gone: false },
      ]),
    );
  });

  test("a folder move logs each file it moved at both names, and no folder", async () => {
    const f = await keyedFixture();
    const before = (await logOf(f)).length;

    await start(f, "1-projects/launch", "3-resources/launch");

    const entries = (await logOf(f)).slice(before);
    expect(entries).toEqual(
      expect.arrayContaining([
        { path: "1-projects/launch/brief.md", gone: true },
        { path: "3-resources/launch/brief.md", gone: false },
        { path: "1-projects/launch/sub/deep.md", gone: true },
        { path: "3-resources/launch/sub/deep.md", gone: false },
      ]),
    );
    expect(entries.map((entry) => entry.path).filter((path) => path.endsWith("/sub") || path.endsWith("/launch"))).toEqual([]);
  });

  test("the facts a note's row holds, and the links that name it, follow the move", async () => {
    const f = await keyedFixture();
    const plan = await rowOf(f, "1-projects/launch/plan.md");
    await f.t.run(async (ctx) => {
      await ctx.db.patch(plan._id, { props: '{"heading":"Plan"}' });
      await ctx.db.insert("nodeLinks", { workspaceId: f.ws, source: "1-projects/launch/plan.md", kind: "path", target: "brief.md" });
    });

    await start(f, "1-projects/launch", "3-resources/launch");

    expect((await rowOf(f, "3-resources/launch/plan.md")).props).toBe('{"heading":"Plan"}');
    const sources = await f.t.run(async (ctx) =>
      (await ctx.db.query("nodeLinks").withIndex("by_workspace_source", (q) => q.eq("workspaceId", f.ws)).collect()).map((link) => link.source),
    );
    expect(sources).toContain("3-resources/launch/plan.md");
    expect(sources).not.toContain("1-projects/launch/plan.md");
  });

  test("a private note moved into a team folder stays private for a team member", async () => {
    const f = await keyedFixture();

    await start(f, "1-projects/secret/codes.md", "3-resources/codes.md");

    expect(await liveAt(f, "3-resources/codes.md")).toBe(true);
    expect(await listed(f.member, f.ws, "3-resources")).not.toContain("3-resources/codes.md");
    expect(await listed(f.owner, f.ws, "3-resources")).toContain("3-resources/codes.md");
  });

  test("a move that is refused leaves the privacy rules as they were", async () => {
    const f = await keyedFixture();
    const rulesBefore = f.store.snapshot()[PRIVACY_KEY];

    await expect(start(f, "1-projects/secret/codes.md", "3-resources/r.md")).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });

    expect(f.store.snapshot()[PRIVACY_KEY]).toBe(rulesBefore);
  });
});

describe("a workspace that is not keyed still moves the old way", () => {
  test("a folder moves as a queued byte move, with no row change", async () => {
    const f = await fixture();
    const moved = await start(f, "1-projects/launch", "3-resources/launch");
    expect(moved).toMatchObject({ from: "1-projects/launch", to: "3-resources/launch", queued: 4 });
    expect(moved).not.toHaveProperty("rowed");
  });

  test("a single note moves the old way: the keyed branch does not answer", async () => {
    const f = await fixture();
    const answer = await startQueuedMove(f.ctx, {
      workspaceId: f.ws,
      store: f.store,
      from: "1-projects/keep.md",
      to: "1-projects/kept.md",
      clearance: OWNER,
      now: Date.now(),
    });
    expect(answer).toBeNull();
  });
});
