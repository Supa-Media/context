/**
 * An exception can outlive the note it was written for.
 *
 * ## WHY THIS SUITE EXISTS
 *
 * `trashPath` moves bytes and deliberately does **not** touch `privacy.md`.
 * That is correct and load-bearing: `restoreTrashedPath` puts the note back at
 * its original path and re-checks `canSee` there, so the note's exception has
 * to still be in the manifest for a restore to return it at the visibility it
 * had. Clearing on trash would silently republish or silently hide every
 * restored note. (`deletePath`, which is permanent and has nothing to restore,
 * *does* clear it — the two paths differ on purpose.)
 *
 * The consequence nobody wrote down is the window in between. Between the
 * trash and the next write, the manifest names a path with no object at it,
 * and **a create at that path inherits the dead note's exception.**
 *
 * `writeFile` asked one question — `canSee(path, …)` — under a comment arguing
 * that creating a note where a team caller cannot see it would be creating a
 * note they immediately could not read. True, and it is the read direction.
 * The gateway's `write_note` asks a second question this door did not:
 *
 *     if (scope === "team" && !existing && inheritedVisibility !== "team")
 *       return writePermissionError("write destination");
 *
 * **Not "can this caller see this path" but "does the FOLDER admit a note from
 * this tier".** `canSee` honours the exact override; `visibilityOf` does not.
 * So with an orphaned `team` exception sitting in a private folder, the gateway
 * refused and the console wrote — one operation, two engines, two answers,
 * which is the shape that makes comparing the two engines worth doing at all:
 * being right in one of them reads, from inside it, exactly like being right.
 *
 * What is proved here:
 *
 *  1. a team-tier caller cannot create a note at an orphaned override inside a
 *     folder the owner keeps private — the escalation this closes;
 *  2. the ordinary team create, in a genuinely team folder, still works;
 *  3. a group-named caller still reaches a folder named to their group;
 *  4. the owner is unaffected at every path;
 *  5. trash → restore still returns a note at the visibility it had, which is
 *     the behaviour that forbids the tempting one-line "fix".
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import {
  type FileStore,
  restoreTrashedPath,
  setFolderVisibility,
  setVisibility,
  trashPath,
  writeFile,
} from "../functions/lib/fileOps";
import { PRIVACY_KEY, canSee, parsePrivacyManifest } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";

function bucket(): MemoryStore & FileStore {
  const store = memoryStore() as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("2-areas/review.md", "# Review\n\nthe owner's own note\n");
  return store;
}

async function privacy(store: FileStore) {
  const object = await store.get(PRIVACY_KEY);
  return parsePrivacyManifest(await object!.text());
}

/** Publish one note out of the private `2-areas`, then trash it. */
async function orphanAnOverride(store: FileStore): Promise<void> {
  await setVisibility(store, {
    path: "2-areas/review.md",
    visibility: "team",
    clearance: clearanceOf("private"),
  });
  await trashPath(store, {
    path: "2-areas/review.md",
    clearance: clearanceOf("private"),
    now: Date.UTC(2026, 8, 18),
  });
  const state = await privacy(store);
  // The premise, asserted rather than assumed: the exception really is still
  // there with nothing at that path. If trash ever starts clearing it, this
  // whole suite is about a window that no longer exists and should say so.
  expect(state.overrides.get("2-areas/review.md")).toBe("team");
  expect(await store.get("2-areas/review.md")).toBeNull();
}

describe("an exception that outlived its note", () => {
  test("a team caller cannot create a note at it inside a private folder", async () => {
    const store = bucket();
    await orphanAnOverride(store);

    await expect(
      writeFile(store, {
        path: "2-areas/review.md",
        text: "# Review\n\nwritten by a team member into the owner's private folder\n",
        clearance: clearanceOf("team"),
        now: Date.UTC(2026, 8, 18),
      }),
    ).rejects.toThrow();
    expect(await store.get("2-areas/review.md")).toBeNull();
  });

  test("the ordinary team create still works in a genuinely team folder", async () => {
    const store = bucket();
    await setFolderVisibility(store, {
      path: "1-projects",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    await writeFile(store, {
      path: "1-projects/new.md",
      text: "# New\n",
      clearance: clearanceOf("team"),
      now: Date.UTC(2026, 8, 18),
    });
    expect(await store.get("1-projects/new.md")).not.toBeNull();
  });

  test("a group-named caller still reaches a folder named to their group", async () => {
    const store = bucket();
    await setFolderVisibility(store, {
      path: "1-projects",
      visibility: "@circle" as never,
      clearance: clearanceOf("private"),
    });
    const inCircle = { ...clearanceOf("team"), names: new Set(["@circle"]) };
    await writeFile(store, {
      path: "1-projects/new.md",
      text: "# New\n",
      clearance: inCircle as never,
      now: Date.UTC(2026, 8, 18),
    });
    expect(await store.get("1-projects/new.md")).not.toBeNull();
  });

  test("the owner is unaffected", async () => {
    const store = bucket();
    await orphanAnOverride(store);
    await writeFile(store, {
      path: "2-areas/review.md",
      text: "# Review\n\nthe owner's replacement\n",
      clearance: clearanceOf("private"),
      now: Date.UTC(2026, 8, 18),
    });
    expect(await store.get("2-areas/review.md")).not.toBeNull();
  });

  test("trash and restore still returns a note at the visibility it had", async () => {
    const store = bucket();
    await setVisibility(store, {
      path: "2-areas/review.md",
      visibility: "team",
      clearance: clearanceOf("private"),
    });
    const trashed = await trashPath(store, {
      path: "2-areas/review.md",
      clearance: clearanceOf("private"),
      now: Date.UTC(2026, 8, 18),
    });
    await restoreTrashedPath(store, {
      from: trashed.to,
      to: "2-areas/review.md",
      clearance: clearanceOf("private"),
    });
    const state = await privacy(store);
    expect(canSee("2-areas/review.md", "team", state.rules, state.overrides)).toBe(true);
  });
});
