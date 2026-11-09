/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexError } from "convex/values";
import type { FileBrowser } from "../features/console/files/browser";
import type { FileEntry, FolderListing, OpenNote } from "../features/console/files/types";
import type { MirrorStore } from "../features/offline/mirrorStoreCore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no Web Crypto; every engine the app runs in does (pictures are named by SHA-256).
if (globalThis.crypto?.subtle === undefined) {
  Object.defineProperty(globalThis, "crypto", { value: require("node:crypto").webcrypto, configurable: true });
}

/**
 * AIRPLANE MODE, A WHOLE TRIP, THROUGH THE REAL CONSOLE, ON THE PHONE'S RULES.
 *
 * Owner, 2026-11-09, approving the offline-first boards: an airplane-mode
 * test through everything, run in CI. Each offline action has its own test
 * (`offlineFileOpsConsole.test.ts`, `offlineFolderOps.test.ts`,
 * `devicePictures.test.ts`); this one is the trip they make together, with
 * the device's copy answering first as it does on the phone and the desktop
 * (`mirrorSupported` is true here). Loaded online, the signal goes, and a
 * person does a morning's work: opens and edits notes, makes a note, a
 * drawing and a folder, renames and moves things, deletes a folder, pastes a
 * picture, acts on two notes at once. Not one of those may stall, refuse, or
 * reach the network. Then the signal comes back, and the bucket has to end
 * up exactly where the person left the device, in an order that loses
 * nothing.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; each fails this test.
 *
 *   folder ops not sent last (`drainUnits` by time only)
 *   pictures not kept on the device (`useDevicePictures` unwired)
 *   `serverPathOf` ignores folder moves
 *   a note moved into a renamed folder not queued under its old name (`api.ts`)
 */

let mockMirror: MirrorStore;
jest.mock("../features/offline/mirrorStore", () => ({
  openMirrorStore: async () => mockMirror,
  // The phone's rule: this device keeps a copy, and it answers first.
  mirrorSupported: () => true,
}));

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  return {
    useQueries: () => ({}),
    useConvex: () => ({ query: async () => null }),
    useAction: (ref: never) => {
      const name = getFunctionName(ref);
      bound[name] ??= (args: never) => actions[name]!(args);
      return bound[name];
    },
    useQuery: () => undefined,
    useMutation: () => async () => undefined,
  };
});

/* eslint-disable @typescript-eslint/no-require-imports */
const { useFileBrowser } =
  require("../features/console/files/useFileBrowser") as typeof import("../features/console/files/useFileBrowser");
const { memoryMirrorStore } =
  require("../features/offline/mirrorStoreCore") as typeof import("../features/offline/mirrorStoreCore");
const { syncContext } =
  require("../features/offline/mirrorSync") as typeof import("../features/offline/mirrorSync");
const { neededEtags } =
  require("../features/offline/mirrorHolds") as typeof import("../features/offline/mirrorHolds");
const { openStore } =
  require("../features/offline/store") as typeof import("../features/offline/store");
const { pictureLeaf } =
  require("../features/offline/devicePictures") as typeof import("../features/offline/devicePictures");
const { currentEpoch } =
  require("../features/offline/epoch") as typeof import("../features/offline/epoch");
/* eslint-enable @typescript-eslint/no-require-imports */

const W = "w1";
const PLAN = "1-projects/plan.md";

function noteAt(path: string, text: string, etag: string): OpenNote {
  return { path, text, etag, visibility: "private", inherited: "private", exception: false, readOnly: false };
}

let bucket: Map<string, OpenNote>;
let pictures: Map<string, ArrayBuffer>;
/** Every call that reached the bucket, in order, as a sentence. */
let calls: string[];
let browser: FileBrowser;
let online = true;
let version = 0;

function setOnline(value: boolean): void {
  online = value;
  Object.defineProperty(window.navigator, "onLine", { get: () => online, configurable: true });
  act(() => {
    window.dispatchEvent(new Event(value ? "online" : "offline"));
  });
}

async function settle(rounds = 30) {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  });
}

function entry(kind: "file" | "folder", path: string): FileEntry {
  return {
    kind,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

/** A folder's listing, derived from the bucket's keys the way the server derives it. */
function listing(folder: string): FolderListing {
  const prefix = folder === "" ? "" : `${folder}/`;
  const entries = new Map<string, FileEntry>();
  for (const path of bucket.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    const child = slash === -1 ? path : `${prefix}${rest.slice(0, slash)}`;
    entries.set(child, entry(slash === -1 ? "file" : "folder", child));
  }
  return {
    path: folder,
    folderDefault: "private",
    entries: [...entries.values()],
    truncated: false,
    manifestUsable: true,
  };
}

async function syncNow() {
  const epoch = currentEpoch();
  await act(async () => {
    await syncContext(
      {
        store: mockMirror,
        epoch,
        mine: () => epoch === currentEpoch(),
        now: () => Date.now(),
        needed: (workspaceId) => neededEtags(openStore(), workspaceId),
        manifest: async () => ({
          entries: [...bucket.values()].map((note) => ({
            path: note.path,
            etag: note.etag,
            visibility: note.visibility,
            inherited: note.inherited,
            exception: false,
            readOnly: false,
          })),
          cursor: null,
          truncated: false,
          manifestUsable: true,
        }),
        readNotes: async (_workspaceId, paths) =>
          paths.map((path) => {
            const found = bucket.get(path);
            return found === undefined
              ? { path, outcome: "error" as const, code: "FILE_NOT_FOUND", message: "gone" }
              : { path, outcome: "read" as const, note: found };
          }),
      },
      { workspaceId: W, tier: "private" },
    );
  });
}

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: W, tier: "private", canEdit: true });
    return null;
  }
  act(() => root.render(createElement(Probe)));
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

const fn = (name: string) => `functions/files:${name}`;
const conflict = (currentEtag?: string) =>
  new ConvexError({ code: "CONFLICT", message: "That note changed somewhere else.", currentEtag });

/** The server's check, for the three ops: the version asked about, or a conflict. */
function checkVersion(path: string, expectedEtag: string | undefined) {
  const current = bucket.get(path);
  if (current === undefined) throw new ConvexError({ code: "FILE_NOT_FOUND", message: "That file does not exist." });
  if (expectedEtag !== undefined && expectedEtag !== current.etag) throw conflict(current.etag);
  return current;
}

let unmount: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.clear();
  mockMirror = memoryMirrorStore();
  calls = [];
  pictures = new Map();
  version = 0;
  bucket = new Map([
    [PLAN, noteAt(PLAN, "# Plan\n", "e1")],
    ["0-inbox/old-notes.md", noteAt("0-inbox/old-notes.md", "# Old\n", "e2")],
    ["2-areas/trips/README.md", noteAt("2-areas/trips/README.md", "# Trips\n", "e3")],
  ]);
  setOnline(true);
  actions[fn("listFiles")] = async (args: never) => listing((args as unknown as { path: string }).path);
  actions[fn("notePaths")] = async () => ({ paths: [...bucket.keys()] });
  actions[fn("readNote")] = async (args: never) => {
    const { path } = args as unknown as { path: string };
    const found = bucket.get(path);
    if (found === undefined) throw new ConvexError({ code: "FILE_NOT_FOUND", message: "gone" });
    return found;
  };
  actions[fn("writeNote")] = async (args: never) => {
    const write = args as unknown as { path: string; text: string; expectedEtag?: string };
    calls.push(`write ${write.path} @${write.expectedEtag ?? "create"}`);
    const current = bucket.get(write.path);
    // The server's create: no expected version means "new, and a conflict if it is there".
    if (write.expectedEtag !== current?.etag) throw conflict(current?.etag);
    const etag = `v${++version}`;
    bucket.set(write.path, noteAt(write.path, write.text, etag));
    return { path: write.path, etag, conflictCheck: "conditional" };
  };
  actions[fn("moveEntry")] = async (args: never) => {
    const move = args as unknown as { from: string; to: string; expectedEtag?: string };
    calls.push(`move ${move.from} → ${move.to} @${move.expectedEtag ?? "unchecked"}`);
    const inside = [...bucket.keys()].filter((path) => path.startsWith(`${move.from}/`));
    if (inside.length > 0) {
      // A folder: every note under it, at its version (notes-by-id: a move renames rows).
      for (const path of inside) {
        const note = bucket.get(path)!;
        bucket.delete(path);
        const to = move.to + path.slice(move.from.length);
        bucket.set(to, { ...note, path: to });
      }
      return { kind: "moved", from: move.from, to: move.to, paths: inside.map((path) => move.to + path.slice(move.from.length)) };
    }
    const current = checkVersion(move.from, move.expectedEtag);
    const etag = `v${++version}`;
    bucket.delete(move.from);
    bucket.set(move.to, noteAt(move.to, current.text, etag));
    return { kind: "moved", from: move.from, to: move.to, paths: [move.to], etag };
  };
  actions[fn("trashEntry")] = async (args: never) => {
    const trash = args as unknown as { path: string; expectedEtag?: string };
    calls.push(`trash ${trash.path} @${trash.expectedEtag ?? "unchecked"}`);
    const inside = [...bucket.keys()].filter((path) => path.startsWith(`${trash.path}/`));
    for (const path of inside) bucket.delete(path);
    if (inside.length > 0) return { kind: "moved", from: trash.path, to: `.context/trash/x/${trash.path}`, paths: [] };
    checkVersion(trash.path, trash.expectedEtag);
    bucket.delete(trash.path);
    return { kind: "moved", from: trash.path, to: `.context/trash/x/${trash.path}`, paths: [] };
  };
  actions[fn("createDirectory")] = async (args: never) => {
    const { path } = args as unknown as { path: string };
    calls.push(`folder ${path}`);
    bucket.set(`${path}/README.md`, noteAt(`${path}/README.md`, `# ${path}\n`, `v${++version}`));
    return { kind: "folderCreated", path, readme: `${path}/README.md` };
  };
  actions[fn("storeNoteImage")] = async (args: never) => {
    const { bytes, contentType } = args as unknown as { bytes: ArrayBuffer; contentType: string };
    const leaf = (await pictureLeaf(bytes, contentType))!;
    calls.push(`picture ${leaf}`);
    pictures.set(leaf, bytes);
    return { leaf };
  };
  actions[fn("duplicateEntry")] = async () => {
    calls.push("duplicate");
    return new Promise(() => {});
  };
  unmount = mount();
});

afterEach(() => {
  unmount?.();
  unmount = null;
  setOnline(true);
});

const names = (folder: string) => browser.listings[folder]?.entries.map((one) => one.path) ?? [];

describe("a morning on the plane", () => {
  test("everything works with the signal gone, nothing reaches the network, and it all lands when the signal is back", async () => {
    // Boarding: loaded online, every folder seen once, the device's copy filled.
    await settle();
    for (const folder of ["1-projects", "0-inbox", "2-areas", "2-areas/trips"]) browser.toggleFolder(folder);
    await settle();
    await syncNow();
    setOnline(false);
    await settle();

    // Opens a note from the device and edits it.
    browser.select(PLAN);
    await settle();
    expect(browser.editor.draft).toBe("# Plan\n");
    browser.setDraft("# Plan\n\nwritten at 30,000 feet\n");
    await settle();
    browser.save();
    await settle();

    // Makes a note, and pastes a picture into it.
    browser.createNote("0-inbox", "Packing");
    await settle();
    expect(browser.editor.path).toBe("0-inbox/Packing.md");
    const photo = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7]).buffer;
    const stored = await browser.storeImage({ bytes: photo, contentType: "image/png" });
    expect("target" in stored).toBe(true);
    const leaf = (stored as { target: string }).target;
    expect(await browser.loadImage(leaf)).toMatch(/^data:image\/png;base64,/);
    browser.setDraft(`# Packing\n\npassport\n\n![](${leaf})\n`);
    await settle();
    browser.save();
    await settle();

    // Makes a drawing and a folder.
    browser.createDrawing("1-projects", "map");
    await settle();
    expect(browser.notice).toBeNull();
    browser.createFolder("", "trips-2027");
    await settle();

    // Renames a folder, then moves two notes into it at once.
    browser.rename("2-areas/trips", "travel");
    await settle();
    expect(browser.notice).toBeNull();
    browser.moveMany?.(["0-inbox/old-notes.md", PLAN], "2-areas/travel");
    await settle();
    expect(browser.notice).toBeNull();

    // Edits a note inside the renamed folder, under its new name.
    browser.select("2-areas/travel/README.md");
    await settle();
    expect(browser.editor.draft).toBe("# Trips\n");
    browser.setDraft("# Trips\n\nLisbon in May\n");
    await settle();
    browser.save();
    await settle();

    // All of it drawn where the person put it, and none of it sent.
    expect(names("2-areas")).toContain("2-areas/travel");
    expect(names("2-areas")).not.toContain("2-areas/trips");
    expect(names("2-areas/travel")).toEqual(
      expect.arrayContaining(["2-areas/travel/README.md", "2-areas/travel/old-notes.md", "2-areas/travel/plan.md"]),
    );
    expect(names("0-inbox")).toContain("0-inbox/Packing.md");
    expect(names("1-projects")).toContain("1-projects/map.excalidraw.md");
    expect(names("")).toContain("trips-2027");
    expect(calls).toEqual([]);

    // The signal comes back.
    setOnline(true);
    await settle(200);

    // The bucket is where the person left the device.
    expect(bucket.get("2-areas/travel/plan.md")?.text).toBe("# Plan\n\nwritten at 30,000 feet\n");
    expect(bucket.has("2-areas/travel/old-notes.md")).toBe(true);
    expect(bucket.get("2-areas/travel/README.md")?.text).toBe("# Trips\n\nLisbon in May\n");
    expect([...bucket.keys()].filter((path) => path.startsWith("2-areas/trips/"))).toEqual([]);
    expect(bucket.get("0-inbox/Packing.md")?.text).toBe(`# Packing\n\npassport\n\n![](${leaf})\n`);
    expect(bucket.get("1-projects/map.excalidraw.md")?.text).toContain("excalidraw");
    expect(bucket.has("trips-2027/README.md")).toBe(true);
    // The picture went up under the name the note already used.
    expect(pictures.has(leaf)).toBe(true);
    // The folder's rename went after everything queued inside it.
    const notes = calls.filter((call) => !call.startsWith("picture "));
    expect(notes.at(-1)).toBe("move 2-areas/trips → 2-areas/travel @unchecked");
    expect(browser.sync?.counts).toEqual({ pending: 0, conflicted: 0, rejected: 0 });
  });
});
