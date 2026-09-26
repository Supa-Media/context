/**
 * A STATUS CHOSEN ON A FOLDER PAGE IS STILL THERE AFTER A REFRESH.
 *
 * Reported from staging: "when trying to edit the status it does not even
 * stick, i refresh and it goes back to the value". The write did land in the
 * bucket. The page reads this device's mirror, and nothing moved the mirror's
 * copy of the note: the choice showed only because it was laid over the page
 * in memory, so a refresh dropped the overlay and drew the old copy again —
 * and the sync that followed fetched the new body without telling the page.
 *
 * So a list write puts the note it wrote back into the mirror, read from the
 * bucket at the version it now holds, and says so; and a sync that fetched
 * bodies says so too. Sabotage-checked: skipping the write-back fails "a
 * chosen status survives a refresh" and "a folder's first status ...";
 * dropping `onFetched` fails "a sync that fetched bodies says so".
 */

import { beforeEach, describe, expect, test } from "@jest/globals";
import { ConvexError } from "convex/values";
import { currentEpoch } from "../features/offline/epoch";
import { putMirroredNotes } from "../features/offline/mirror";
import { memoryMirrorStore, type MirrorStore } from "../features/offline/mirrorStoreCore";
import { forgetMirrorLists } from "../features/offline/mirrorLists";
import { folderListSource, type FolderListIO } from "../features/offline/folderListSource";
import { syncContext, type ManifestEntry } from "../features/offline/mirrorSync";
import type { OpenNote } from "../features/console/files/types";

const W = "ws_one";

let store: MirrorStore;
let bucket: Map<string, { text: string; etag: string }>;
let version: number;

const noteAt = (path: string): OpenNote & { updatedAt: number } => {
  const held = bucket.get(path);
  if (held === undefined) {
    throw new ConvexError({ code: "FILE_NOT_FOUND", message: "gone" });
  }
  return {
    path,
    text: held.text,
    etag: held.etag,
    visibility: "team",
    inherited: "team",
    exception: false,
    readOnly: false,
    updatedAt: version,
  };
};

const io: FolderListIO = {
  readNote: async (path) => noteAt(path),
  writeNote: async (path, text, expectedEtag) => {
    const held = bucket.get(path);
    if ((held?.etag ?? undefined) !== expectedEtag) throw new Error("conflict");
    version += 1;
    bucket.set(path, { text, etag: `e${version}` });
    return { path };
  },
};

function source() {
  return folderListSource({
    workspaceId: W,
    scope: "private",
    canEdit: true,
    io,
    openMirror: async () => store,
    needed: async () => () => new Set(),
  });
}

/** What a reload reads: nothing in memory, only what the device holds. */
async function afterRefresh(path: string) {
  forgetMirrorLists();
  const listed = await source().load("1-projects", true);
  return listed?.notes.find((note) => note.path === path)?.properties.status;
}

beforeEach(async () => {
  store = memoryMirrorStore();
  version = 1;
  bucket = new Map([["1-projects/web/overview.md", { text: "---\nstatus: active\n---\n# Web\n", etag: "e1" }]]);
  forgetMirrorLists();
  await putMirroredNotes(store, currentEpoch(), "private", W, [noteAt("1-projects/web/overview.md")], () => new Set(), 1);
});

describe("a list write is what the device holds afterwards", () => {
  test("a chosen status survives a refresh", async () => {
    expect(await afterRefresh("1-projects/web/overview.md")).toBe("active");
    expect(await source().setProperty!("1-projects/web/overview.md", "status", "done")).toBeNull();
    expect(bucket.get("1-projects/web/overview.md")?.text).toContain("status: done");
    expect(await afterRefresh("1-projects/web/overview.md")).toBe("done");
  });

  test("a folder's first status, written into a new overview.md, survives a refresh", async () => {
    expect(await source().setProperty!("1-projects/app/overview.md", "status", "planned", { create: true })).toBeNull();
    expect(await afterRefresh("1-projects/app/overview.md")).toBe("planned");
  });

  test("the lists reading this workspace are told, once the device holds it", async () => {
    const heard: string[] = [];
    const listening = source();
    const stop = listening.subscribe!(() => heard.push("changed"));
    await listening.setProperty!("1-projects/web/overview.md", "status", "done");
    stop();
    expect(heard.length).toBeGreaterThan(0);
  });

  test("a refused write moves nothing on the device", async () => {
    const refusing = folderListSource({
      workspaceId: W,
      scope: "private",
      canEdit: true,
      io: { ...io, writeNote: async () => Promise.reject(new Error("storage down")) },
      openMirror: async () => store,
      needed: async () => () => new Set(),
    });
    expect(await refusing.setProperty!("1-projects/web/overview.md", "status", "done")).toBe("That change could not be saved.");
    expect(await afterRefresh("1-projects/web/overview.md")).toBe("active");
  });

  test("a reader who may not write is offered no write", () => {
    const reading = folderListSource({ workspaceId: W, scope: "team", canEdit: false, io, openMirror: async () => store, needed: async () => () => new Set() });
    expect(reading.setProperty).toBeUndefined();
  });
});

describe("a sync that fetched bodies says so", () => {
  const manifest = (): ManifestEntry[] =>
    [...bucket].map(([path, held]) => ({ path, etag: held.etag, visibility: "team", inherited: "team", exception: false, readOnly: false }));

  test("the page hears about a body that changed elsewhere, not only about the listing", async () => {
    bucket.set("1-projects/web/overview.md", { text: "---\nstatus: paused\n---\n", etag: "e9" });
    const fetched: string[] = [];
    const epoch = currentEpoch();
    await syncContext(
      {
        store,
        epoch,
        mine: () => epoch === currentEpoch(),
        now: () => 5,
        needed: async () => () => new Set(),
        manifest: async () => ({ entries: manifest(), cursor: null, truncated: false, manifestUsable: true }),
        readNotes: async (_workspaceId, paths) => paths.map((path) => ({ path, outcome: "read" as const, note: { ...noteAt(path), encrypted: false } })),
        onFetched: (workspaceId) => fetched.push(workspaceId),
      },
      { workspaceId: W, tier: "private" },
    );
    expect(fetched).toEqual([W]);
    expect(await afterRefresh("1-projects/web/overview.md")).toBe("paused");
  });

  test("and says nothing when nothing changed", async () => {
    const fetched: string[] = [];
    const epoch = currentEpoch();
    await syncContext(
      {
        store,
        epoch,
        mine: () => epoch === currentEpoch(),
        now: () => 5,
        needed: async () => () => new Set(),
        manifest: async () => ({ entries: manifest(), cursor: null, truncated: false, manifestUsable: true }),
        readNotes: async () => [],
        onFetched: (workspaceId) => fetched.push(workspaceId),
      },
      { workspaceId: W, tier: "private" },
    );
    expect(fetched).toEqual([]);
  });
});
