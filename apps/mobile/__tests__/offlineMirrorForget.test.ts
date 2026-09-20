import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import type { KeyValueStore } from "../features/offline/memory";
import type { MirrorStore } from "../features/offline/mirrorStoreCore";

/**
 * Every ending that clears the read cache clears the mirror, and says so.
 *
 * The mirror is every note body on the device, so the three endings
 * `forget.ts` handles — sign-out, leaving, and a membership that ended
 * somewhere else — each take it too, verified by re-listing rather than
 * trusted. Sabotage-checked: dropping the mirror's clear from any of the three
 * fails its test here, and a verification that ignored the mirror's roots
 * fails "a mirror that will not clear is reported, not hidden".
 */

let mockOpened: KeyValueStore;
let mockMirror: MirrorStore | null;

jest.mock("../features/offline/store", () => ({ openStore: () => mockOpened }));
jest.mock("../features/offline/mirrorStore", () => ({ openMirrorStore: async () => mockMirror }));
// The device search's in-memory copy of the bodies is its own module; each
// ending must reach it too, and a spy is the only way to see a `Map` cleared.
const mockForgetSearch = jest.fn();
jest.mock("../features/offline/mirrorSearch", () => ({
  forgetMirrorSearch: (...args: unknown[]) => mockForgetSearch(...args),
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { forgetContextCopies, forgetDepartedContexts, forgetLocalCopies } =
  require("../features/offline/forget") as typeof import("../features/offline/forget");
const { currentEpoch } =
  require("../features/offline/epoch") as typeof import("../features/offline/epoch");
const { memoryMirrorStore } =
  require("../features/offline/mirrorStoreCore") as typeof import("../features/offline/mirrorStoreCore");
const { memoryStore } =
  require("../features/offline/memory") as typeof import("../features/offline/memory");
const { mirrorStatuses, publishMirrorStatus } =
  require("../features/offline/mirrorStatus") as typeof import("../features/offline/mirrorStatus");
/* eslint-enable @typescript-eslint/no-require-imports */

function durable(): KeyValueStore {
  return { ...memoryStore(), durable: true };
}

async function seed(store: MirrorStore, workspaceId: string): Promise<void> {
  const epoch = currentEpoch();
  await store.writeBody(epoch, "private", workspaceId, "current", "a.md", "private body");
  await store.writeIndex(epoch, "team", workspaceId, "{}");
}

function workspaces(roots: { workspaceId: string }[]): string[] {
  return [...new Set(roots.map((root) => root.workspaceId))].sort();
}

let warn: jest.SpiedFunction<typeof console.warn>;

beforeEach(async () => {
  mockOpened = durable();
  mockMirror = memoryMirrorStore();
  await seed(mockMirror, "w1");
  await seed(mockMirror, "w2");
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  mockForgetSearch.mockClear();
});

afterEach(() => warn.mockRestore());

describe("the mirror goes with every ending", () => {
  test("sign-out takes the whole mirror, every scope and workspace", async () => {
    publishMirrorStatus("w1", { state: "synced", notes: 1, bytes: 1, lastSyncedAt: 1 });
    const result = await forgetLocalCopies();
    expect(result.verdict).toBe("cleared");
    expect(await mockMirror!.roots()).toEqual([]);
    // And nothing on screen goes on claiming notes are here.
    expect(mirrorStatuses().size).toBe(0);
  });

  test("a sync write queued behind the sign-out does not come back", async () => {
    const epoch = currentEpoch();
    const signingOut = forgetLocalCopies();
    // Issued from the session that just ended, after the clear was requested.
    const late = mockMirror!.writeBody(epoch, "private", "w1", "current", "late.md", "x");
    await signingOut;
    expect(await late).toBe(false);
    expect(await mockMirror!.roots()).toEqual([]);
  });

  test("leaving takes that context's mirror and no other", async () => {
    expect((await forgetContextCopies("w1")).verdict).toBe("cleared");
    expect(workspaces(await mockMirror!.roots())).toEqual(["w2"]);
  });

  test("a membership that ended elsewhere takes that context's mirror", async () => {
    expect((await forgetDepartedContexts(["w2"])).verdict).toBe("cleared");
    expect(workspaces(await mockMirror!.roots())).toEqual(["w2"]);
  });

  test("every ending also drops what the device search holds in memory", async () => {
    await forgetDepartedContexts(["w2"]);
    // Once per clearance the departed context was mirrored at; never the live one.
    expect(mockForgetSearch.mock.calls).toContainEqual(["w1"]);
    expect(mockForgetSearch.mock.calls).not.toContainEqual(["w2"]);
    mockForgetSearch.mockClear();
    await forgetContextCopies("w2");
    expect(mockForgetSearch.mock.calls).toEqual([["w2"]]);
    mockForgetSearch.mockClear();
    await forgetLocalCopies();
    expect(mockForgetSearch).toHaveBeenCalledWith();
  });

  test("an unknown list purges nothing", async () => {
    await forgetDepartedContexts([]);
    expect(workspaces(await mockMirror!.roots())).toEqual(["w1", "w2"]);
  });

  test("a mirror that will not clear is reported, not hidden", async () => {
    const stubborn = memoryMirrorStore();
    await seed(stubborn, "w1");
    mockMirror = { ...stubborn, clearAll: async () => {}, forgetWorkspace: async () => {} };
    expect((await forgetLocalCopies()).verdict).toBe("left-behind");
    expect((await forgetContextCopies("w1")).verdict).toBe("left-behind");
  });

  test("no mirror on this device changes nothing about the verdicts", async () => {
    mockMirror = null;
    expect((await forgetLocalCopies()).verdict).toBe("cleared");
  });
});
