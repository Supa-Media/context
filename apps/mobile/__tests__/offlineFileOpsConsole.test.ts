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

/**
 * Taking notes offline, through the real console.
 *
 * The owner's requirement: people can take notes offline, and the app feels
 * like Apple Notes or Obsidian there — a new note appears in the tree and opens
 * at once, a rename shows the new name, a delete takes the row away, and all
 * of it goes to the bucket when the connection comes back, each op checked
 * against the version it was asked about. `offlineFileOps.test.ts` has the
 * queue's rules; this is that the console reaches them, and that nothing sits
 * on a 45-second "it may still have gone through" while the device is known to
 * be offline.
 */

let mockMirror: MirrorStore;
jest.mock("../features/offline/mirrorStore", () => ({
  openMirrorStore: async () => mockMirror,
}));

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  return {
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
const { currentEpoch } =
  require("../features/offline/epoch") as typeof import("../features/offline/epoch");
/* eslint-enable @typescript-eslint/no-require-imports */

const W = "w1";
const PLAN = "1-projects/plan.md";

function noteAt(path: string, text: string, etag: string): OpenNote {
  return { path, text, etag, visibility: "private", inherited: "private", exception: false, readOnly: false };
}

let bucket: Map<string, OpenNote>;
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
    const current = checkVersion(move.from, move.expectedEtag);
    const etag = `v${++version}`;
    bucket.delete(move.from);
    bucket.set(move.to, noteAt(move.to, current.text, etag));
    return { kind: "moved", from: move.from, to: move.to, paths: [move.to], etag };
  };
  actions[fn("trashEntry")] = async (args: never) => {
    const trash = args as unknown as { path: string; expectedEtag?: string };
    calls.push(`trash ${trash.path} @${trash.expectedEtag ?? "unchecked"}`);
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

/** Loaded online and mirrored, then the signal goes. */
async function onTheTrain() {
  await settle();
  browser.toggleFolder("1-projects");
  browser.toggleFolder("0-inbox");
  await settle();
  await syncNow();
  setOnline(false);
  await settle();
}

const names = (folder: string) => browser.listings[folder]?.entries.map((one) => one.path) ?? [];

describe("a note made on the train", () => {
  test("appears in the tree, opens at once, and is created when the connection comes back", async () => {
    await onTheTrain();
    browser.createNote("1-projects", "Groceries");
    await settle();

    expect(names("1-projects")).toContain("1-projects/Groceries.md");
    expect(browser.editor.path).toBe("1-projects/Groceries.md");
    expect(browser.editor.status).toBe("queued");
    // "Did not exist", which is what makes its every save a create.
    expect(browser.editor.etag).toBeNull();
    expect(browser.pending?.stateFor("1-projects/Groceries.md")).toBe("queued");
    expect(browser.pending?.labelFor?.("1-projects/Groceries.md")).toBe("New note: Groceries");

    browser.setDraft("# Groceries\n\nmilk\n");
    await settle();
    expect(calls).toEqual([]);

    setOnline(true);
    await settle(60);
    expect(calls).toEqual(["write 1-projects/Groceries.md @create"]);
    expect(bucket.get("1-projects/Groceries.md")?.text).toBe("# Groceries\n\nmilk\n");
    expect(browser.sync?.counts).toEqual({ pending: 0, conflicted: 0, rejected: 0 });
    expect(names("1-projects")).toContain("1-projects/Groceries.md");
  });

  test("a note that appeared at the same name meanwhile is parked, and nothing is overwritten", async () => {
    await onTheTrain();
    browser.createNote("1-projects", "Groceries");
    await settle();
    bucket.set("1-projects/Groceries.md", noteAt("1-projects/Groceries.md", "# Theirs\n", "t1"));

    setOnline(true);
    await settle(60);
    expect(bucket.get("1-projects/Groceries.md")?.text).toBe("# Theirs\n");
    expect(browser.sync?.counts.conflicted).toBe(1);
    expect(browser.pending?.stateFor("1-projects/Groceries.md")).toBe("conflict");
  });

  test("a name already in the tree is refused, as online", async () => {
    await onTheTrain();
    browser.createNote("1-projects", "plan");
    await settle();
    expect(browser.notice).not.toBeNull();
    expect(browser.sync?.counts.pending).toBe(0);
  });

  test("renamed before it synced, it is created once, at the new name", async () => {
    await onTheTrain();
    browser.createNote("1-projects", "Grocieries");
    await settle();
    browser.rename("1-projects/Grocieries.md", "Groceries");
    await settle();
    expect(names("1-projects")).toContain("1-projects/Groceries.md");
    expect(names("1-projects")).not.toContain("1-projects/Grocieries.md");
    expect(browser.editor.path).toBe("1-projects/Groceries.md");

    setOnline(true);
    await settle(60);
    expect(calls).toEqual(["write 1-projects/Groceries.md @create"]);
  });

  test("deleted before it synced, nothing is sent at all", async () => {
    await onTheTrain();
    browser.createNote("0-inbox", "scratch");
    await settle();
    browser.destroy("0-inbox/scratch.md");
    await settle();
    expect(names("0-inbox")).not.toContain("0-inbox/scratch.md");
    expect(browser.toasts[0]?.message).toMatch(/nothing was sent/);

    setOnline(true);
    await settle(60);
    expect(calls).toEqual([]);
  });

  test("a new drawing is refused offline, in a sentence, rather than made uneditable", async () => {
    await onTheTrain();
    browser.createDrawing("1-projects", "sketch");
    await settle();
    expect(browser.notice).toMatch(/drawing needs a connection/);
    expect(browser.sync?.counts.pending).toBe(0);
  });
});

describe("renaming, moving and deleting on the train", () => {
  test("a rename shows the new name at once, and is sent against the version it was asked about", async () => {
    await onTheTrain();
    browser.rename(PLAN, "plan-2026");
    await settle();
    expect(names("1-projects")).toContain("1-projects/plan-2026.md");
    expect(names("1-projects")).not.toContain(PLAN);
    expect(browser.pending?.operations?.map((op) => op.text)).toEqual(["Rename plan → plan-2026"]);

    setOnline(true);
    await settle(60);
    expect(calls).toEqual(["move 1-projects/plan.md → 1-projects/plan-2026.md @e1"]);
    expect(browser.sync?.counts.pending).toBe(0);
  });

  test("renamed, then edited under the new name: the edit goes to the old name first, then the rename", async () => {
    await onTheTrain();
    browser.select(PLAN);
    await settle();
    browser.rename(PLAN, "plan-2026");
    await settle();
    expect(browser.editor.path).toBe("1-projects/plan-2026.md");
    browser.setDraft("# Plan\n\nfrom the train\n");
    await settle();
    browser.save();
    await settle();

    setOnline(true);
    await settle(80);
    expect(calls).toEqual([
      "write 1-projects/plan.md @e1",
      "move 1-projects/plan.md → 1-projects/plan-2026.md @v1",
    ]);
    expect(bucket.get("1-projects/plan-2026.md")?.text).toBe("# Plan\n\nfrom the train\n");
    // And the open note follows the rename onto its new version.
    expect(browser.editor.etag).toBe("v2");
  });

  test("a rename of a note somebody edited meanwhile is parked, and answered from the sheet", async () => {
    await onTheTrain();
    browser.rename(PLAN, "plan-2026");
    await settle();
    bucket.set(PLAN, noteAt(PLAN, "# Plan\n\ntheirs\n", "t9"));

    setOnline(true);
    await settle(60);
    expect(bucket.has(PLAN)).toBe(true);
    const [row] = browser.pending?.operations ?? [];
    expect(row).toMatchObject({ mark: "conflict", answers: ["override", "discard"] });

    // Answered: done anyway, and still conditional — on the version reported.
    browser.answerOp?.(row!.id, "override");
    await settle(60);
    expect(calls.at(-1)).toBe("move 1-projects/plan.md → 1-projects/plan-2026.md @t9");
    expect(bucket.get("1-projects/plan-2026.md")?.text).toBe("# Plan\n\ntheirs\n");
  });

  test("a delete takes the row away and is sent with the version it was asked about", async () => {
    await onTheTrain();
    browser.destroy("0-inbox/old-notes.md");
    await settle();
    expect(names("0-inbox")).not.toContain("0-inbox/old-notes.md");
    expect(browser.pending?.operations?.map((op) => op.text)).toEqual(["Delete old-notes"]);
    expect(browser.sync?.counts.pending).toBe(1);

    setOnline(true);
    await settle(60);
    expect(calls).toEqual(["trash 0-inbox/old-notes.md @e2"]);
  });

  test("a folder cannot be renamed offline, and says why", async () => {
    await onTheTrain();
    browser.rename("2-areas", "areas");
    await settle();
    expect(browser.notice).toMatch(/folder needs a connection/);
    expect(browser.sync?.counts.pending).toBe(0);
  });

  test("a new folder is drawn at once and created when the connection comes back", async () => {
    await onTheTrain();
    browser.createFolder("", "trips-2027");
    await settle();
    expect(names("")).toContain("trips-2027");
    expect(browser.listings["trips-2027"]?.entries).toEqual([]);

    setOnline(true);
    await settle(60);
    expect(calls).toEqual(["folder trips-2027"]);
  });
});

describe("what a known-offline device does not do", () => {
  test("an operation that cannot wait is refused at once, never sent to hang for 45 seconds", async () => {
    await onTheTrain();
    browser.duplicate(PLAN);
    await settle();
    expect(calls).toEqual([]);
    expect(browser.busy).toBe(false);
    expect(browser.notice).toMatch(/You are offline, so that was not done/);
  });
});
