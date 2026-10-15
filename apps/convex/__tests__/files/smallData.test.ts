import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { FOLDER_ICONS_KEY, parseFolderIcons, serializeFolderIcons } from "@context/shared/src/folderIcons.cjs";
import { FORWARDING_PATH, parseForwarding, serializeForwarding } from "../../../mcp/src/forwarding.js";
import { asUser, captureError } from "../fixtures.helpers";
import { type Fixture, danglingWorkspaceId, errorShape, fixture, share } from "./fixtures.helpers";

/**
 * A workspace's small data held in Convex (`functions/smallData.ts`), end to
 * end through the real actions and a bucket that speaks S3: folder icons,
 * the names of its own emoji, and the forwarding ledger.
 *
 * What is proved:
 *  - listing or setting an icon, and listing an emoji, never reads
 *    `.context/folder-icons.json` or the image store: the rows answer;
 *  - the files are still written, in the same format, behind every change;
 *  - the one-time import brings in what the bucket held, and never over a
 *    value Convex already held: an icon set or removed first wins, a move
 *    recorded first carries the file's icons and collapses the file's chain;
 *  - a second sync reads nothing back;
 *  - a stranger is answered exactly as for a workspace that does not exist,
 *    and one workspace's rows never answer for another;
 *  - deleting the workspace's tree purges the rows; a storage move keeps the
 *    icons and ledger, drops the emoji names, and imports the new bucket.
 *
 * Sabotage (temporary local edits, reverted):
 *  - the import inserting a file icon over an existing row: "a value Convex
 *    held before the import wins" fails;
 *  - `purgeSmallDataBatch` skipping the ledger: "deleting the tree purges
 *    the rows" fails.
 *
 * Every value is obviously fake; this repository is public.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 3, 3]);

/** Let every scheduled sync start and finish (`runAfter(0)` runs on real timers here). */
async function settle(f: Fixture): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await f.t.finishInProgressScheduledFunctions();
  }
}

async function sync(f: Fixture, workspaceId: Id<"workspaces"> = f.workspaceId): Promise<void> {
  await f.t.action(internal.functions.files.runFileOperation, {
    workspaceId,
    scope: "private",
    operation: { kind: "nodesSmallData" },
  });
  await settle(f);
}

function fileText(f: Fixture, key: string): string | undefined {
  const text = f.backend.snapshot()[key];
  return typeof text === "string" ? text : undefined;
}

/**
 * GETs of `key` that were not the storage layer looking at what a write is
 * about to replace (`logicalDelete.js` reads the current object before an
 * unconditional put, to keep a deletion marker; the bytes go nowhere).
 */
function reads(f: Fixture, key: string): number {
  const onKey = f.backend.requests.filter((request) => request.key === key);
  return onKey.filter((request, at) => request.method === "GET" && onKey[at + 1]?.method !== "PUT").length;
}

function imageReads(f: Fixture): number {
  const keys = new Set(f.backend.requests.map((request) => request.key).filter((key) => key.startsWith(".context/assets/images/")));
  return [...keys].reduce((sum, key) => sum + reads(f, key), 0);
}

describe("icons and emoji answer from Convex", () => {
  test("listing and setting never read the bucket's files, and the files are written behind", async () => {
    const f = await fixture();
    await share(f);
    await sync(f);
    f.backend.requests.length = 0;

    const owner = asUser(f.t, f.owner);
    await owner.action(api.functions.folderIcons.set, { workspaceId: f.workspaceId, path: "1-projects", icon: "🚀" });
    await owner.action(api.functions.folderIcons.set, { workspaceId: f.workspaceId, path: "2-areas", icon: "🌲" });
    await asUser(f.t, f.editor).action(api.functions.emoji.add, { workspaceId: f.workspaceId, name: "ship", bytes: PNG.buffer });
    const forOwner = await owner.action(api.functions.folderIcons.list, { workspaceId: f.workspaceId });
    const forReader = await asUser(f.t, f.reader).action(api.functions.folderIcons.list, { workspaceId: f.workspaceId });
    const emoji = await asUser(f.t, f.reader).action(api.functions.emoji.list, { workspaceId: f.workspaceId });
    await settle(f);

    expect(forOwner).toEqual([
      { path: "1-projects", icon: "🚀" },
      { path: "2-areas", icon: "🌲" },
    ]);
    // `2-areas` is private: a member is not told its icon, nor that it has one.
    expect(forReader).toEqual([{ path: "1-projects", icon: "🚀" }]);
    expect(emoji).toEqual([{ name: "ship", leaf: "emoji-ship.png" }]);
    expect(reads(f, FOLDER_ICONS_KEY)).toBe(0);
    expect(reads(f, FORWARDING_PATH)).toBe(0);
    expect(f.backend.requests.some((request) => request.method === "LIST" || request.key === "")).toBe(false);
    expect(imageReads(f)).toBe(0);
    expect(parseFolderIcons(fileText(f, FOLDER_ICONS_KEY))).toEqual({ "1-projects": "🚀", "2-areas": "🌲" });
  });

  test("a stranger is answered as for a workspace that does not exist", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.folderIcons.set, { workspaceId: f.workspaceId, path: "1-projects", icon: "🚀" });
    const dangling = await danglingWorkspaceId(f.t);
    const as = asUser(f.t, f.stranger);
    const calls = [
      (workspaceId: Id<"workspaces">) => as.action(api.functions.folderIcons.list, { workspaceId }),
      (workspaceId: Id<"workspaces">) => as.action(api.functions.folderIcons.set, { workspaceId, path: "1-projects", icon: "🌲" }),
      (workspaceId: Id<"workspaces">) => as.action(api.functions.emoji.list, { workspaceId }),
    ];
    for (const call of calls) {
      expect(errorShape(await captureError(() => call(f.workspaceId)))).toBe(errorShape(await captureError(() => call(dangling))));
    }
  });

  test("one workspace's rows never answer for another", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.folderIcons.set, { workspaceId: f.workspaceId, path: "1-projects", icon: "🚀" });
    await f.t.mutation(internal.functions.smallData.recordForwarding, {
      workspaceId: f.workspaceId,
      moves: [{ from: "1-projects/a.md", to: "1-projects/b.md", kind: "note" }],
      now: 1_000,
    });
    await f.t.mutation(internal.functions.smallData.putEmoji, { workspaceId: f.workspaceId, name: "ship", leaf: "emoji-ship.png" });
    const theirs = await f.t.run(async (ctx) =>
      (await ctx.db.query("workspaces").collect()).find((row) => row._id !== f.workspaceId)!._id,
    );
    expect(await f.t.query(internal.functions.smallData.icons, { workspaceId: theirs })).toEqual([]);
    expect(await f.t.query(internal.functions.smallData.ledger, { workspaceId: theirs })).toEqual([]);
    expect(await f.t.query(internal.functions.smallData.emojiList, { workspaceId: theirs })).toEqual([]);
    expect(await f.t.query(internal.functions.smallData.forward, { workspaceId: theirs, paths: ["1-projects/a.md"] })).toEqual([
      "1-projects/a.md",
    ]);
  });
});

describe("the one-time import", () => {
  async function bucketWithFiles(): Promise<Fixture> {
    const f = await fixture();
    f.backend.seed(FOLDER_ICONS_KEY, serializeFolderIcons({ "1-projects": "🗂️", "2-areas": "🌲", "1-projects/old": "📦" }));
    f.backend.seed(
      FORWARDING_PATH,
      serializeForwarding({ version: 1, entries: [{ from: "1-projects/a.md", to: "1-projects/b.md", kind: "note", at: 1 }] }),
    );
    f.backend.seed(".context/assets/images/emoji-wave.png", PNG);
    return f;
  }

  test("brings in what the bucket held", async () => {
    const f = await bucketWithFiles();
    await sync(f);
    expect(await f.t.query(internal.functions.smallData.icons, { workspaceId: f.workspaceId })).toEqual(
      expect.arrayContaining([
        { path: "1-projects", icon: "🗂️" },
        { path: "2-areas", icon: "🌲" },
        { path: "1-projects/old", icon: "📦" },
      ]),
    );
    expect(await f.t.query(internal.functions.smallData.emojiList, { workspaceId: f.workspaceId })).toEqual([
      { name: "wave", leaf: "emoji-wave.png" },
    ]);
    expect(await f.t.query(internal.functions.smallData.forward, { workspaceId: f.workspaceId, paths: ["1-projects/a.md"] })).toEqual([
      "1-projects/b.md",
    ]);
  });

  test("a value Convex held before the import wins, and a move carries the file's icons", async () => {
    const f = await bucketWithFiles();
    await f.t.run(async (ctx) => {
      const workspaceId = f.workspaceId;
      await ctx.db.insert("folderIcons", { workspaceId, path: "1-projects", icon: "📌" });
      // Removed before the import: the file's icon must not come back.
      await ctx.db.insert("folderIcons", { workspaceId, path: "2-areas", icon: null });
      await ctx.db.insert("forwardingEntries", { workspaceId, seq: 1, from: "1-projects/b.md", to: "1-projects/c.md", kind: "note", at: 5 });
      await ctx.db.insert("forwardingEntries", { workspaceId, seq: 2, from: "1-projects/old", to: "4-archive/old", kind: "folder", at: 6 });
      await ctx.db.insert("customEmoji", { workspaceId, name: "wave", leaf: "emoji-wave.gif" });
      await ctx.db.insert("smallDataState", { workspaceId, forwardingVersion: 1, forwardingExported: 0, iconsVersion: 1, iconsExported: 0 });
    });
    await sync(f);

    const icons = Object.fromEntries(
      (await f.t.query(internal.functions.smallData.icons, { workspaceId: f.workspaceId })).map(({ path, icon }) => [path, icon]),
    );
    expect(icons).toEqual({ "1-projects": "📌", "4-archive/old": "📦" });
    expect(await f.t.query(internal.functions.smallData.emojiList, { workspaceId: f.workspaceId })).toEqual([
      { name: "wave", leaf: "emoji-wave.gif" },
    ]);
    // The file's a → b and Convex's b → c: a lands on c.
    expect(
      await f.t.query(internal.functions.smallData.forward, { workspaceId: f.workspaceId, paths: ["1-projects/a.md", "1-projects/b.md"] }),
    ).toEqual(["1-projects/c.md", "1-projects/c.md"]);
    // The merged rows are written back, in the file's own format.
    expect(parseFolderIcons(fileText(f, FOLDER_ICONS_KEY))).toEqual(icons);
    const ledger = parseForwarding(fileText(f, FORWARDING_PATH)!);
    expect(ledger.entries.map(({ from, to }: { from: string; to: string }) => [from, to])).toEqual(
      expect.arrayContaining([
        ["1-projects/a.md", "1-projects/c.md"],
        ["1-projects/b.md", "1-projects/c.md"],
      ]),
    );
    // No removal markers are left once the import has done with them.
    const tombstones = await f.t.run(async (ctx) =>
      (await ctx.db.query("folderIcons").collect()).filter((row) => row.icon === null),
    );
    expect(tombstones).toEqual([]);
  });

  test("runs once: a later sync reads nothing back", async () => {
    const f = await bucketWithFiles();
    await sync(f);
    f.backend.requests.length = 0;
    await asUser(f.t, f.owner).action(api.functions.folderIcons.set, { workspaceId: f.workspaceId, path: "1-projects", icon: "🚀" });
    await settle(f);
    expect(reads(f, FOLDER_ICONS_KEY)).toBe(0);
    expect(reads(f, FORWARDING_PATH)).toBe(0);
    expect(parseFolderIcons(fileText(f, FOLDER_ICONS_KEY))["1-projects"]).toBe("🚀");
  });
});

describe("the rows leave with the workspace", () => {
  async function held(f: Fixture): Promise<Record<string, number>> {
    return await f.t.run(async (ctx) => {
      const count = async (table: "folderIcons" | "customEmoji" | "forwardingEntries" | "smallDataState") =>
        (await ctx.db.query(table).collect()).filter((row) => row.workspaceId === f.workspaceId).length;
      return {
        icons: await count("folderIcons"),
        emoji: await count("customEmoji"),
        ledger: await count("forwardingEntries"),
        state: await count("smallDataState"),
      };
    });
  }

  async function populated(): Promise<Fixture> {
    const f = await fixture();
    await sync(f);
    await asUser(f.t, f.owner).action(api.functions.folderIcons.set, { workspaceId: f.workspaceId, path: "1-projects", icon: "🚀" });
    await asUser(f.t, f.owner).action(api.functions.emoji.add, { workspaceId: f.workspaceId, name: "ship", bytes: PNG.buffer });
    await f.t.mutation(internal.functions.smallData.recordForwarding, {
      workspaceId: f.workspaceId,
      moves: [{ from: "1-projects/a.md", to: "1-projects/b.md", kind: "note" }],
      now: 1_000,
    });
    await settle(f);
    expect(await held(f)).toEqual({ icons: 1, emoji: 1, ledger: 1, state: 1 });
    return f;
  }

  test("deleting the tree purges the rows", async () => {
    const f = await populated();
    await f.t.run(async (ctx) => {
      const { forgetWorkspaceTree } = await import("../../functions/nodesPurge");
      await forgetWorkspaceTree(ctx, f.workspaceId);
    });
    await settle(f);
    expect(await held(f)).toEqual({ icons: 0, emoji: 0, ledger: 0, state: 0 });
  });

  test("a storage move keeps the icons and ledger, and imports the new bucket's emoji", async () => {
    const f = await populated();
    await f.t.mutation(internal.functions.nodesPurge.resetForStorage, { workspaceId: f.workspaceId });
    const after = await held(f);
    expect(after).toEqual({ icons: 1, emoji: 0, ledger: 1, state: 1 });
    await settle(f);
    // The same fake bucket answers as the "new" one: its emoji come back by import.
    await sync(f);
    expect(await f.t.query(internal.functions.smallData.emojiList, { workspaceId: f.workspaceId })).toEqual([
      { name: "ship", leaf: "emoji-ship.png" },
    ]);
    expect(parseFolderIcons(fileText(f, FOLDER_ICONS_KEY))).toEqual({ "1-projects": "🚀" });
  });
});
