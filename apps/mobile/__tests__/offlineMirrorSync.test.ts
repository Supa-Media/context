import { beforeEach, describe, expect, test } from "@jest/globals";
import { currentEpoch, endSession } from "../features/offline/epoch";
import {
  listingOf,
  mirroredAncestor,
  mirroredListing,
  mirroredNote,
  putMirroredNotes,
  readIndex,
  type Needed,
} from "../features/offline/mirror";
import { memoryMirrorStore, type MirrorStore } from "../features/offline/mirrorStoreCore";
import {
  syncAll,
  syncContext,
  type BatchRead,
  type ManifestEntry,
  type ManifestPage,
  type MirrorSyncDeps,
} from "../features/offline/mirrorSync";
import type { OpenNote } from "../features/console/files/types";

/**
 * The mirror's sync: every note a person can see, fetched when it changed,
 * dropped when it stopped being theirs — and six ways that goes wrong, each a
 * test that fails when the rule is removed (sabotage-checked while writing):
 *
 *  - **prune on a truncated manifest** — a page that says it could not finish
 *    is a floor, not a list, and a missing path is not a deletion. Pruning
 *    anyway fails "a truncated manifest prunes nothing".
 *  - **a lost grant** — a complete manifest is the whole of what this device
 *    may hold, so a note that left it goes, body and all. Not pruning fails
 *    "a note that left the manifest leaves the device".
 *  - **unknown clearance** — a context whose tier is not known downloads and
 *    deletes nothing. Letting it through fails "an unknown tier touches
 *    nothing".
 *  - **cross-workspace write-back** — each context's notes land under that
 *    context and no other. Writing under the wrong id fails "each context's
 *    notes are filed under that context".
 *  - **sign-out mid-sync** — nothing is written back once the session ends.
 *    Two layers hold this, the engine's `mine()` checks and the store's epoch
 *    compare inside its queue, and each alone keeps this test green; removing
 *    both fails "a sign-out during a sync leaves nothing". The store's half is
 *    the one pinned on its own, in `offlineMirrorStore.test.ts`.
 *  - **the ancestor** — a note somebody's queued edit is based on keeps that
 *    version when the bucket moves on. Dropping the rule fails "the version a
 *    queued edit is based on survives the sync that replaces it", and keeping
 *    it for a note that became ciphertext fails "a note that became encrypted
 *    keeps no plaintext ancestor".
 */

const W1 = "w1";
const W2 = "w2";

interface Remote {
  path: string;
  text: string;
  etag: string;
  rawEtag?: string;
  visibility?: OpenNote["visibility"];
  encrypted?: boolean;
}

function manifestOf(notes: readonly Remote[]): ManifestEntry[] {
  return notes.map((note) => ({
    path: note.path,
    etag: note.rawEtag ?? note.etag,
    size: note.text.length,
    visibility: note.visibility ?? "private",
    inherited: note.visibility ?? "private",
    exception: false,
    readOnly: false,
  }));
}

function noteOf(remote: Remote): OpenNote & { encrypted: boolean } {
  return {
    path: remote.path,
    text: remote.text,
    etag: remote.etag,
    ...(remote.rawEtag === undefined ? {} : { rawEtag: remote.rawEtag }),
    visibility: remote.visibility ?? "private",
    inherited: remote.visibility ?? "private",
    exception: false,
    readOnly: false,
    encrypted: remote.encrypted === true,
  };
}

/** A bucket per workspace, and a log of every call the engine made. */
let buckets: Record<string, Remote[]>;
let calls: string[];
let store: MirrorStore;
let needed: Needed;
let pageOverride: ((workspaceId: string, cursor?: string) => ManifestPage) | null;

function deps(overrides: Partial<MirrorSyncDeps> = {}): MirrorSyncDeps {
  const epoch = currentEpoch();
  return {
    store,
    epoch,
    mine: () => epoch === currentEpoch(),
    now: () => 1_000,
    needed: async () => needed,
    manifest: async (workspaceId, cursor) => {
      calls.push(`manifest:${workspaceId}:${cursor ?? ""}`);
      if (pageOverride !== null) return pageOverride(workspaceId, cursor);
      return {
        entries: manifestOf(buckets[workspaceId] ?? []),
        cursor: null,
        truncated: false,
        manifestUsable: true,
      };
    },
    readNotes: async (workspaceId, paths) => {
      calls.push(`read:${workspaceId}:${paths.join(",")}`);
      return paths.map((path): BatchRead => {
        const found = (buckets[workspaceId] ?? []).find((note) => note.path === path);
        return found === undefined
          ? { path, outcome: "error", code: "FILE_NOT_FOUND", message: "not found" }
          : { path, outcome: "read", note: noteOf(found) };
      });
    },
    ...overrides,
  };
}

beforeEach(() => {
  store = memoryMirrorStore();
  calls = [];
  needed = () => new Set();
  pageOverride = null;
  buckets = {
    [W1]: [
      { path: "index.md", text: "# Home\n", etag: "h1" },
      { path: "1-projects/pilot.md", text: "pilot v1\n", etag: "p1" },
      { path: "1-projects/deep/plan.md", text: "plan\n", etag: "d1", visibility: "team" },
      { path: "assets/photo.png", text: "binary", etag: "img1" },
    ],
    [W2]: [{ path: "index.md", text: "# Someone else's home\n", etag: "x1" }],
  };
});

describe("a sync puts every note on the device", () => {
  test("every note is downloaded, attachments are listed and not fetched", async () => {
    const run = await syncContext(deps(), { workspaceId: W1, tier: "private" });
    expect(run?.complete).toBe(true);
    expect(run?.fetched).toBe(3);
    const pilot = await mirroredNote(store, "private", W1, "1-projects/pilot.md");
    expect(pilot?.value.text).toBe("pilot v1\n");
    expect(pilot?.value.etag).toBe("p1");
    expect(calls.some((call) => call.includes("photo.png"))).toBe(false);
    const index = await readIndex(store, "private", W1);
    expect(index?.entries.get("assets/photo.png")?.body).toBe(false);
    expect(index?.complete).toBe(true);
    expect(index?.remaining).toBe(0);
  });

  test("a second sync fetches only what changed", async () => {
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    calls = [];
    buckets[W1]![1] = { path: "1-projects/pilot.md", text: "pilot v2\n", etag: "p2" };
    const run = await syncContext(deps(), { workspaceId: W1, tier: "private" });
    expect(run?.fetched).toBe(1);
    expect(calls.filter((call) => call.startsWith("read:"))).toEqual([
      `read:${W1}:1-projects/pilot.md`,
    ]);
    expect((await mirroredNote(store, "private", W1, "1-projects/pilot.md"))?.value.text).toBe(
      "pilot v2\n",
    );
  });

  test("a collaboration etag compares with its raw storage token", async () => {
    buckets[W1] = [
      {
        path: "1-projects/live.md",
        text: "shared\n",
        etag: "c2-doc:r1",
        rawEtag: "raw-1",
      },
    ];
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    expect((await mirroredNote(store, "private", W1, "1-projects/live.md"))?.value).toEqual(
      expect.objectContaining({ etag: "c2-doc:r1", rawEtag: "raw-1", text: "shared\n" }),
    );
    calls = [];

    // The collaboration generation is unchanged, and the provider token is
    // still the same, so a second sync must not download the body again.
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    expect(calls.filter((call) => call.startsWith("read:"))).toEqual([]);

    // A provider change invalidates the mirror even when the collaboration
    // version happened to be represented by the same document revision.
    buckets[W1]![0] = {
      path: "1-projects/live.md",
      text: "shared from peer\n",
      etag: "c2-doc:r2",
      rawEtag: "raw-2",
    };
    calls = [];
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    expect(calls.filter((call) => call.startsWith("read:"))).toEqual([
      `read:${W1}:1-projects/live.md`,
    ]);
    expect((await mirroredNote(store, "private", W1, "1-projects/live.md"))?.value.rawEtag).toBe(
      "raw-2",
    );
  });

  test("a note the manifest gave no version for is read to learn it", async () => {
    pageOverride = (workspaceId) => ({
      entries: manifestOf(buckets[workspaceId]!).map(({ etag: _etag, ...rest }) => rest),
      cursor: null,
      truncated: false,
      manifestUsable: true,
    });
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    calls = [];
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    // No etag means "the store gave none", never "unchanged".
    expect(calls.filter((call) => call.startsWith("read:"))).toHaveLength(1);
    expect(calls.find((call) => call.startsWith("read:"))).toContain("pilot.md");
  });

  test("a key ending in a slash is a folder marker, not a note", async () => {
    pageOverride = (workspaceId) => ({
      entries: [
        ...manifestOf(buckets[workspaceId]!),
        { path: "1-projects/", visibility: "private", inherited: "private", exception: false, readOnly: false },
      ],
      cursor: null,
      truncated: false,
      manifestUsable: true,
    });
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    expect(calls.some((call) => call.includes("1-projects/,") || call.endsWith("1-projects/"))).toBe(
      false,
    );
    expect((await readIndex(store, "private", W1))?.entries.has("1-projects/")).toBe(false);
  });

  test("the manifest is paged by cursor until it says it is done", async () => {
    const all = manifestOf(buckets[W1]!);
    pageOverride = (_workspaceId, cursor) =>
      cursor === undefined
        ? { entries: all.slice(0, 2), cursor: all[1]!.path, truncated: false, manifestUsable: true }
        : { entries: all.slice(2), cursor: null, truncated: false, manifestUsable: true };
    const run = await syncContext(deps(), { workspaceId: W1, tier: "private" });
    expect(calls.filter((call) => call.startsWith("manifest:"))).toEqual([
      `manifest:${W1}:`,
      `manifest:${W1}:${all[1]!.path}`,
    ]);
    expect(run?.complete).toBe(true);
  });

  test("reads go in batches of at most fifty, and a deferral is asked for again", async () => {
    buckets[W1] = Array.from({ length: 120 }, (_, n) => ({
      path: `notes/n${String(n).padStart(3, "0")}.md`,
      text: `note ${n}`,
      etag: `e${n}`,
    }));
    const run = await syncContext(
      deps({
        readNotes: async (workspaceId, paths) => {
          calls.push(`read:${workspaceId}:${paths.length}`);
          expect(paths.length).toBeLessThanOrEqual(50);
          return paths.map((path, position): BatchRead => {
            // The server's byte budget: the tail of every full batch is deferred.
            if (position >= 40) return { path, outcome: "deferred" };
            const found = buckets[workspaceId]!.find((note) => note.path === path)!;
            return { path, outcome: "read", note: noteOf(found) };
          });
        },
      }),
      { workspaceId: W1, tier: "private" },
    );
    expect(run?.complete).toBe(true);
    expect((await readIndex(store, "private", W1))?.entries.size).toBe(120);
  });
});

describe("a first sync does not rewrite the index per batch", () => {
  test("six hundred notes are committed in a handful of index writes", async () => {
    buckets[W1] = Array.from({ length: 600 }, (_, n) => ({
      path: `n${n}.md`,
      text: `note ${n}`,
      etag: `e${n}`,
    }));
    let indexWrites = 0;
    const counted: MirrorStore = {
      ...store,
      writeIndex: (...args) => {
        indexWrites += 1;
        return store.writeIndex(...args);
      },
    };
    const run = await syncContext(deps({ store: counted }), { workspaceId: W1, tier: "private" });
    expect(run?.complete).toBe(true);
    expect((await readIndex(store, "private", W1))?.entries.size).toBe(600);
    // Three commits of up to 250 and the final reconcile — not twelve batches.
    expect(indexWrites).toBeLessThanOrEqual(4);
  });
});

describe("what the device may hold is re-derived by every complete sync", () => {
  test("a note that left the manifest leaves the device", async () => {
    await syncContext(deps(), { workspaceId: W1, tier: "team" });
    expect(await mirroredNote(store, "team", W1, "1-projects/pilot.md")).not.toBeNull();
    // A group grant lost, a folder made private, a note deleted — to this
    // device they are all one fact: the path is no longer in the answer.
    buckets[W1] = buckets[W1]!.filter((note) => note.path !== "1-projects/pilot.md");
    const run = await syncContext(deps(), { workspaceId: W1, tier: "team" });
    expect(run?.pruned).toBe(1);
    expect(await mirroredNote(store, "team", W1, "1-projects/pilot.md")).toBeNull();
    expect(await store.readBody("team", W1, "current", "1-projects/pilot.md")).toBeNull();
    expect(listingOf((await readIndex(store, "team", W1))!, "1-projects")?.entries.map((e) => e.path)).toEqual([
      "1-projects/deep",
    ]);
  });

  test("a truncated manifest prunes nothing", async () => {
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    pageOverride = (workspaceId) => ({
      // Only the first entry, and the page says it could not finish.
      entries: manifestOf(buckets[workspaceId]!).slice(0, 1),
      cursor: null,
      truncated: true,
      manifestUsable: true,
    });
    const run = await syncContext(deps(), { workspaceId: W1, tier: "private" });
    expect(run?.complete).toBe(false);
    expect(run?.incomplete).toBe("manifest-truncated");
    expect(run?.pruned).toBe(0);
    expect(await mirroredNote(store, "private", W1, "1-projects/pilot.md")).not.toBeNull();
    expect((await readIndex(store, "private", W1))?.complete).toBe(false);
  });

  test("a manifest that fails part-way prunes nothing", async () => {
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    const all = manifestOf(buckets[W1]!);
    pageOverride = (_workspaceId, cursor) => {
      if (cursor !== undefined) throw new Error("timed out");
      return { entries: all.slice(0, 1), cursor: all[0]!.path, truncated: false, manifestUsable: true };
    };
    const run = await syncContext(deps(), { workspaceId: W1, tier: "private" });
    expect(run?.complete).toBe(false);
    expect(run?.pruned).toBe(0);
    expect(await mirroredNote(store, "private", W1, "1-projects/deep/plan.md")).not.toBeNull();
  });

  test("a manifest that cannot be fetched at all changes nothing on the device", async () => {
    pageOverride = () => {
      throw new Error("STORAGE_NOT_CONNECTED");
    };
    const first = await syncContext(deps(), { workspaceId: W1, tier: "private" });
    expect(first?.complete).toBe(false);
    // No index is created, so an empty or unreachable context is not "partial".
    expect(await readIndex(store, "private", W1)).toBeNull();

    pageOverride = null;
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    const before = await readIndex(store, "private", W1);
    pageOverride = () => {
      throw new Error("timed out");
    };
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    expect(await readIndex(store, "private", W1)).toEqual(before);
  });

  test("a cursor that does not move is truncation, not a loop", async () => {
    pageOverride = () => ({
      entries: manifestOf(buckets[W1]!).slice(0, 1),
      cursor: "index.md",
      truncated: false,
      manifestUsable: true,
    });
    const run = await syncContext(deps(), { workspaceId: W1, tier: "private" });
    expect(run?.complete).toBe(false);
    expect(calls.filter((call) => call.startsWith("manifest:")).length).toBeLessThanOrEqual(2);
  });

  test("a note the server refuses to read is dropped, even from an incomplete sync", async () => {
    await syncContext(deps(), { workspaceId: W1, tier: "team" });
    buckets[W1]![1] = { ...buckets[W1]![1]!, etag: "p2" };
    const listed = manifestOf(buckets[W1]!);
    buckets[W1] = buckets[W1]!.filter((note) => note.path !== "1-projects/pilot.md");
    pageOverride = () => ({ entries: listed, cursor: null, truncated: true, manifestUsable: true });
    await syncContext(deps(), { workspaceId: W1, tier: "team" });
    // Listed, then refused by the read: that is an answer about this path.
    expect(await mirroredNote(store, "team", W1, "1-projects/pilot.md")).toBeNull();
  });
});

describe("the clearance decides everything, and an unknown one decides nothing", () => {
  test("an unknown tier touches nothing", async () => {
    const run = await syncContext(deps(), { workspaceId: W1, tier: "unknown" });
    expect(run).toBeNull();
    expect(calls).toEqual([]);
    expect(await store.roots()).toEqual([]);
  });

  test("a team session's copy is filed at team and never served to a narrower read", async () => {
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    // An owner's copy is invisible to a team-level session.
    expect(await mirroredNote(store, "team", W1, "index.md")).toBeNull();
    expect(await mirroredListing(store, "team", W1, "")).toBeNull();
    // And a team copy is readable by an owner, as the read cache's widening is.
    const teamStore = store;
    await syncContext(deps(), { workspaceId: W2, tier: "team" });
    expect(await mirroredNote(teamStore, "private", W2, "index.md")).not.toBeNull();
  });

  test("each context's notes are filed under that context", async () => {
    await syncAll(deps(), [
      { workspaceId: W1, tier: "private" },
      { workspaceId: W2, tier: "private" },
    ]);
    expect((await mirroredNote(store, "private", W1, "index.md"))?.value.text).toBe("# Home\n");
    expect((await mirroredNote(store, "private", W2, "index.md"))?.value.text).toBe(
      "# Someone else's home\n",
    );
    expect((await readIndex(store, "private", W2))?.entries.size).toBe(1);
  });

  test("contexts are synced one after another, never interleaved", async () => {
    await syncAll(deps(), [
      { workspaceId: W1, tier: "private" },
      { workspaceId: W2, tier: "team" },
    ]);
    const firstW2 = calls.findIndex((call) => call.includes(`:${W2}:`));
    const lastW1 = calls.map((call) => call.includes(`:${W1}:`)).lastIndexOf(true);
    expect(lastW1).toBeLessThan(firstW2);
  });
});

describe("a sign-out during a sync", () => {
  test("a sign-out during a sync leaves nothing", async () => {
    buckets[W1] = Array.from({ length: 200 }, (_, n) => ({
      path: `n${n}.md`,
      text: `note ${n}`,
      etag: `e${n}`,
    }));
    const base = deps();
    let reads = 0;
    const running = syncContext(
      {
        ...base,
        readNotes: async (workspaceId, paths) => {
          reads += 1;
          if (reads === 2) {
            // The person presses sign out while this batch is on the wire.
            endSession();
            await store.clearAll();
          }
          return base.readNotes(workspaceId, paths);
        },
      },
      { workspaceId: W1, tier: "private" },
    );
    const run = await running;
    expect(run?.aborted).toBe(true);
    expect(await store.roots()).toEqual([]);
    expect(await readIndex(store, "private", W1)).toBeNull();
  });
});

describe("the ancestor a queued edit needs", () => {
  test("the version a queued edit is based on survives the sync that replaces it", async () => {
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    // Typed offline against p1; the bucket has since moved to p2.
    needed = (path) => new Set(path === "1-projects/pilot.md" ? ["p1"] : []);
    buckets[W1]![1] = { path: "1-projects/pilot.md", text: "pilot v2\n", etag: "p2" };
    await syncContext(deps(), { workspaceId: W1, tier: "private" });

    // What the editor serves is the bucket's newest…
    expect((await mirroredNote(store, "private", W1, "1-projects/pilot.md"))?.value.etag).toBe("p2");
    // …and the ancestor the merge needs is still here, at exactly p1.
    expect(await mirroredAncestor(store, "private", W1, "1-projects/pilot.md", "p1")).toEqual({
      text: "pilot v1\n",
      etag: "p1",
    });
  });

  test("the held ancestor goes once nothing is based on it", async () => {
    needed = (path) => new Set(path === "1-projects/pilot.md" ? ["p1"] : []);
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    buckets[W1]![1] = { path: "1-projects/pilot.md", text: "pilot v2\n", etag: "p2" };
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    expect((await readIndex(store, "private", W1))?.entries.get("1-projects/pilot.md")?.base).toBe(
      "p1",
    );
    needed = () => new Set();
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    expect((await readIndex(store, "private", W1))?.entries.get("1-projects/pilot.md")?.base).toBe(
      undefined,
    );
    expect(await store.readBody("private", W1, "base", "1-projects/pilot.md")).toBeNull();
    // With nothing held, the current copy is offered and `offerMerge` will
    // say it moved on — the true sentence.
    expect(
      (await mirroredAncestor(store, "private", W1, "1-projects/pilot.md", "p1"))?.etag,
    ).toBe("p2");
  });

  test("a note that became encrypted keeps no plaintext ancestor", async () => {
    needed = (path) => new Set(path === "1-projects/pilot.md" ? ["p1"] : []);
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    buckets[W1]![1] = {
      path: "1-projects/pilot.md",
      text: "-----BEGIN CONTEXT ENCRYPTED NOTE-----\nciphertext\n",
      etag: "p2",
      encrypted: true,
    };
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    const note = await mirroredNote(store, "private", W1, "1-projects/pilot.md");
    // Stored as the bucket returned it: ciphertext, marked, never plaintext.
    expect(note?.value.encrypted).toBe(true);
    expect(note?.value.text).toContain("ciphertext");
    expect(await store.readBody("private", W1, "base", "1-projects/pilot.md")).toBeNull();
    expect(await mirroredAncestor(store, "private", W1, "1-projects/pilot.md", "p1")).not.toEqual(
      expect.objectContaining({ text: "pilot v1\n" }),
    );
  });

  test("an online open keeps the ancestor too, through the same writer", async () => {
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    const opened = noteOf({ path: "1-projects/pilot.md", text: "pilot v2\n", etag: "p2" });
    await putMirroredNotes(
      store,
      currentEpoch(),
      "private",
      W1,
      [opened],
      (path) => new Set(path === "1-projects/pilot.md" ? ["p1"] : []),
      2_000,
    );
    expect(
      (await mirroredAncestor(store, "private", W1, "1-projects/pilot.md", "p1"))?.text,
    ).toBe("pilot v1\n");
  });
});

describe("a listing is derived for every folder, opened before or not", () => {
  test("folders and files come from paths, folders first", async () => {
    await syncContext(deps(), { workspaceId: W1, tier: "private" });
    const root = await mirroredListing(store, "private", W1, "");
    expect(root?.value.entries.map((entry) => `${entry.kind}:${entry.path}`)).toEqual([
      "folder:1-projects",
      "folder:assets",
      "file:index.md",
    ]);
    const deep = await mirroredListing(store, "private", W1, "1-projects/deep");
    expect(deep?.value.entries.map((entry) => entry.path)).toEqual(["1-projects/deep/plan.md"]);
    // A folder row's badge, with no listing ever seen: its direct note's rule.
    expect(deep?.value.folderDefault).toBe("team");
    expect(await mirroredListing(store, "private", W1, "nowhere")).toBeNull();
  });
});
