/**
 * The sync manifest steps over hidden plumbing instead of walking it.
 *
 * `.context/` sorts ahead of every note and, since AI reads are stored one
 * object each (2026-10-07), it grows with every question anybody asks. Walked
 * a page at a time, a busy workspace's manifest spent its whole page budget
 * there before reaching a note, and the device's tree named folders it never
 * saw the notes of: Inbox and Areas drew "Empty" (2026-10-08).
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import { type FileStore, syncManifest } from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";

const OWNER = clearanceOf("private");
const PLUMBING = 3_000;

function bucket(options: Parameters<typeof memoryStore>[0] = {}): MemoryStore & FileStore & { lists: number } {
  const store = memoryStore(options) as MemoryStore & FileStore & { lists: number };
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  for (let index = 0; index < PLUMBING; index += 1) {
    store.seed(`.context/reads/2026-10-08/${String(index).padStart(6, "0")}.json`, "{}");
  }
  store.seed(".history/0-inbox/a.md.old.md", "# old\n");
  store.seed("0-inbox/a.md", "# A\n");
  store.seed("2-areas/health.md", "# Health\n");
  store.seed("index.md", "# Context\n");
  store.lists = 0;
  const list = store.list.bind(store);
  store.list = async (listOptions) => {
    store.lists += 1;
    // Pages of 100 whatever was asked for, so walking the plumbing costs 30.
    return list({ ...listOptions, limit: 100 });
  };
  return store;
}

describe("the manifest steps over hidden plumbing", () => {
  test("every note arrives, and the plumbing is not paged through", async () => {
    const store = bucket();
    const manifest = await syncManifest(store, { clearance: OWNER });
    expect(manifest.entries.map((entry) => entry.path).sort()).toEqual(
      ["0-inbox/a.md", "2-areas/health.md", "index.md", PRIVACY_KEY].sort(),
    );
    expect(manifest.folders.map((folder) => folder.path)).toEqual(["", "0-inbox", "2-areas"]);
    expect(manifest.truncated).toBe(false);
    expect(manifest.cursor).toBeNull();
    // One page to meet `.context/`, one past it to meet `.history/`, one past that.
    expect(store.lists).toBeLessThanOrEqual(4);
  });

  test("a store that ignores the position is walked the slow way, and still misses nothing", async () => {
    const store = bucket({ ignoreStartAfter: true });
    const manifest = await syncManifest(store, { clearance: OWNER });
    expect(manifest.entries.map((entry) => entry.path).sort()).toEqual(
      ["0-inbox/a.md", "2-areas/health.md", "index.md", PRIVACY_KEY].sort(),
    );
    expect(JSON.stringify(manifest)).not.toContain(".context");
    expect(JSON.stringify(manifest)).not.toContain(".history");
  });

  test("a walk resumed from a cursor still steps over plumbing after it", async () => {
    const store = bucket();
    store.seed(".zz/x/1.json", "{}");
    const first = await syncManifest(store, { clearance: OWNER, pageEntries: 1 });
    expect(first.entries.map((entry) => entry.path)).toEqual(["0-inbox/a.md"]);
    const rest = await syncManifest(store, { clearance: OWNER, cursor: first.cursor! });
    expect(rest.entries.map((entry) => entry.path).sort()).toEqual(
      ["2-areas/health.md", "index.md", PRIVACY_KEY].sort(),
    );
  });
});

describe("the manifest of one folder, for a List or Board read from the server", () => {
  const TEAM = clearanceOf("team");

  async function shared(): Promise<MemoryStore & FileStore> {
    const store = memoryStore() as MemoryStore & FileStore;
    store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
    store.seed("1-projects/a.md", "# A\n");
    store.seed("1-projects/deep/b.md", "# B\n");
    store.seed("1-projectsX/no.md", "# not under 1-projects\n");
    store.seed("2-areas/secret/c.md", "# C\n");
    store.seed("index.md", "# Context\n");
    const { setFolderVisibility } = await import("../functions/lib/fileOps");
    await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: OWNER });
    return store;
  }

  test("only the subtree, recursively, with versions", async () => {
    const store = await shared();
    const manifest = await syncManifest(store, { clearance: OWNER, folder: "1-projects" });
    expect(manifest.entries.map((entry) => entry.path)).toEqual(["1-projects/a.md", "1-projects/deep/b.md"]);
    expect(manifest.entries.every((entry) => typeof entry.etag === "string")).toBe(true);
    expect(manifest.cursor).toBeNull();
  });

  test("a folder the reader cannot see answers exactly as one that is not there", async () => {
    const store = await shared();
    const hidden = await syncManifest(store, { clearance: TEAM, folder: "2-areas/secret" });
    const absent = await syncManifest(store, { clearance: TEAM, folder: "1-projects/nothing-here" });
    expect(hidden.entries).toEqual([]);
    expect(JSON.stringify(hidden)).not.toContain("secret");
    expect(hidden).toEqual(absent);
  });

  test("a path that climbs out is refused", async () => {
    const store = await shared();
    await expect(syncManifest(store, { clearance: OWNER, folder: "../x" })).rejects.toThrow();
  });

  /*
    THE BODIES BEING EQUAL IS THE PROXY; THE COST IS THE THING.

    The register's oldest cost-leak rule: a second route to a file is a second
    access check, and the one nobody writes. It has been missed on three doors
    already, and every time the refusal was byte-identical and the *number of
    storage round trips* was not — which hands a team caller `canSee` on a name
    it guessed, read with a clock instead of a read.

    `syncManifest` closes it by walking one page for a folder it will say
    nothing about, exactly as an absent folder costs one page. That walk looks
    like dead work to anybody tidying this function, and deleting it would keep
    the test above green: the two answers would stay equal and only their cost
    would diverge. So the cost is asserted here as well, on data the same two
    calls already produce.
  */
  test("a folder the reader cannot see costs exactly what an absent one costs", async () => {
    const counted = async (folder: string): Promise<number> => {
      const store = await shared();
      const list = store.list.bind(store);
      let lists = 0;
      store.list = async (options) => {
        lists += 1;
        return list(options);
      };
      const manifest = await syncManifest(store, { clearance: TEAM, folder });
      expect(manifest.entries).toEqual([]);
      return lists;
    };
    const hidden = await counted("2-areas/secret");
    const absent = await counted("1-projects/nothing-here");
    // Non-vacuous in both directions: a real walk happens on each, and it is
    // the same walk. Zero would mean the refusal never reached storage, which
    // is the shape of the leak.
    expect(hidden).toBeGreaterThan(0);
    expect(hidden).toEqual(absent);
  });
});
