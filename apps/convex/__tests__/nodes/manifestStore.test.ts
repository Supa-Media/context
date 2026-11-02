/**
 * The whole-tree walk answered from the Convex tree (`nodesPagedStore`): the
 * same `syncManifest` over the tree's rows and rules must hand every
 * clearance exactly what it hands them over the bucket, across pages.
 *
 * Sabotage:
 *  - drop the prefix start or the past-the-prefix stop and the folder walk
 *    case fails (a sibling folder leaks in, or the walk never ends);
 *  - answer `privacy.md` from the bucket instead of the mirror and the
 *    "rules come from the tree" case fails;
 *  - hand back the store's own page token instead of the last key and the
 *    paging case fails.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf, type Clearance } from "../../functions/lib/clearance";
import { type FileStore, syncManifest } from "../../functions/lib/fileOps";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { nodesPagedStore, type NodePage } from "../../functions/lib/nodes/manifestStore";
import { privacyMirrorOf } from "../privacyMirrorOf.helpers";
import { compareKeys } from "../../functions/lib/nodes/table";
import type { NodeRow, PrivacyMirror } from "../../functions/lib/nodes/table";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";
import { renderPrivacyManifest, setExactVisibility, setFolderVisibility, setVisibility } from "../seededRules.helpers";

type Store = MemoryStore & FileStore;
const OWNER = clearanceOf("private");
const CLEARANCES: Clearance[] = [OWNER, clearanceOf("team"), clearanceOf("team", ["supa-leads"])];

async function workspace(): Promise<Store> {
  const store = memoryStore() as Store;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("1-projects/launch.md", "# Launch\n");
  store.seed("1-projects/launch/brief.md", "# Brief\n");
  store.seed("1-projects/held-back.md", "# Held back\n");
  store.seed("1-projects/private/plan.md", "# Plan\n");
  store.seed("1-projects/empty/", "");
  store.seed("1-projectsX/sibling.md", "# Not under 1-projects\n");
  store.seed("2-areas/health/vitals.md", "# Vitals\n");
  for (let index = 0; index < 30; index += 1) {
    store.seed(`3-resources/r${String(index).padStart(2, "0")}.md`, `# R${index}\n`);
  }
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: OWNER });
  await setFolderVisibility(store, { path: "3-resources", visibility: "team", clearance: OWNER });
  await setFolderVisibility(store, { path: "1-projects/private", visibility: "private", clearance: OWNER });
  await setVisibility(store, { path: "1-projects/held-back.md", visibility: "private", clearance: OWNER });
  await setExactVisibility(store, "3-resources/r05.md", "@supa-leads");
  return store;
}

/** The tree's rows for a bucket, as a sweep would record them. */
async function rowsOf(store: Store): Promise<NodeRow[]> {
  const listing = await store.list({ limit: 10_000 });
  return (listing.objects ?? [])
    .map((object: { key: string; etag?: string; size?: number; uploaded?: Date }) => ({
      path: object.key,
      ...(object.etag === undefined ? {} : { etag: object.etag }),
      ...(object.size === undefined ? {} : { size: object.size }),
      ...(object.uploaded === undefined ? {} : { uploaded: object.uploaded.getTime() }),
    }))
    .sort((a: NodeRow, b: NodeRow) => compareKeys(a.path, b.path));
}

/** `listLive` over rows in memory: live rows in key order after `after`, `size` at most per page. */
function pages(rows: readonly NodeRow[], size: number, roots: (string | undefined)[] = []): NodePage {
  return async (after, limit, root) => {
    roots.push(root);
    const rest = rows.filter(
      (row) => (after === undefined || compareKeys(row.path, after) > 0) && (root === undefined || row.path.startsWith(`${root}/`)),
    );
    const page = rest.slice(0, Math.min(limit, size));
    return { rows: page, cursor: page.length === Math.min(limit, size) ? page[page.length - 1]!.path : null };
  };
}

async function walk(store: FileStore, clearance: Clearance, folder?: string) {
  const entries = new Map<string, string>();
  const folders = new Map<string, string>();
  let cursor: string | undefined;
  for (let page = 0; page < 200; page += 1) {
    const manifest = await syncManifest(store, {
      clearance,
      pageEntries: 4,
      ...(folder === undefined ? {} : { folder }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    for (const entry of manifest.entries) entries.set(entry.path, `${entry.etag ?? ""}|${entry.visibility}|${entry.readOnly}`);
    for (const each of manifest.folders) folders.set(each.path, each.visibility);
    expect(manifest.truncated).toBe(false);
    if (manifest.cursor === null) return { entries, folders };
    cursor = manifest.cursor;
  }
  throw new Error("walk did not end");
}

async function tree(size = 3): Promise<{ bucket: Store; served: FileStore; mirror: PrivacyMirror }> {
  const bucket = await workspace();
  const mirror = await privacyMirrorOf(bucket);
  return { bucket, served: nodesPagedStore(bucket, pages(await rowsOf(bucket), size), mirror), mirror };
}

describe("a walk the Convex tree answers", () => {
  test("hands every clearance what the bucket's walk hands it, across pages", async () => {
    const { bucket, served } = await tree();
    for (const clearance of CLEARANCES) {
      expect(await walk(served, clearance)).toEqual(await walk(bucket, clearance));
    }
  });

  test("a folder's walk stays inside it, and a withheld one answers as absent", async () => {
    const { bucket, served } = await tree();
    for (const clearance of CLEARANCES) {
      for (const folder of ["1-projects", "1-projects/private", "3-resources", "nowhere"]) {
        const fromTree = await walk(served, clearance, folder);
        expect(fromTree).toEqual(await walk(bucket, clearance, folder));
        for (const path of fromTree.entries.keys()) expect(path.startsWith(`${folder}/`)).toBe(true);
      }
    }
    const projects = await walk(served, OWNER, "1-projects");
    expect([...projects.entries.keys()]).not.toContain("1-projectsX/sibling.md");
  });

  test("a folder's walk asks for that folder's rows alone, never the rest of the tree", async () => {
    // Without `root` a folder walk read on to the page cap past its last row (Convex invoice, owner 2026-10-30).
    const bucket = await workspace();
    const roots: (string | undefined)[] = [];
    const served = nodesPagedStore(bucket, pages(await rowsOf(bucket), 3, roots), await privacyMirrorOf(bucket));
    const fromTree = await walk(served, OWNER, "1-projects");
    expect(fromTree).toEqual(await walk(bucket, OWNER, "1-projects"));
    expect(new Set(roots)).toEqual(new Set(["1-projects"]));
    roots.length = 0;
    await walk(served, OWNER);
    expect(new Set(roots)).toEqual(new Set([undefined]));
  });

  test("the rules come from the tree, never the bucket's file", async () => {
    const { bucket } = await tree();
    const mirror = await privacyMirrorOf(bucket);
    // The tree has made 3-resources private; the bucket's file still says team.
    const tighter: PrivacyMirror = {
      ...mirror,
      folders: mirror.folders.map((rule) => (rule.prefix.startsWith("3-resources") ? { ...rule, visibility: "private" } : rule)),
    };
    const served = nodesPagedStore(bucket, pages(await rowsOf(bucket), 5), tighter);
    const team = await walk(served, clearanceOf("team"));
    expect([...team.entries.keys()].some((path) => path.startsWith("3-resources/"))).toBe(false);
    const fromBucket = await walk(bucket, clearanceOf("team"));
    expect([...fromBucket.entries.keys()].some((path) => path.startsWith("3-resources/"))).toBe(true);
  });

  test("a tree with no rules shows the team nothing", async () => {
    const { bucket } = await tree();
    const served = nodesPagedStore(bucket, pages(await rowsOf(bucket), 5), null);
    expect((await walk(served, clearanceOf("team"))).entries.size).toBe(0);
  });

  test("the cursor it hands back is the last key of the page", async () => {
    const { served } = await tree(2);
    const first = await served.list({ limit: 1000 });
    expect(first.truncated).toBe(true);
    expect(first.cursor).toBe(first.objects[first.objects.length - 1]!.key);
    const next = await served.list({ limit: 1000, cursor: first.cursor });
    expect(compareKeys(next.objects[0]!.key, first.cursor!)).toBeGreaterThan(0);
  });
});
