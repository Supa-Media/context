import { describe, expect, test } from "@jest/globals";
import { currentEpoch } from "../features/offline/epoch";
import { putMirroredNotes, readIndex } from "../features/offline/mirror";
import { moveMirroredBody } from "../features/offline/mirrorMove";
import { onMirrorNotesChanged } from "../features/offline/mirrorEvents";
import { memoryMirrorStore } from "../features/offline/mirrorStoreCore";
import type { OpenNote } from "../features/console/files/types";

/**
 * A note saved on this device is a note edited now.
 *
 * The phone's Home lists Recent from the mirror's `updatedAt`. A save moved
 * the mirrored body onto the new text but kept the listing's old time, and
 * nothing told Home the entry had changed, so a note just edited on the phone
 * stayed out of Recent until the next full sync (owner, 2026-10-05).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. `updatedAt: now` dropped from the moved entry. → "a saved edit is dated now"
 *  2. No `publishMirrorNotesChanged` after the move.  → "and says so, so Home redraws"
 */

const LONG_AGO = Date.UTC(2026, 8, 1);
const NOW = Date.UTC(2026, 9, 5, 12);
const none = () => new Set<string>();

function note(text: string, etag: string): OpenNote {
  return {
    path: "1-projects/launch.md",
    text,
    etag,
    visibility: "team",
    inherited: "team",
    exception: false,
    readOnly: false,
  };
}

async function seeded() {
  const store = memoryMirrorStore();
  await putMirroredNotes(store, currentEpoch(), "team", "w1", [{ ...note("old", "e1"), updatedAt: LONG_AGO }], none, LONG_AGO);
  return store;
}

describe("a saved edit reaches Home's Recent", () => {
  test("a saved edit is dated now", async () => {
    const store = await seeded();
    await moveMirroredBody(store, currentEpoch(), "w1", { path: "1-projects/launch.md", text: "new", etag: "e2" }, none, NOW);
    const index = await readIndex(store, "team", "w1");
    expect(index?.entries.get("1-projects/launch.md")?.updatedAt).toBe(NOW);
  });

  test("and says so, so Home redraws", async () => {
    const store = await seeded();
    const heard: string[] = [];
    const stop = onMirrorNotesChanged((workspaceId) => heard.push(workspaceId));
    await moveMirroredBody(store, currentEpoch(), "w1", { path: "1-projects/launch.md", text: "new", etag: "e2" }, none, NOW);
    stop();
    expect(heard).toEqual(["w1"]);
  });

  test("a note the mirror does not hold says nothing", async () => {
    const store = await seeded();
    const heard: string[] = [];
    const stop = onMirrorNotesChanged((workspaceId) => heard.push(workspaceId));
    await moveMirroredBody(store, currentEpoch(), "w1", { path: "elsewhere.md", text: "x", etag: "e9" }, none, NOW);
    stop();
    expect(heard).toEqual([]);
  });
});
