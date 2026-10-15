/**
 * ONLINE, A LIST OR BOARD READS THE SERVER; THE DEVICE'S COPY IS FOR OFFLINE.
 *
 * Decided by the owner, 2026-10-08: "when connected to the internet we should
 * always be using server", and "offline should only be a thing on the desktop
 * app and on a native mobile app". A project List drawn from a mirror whose
 * walk had stopped short showed folders as empty and statuses as old. So:
 *
 * - online, `load` asks the server for the folder's notes (`folderNotes`),
 *   whatever the device holds;
 * - offline, it reads the device's copy, and only there;
 * - a browser has no copy, and a list still works.
 *
 * And, decided by the owner on 2026-10-13, the server answers a List from
 * the Convex tree and its parsed facts alone: no note body is read for it,
 * not even where the facts cannot answer yet. That is an incomplete List,
 * never a walk and a read of every note.
 *
 * Sabotage-checked: making `load` prefer the mirror while online fails "the
 * server's answer, not the device's older copy"; drawing an unavailable
 * answer as a complete List fails "a server that cannot answer yet".
 */

import { beforeEach, describe, expect, test } from "@jest/globals";
import { currentEpoch } from "../features/offline/epoch";
import { putMirroredNotes } from "../features/offline/mirror";
import { memoryMirrorStore, type MirrorStore } from "../features/offline/mirrorStoreCore";
import { folderListSource, type FolderListIO } from "../features/offline/folderListSource";
import { serverFrontNotes, tableListNotes, type ServerListIO } from "../features/offline/serverLists";
import type { BatchRead } from "../features/offline/mirrorSync";
import type { OpenNote } from "../features/console/files/types";

const W = "ws_one";

const note = (path: string, text: string, etag = `e-${path}`): OpenNote => ({
  path,
  text,
  etag,
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
});

/** Front matter as the server's facts hold it, for one note's body. */
function factsOf(text: string): string {
  const status = /status: (\w+)/.exec(text)?.[1];
  return JSON.stringify({ properties: status === undefined ? {} : { status }, heading: null, lede: null });
}

/** A workspace as the server answers for it: a folder's notes from its facts, and reads by name. */
function server(bucket: Record<string, OpenNote & { encrypted?: boolean }>) {
  const calls = { folderNotes: 0, read: [] as string[] };
  const io: ServerListIO = {
    folderNotes: async (folder, subfolders) => {
      calls.folderNotes += 1;
      const prefix = folder === "" ? "" : `${folder}/`;
      const paths = Object.keys(bucket)
        .filter((path) => path.startsWith(prefix) && (subfolders || !path.slice(prefix.length).includes("/")))
        .sort();
      return { available: true, notes: paths.map((path) => ({ path, props: factsOf(bucket[path]!.text) })), cursor: null, missing: [] };
    },
    readNotes: async (paths) => {
      calls.read.push(...paths);
      return paths.map((path): BatchRead => {
        const found = bucket[path];
        return found === undefined
          ? { path, outcome: "error", code: "FILE_NOT_FOUND", message: "gone" }
          : { path, outcome: "read", note: found };
      });
    },
  };
  return { io, calls };
}

describe("folderListSource reads the server online and the device only offline", () => {
  let store: MirrorStore;
  let online: boolean;
  const live = { "1-projects/web/overview.md": note("1-projects/web/overview.md", "---\nstatus: done\n---\n# Web\n", "e-new") };

  beforeEach(async () => {
    store = memoryMirrorStore();
    online = true;
    // The device's copy is older than the bucket: it still says active.
    await putMirroredNotes(store, currentEpoch(), "private", W, [note("1-projects/web/overview.md", "---\nstatus: active\n---\n# Web\n", "e-old")], () => new Set(), 1);
  });

  function source(io: ServerListIO, mirror: MirrorStore | null = store) {
    const full: FolderListIO = {
      ...io,
      readNote: async (path) => {
        const found = live[path as keyof typeof live];
        if (found === undefined) throw new Error("not found");
        return found;
      },
      writeNote: async (path) => ({ path }),
    };
    return folderListSource({
      workspaceId: W,
      scope: "private",
      canEdit: true,
      io: full,
      openMirror: async () => mirror,
      needed: async () => () => new Set(),
      online: () => online,
    });
  }

  test("online: the server's answer, not the device's older copy", async () => {
    const result = await source(server(live).io).load("1-projects/web", false);
    expect(result!.notes.map((each) => each.properties.status)).toEqual(["done"]);
  });

  test("offline: the device's copy, and the server is not asked", async () => {
    online = false;
    const { io, calls } = server(live);
    const result = await source(io).load("1-projects/web", false);
    expect(result!.notes.map((each) => each.properties.status)).toEqual(["active"]);
    expect(calls.folderNotes).toBe(0);
  });

  test("a browser with no copy still draws its lists from the server", async () => {
    const result = await source(server(live).io, null).load("1-projects/web", false);
    expect(result!.notes.map((each) => each.path)).toEqual(["1-projects/web/overview.md"]);
  });

  test("a server that fails falls back to the device's copy where there is one, and errors where there is not", async () => {
    const down: ServerListIO = { folderNotes: async () => Promise.reject(new Error("down")), readNotes: async () => [] };
    const fallback = await source(down).load("1-projects/web", false);
    expect(fallback!.notes.map((each) => each.properties.status)).toEqual(["active"]);
    await expect(source(down, null).load("1-projects/web", false)).rejects.toThrow("down");
  });

  test("online, the side panel reads the bucket before the device's copy", async () => {
    const body = await source(server(live).io).readBody!("1-projects/web/overview.md");
    expect(body!.text).toContain("status: done");
    online = false;
    const offlineBody = await source(server(live).io).readBody!("1-projects/web/overview.md");
    expect(offlineBody!.text).toContain("status: active");
  });

  test("a list's own write tells its subscribers, with no copy on the device to announce it", async () => {
    const lists = source(server(live).io, null);
    let heard = 0;
    const stop = lists.subscribe!(() => {
      heard += 1;
    });
    expect(await lists.setProperty!("1-projects/web/overview.md", "status", "paused")).toBeNull();
    expect(heard).toBeGreaterThan(0);
    stop();
  });
});

describe("serverFrontNotes", () => {
  test("reads the front notes of the folders above by name, without walking them", async () => {
    const bucket = {
      "1-projects/about.md": note("1-projects/about.md", "---\nstatuses: [todo, done]\n---\n"),
      "1-projects/big-sibling.md": note("1-projects/big-sibling.md", "---\nstatus: todo\n---\n"),
      "index.md": note("index.md", "# Home\n"),
    };
    const { io, calls } = server(bucket);
    const notes = await serverFrontNotes(io, ["1-projects", ""]);
    expect(notes.map((each) => each.path).sort()).toEqual(["1-projects/about.md", "index.md"]);
    expect(calls.folderNotes).toBe(0);
    expect(calls.read).not.toContain("1-projects/big-sibling.md");
  });
});

describe("tableListNotes", () => {
  const props = (status: string) => JSON.stringify({ properties: { status }, heading: "H", lede: null });

  test("the table's pages become the list, and no note is read", async () => {
    const { io, calls } = server({});
    const asked: (string | undefined)[] = [];
    const table: ServerListIO = {
      ...io,
      folderNotes: async (_folder, _subfolders, cursor) => {
        asked.push(cursor);
        return cursor === undefined
          ? { available: true, notes: [{ path: "1-projects/a.md", updatedAt: 3, props: props("doing") }], cursor: "1-projects/a.md", missing: [] }
          : { available: true, notes: [{ path: "1-projects/b.md", props: props("done") }], cursor: null, missing: [] };
      },
    };
    const result = await tableListNotes(table, "1-projects", true);
    expect(result?.notes.map((note) => [note.path, note.properties.status, note.heading])).toEqual([
      ["1-projects/a.md", "doing", "H"],
      ["1-projects/b.md", "done", "H"],
    ]);
    expect(result?.complete).toBe(true);
    expect(asked).toEqual([undefined, "1-projects/a.md"]);
    expect(calls.read).toEqual([]);
  });

  test("a server that cannot answer yet is an incomplete List, and no note is read for it", async () => {
    const bucket = { "1-projects/a.md": note("1-projects/a.md", "---\nstatus: active\n---\n") };
    const { io, calls } = server(bucket);
    const table: FolderListIO = {
      ...io,
      folderNotes: async () => ({ available: false, notes: [], cursor: null, missing: [] }),
      readNote: async () => { throw new Error("unused"); },
      writeNote: async () => { throw new Error("unused"); },
    };
    const source = folderListSource({
      workspaceId: W,
      scope: "team",
      canEdit: false,
      io: table,
      openMirror: async () => null,
      needed: async () => new Map() as never,
      online: () => true,
    });
    const result = await source.load("1-projects", true);
    expect(result).toEqual({ notes: [], complete: false });
    expect(calls.read).toEqual([]);
  });

  test("a note the facts have not parsed yet is a gap the List admits to", async () => {
    const gaps: ServerListIO = {
      readNotes: async () => [],
      folderNotes: async () => ({ available: true, notes: [], cursor: null, missing: ["1-projects/new.md"] }),
    };
    expect(await tableListNotes(gaps, "1-projects", true)).toEqual({ notes: [], complete: false, missing: ["1-projects/new.md"] });
  });
});
