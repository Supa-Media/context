/**
 * A browser tab keeps no copy of a workspace, so it walks the server's
 * manifest and holds the tree in memory (`serverTree.ts`). Reported
 * 2026-10-08: after the tab's mirror was removed (#1346), every folder opened
 * in the side panel was its own request ("Loading…"), and changes made
 * elsewhere never reached the tree.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import {
  forgetServerTrees,
  holdServerTree,
  serverTree,
} from "../features/offline/serverTree";
import { stampLiveFolders, wantsLiveListing } from "../features/console/files/fileBrowser/liveListing";
import type { ContextListing, ManifestEntry } from "../features/offline/mirrorSync";
import type { Listings } from "../features/console/files/fileBrowser/types";

function entry(path: string): ManifestEntry {
  return { path, etag: `e-${path}`, visibility: "private", inherited: "private", exception: false, readOnly: false };
}

function walk(
  paths: string[],
  options: { listedAt?: number; complete?: boolean; pagesListed?: number; folders?: string[]; scope?: "private" | "team" } = {},
): ContextListing & { pagesListed: number } {
  return {
    workspaceId: "ws1",
    scope: options.scope ?? "private",
    listed: new Map(paths.map((path) => [path, entry(path)])),
    folders: options.folders === undefined ? null : new Map(options.folders.map((f) => [f, "private" as const])),
    complete: options.complete ?? true,
    manifestUsable: true,
    listedAt: options.listedAt ?? 100,
    pagesListed: options.pagesListed ?? 1,
  };
}

afterEach(() => forgetServerTrees());

describe("the tree a browser tab walked", () => {
  test("every folder of a complete walk is drawn, nested ones included, with nothing written to the device", () => {
    expect(holdServerTree(walk(["0-inbox/google-chat/a.md", "0-inbox/b.md", "todo.md"]), 1, 200)).toBe(true);
    const tree = serverTree("private", "ws1", 1)!;
    expect(tree.live).toBe(true);
    expect(tree.complete).toBe(true);
    expect(tree.value.get("")!.entries.map((e) => e.path)).toEqual(["0-inbox", "todo.md"]);
    expect(tree.value.get("0-inbox")!.entries.map((e) => e.path)).toEqual(["0-inbox/google-chat", "0-inbox/b.md"]);
    expect(tree.value.get("0-inbox/google-chat")!.entries.map((e) => e.path)).toEqual(["0-inbox/google-chat/a.md"]);
  });

  test("empty folders the server named are drawn as empty, not missing", () => {
    holdServerTree(walk(["todo.md"], { folders: ["", "3-resources"] }), 1, 200);
    expect(serverTree("private", "ws1", 1)!.value.get("3-resources")!.entries).toEqual([]);
  });

  test("a walk that stopped part-way is not kept: a folder it never reached would read Empty", () => {
    expect(holdServerTree(walk(["0-inbox/a.md"], { complete: false }), 1, 200)).toBe(false);
    expect(holdServerTree(walk([], { pagesListed: 0 }), 1, 200)).toBe(false);
    expect(serverTree("private", "ws1", 1)).toBeNull();
  });

  test("an older walk landing late does not undo a newer one", () => {
    holdServerTree(walk(["new.md"], { listedAt: 300 }), 1, 400);
    expect(holdServerTree(walk(["old.md"], { listedAt: 200 }), 1, 500)).toBe(false);
    expect(serverTree("private", "ws1", 1)!.value.get("")!.entries.map((e) => e.path)).toEqual(["new.md"]);
  });

  test("nothing walked before a sign-out is served after it", () => {
    holdServerTree(walk(["private.md"]), 1, 200);
    expect(serverTree("private", "ws1", 2)).toBeNull();
    // And it is gone, not merely hidden from the new session.
    expect(serverTree("private", "ws1", 1)).toBeNull();
  });

  test("a tree walked at one clearance is never drawn at another", () => {
    holdServerTree(walk(["private.md"], { scope: "private" }), 1, 200);
    expect(serverTree("team", "ws1", 1)).toBeNull();
  });
});

describe("opening a folder of the walked tree", () => {
  test("asks nothing more of the server: the walk was its answer", () => {
    holdServerTree(walk(["0-inbox/google-chat/a.md"], { listedAt: 100 }), 1, 200);
    const tree = serverTree("private", "ws1", 1)!;
    const adopted: Listings = Object.fromEntries(tree.value);
    const listedAt = new Map<string, number>();
    stampLiveFolders(adopted, tree, listedAt);
    expect(wantsLiveListing("0-inbox/google-chat", adopted, listedAt, false)).toBe(false);
  });

  test("a tree off the device's copy stamps nothing, and is still asked for online", () => {
    holdServerTree(walk(["0-inbox/a.md"]), 1, 200);
    const tree = { ...serverTree("private", "ws1", 1)!, live: false };
    const adopted: Listings = Object.fromEntries(tree.value);
    const listedAt = new Map<string, number>();
    stampLiveFolders(adopted, tree, listedAt);
    expect(listedAt.size).toBe(0);
    expect(wantsLiveListing("0-inbox", adopted, listedAt, false)).toBe(true);
  });

  test("a folder a newer listing kept keeps that listing's stamp", () => {
    holdServerTree(walk(["0-inbox/a.md"], { listedAt: 100 }), 1, 200);
    const tree = serverTree("private", "ws1", 1)!;
    const newer = { ...tree.value.get("0-inbox")!, entries: [] };
    const adopted: Listings = { ...Object.fromEntries(tree.value), "0-inbox": newer };
    const listedAt = new Map([["0-inbox", 500]]);
    stampLiveFolders(adopted, tree, listedAt);
    expect(listedAt.get("0-inbox")).toBe(500);
    expect(listedAt.get("")).toBe(100);
  });
});
