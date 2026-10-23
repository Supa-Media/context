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
 * Runs on a keyed workspace (`keyedFixture.links.helpers.ts`): a move, archive
 * or trash is a row change, and the version is the note's key's.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../functions/lib/clearance";
import {
  archivePath,
  FileOpError,
  movePath,
  setFolderVisibility,
  setVisibility,
  trashPath,
} from "../functions/lib/fileOps";
import {
  type KeyedLinks,
  type LinksStore,
  anyRowAt,
  bodyAt,
  editedElsewhere,
  etagAt,
  keyedLinks,
  liveRowAt,
  rowsOf,
} from "./keyedFixture.links.helpers";

const NOW = 1_800_000_000_000;
const OWNER = clearanceOf("private");
const TEAM = clearanceOf("team");

async function workspace(): Promise<KeyedLinks> {
  return await keyedLinks(
    {
      "1-projects/README.md": "# Projects\n",
      "1-projects/plan.md": "# Plan\n\nmine\n",
      "1-projects/pay.md": "# Pay\n",
      "4-archive/README.md": "# Archive\n",
    },
    async (store: LinksStore) => {
      await setFolderVisibility(store, { path: "1-projects", visibility: "team", clearance: OWNER });
      await setFolderVisibility(store, { path: "4-archive", visibility: "team", clearance: OWNER });
      await setVisibility(store, { path: "1-projects/pay.md", visibility: "private", clearance: OWNER });
    },
  );
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

describe("a move asked for against a version", () => {
  test("goes through when the note is still at that version, and says what it is now", async () => {
    const f = await workspace();
    const read = await etagAt(f, "1-projects/plan.md");
    const moved = await movePath(f.store, {
      from: "1-projects/plan.md",
      to: "1-projects/plan-2026.md",
      clearance: TEAM,
      now: NOW,
      expectedEtag: read,
    });
    expect(await bodyAt(f, "1-projects/plan-2026.md")).toBe("# Plan\n\nmine\n");
    expect(await liveRowAt(f, "1-projects/plan.md")).toBeNull();
    // The version the queue must carry on to anything asked after the rename.
    expect(moved.etag).toBe(await etagAt(f, "1-projects/plan-2026.md"));
  });

  test("is a conflict carrying the current version when the note changed, and nothing moves", async () => {
    const f = await workspace();
    const read = await etagAt(f, "1-projects/plan.md");
    const theirs = await editedElsewhere(f, "1-projects/plan.md", "# Plan\n\ntheirs\n");

    const error = await capture(() =>
      movePath(f.store, {
        from: "1-projects/plan.md",
        to: "1-projects/plan-2026.md",
        clearance: TEAM,
        now: NOW,
        expectedEtag: read,
      }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.currentEtag).toBe(theirs);
    expect(await bodyAt(f, "1-projects/plan.md")).toBe("# Plan\n\ntheirs\n");
    expect(await liveRowAt(f, "1-projects/plan-2026.md")).toBeNull();
  });

  test("uses the version check on a bucket that cannot make it atomic, rather than refusing", async () => {
    // A keyed move is a row change, so the bucket's conditional writes never
    // come into it: the version is compared on the row, and nothing is refused
    // for want of an atomic bucket.
    const f = await workspace();
    expect(f.store.capabilities.conditionalCreate).toBeUndefined();
    await movePath(f.store, {
      from: "1-projects/plan.md",
      to: "1-projects/plan-2026.md",
      clearance: TEAM,
      now: NOW,
      expectedEtag: await etagAt(f, "1-projects/plan.md"),
    });
    expect(await bodyAt(f, "1-projects/plan-2026.md")).toBe("# Plan\n\nmine\n");
  });

  test("a plugin rename is a row change too: it does not refuse a bucket that cannot make a check atomic", async () => {
    // Before the keyed move, a plugin rename on a bucket with no atomic
    // conditional write was refused `STORAGE_UNSAFE`, because the bytes were
    // copied and the copy could not be checked. A keyed rename moves no bytes,
    // so there is nothing to refuse for. The note keeps its bytes and its key.
    const f = await workspace();
    const before = await anyRowAt(f, "1-projects/plan.md");
    const moved = await movePath(f.store, {
      from: "1-projects/plan.md",
      to: "1-projects/plan-2026.md",
      clearance: TEAM,
      now: NOW,
      expectedEtag: await etagAt(f, "1-projects/plan.md"),
      requireAtomic: true,
    });
    expect(moved).toMatchObject({ from: "1-projects/plan.md", to: "1-projects/plan-2026.md" });
    expect(await anyRowAt(f, "1-projects/plan-2026.md")).toMatchObject({ storageKey: before?.storageKey });
    expect(await bodyAt(f, "1-projects/plan-2026.md")).toBe("# Plan\n\nmine\n");
  });

  test("a note the caller cannot see is not found — its version is never compared or disclosed", async () => {
    const f = await workspace();
    const error = await capture(() =>
      movePath(f.store, {
        from: "1-projects/pay.md",
        to: "1-projects/pay-2.md",
        clearance: TEAM,
        now: NOW,
        expectedEtag: "a guess",
      }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
    expect(error.currentEtag).toBeUndefined();
    expect(await bodyAt(f, "1-projects/pay.md")).toBe("# Pay\n");
  });

  test("a folder has no version, so a folder move against one is refused", async () => {
    const f = await workspace();
    const error = await capture(() =>
      movePath(f.store, {
        from: "1-projects",
        to: "projects",
        clearance: OWNER,
        now: NOW,
        expectedEtag: "anything",
      }),
    );
    expect(error.code).toBe("PATH_INVALID");
    expect(await bodyAt(f, "1-projects/plan.md")).toBe("# Plan\n\nmine\n");
  });
});

describe("a trash asked for against a version", () => {
  test("is a conflict when the note changed, and the note stays where it was", async () => {
    const f = await workspace();
    const read = await etagAt(f, "1-projects/plan.md");
    const theirs = await editedElsewhere(f, "1-projects/plan.md", "# Plan\n\ntheirs\n");
    const error = await capture(() =>
      trashPath(f.store, { path: "1-projects/plan.md", clearance: TEAM, now: NOW, expectedEtag: read }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.currentEtag).toBe(theirs);
    expect(await bodyAt(f, "1-projects/plan.md")).toBe("# Plan\n\ntheirs\n");
  });

  test("goes through at the version it was asked about", async () => {
    const f = await workspace();
    const read = await etagAt(f, "1-projects/plan.md");
    const trashed = await trashPath(f.store, {
      path: "1-projects/plan.md",
      clearance: TEAM,
      now: NOW,
      expectedEtag: read,
    });
    expect(await liveRowAt(f, "1-projects/plan.md")).toBeNull();
    expect(await bodyAt(f, trashed.to)).toBe("# Plan\n\nmine\n");
  });

  test("a hidden note is not found, whatever version was guessed", async () => {
    const f = await workspace();
    const error = await capture(() =>
      trashPath(f.store, { path: "1-projects/pay.md", clearance: TEAM, now: NOW, expectedEtag: "x" }),
    );
    expect(error.code).toBe("FILE_NOT_FOUND");
    expect(error.currentEtag).toBeUndefined();
    expect((await liveRowAt(f, "1-projects/pay.md"))?.path).toBe("1-projects/pay.md");
  });
});

describe("an archive asked for against a version", () => {
  test("is a conflict when the note changed, and nothing is archived", async () => {
    const f = await workspace();
    const read = await etagAt(f, "1-projects/plan.md");
    const theirs = await editedElsewhere(f, "1-projects/plan.md", "# Plan\n\ntheirs\n");
    const error = await capture(() =>
      archivePath(f.store, { path: "1-projects/plan.md", clearance: OWNER, now: NOW, expectedEtag: read }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.currentEtag).toBe(theirs);
    expect(await bodyAt(f, "1-projects/plan.md")).toBe("# Plan\n\ntheirs\n");
    const archived = (await rowsOf(f)).filter((row) => row.live && row.path.startsWith("4-archive/2"));
    expect(archived).toEqual([]);
  });

  test("goes through at the version it was asked about", async () => {
    const f = await workspace();
    const read = await etagAt(f, "1-projects/plan.md");
    const archived = await archivePath(f.store, {
      path: "1-projects/plan.md",
      clearance: OWNER,
      now: NOW,
      expectedEtag: read,
    });
    expect(await bodyAt(f, archived.to)).toBe("# Plan\n\nmine\n");
    expect(await liveRowAt(f, "1-projects/plan.md")).toBeNull();
  });
});
