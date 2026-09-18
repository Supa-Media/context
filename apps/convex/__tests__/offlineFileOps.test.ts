/**
 * A RENAME, MOVE, ARCHIVE OR DELETE SENT HOURS AFTER IT WAS ASKED FOR.
 *
 * The app queues these offline, next to the edits it already queued, and sends
 * them when the phone is back. The property each one needs is the one a queued
 * edit already has: **it is checked against the version it was asked about**.
 * A rename typed on a train is a decision about the note as it was on the
 * train. If somebody rewrote that note in Obsidian in the meantime, the rename
 * must come back as a `CONFLICT` carrying the version that is there now — the
 * same answer a queued edit gets — and nothing may have moved, so the person
 * decides knowing it changed rather than finding their colleague's text under
 * a name they chose for something else.
 *
 * `expectedEtag` is optional on all three, and absent means exactly what it
 * meant before: an online press, made while looking at the listing. It is
 * never a force flag in the other direction — there is no argument that turns
 * the check off once it is given.
 *
 * Against the in-memory bucket; `files.test.ts` covers the actions around it.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "./storeStub.helpers";
import {
  archivePath,
  FileOpError,
  type FileStore,
  movePath,
  setFolderVisibility,
  setVisibility,
  trashPath,
} from "../functions/lib/fileOps";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";

const NOW = 1_800_000_000_000;
const OWNER = clearanceOf("private");
const TEAM = clearanceOf("team");

async function bucket(
  options: Parameters<typeof memoryStore>[0] = {},
): Promise<MemoryStore & FileStore> {
  const store = memoryStore(options) as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("1-projects/README.md", "# Projects\n");
  store.seed("1-projects/plan.md", "# Plan\n\nmine\n");
  store.seed("1-projects/pay.md", "# Pay\n");
  store.seed("4-archive/README.md", "# Archive\n");
  await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: OWNER });
  await setFolderVisibility(store, { path: "4-archive", visibility: "team", clearance: OWNER });
  await setVisibility(store, { path: "1-projects/pay.md", visibility: "private", clearance: OWNER });
  return store;
}

async function capture(fn: () => Promise<unknown>): Promise<FileOpError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof FileOpError) return error;
    throw error;
  }
  throw new Error("Expected the operation to throw, but it resolved.");
}

/** Somebody else's edit, landing between the phone's read and its rename. */
function editedElsewhere(store: MemoryStore, key: string, body: string): string {
  store.seed(key, body);
  return store.objects.get(key)!.etag;
}

describe("a move asked for against a version", () => {
  test("goes through when the note is still at that version, and says what it is now", async () => {
    const store = await bucket();
    const read = store.objects.get("1-projects/plan.md")!.etag;
    const moved = await movePath(store, {
      from: "1-projects/plan.md",
      to: "1-projects/plan-2026.md",
      clearance: TEAM,
      now: NOW,
      expectedEtag: read,
    });
    expect(store.snapshot()["1-projects/plan-2026.md"]).toBe("# Plan\n\nmine\n");
    expect(store.snapshot()["1-projects/plan.md"]).toBeUndefined();
    // The version the queue must carry on to anything asked after the rename.
    expect(moved.etag).toBe(store.objects.get("1-projects/plan-2026.md")!.etag);
  });

  test("is a conflict carrying the current version when the note changed, and nothing moves", async () => {
    const store = await bucket();
    const read = store.objects.get("1-projects/plan.md")!.etag;
    const theirs = editedElsewhere(store, "1-projects/plan.md", "# Plan\n\ntheirs\n");

    const error = await capture(() =>
      movePath(store, {
        from: "1-projects/plan.md",
        to: "1-projects/plan-2026.md",
        clearance: TEAM,
        now: NOW,
        expectedEtag: read,
      }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.currentEtag).toBe(theirs);
    expect(store.snapshot()["1-projects/plan.md"]).toBe("# Plan\n\ntheirs\n");
    expect(store.snapshot()["1-projects/plan-2026.md"]).toBeUndefined();
  });

  test("uses a read-compare on a bucket that cannot make it atomic, rather than refusing", async () => {
    // The plugin rename refuses such a bucket outright (`STORAGE_UNSAFE`); a
    // person's queued rename there gets the check an online save gets there.
    const store = await bucket();
    expect(store.capabilities.conditionalCreate).toBeUndefined();
    const read = store.objects.get("1-projects/plan.md")!.etag;
    await movePath(store, {
      from: "1-projects/plan.md",
      to: "1-projects/plan-2026.md",
      clearance: TEAM,
      now: NOW,
      expectedEtag: read,
    });
    expect(store.snapshot()["1-projects/plan-2026.md"]).toBe("# Plan\n\nmine\n");
  });

  test("a plugin rename still refuses a bucket that cannot make it atomic", async () => {
    const store = await bucket();
    const read = store.objects.get("1-projects/plan.md")!.etag;
    const error = await capture(() =>
      movePath(store, {
        from: "1-projects/plan.md",
        to: "1-projects/plan-2026.md",
        clearance: TEAM,
        now: NOW,
        expectedEtag: read,
        requireAtomic: true,
      }),
    );
    expect(error.code).toBe("STORAGE_UNSAFE");
    expect(store.snapshot()["1-projects/plan.md"]).toBe("# Plan\n\nmine\n");
  });

  test("a note the caller cannot see is not found — its version is never compared or disclosed", async () => {
    const store = await bucket();
    const error = await capture(() =>
      movePath(store, {
        from: "1-projects/pay.md",
        to: "1-projects/pay-2.md",
        clearance: TEAM,
        now: NOW,
        expectedEtag: "a guess",
      }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
    expect(error.currentEtag).toBeUndefined();
  });

  test("a folder has no version, so a folder move against one is refused", async () => {
    const store = await bucket();
    const error = await capture(() =>
      movePath(store, {
        from: "1-projects",
        to: "projects",
        clearance: OWNER,
        now: NOW,
        expectedEtag: "anything",
      }),
    );
    expect(error.code).toBe("PATH_INVALID");
    expect(store.snapshot()["1-projects/plan.md"]).toBe("# Plan\n\nmine\n");
  });
});

describe("a trash asked for against a version", () => {
  test("is a conflict when the note changed, and the note stays where it was", async () => {
    const store = await bucket();
    const read = store.objects.get("1-projects/plan.md")!.etag;
    const theirs = editedElsewhere(store, "1-projects/plan.md", "# Plan\n\ntheirs\n");
    const error = await capture(() =>
      trashPath(store, { path: "1-projects/plan.md", clearance: TEAM, now: NOW, expectedEtag: read }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.currentEtag).toBe(theirs);
    expect(store.snapshot()["1-projects/plan.md"]).toBe("# Plan\n\ntheirs\n");
  });

  test("goes through at the version it was asked about", async () => {
    const store = await bucket({ conditional: true });
    const read = store.objects.get("1-projects/plan.md")!.etag;
    const trashed = await trashPath(store, {
      path: "1-projects/plan.md",
      clearance: TEAM,
      now: NOW,
      expectedEtag: read,
    });
    expect(store.snapshot()["1-projects/plan.md"]).toBeUndefined();
    expect(store.snapshot()[trashed.to]).toBe("# Plan\n\nmine\n");
  });

  test("a hidden note is not found, whatever version was guessed", async () => {
    const store = await bucket();
    const error = await capture(() =>
      trashPath(store, { path: "1-projects/pay.md", clearance: TEAM, now: NOW, expectedEtag: "x" }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
    expect(error.currentEtag).toBeUndefined();
  });
});

describe("an archive asked for against a version", () => {
  test("is a conflict when the note changed, and nothing is archived", async () => {
    const store = await bucket();
    const read = store.objects.get("1-projects/plan.md")!.etag;
    const theirs = editedElsewhere(store, "1-projects/plan.md", "# Plan\n\ntheirs\n");
    const error = await capture(() =>
      archivePath(store, { path: "1-projects/plan.md", clearance: OWNER, now: NOW, expectedEtag: read }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.currentEtag).toBe(theirs);
    expect(store.snapshot()["1-projects/plan.md"]).toBe("# Plan\n\ntheirs\n");
    expect(Object.keys(store.snapshot()).some((key) => key.startsWith("4-archive/2"))).toBe(false);
  });

  test("goes through at the version it was asked about", async () => {
    const store = await bucket();
    const read = store.objects.get("1-projects/plan.md")!.etag;
    const archived = await archivePath(store, {
      path: "1-projects/plan.md",
      clearance: OWNER,
      now: NOW,
      expectedEtag: read,
    });
    expect(store.snapshot()[archived.to]).toBe("# Plan\n\nmine\n");
    expect(store.snapshot()["1-projects/plan.md"]).toBeUndefined();
  });
});
