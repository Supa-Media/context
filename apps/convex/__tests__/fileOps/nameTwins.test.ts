/**
 * Names in one folder that differ only by case are one folder to a person and
 * two to the bucket, so a second one is refused, and at the root a new folder
 * may not take a role another folder plays (`fileOps/nameTwins.ts`, decided by
 * the owner 2026-10-14 after an agent made `projects` beside `Projects`).
 *
 * Keyed workspace: the twin check reads the tree's names, so a sibling is
 * judged by its row, whatever key its bytes sit at.
 *
 * Every value here is obviously fake. This repository is public.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { createFolder, movePath, writeFile } from "../../functions/lib/fileOps";
import { NOW, capture, shareProjects } from "./fixtures.helpers";
import { keyedBucket, liveAt, PARA_SEEDS, textAt } from "./keyedFixture.fileops1.helpers";

const OWNER = clearanceOf("private");

/**
 * The scaffold without its `1-projects` folder, with one root folder holding one note. A root folder named
 * `Projects` claims the projects role in a keyed tree, so the case-twin tests use `Ideas`, which plays no
 * role, and the role test asks for `Projects`.
 */
function withFolder(name: string) {
  const seeds: Record<string, string> = { ...PARA_SEEDS, [`${name}/about.md`]: "" };
  for (const key of Object.keys(seeds)) if (key.startsWith("1-projects/")) delete seeds[key];
  return keyedBucket(seeds);
}

describe("a new name may not twin a sibling", () => {
  test("a folder differing only by case is refused, naming the one to use", async () => {
    const f = await withFolder("Ideas");
    const error = await capture(() => createFolder(f.store, { path: "ideas", clearance: OWNER, now: NOW }));
    expect(error.code).toBe("DESTINATION_EXISTS");
    expect(error.message).toMatch(/Ideas is already here/);
    expect(await liveAt(f, "ideas/about.md")).toBe(false);
  });

  test("a note whose folder would twin one is refused, and the right path is named", async () => {
    const f = await withFolder("Ideas");
    const error = await capture(() =>
      writeFile(f.store, { path: "ideas/plan.md", text: "# Plan\n", clearance: OWNER, now: NOW }),
    );
    expect(error.message).toContain("Use Ideas/plan.md instead");
    expect(await liveAt(f, "ideas/plan.md")).toBe(false);
    // The right spelling goes straight in.
    await writeFile(f.store, { path: "Ideas/plan.md", text: "# Plan\n", clearance: OWNER, now: NOW });
    expect(await liveAt(f, "Ideas/plan.md")).toBe(true);
  });

  test("at the root a new folder may not take a role another folder plays", async () => {
    const f = await withFolder("Projects");
    const error = await capture(() => createFolder(f.store, { path: "1-projects", clearance: OWNER, now: NOW }));
    expect(error.message).toMatch(/Projects is already this workspace's Projects folder/);
    // Below the root a number is just a name.
    await createFolder(f.store, { path: "Projects/1-projects", clearance: OWNER, now: NOW });
  });

  test("a note twinning a note by case is refused; an edit of the note itself is not", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    const error = await capture(() =>
      writeFile(f.store, { path: "1-projects/Pay.md", text: "# Pay\n", clearance: OWNER, now: NOW }),
    );
    expect(error.message).toMatch(/pay\.md is already here/);
    const stored = await f.store.get("1-projects/pay.md");
    await writeFile(f.store, {
      path: "1-projects/pay.md",
      text: "# Pay\n\nmore\n",
      expectedEtag: stored!.etag,
      clearance: OWNER,
      now: NOW,
    });
    expect(await textAt(f, "1-projects/pay.md")).toBe("# Pay\n\nmore\n");
  });

  test("a rename onto a twin is refused, and a rename that only changes case is not", async () => {
    const f = await withFolder("Ideas");
    await f.store.put("Ideas/Launch/plan.md", "# Plan\n");
    await f.store.put("Ideas/notes.md", "# Notes\n");
    const error = await capture(() =>
      movePath(f.store, { from: "Ideas/notes.md", to: "Ideas/launch", clearance: OWNER, now: NOW }),
    );
    expect(error.message).toMatch(/Launch is already here/);
    await movePath(f.store, { from: "Ideas/notes.md", to: "Ideas/Notes.md", clearance: OWNER, now: NOW });
    expect(await liveAt(f, "Ideas/Notes.md")).toBe(true);
  });

  test("a twin the caller cannot see is not refused on, so the refusal discloses nothing", async () => {
    const f = await keyedBucket(PARA_SEEDS);
    await shareProjects(f.store);
    // `1-projects/pay.md` is private; a team caller is never told about it by name.
    const error = await capture(() =>
      writeFile(f.store, { path: "1-projects/Pay.md", text: "# Pay\n", clearance: clearanceOf("team"), now: NOW }),
    ).catch(() => null);
    expect(error?.message ?? "").not.toMatch(/already here/);
  });
});
