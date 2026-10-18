/**
 * Every app read of which notes exist is answered from the Convex tree with
 * no bucket credential opened, and never from the bucket (decided by the
 * owner, 2026-10-13: "the only thing that should be reading from storage
 * directly should be actually opening and editing a note").
 *
 * The workspace here has **no storage binding at all**, the same proof the
 * projection pass uses: opening a credential makes no bucket request a stub
 * could see, but with no binding it answers `STORAGE_NOT_CONNECTED`. So an
 * operation that reaches the credential fails these tests, served or not.
 *
 * What is proved:
 *  - a one-folder list, a `source: "tree"` walk, link completion, the folder
 *    picker, the map, the moves panel's visibility check, a List's notes and
 *    the chaos score each answer from the rows and the rules mirror;
 *  - who sees what is the mirror's `canSee`: a team member never gets a
 *    private name from any of them;
 *  - a workspace whose first copy has not finished answers `TREE_LOADING`
 *    and has its copy started, and one whose store cannot be swept says so,
 *    neither one opening the bucket;
 *  - a List shows the last parsed front matter for a note saved since, and a
 *    note never parsed is a gap (`missing`), with no note read.
 *
 * Sabotage (temporary local edits, reverted):
 *  - drop the `isTreeRead` line from the barrier: every case answers
 *    `STORAGE_NOT_CONNECTED`;
 *  - answer `null` from `servedStoreOrLoading` instead of throwing: the
 *    loading cases fail;
 *  - let `workspaceGraph` read the search index's docmap on the tree's store:
 *    the "facts not filled yet" map case fails (it reaches for the bucket).
 */

import { describe, expect, test } from "vitest";
import { getFunctionName } from "convex/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { clearanceOf } from "../../functions/lib/clearance";
import { setFolderVisibility, setVisibility, type FileStore } from "../../functions/lib/fileOps";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { renderPrivacyManifest } from "../../functions/lib/scaffold";
import { privacyMirrorOf } from "../../functions/lib/nodes/privacyMirror";
import { answerFromFacts } from "../../functions/lib/filesFns/folderNotes";
import { TREE_LOADING } from "../../functions/lib/nodes/treeLoading";
import { fillAll, observeBucket, tester, workspace, type Tester } from "./facts.helpers";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";
import { seedStorageBinding } from "../fixtures.helpers";

const OWNER = clearanceOf("private");

async function bucket(): Promise<MemoryStore & FileStore> {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("1-projects/plan.md", "---\nstatus: doing\n---\n# Plan\n\nSee [Pay](pay.md) and [Other](other.md).\n");
  store.seed("1-projects/other.md", "---\nstatus: done\n---\n# Other\n\nBack to [Plan](plan.md).\n");
  store.seed("1-projects/pay.md", "---\nstatus: secret\n---\n# Pay\n");
  store.seed("1-projects/private/codes.md", "# Codes\n");
  store.seed("2-areas/health.md", "# Health\n");
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: OWNER });
  await setFolderVisibility(store, { path: "1-projects/private", visibility: "private", clearance: OWNER });
  await setVisibility(store, { path: "1-projects/pay.md", visibility: "private", clearance: OWNER });
  return store;
}

/** A workspace with no bucket bound, whose tree mirrors `store` and has finished its first copy. */
async function fixture(options: { facts?: boolean } = {}) {
  const t = tester();
  const ws = await workspace(t, "acme");
  const store = await bucket();
  await t.mutation(internal.functions.nodes.begin, { workspaceId: ws, at: 1 });
  await observeBucket(t, ws, store, 2);
  await t.mutation(internal.functions.nodes.savePrivacy, { workspaceId: ws, mirror: await privacyMirrorOf(store), at: 2 });
  await t.mutation(internal.functions.nodes.finish, { workspaceId: ws, at: 3, files: 7 });
  if (options.facts !== false) await fillAll(t, ws, store);
  return { t, ws, store };
}

function operate(t: Tester, ws: Id<"workspaces">, scope: "private" | "team", operation: Record<string, unknown>) {
  return t.action(internal.functions.files.runFileOperation, { workspaceId: ws, scope, operation: operation as never });
}

/** A bucket bound to the workspace, so a tree not copied yet is loading rather than unbound. Never opened here. */
async function bound(t: Tester, ws: Id<"workspaces">) {
  const owner = await t.run(async (ctx) => (await ctx.db.get(ws))!.createdBy);
  await seedStorageBinding(t as never, { workspaceId: ws, boundBy: owner, status: "connected" });
}

async function notCopied(t: Tester) {
  await t.run(async (ctx) => {
    const row = await ctx.db.query("nodeTrees").first();
    if (row) await ctx.db.patch(row._id, { status: "filling", sweptAt: undefined, leaseAt: undefined, cursor: "1-projects" });
  });
}

async function sweepsScheduled(t: Tester): Promise<number> {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (job) =>
        getFunctionName(job.name as never) === "functions/files:runFileOperation" &&
        (job.args[0] as { operation?: { kind?: string } })?.operation?.kind === "nodesSweep" &&
        job.state.kind === "pending",
    ).length,
  );
}

const READS: Record<string, unknown>[] = [
  { kind: "list", path: "1-projects" },
  { kind: "manifest", source: "tree" },
  { kind: "notePaths" },
  { kind: "folderPaths" },
  { kind: "workspaceGraph" },
  { kind: "visiblePaths", paths: ["1-projects/pay.md", "1-projects/plan.md"] },
  { kind: "folderNotes", folder: "1-projects", subfolders: true },
  { kind: "chaosScore" },
];

/** Every path an answer names, wherever it names one. */
function named(answer: unknown): string {
  return JSON.stringify(answer);
}

describe("reads the tree answers with no bucket at all", () => {
  test("every read answers for the owner, with the workspace's names", async () => {
    const { t, ws } = await fixture();
    for (const operation of READS) {
      const answer = (await operate(t, ws, "private", operation)) as { kind: string };
      expect(answer.kind, operation.kind as string).not.toBe(undefined);
    }
    const manifest = (await operate(t, ws, "private", { kind: "manifest", source: "tree" })) as {
      source: string;
      entries: { path: string }[];
      since?: number;
    };
    expect(manifest.source).toBe("nodes");
    expect(manifest.entries.map((entry) => entry.path)).toContain("1-projects/pay.md");
    expect(typeof manifest.since).toBe("number");
    const notes = (await operate(t, ws, "private", { kind: "notePaths" })) as { paths: string[] };
    expect(notes.paths).toEqual(expect.arrayContaining(["1-projects/pay.md", "2-areas/health.md", "index.md"]));
    const folders = (await operate(t, ws, "private", { kind: "folderPaths" })) as { folders: string[] };
    expect(folders.folders).toEqual(["1-projects", "1-projects/private", "2-areas"]);
    const graph = (await operate(t, ws, "private", { kind: "workspaceGraph" })) as { nodes: { path: string }[]; edges: number[][]; behind: boolean };
    expect(graph.nodes.map((node) => node.path)).toContain("1-projects/pay.md");
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.behind).toBe(false);
    const list = (await operate(t, ws, "private", { kind: "folderNotes", folder: "1-projects", subfolders: false })) as {
      available: boolean;
      notes: { path: string; props: string }[];
      missing: string[];
    };
    expect(list.available).toBe(true);
    expect(list.notes.map((note) => note.path).sort()).toEqual(["1-projects/other.md", "1-projects/pay.md", "1-projects/plan.md"]);
    expect(list.missing).toEqual([]);
    const chaos = (await operate(t, ws, "private", { kind: "chaosScore" })) as { available: boolean };
    expect(chaos.available).toBe(true);
  });

  test("a team member never gets a private name from any of them", async () => {
    const { t, ws } = await fixture();
    for (const operation of READS) {
      const answer = named(await operate(t, ws, "team", operation));
      expect(answer, operation.kind as string).not.toContain("pay.md");
      expect(answer, operation.kind as string).not.toContain("codes.md");
      expect(answer, operation.kind as string).not.toContain("health.md");
      expect(answer, operation.kind as string).not.toContain("1-projects/private");
    }
    const list = (await operate(t, ws, "team", { kind: "list", path: "1-projects" })) as { entries: { path: string }[] };
    expect(list.entries.map((entry) => entry.path)).toEqual(expect.arrayContaining(["1-projects/plan.md", "1-projects/other.md"]));
  });

  test("a malformed folder is refused in the listing's own words, still with no bucket", async () => {
    const { t, ws } = await fixture();
    await expect(operate(t, ws, "private", { kind: "list", path: "../etc" })).rejects.toMatchObject({
      data: expect.objectContaining({ code: expect.not.stringMatching(/STORAGE/) }),
    });
  });
});

describe("a first copy not finished is still loading", () => {
  test("every read answers TREE_LOADING, never the bucket, and the copy is started", async () => {
    const { t, ws } = await fixture({ facts: false });
    await bound(t, ws);
    await notCopied(t);
    for (const operation of READS) {
      await expect(operate(t, ws, "private", operation), operation.kind as string).rejects.toMatchObject({
        data: { code: TREE_LOADING },
      });
    }
    expect(await sweepsScheduled(t)).toBeGreaterThan(0);
  });

  test("with no bucket bound there is nothing to load: the barrier's own STORAGE_NOT_CONNECTED, and no copy started", async () => {
    const { t, ws } = await fixture({ facts: false });
    await notCopied(t);
    for (const operation of READS) {
      await expect(operate(t, ws, "private", operation), operation.kind as string).rejects.toMatchObject({
        data: { code: "STORAGE_NOT_CONNECTED" },
      });
    }
    expect(await sweepsScheduled(t)).toBe(0);
  });

  test("a store no sweep can copy says so in its own words", async () => {
    const { t, ws } = await fixture({ facts: false });
    await bound(t, ws);
    await t.mutation(internal.functions.nodes.unsupported, { workspaceId: ws });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("nodeTrees").first();
      if (row) await ctx.db.patch(row._id, { status: "unsupported" });
    });
    await expect(operate(t, ws, "private", { kind: "list", path: "" })).rejects.toMatchObject({
      data: { code: TREE_LOADING, message: expect.stringMatching(/could not be listed/) },
    });
    expect(await sweepsScheduled(t)).toBe(0);
  });

  test("facts not filled yet: the map and the List still answer from the rows, and the fill starts", async () => {
    const { t, ws } = await fixture({ facts: false });
    const graph = (await operate(t, ws, "private", { kind: "workspaceGraph" })) as { nodes: unknown[]; behind: boolean };
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.behind).toBe(true);
    const list = (await operate(t, ws, "private", { kind: "folderNotes", folder: "1-projects", subfolders: false })) as {
      available: boolean;
      notes: unknown[];
      missing: string[];
    };
    expect(list.available).toBe(true);
    expect(list.notes).toEqual([]);
    expect(list.missing.sort()).toEqual(["1-projects/other.md", "1-projects/pay.md", "1-projects/plan.md"]);
    const chaos = (await operate(t, ws, "private", { kind: "chaosScore" })) as { available: boolean };
    expect(chaos.available).toBe(true);
  });
});

describe("a List reads no note", () => {
  const row = (path: string, fields: Partial<Parameters<typeof answerFromFacts>[0][number]>) => ({
    path,
    etag: "v2",
    uploaded: 5,
    stale: false,
    encrypted: false,
    props: JSON.stringify({ properties: { status: "doing" } }),
    ...fields,
  });

  test("a note saved since it was parsed shows what was last parsed, and asks for a fill", () => {
    const answer = answerFromFacts([row("a.md", { stale: true })], null);
    expect(answer.notes.map((note) => note.path)).toEqual(["a.md"]);
    expect(answer.missing).toEqual([]);
    expect(answer.fill).toBe(true);
  });

  test("a note never parsed is a gap, an encrypted one is left out", () => {
    const answer = answerFromFacts(
      [row("never.md", { stale: true, props: null }), row("sealed.md", { encrypted: true, props: null }), row("ok.md", {})],
      "ok.md",
    );
    expect(answer.notes.map((note) => note.path)).toEqual(["ok.md"]);
    expect(answer.missing).toEqual(["never.md"]);
    expect(answer.cursor).toBe("ok.md");
    expect(answer.fill).toBe(true);
  });
  test("a note's size comes through when the tree lists one, and is left out when it does not", () => {
    const answer = answerFromFacts([row("sized.md", { size: 27_661 }), row("unsized.md", {})], null);
    expect(answer.notes.find((note) => note.path === "sized.md")?.size).toBe(27_661);
    expect(answer.notes.find((note) => note.path === "unsized.md")).not.toHaveProperty("size");
  });
});
