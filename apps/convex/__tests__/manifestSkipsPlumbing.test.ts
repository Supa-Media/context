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
