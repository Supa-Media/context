/**
 * @jest-environment jsdom
 */

/**
 * A browser tab keeps no copy of a workspace, so it walks the server's
 * manifest and draws the tree from that (`serverTree.ts`).
 *
 * Reported 2026-10-08, twice: first every folder was its own request after
 * the tab's mirror was removed (#1346); then, with the walk in place (#1352),
 * a 9k-note workspace still waited for every page of the walk before a single
 * folder came from it, and every reload started from nothing.
 *
 * Sabotage-checked: drawing nothing until the last page fails "each finished
 * folder is drawn as its page lands"; counting a folder as finished while the
 * cursor is still inside it fails "a folder the cursor is still inside is not
 * finished"; dropping the tab copy fails "a reload draws the last whole tree".
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import {
  finishedBefore,
  forgetServerTree,
  forgetServerTrees,
  holdServerTree,
  keepServerTree,
  keptServerTree,
  serverTree,
  treeOfWalk,
  walkServerTree,
  type LiveTree,
} from "../features/offline/serverTree";
import { stampLiveFolders, wantsLiveListing } from "../features/console/files/fileBrowser/liveListing";
import type { ManifestEntry, ManifestPage } from "../features/offline/mirrorSync";
import type { Listings } from "../features/console/files/fileBrowser/types";

function entry(path: string): ManifestEntry {
  return { path, etag: `e-${path}`, visibility: "private", inherited: "private", exception: false, readOnly: false };
}

function treeOf(paths: string[], listedAt = 100): LiveTree {
  return treeOfWalk(new Map(paths.map((p) => [p, entry(p)])), new Map(), true, listedAt, listedAt);
}

function paths(tree: { value: ReadonlyMap<string, { entries: { path: string }[] }> }, folder: string) {
  return tree.value.get(folder)?.entries.map((e) => e.path);
}

afterEach(() => forgetServerTrees());

describe("walking the server's tree", () => {
  const pages: Record<string, ManifestPage> = {
    start: {
      entries: ["0-inbox/a.md", "0-inbox/chat/b.md", "1-projects/c.md", "2-areas/d.md"].map(entry),
      cursor: "2-areas/d.md",
      truncated: false,
      manifestUsable: true,
    },
    "2-areas/d.md": {
      entries: ["2-areas/e.md", "4-archive/f.md"].map(entry),
      cursor: "4-archive/f.md",
      truncated: false,
      manifestUsable: true,
    },
    "4-archive/f.md": { entries: ["4-archive/g.md", "todo.md"].map(entry), cursor: null, truncated: false, manifestUsable: true },
  };

  test("each finished folder is drawn as its page lands, and the whole tree at the end", async () => {
    const drawn: LiveTree[] = [];
    const done = await walkServerTree({
      manifest: async (cursor) => pages[cursor ?? "start"]!,
      mine: () => true,
      now: () => 100,
      onTree: (tree) => drawn.push(tree),
    });
    expect(done).toBe(true);
    expect(drawn.map((tree) => tree.complete)).toEqual([false, false, true]);
    // After the first page: the inbox and projects are whole, the areas are not.
    expect([...drawn[0]!.value.keys()].sort()).toEqual(["0-inbox", "0-inbox/chat", "1-projects"]);
    expect(paths(drawn[0]!, "0-inbox")).toEqual(["0-inbox/chat", "0-inbox/a.md"]);
    expect([...drawn[1]!.value.keys()].sort()).toEqual(["0-inbox", "0-inbox/chat", "1-projects", "2-areas"]);
    expect(paths(drawn[1]!, "2-areas")).toEqual(["2-areas/d.md", "2-areas/e.md"]);
    expect(paths(drawn[2]!, "")).toEqual(["0-inbox", "1-projects", "2-areas", "4-archive", "todo.md"]);
    expect(drawn.every((tree) => tree.live)).toBe(true);
  });

  test("a walk that cannot go on keeps what it finished, and says it did not finish", async () => {
    const drawn: LiveTree[] = [];
    const done = await walkServerTree({
      manifest: async (cursor) => {
        if (cursor === undefined) return pages.start!;
        throw new Error("timed out");
      },
      mine: () => true,
      now: () => 100,
      onTree: (tree) => drawn.push(tree),
    });
    expect(done).toBe(false);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.complete).toBe(false);
    expect(drawn[0]!.value.has("")).toBe(false);
  });

  test("a walk whose session ended draws nothing more", async () => {
    let mine = true;
    const drawn: LiveTree[] = [];
    await walkServerTree({
      manifest: async (cursor) => {
        mine = false;
        return pages[cursor ?? "start"]!;
      },
      mine: () => mine,
      now: () => 100,
      onTree: (tree) => drawn.push(tree),
    });
    expect(drawn).toEqual([]);
  });
});

describe("which folders a cursor has finished", () => {
  const tree = treeOf(["a/x.md", "a-b/y.md", "a/deep/z.md", "b/w.md"]);

  test("a folder the cursor is still inside is not finished", () => {
    expect([...finishedBefore(tree.value, "a/deep/z.md").keys()].sort()).toEqual(["a-b"]);
  });

  test("a folder whose name continues past the cursor's is not mistaken for finished", () => {
    // "a-b/…" sorts before "a/…", so a cursor in "a-b" has not reached "a".
    expect(finishedBefore(tree.value, "a-b/y.md").has("a")).toBe(false);
  });

  test("past a folder, it and everything under it is finished; the root never is", () => {
    const done = finishedBefore(tree.value, "b/w.md");
    expect([...done.keys()].sort()).toEqual(["a", "a-b", "a/deep"]);
    expect(done.has("")).toBe(false);
  });
});

describe("the tree held for the tab", () => {
  test("an older walk landing late does not undo a newer one", () => {
    holdServerTree("private", "ws1", treeOf(["new.md"], 300), 1);
    expect(holdServerTree("private", "ws1", treeOf(["old.md"], 200), 1)).toBe(false);
    expect(paths(serverTree("private", "ws1", 1)!, "")).toEqual(["new.md"]);
  });

  test("part of a later walk never replaces a whole earlier one", () => {
    holdServerTree("private", "ws1", treeOf(["a/x.md", "b/y.md"], 100), 1);
    const part = { ...treeOf(["a/x.md"], 200), complete: false };
    expect(holdServerTree("private", "ws1", part, 1)).toBe(false);
    expect(serverTree("private", "ws1", 1)!.value.has("b")).toBe(true);
  });

  test("nothing walked before a sign-out is served after it", () => {
    holdServerTree("private", "ws1", treeOf(["private.md"]), 1);
    expect(serverTree("private", "ws1", 2)).toBeNull();
    expect(serverTree("private", "ws1", 1)).toBeNull();
  });

  test("a tree walked at one clearance is never drawn at another", () => {
    holdServerTree("private", "ws1", treeOf(["private.md"]), 1);
    keepServerTree("private", "ws1", treeOf(["private.md"]));
    expect(serverTree("team", "ws1", 1)).toBeNull();
    expect(keptServerTree("team", "ws1")).toBeNull();
  });
});

describe("a reload", () => {
  test("draws the last whole tree, exactly, and as a copy rather than the server's answer", () => {
    const tree = treeOf(["0-inbox/chat/a.md", "todo.md"]);
    keepServerTree("private", "ws1", tree);
    const kept = keptServerTree("private", "ws1")!;
    expect((kept as { live?: boolean }).live).toBeUndefined();
    expect([...kept.value.keys()].sort()).toEqual([...tree.value.keys()].sort());
    for (const [folder, listing] of tree.value) expect(kept.value.get(folder)).toEqual(listing);
  });

  test("never keeps part of a walk", () => {
    keepServerTree("private", "ws1", { ...treeOf(["a/x.md"]), complete: false });
    expect(keptServerTree("private", "ws1")).toBeNull();
  });

  test("keeps nothing in localStorage, and nothing past sign-out or leaving", () => {
    keepServerTree("private", "ws1", treeOf(["a.md"]));
    keepServerTree("private", "ws2", treeOf(["b.md"]));
    expect(window.localStorage.length).toBe(0);
    forgetServerTree("ws1");
    expect(keptServerTree("private", "ws1")).toBeNull();
    expect(keptServerTree("private", "ws2")).not.toBeNull();
    forgetServerTrees();
    expect(keptServerTree("private", "ws2")).toBeNull();
  });

  test("a full session store costs only the instant reload", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };
    try {
      expect(() => keepServerTree("private", "ws1", treeOf(["a.md"]))).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
    expect(keptServerTree("private", "ws1")).toBeNull();
  });
});

describe("opening a folder of the walked tree", () => {
  test("asks nothing more of the server: the walk was its answer", () => {
    const tree = treeOf(["0-inbox/google-chat/a.md"]);
    const adopted: Listings = Object.fromEntries(tree.value);
    const listedAt = new Map<string, number>();
    stampLiveFolders(adopted, tree, listedAt);
    expect(wantsLiveListing("0-inbox/google-chat", adopted, listedAt, false)).toBe(false);
  });

  test("a tree kept from before a reload stamps nothing, and is still asked for online", () => {
    keepServerTree("private", "ws1", treeOf(["0-inbox/a.md"]));
    const kept = keptServerTree("private", "ws1")!;
    const adopted: Listings = Object.fromEntries(kept.value);
    const listedAt = new Map<string, number>();
    stampLiveFolders(adopted, kept, listedAt);
    expect(listedAt.size).toBe(0);
    expect(wantsLiveListing("0-inbox", adopted, listedAt, false)).toBe(true);
  });

  test("a folder a newer listing kept keeps that listing's stamp", () => {
    const tree = treeOf(["0-inbox/a.md"], 100);
    const newer = { ...tree.value.get("0-inbox")!, entries: [] };
    const adopted: Listings = { ...Object.fromEntries(tree.value), "0-inbox": newer };
    const listedAt = new Map([["0-inbox", 500]]);
    stampLiveFolders(adopted, tree, listedAt);
    expect(listedAt.get("0-inbox")).toBe(500);
    expect(listedAt.get("")).toBe(100);
  });
});
