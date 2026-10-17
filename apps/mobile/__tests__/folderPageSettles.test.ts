/**
 * What still moved on a phone's pages after #1770 (owner's second recording,
 * 2026-10-17): the chaos line arriving under a folder's title a beat after the
 * page, the about's "More" line appearing once the block had measured itself,
 * and a note opened from this device's copy saying "Saved on this device;
 * syncing soon" when nothing had been typed.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `readFolderLine` not filing its answer.          → "a folder's line is kept"
 *  2. `readFolderLine` ignoring a question on its way. → "one question at a time"
 *  3. `forgetFolderLines` not bumping its generation.  → "an answer asked before forgetting files nothing"
 *  4. The `pending === 0` arm dropped from `noteFoot`.  → "a note opened from the device's copy is a read"
 */

import { describe, expect, test } from "@jest/globals";
import type { ChaosScore } from "../features/chaos/chaosModel";
import {
  cachedFolderLine,
  forgetFolderLines,
  preloadFolderLine,
  readFolderLine,
  type AskFolder,
} from "../features/chaos/folderLineCache";
import { noteFoot } from "../features/console/files/noteEditor/statusLine";
import type { EditorState } from "../features/console/files/editor";
import type { Presence } from "../features/console/presence/usePresence";

const scored = (folder: string, items: number): ChaosScore => ({
  kind: "chaosScore",
  available: true,
  score: 30,
  word: "fine",
  weekAgo: null,
  folders: [],
  longNotes: [],
  folder: { folder, items, chaos: 60 },
});

function counting(answer: (folder: string) => ChaosScore | null = (folder) => scored(folder, 14)) {
  const asked: string[] = [];
  const ask: AskFolder = async (folder) => {
    asked.push(folder);
    return answer(folder);
  };
  return { ask, asked };
}

describe("folderLineCache: the chaos line, kept and asked ahead", () => {
  test("a folder's line is kept, and nothing is known before it is asked", async () => {
    const { ask } = counting();
    expect(cachedFolderLine(ask, "1-projects")).toBeUndefined();
    await readFolderLine(ask, "1-projects");
    expect(cachedFolderLine(ask, "1-projects")).toEqual({ folder: "1-projects", items: 14, chaos: 60 });
  });

  test("an unscored workspace or a failed question is kept as no line, so the page is not held for it again", async () => {
    const unscored = counting(() => ({ ...scored("x", 1), available: false }));
    await readFolderLine(unscored.ask, "x");
    expect(cachedFolderLine(unscored.ask, "x")).toBeNull();
    const failing: AskFolder = async () => {
      throw new Error("offline");
    };
    await readFolderLine(failing, "y");
    expect(cachedFolderLine(failing, "y")).toBeNull();
  });

  test("one question at a time: the press's question is the page's", async () => {
    const { ask, asked } = counting();
    preloadFolderLine(ask, "2-areas");
    await readFolderLine(ask, "2-areas");
    expect(asked).toEqual(["2-areas"]);
    // Already answered: a preload asks nothing, a fresh read asks again.
    preloadFolderLine(ask, "2-areas");
    await readFolderLine(ask, "2-areas", true);
    expect(asked).toEqual(["2-areas", "2-areas"]);
  });

  test("each workspace's question is its own", async () => {
    const one = counting((folder) => scored(folder, 3));
    const two = counting((folder) => scored(folder, 30));
    await readFolderLine(one.ask, "notes");
    expect(cachedFolderLine(two.ask, "notes")).toBeUndefined();
  });

  test("an answer asked before forgetting files nothing", async () => {
    let answer: (score: ChaosScore) => void = () => {};
    const ask: AskFolder = () => new Promise((resolve) => (answer = resolve));
    const read = readFolderLine(ask, "notes");
    forgetFolderLines();
    answer(scored("notes", 9));
    await read;
    expect(cachedFolderLine(ask, "notes")).toBeUndefined();
  });
});

describe("a note's foot while its shared copy settles", () => {
  const state = { path: "a.md", draft: "a", status: "clean" } as EditorState;
  const foot = (status: string, pending: number) =>
    noteFoot({
      state,
      presence: { collaboration: { status, pending } } as unknown as Presence,
      editable: true,
      compact: true,
      button: { label: "Save", disabled: true },
    }).durability;

  test("a note opened from the device's copy is a read, not a save waiting to sync", () => {
    expect(foot("local", 0)).toBe("Read from this device");
  });

  test("an edit kept on this device still says it will sync", () => {
    expect(foot("local", 2)).toBe("Saved on this device; syncing soon.");
    expect(foot("saved", 0)).toBe("Saved in your bucket");
  });
});
