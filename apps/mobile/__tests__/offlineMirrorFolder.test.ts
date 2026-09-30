/**
 * A project folder's notes, brought up to date on this device when its List
 * opens — the phone that read "In progress 2" where the web read "In progress
 * 9", because the whole-context pass stopped in `0-inbox/` every time and
 * never reached `1-projects/`.
 *
 * Sabotage-checked: dropping the version compare from `stalePathsFor` fails
 * "an older copy is replaced"; widening `wanted` to everything fails "only the
 * open folder and the notes above it are read".
 */
import { beforeEach, describe, expect, test } from "@jest/globals";
import { currentEpoch } from "../features/offline/epoch";
import { readIndex, type Needed } from "../features/offline/mirror";
import { FOLDER_FRESHEN_LIMIT, freshenFolder } from "../features/offline/mirrorFolder";
import { forgetMirrorLists, mirroredListNotes } from "../features/offline/mirrorLists";
import { memoryMirrorStore, type MirrorStore } from "../features/offline/mirrorStoreCore";
import { syncContext, type BatchRead, type MirrorSyncDeps } from "../features/offline/mirrorSync";

const WS = "ws";
const TARGET = { workspaceId: WS, tier: "private" as const };

interface Remote {
  path: string;
  text: string;
  etag: string;
}

let bucket: Remote[];
let reads: string[][];
let store: MirrorStore;
let failReads: boolean;
const needed: Needed = () => new Set();

function deps(): MirrorSyncDeps {
  const epoch = currentEpoch();
  return {
    store,
    epoch,
    mine: () => epoch === currentEpoch(),
    now: () => 1_000,
    needed: async () => needed,
    manifest: async () => ({
      entries: bucket.map((note) => ({
        path: note.path,
        etag: note.etag,
        size: note.text.length,
        visibility: "private",
        inherited: "private",
        exception: false,
        readOnly: false,
      })),
      cursor: null,
      truncated: false,
      manifestUsable: true,
    }),
    readNotes: async (_workspaceId, paths) => {
      reads.push(paths);
      if (failReads) throw new Error("timed out");
      return paths.map((path): BatchRead => {
        const found = bucket.find((note) => note.path === path);
        return found === undefined
          ? { path, outcome: "error", code: "FILE_NOT_FOUND", message: "not found" }
          : {
              path,
              outcome: "read",
              note: {
                path,
                text: found.text,
                etag: found.etag,
                visibility: "private",
                inherited: "private",
                exception: false,
                readOnly: false,
              },
            };
      });
    },
  };
}

const task = (path: string, status: string, etag = "v1"): Remote => ({
  path,
  text: `---\nstatus: ${status}\n---\n# ${path}\n`,
  etag,
});

async function statuses(folder: string): Promise<Record<string, unknown>> {
  const source = await mirroredListNotes(store, "private", WS, folder, true);
  return Object.fromEntries((source?.notes ?? []).map((note) => [note.path, note.properties.status]));
}

beforeEach(() => {
  store = memoryMirrorStore();
  forgetMirrorLists();
  reads = [];
  failReads = false;
  bucket = [
    { path: "index.md", text: "# Home\n", etag: "h1" },
    ...Array.from({ length: 60 }, (_, n) => ({
      path: `0-inbox/sessions/s${String(n).padStart(3, "0")}.md`,
      text: "session\n",
      etag: "s1",
    })),
    { path: "1-projects/README.md", text: "---\nstatuses: backlog, in progress, finished\n---\n", etag: "r1" },
    task("1-projects/cast-promo-videos/overview.md", "in progress"),
    task("1-projects/cast-promo-videos/export.md", "finished"),
    task("1-projects/premium/overview.md", "in progress"),
    { path: "2-products/context.md", text: "# Context\n", etag: "c1" },
  ];
});

describe("a project folder's notes, fetched when its List opens", () => {
  test("a pass that never got past 0-inbox leaves the List with no statuses, and opening it fetches them", async () => {
    failReads = true;
    await syncContext(deps(), TARGET);
    expect(await statuses("1-projects")).toEqual({});

    failReads = false;
    reads = [];
    const fetched = await freshenFolder(deps(), TARGET, "1-projects");
    expect(fetched).toBe(5); // four under 1-projects, and index.md above it
    expect(await statuses("1-projects")).toEqual({
      "1-projects/README.md": undefined,
      "1-projects/cast-promo-videos/overview.md": "in progress",
      "1-projects/cast-promo-videos/export.md": "finished",
      "1-projects/premium/overview.md": "in progress",
    });
  });

  test("only the open folder and the notes above it are read", async () => {
    await freshenFolder(deps(), TARGET, "1-projects/cast-promo-videos");
    expect(reads.flat().sort()).toEqual([
      "1-projects/README.md",
      "1-projects/cast-promo-videos/export.md",
      "1-projects/cast-promo-videos/overview.md",
      "index.md",
    ]);
  });

  test("an older copy is replaced, and a current one is not read again", async () => {
    await freshenFolder(deps(), TARGET, "1-projects");
    bucket = bucket.map((note) =>
      note.path === "1-projects/cast-promo-videos/overview.md" ? task(note.path, "finished", "v2") : note,
    );
    reads = [];
    expect(await freshenFolder(deps(), TARGET, "1-projects")).toBe(1);
    expect(reads).toEqual([["1-projects/cast-promo-videos/overview.md"]]);
    expect((await statuses("1-projects"))["1-projects/cast-promo-videos/overview.md"]).toBe("finished");
  });

  test("other folders' copies stay as they were, and the context's own sync status is left to the pass", async () => {
    await syncContext(deps(), TARGET);
    const before = await readIndex(store, "private", WS);
    bucket = bucket.map((note) => (note.path === "2-products/context.md" ? { ...note, text: "# New\n", etag: "c2" } : note));
    bucket.push(task("1-projects/new/overview.md", "backlog"));
    await freshenFolder(deps(), TARGET, "1-projects");
    const after = await readIndex(store, "private", WS);
    expect(after?.entries.get("2-products/context.md")?.etag).toBe("c1");
    expect(after?.entries.get("1-projects/new/overview.md")?.body).toBe(true);
    expect(after?.lastSyncedAt).toBe(before?.lastSyncedAt);
    expect(after?.complete).toBe(before?.complete);
  });

  test("offline, it reads nothing and says so without throwing", async () => {
    failReads = true;
    expect(await freshenFolder(deps(), TARGET, "1-projects")).toBe(0);
  });

  test("a huge folder is a bounded cost", async () => {
    bucket = Array.from({ length: FOLDER_FRESHEN_LIMIT + 40 }, (_, n) => task(`1-projects/t${n}.md`, "backlog"));
    await freshenFolder(deps(), TARGET, "1-projects");
    expect(reads.flat()).toHaveLength(FOLDER_FRESHEN_LIMIT);
  });
});
