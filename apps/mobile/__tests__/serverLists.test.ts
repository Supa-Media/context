/**
 * ONLINE, A LIST OR BOARD READS THE SERVER; THE DEVICE'S COPY IS FOR OFFLINE.
 *
 * Decided by the owner, 2026-10-08: "when connected to the internet we should
 * always be using server", and "offline should only be a thing on the desktop
 * app and on a native mobile app". A project List drawn from a mirror whose
 * walk had stopped short showed folders as empty and statuses as old. So:
 *
 * - online, `load` walks the folder's manifest and reads the notes, whatever
 *   the device holds;
 * - offline, it reads the device's copy, and only there;
 * - a browser has no copy, and a list still works.
 *
 * Sabotage-checked: making `load` prefer the mirror while online fails "the
 * server's answer, not the device's older copy".
 */

import { beforeEach, describe, expect, test } from "@jest/globals";
import { currentEpoch } from "../features/offline/epoch";
import { putMirroredNotes } from "../features/offline/mirror";
import { memoryMirrorStore, type MirrorStore } from "../features/offline/mirrorStoreCore";
import { folderListSource, type FolderListIO } from "../features/offline/folderListSource";
import { READ_PARALLEL, serverFrontNotes, serverListNotes, type ServerListIO, type ServerListMemo } from "../features/offline/serverLists";
import type { BatchRead, ManifestPage } from "../features/offline/mirrorSync";
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

/** A bucket as the server answers for it: a manifest of one folder, and batch reads. */
function server(bucket: Record<string, OpenNote & { encrypted?: boolean }>, options: { pageSize?: number; defer?: (path: string) => boolean; refuse?: Set<string> } = {}) {
  const calls = { manifest: 0, read: [] as string[] };
  const io: ServerListIO = {
    manifest: async (folder, cursor) => {
      calls.manifest += 1;
      const prefix = folder === "" ? "" : `${folder}/`;
      const paths = Object.keys(bucket).filter((path) => path.startsWith(prefix)).sort();
      const start = cursor === undefined ? 0 : paths.indexOf(cursor) + 1;
      const size = options.pageSize ?? 1000;
      const page = paths.slice(start, start + size);
      const more = start + size < paths.length;
      return {
        entries: page.map((path) => ({ path, etag: bucket[path]!.etag, updatedAt: 5, visibility: "team", inherited: "team", exception: false, readOnly: false })),
        cursor: more ? page[page.length - 1]! : null,
        truncated: false,
        manifestUsable: true,
      } as ManifestPage;
    },
    readNotes: async (paths) => {
      calls.read.push(...paths);
      return paths.map((path): BatchRead => {
        if (options.refuse?.has(path)) return { path, outcome: "error", code: "FORBIDDEN", message: "no" };
        if (options.defer?.(path)) return { path, outcome: "deferred" };
        const found = bucket[path];
        return found === undefined
          ? { path, outcome: "error", code: "FILE_NOT_FOUND", message: "gone" }
          : { path, outcome: "read", note: found };
      });
    },
  };
  return { io, calls };
}

describe("serverListNotes", () => {
  const bucket = {
    "1-projects/a.md": note("1-projects/a.md", "---\nstatus: active\n---\n# A\n"),
    "1-projects/deep/b.md": note("1-projects/deep/b.md", "---\nstatus: done\n---\n# B\n"),
    "1-projects/.hidden/c.md": note("1-projects/.hidden/c.md", "# C\n"),
    "1-projects/picture.png": note("1-projects/picture.png", ""),
  };

  test("the folder's own notes, or its whole subtree, never plumbing or attachments", async () => {
    const { io } = server(bucket);
    const direct = await serverListNotes(io, new Map(), "1-projects", false);
    expect(direct.notes.map((each) => each.path)).toEqual(["1-projects/a.md"]);
    expect(direct.notes[0]!.properties.status).toBe("active");
    expect(direct.complete).toBe(true);
    const all = await serverListNotes(io, new Map(), "1-projects", true);
    expect(all.notes.map((each) => each.path).sort()).toEqual(["1-projects/a.md", "1-projects/deep/b.md"]);
  });

  test("a redraw reads only the notes whose version changed", async () => {
    const live = { ...bucket };
    const { io, calls } = server(live);
    const memo: ServerListMemo = new Map();
    await serverListNotes(io, memo, "1-projects", true);
    calls.read.length = 0;
    live["1-projects/a.md"] = note("1-projects/a.md", "---\nstatus: paused\n---\n# A\n", "e-2");
    const again = await serverListNotes(io, memo, "1-projects", true);
    expect(calls.read).toEqual(["1-projects/a.md"]);
    expect(again.notes.find((each) => each.path === "1-projects/a.md")!.properties.status).toBe("paused");
  });

  test("every page of a long folder is walked", async () => {
    const many: Record<string, OpenNote> = {};
    for (let index = 0; index < 7; index += 1) many[`0-inbox/n${index}.md`] = note(`0-inbox/n${index}.md`, `# ${index}\n`);
    const { io, calls } = server(many, { pageSize: 3 });
    const result = await serverListNotes(io, new Map(), "0-inbox", false);
    expect(result.notes).toHaveLength(7);
    expect(calls.manifest).toBe(3);
    expect(result.complete).toBe(true);
  });

  test("a deferred note is asked again; one that never fits is a gap, not a hang", async () => {
    let first = true;
    // The server reads what fits its byte budget and defers the rest.
    const once = server(bucket, { defer: (path) => path === "1-projects/deep/b.md" && (first ? ((first = false), true) : false) });
    const read = await serverListNotes(once.io, new Map(), "1-projects", true);
    expect(read.notes.map((each) => each.path).sort()).toEqual(["1-projects/a.md", "1-projects/deep/b.md"]);
    expect(once.calls.read).toEqual(["1-projects/a.md", "1-projects/deep/b.md", "1-projects/deep/b.md"]);
    const never = server(bucket, { defer: () => true });
    const gap = await serverListNotes(never.io, new Map(), "1-projects", false);
    expect(gap.notes).toEqual([]);
    expect(gap.complete).toBe(false);
    expect(gap.missing).toEqual(["1-projects/a.md"]);
  });

  test("a note gone since the walk is simply absent; a refused one is a gap", async () => {
    const { io } = server({ ...bucket }, { refuse: new Set(["1-projects/deep/b.md"]) });
    const shrinking = { ...io, readNotes: async (paths: string[]) => (await io.readNotes(paths)).map((each): BatchRead => (each.path === "1-projects/a.md" ? { path: each.path, outcome: "error", code: "FILE_NOT_FOUND", message: "gone" } : each)) };
    const result = await serverListNotes(shrinking, new Map(), "1-projects", true);
    expect(result.notes).toEqual([]);
    expect(result.missing).toEqual(["1-projects/deep/b.md"]);
    expect(result.complete).toBe(false);
  });

  test("a big folder's batches are asked for several at once, and every note still arrives", async () => {
    const many: Record<string, OpenNote> = {};
    for (let index = 0; index < 230; index += 1) many[`1-projects/n${String(index).padStart(3, "0")}.md`] = note(`1-projects/n${String(index).padStart(3, "0")}.md`, `---\nstatus: s${index}\n---\n`);
    const { io } = server(many);
    let inFlight = 0;
    let most = 0;
    const counting: ServerListIO = {
      ...io,
      readNotes: async (paths) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        try {
          return await io.readNotes(paths);
        } finally {
          inFlight -= 1;
        }
      },
    };
    const result = await serverListNotes(counting, new Map(), "1-projects", false);
    expect(result.notes).toHaveLength(230);
    expect(result.complete).toBe(true);
    expect(most).toBe(READ_PARALLEL);
  });

  test("a batch that never fits stops every reader and leaves the rest as gaps", async () => {
    const many: Record<string, OpenNote> = {};
    for (let index = 0; index < 120; index += 1) many[`0-inbox/n${index}.md`] = note(`0-inbox/n${index}.md`, "# x\n");
    const result = await serverListNotes(server(many, { defer: () => true }).io, new Map(), "0-inbox", false);
    expect(result.notes).toEqual([]);
    expect(result.complete).toBe(false);
    expect([...(result.missing ?? [])].sort()).toEqual(Object.keys(many).sort());
  });

  test("an encrypted note is left out, as offline", async () => {
    const sealed = { "0-inbox/s.md": { ...note("0-inbox/s.md", "ciphertext"), encrypted: true } };
    const result = await serverListNotes(server(sealed).io, new Map(), "0-inbox", false);
    expect(result.notes).toEqual([]);
    expect(result.complete).toBe(true);
  });
});

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
    expect(calls.manifest).toBe(0);
  });

  test("a browser with no copy still draws its lists from the server", async () => {
    const result = await source(server(live).io, null).load("1-projects/web", false);
    expect(result!.notes.map((each) => each.path)).toEqual(["1-projects/web/overview.md"]);
  });

  test("a server that fails falls back to the device's copy where there is one, and errors where there is not", async () => {
    const down: ServerListIO = { manifest: async () => Promise.reject(new Error("down")), readNotes: async () => [] };
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
    expect(calls.manifest).toBe(0);
    expect(calls.read).not.toContain("1-projects/big-sibling.md");
  });
});
