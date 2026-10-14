/**
 * Names in one folder that differ only by case are one folder to a person and
 * two to the bucket, so a second one is refused, and at the root a new folder
 * may not take a role another folder plays (`fileOps/nameTwins.ts`, decided by
 * the owner 2026-10-14 after an agent made `projects` beside `Projects`).
 *
 * Every value here is obviously fake. This repository is public.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { createFolder, movePath, writeFile } from "../../functions/lib/fileOps";
import { NOW, bucket, capture, shareProjects } from "./fixtures.helpers";

const OWNER = clearanceOf("private");

function withProjects() {
  const store = bucket();
  store.seed("Projects/about.md", "");
  store.objects.delete("1-projects/README.md");
  for (const key of [...store.objects.keys()]) if (key.startsWith("1-projects/")) store.objects.delete(key);
  return store;
}

describe("a new name may not twin a sibling", () => {
  test("a folder differing only by case is refused, naming the one to use", async () => {
    const store = withProjects();
    const error = await capture(() => createFolder(store, { path: "projects", clearance: OWNER, now: NOW }));
    expect(error.code).toBe("DESTINATION_EXISTS");
    expect(error.message).toMatch(/Projects is already here/);
    expect(store.objects.has("projects/about.md")).toBe(false);
  });

  test("a note whose folder would twin one is refused, and the right path is named", async () => {
    const store = withProjects();
    const error = await capture(() =>
      writeFile(store, { path: "projects/plan.md", text: "# Plan\n", clearance: OWNER, now: NOW }),
    );
    expect(error.message).toContain("Use Projects/plan.md instead");
    expect(store.objects.has("projects/plan.md")).toBe(false);
    // The right spelling goes straight in.
    await writeFile(store, { path: "Projects/plan.md", text: "# Plan\n", clearance: OWNER, now: NOW });
    expect(store.objects.has("Projects/plan.md")).toBe(true);
  });

  test("at the root a new folder may not take a role another folder plays", async () => {
    const store = withProjects();
    const error = await capture(() => createFolder(store, { path: "1-projects", clearance: OWNER, now: NOW }));
    expect(error.message).toMatch(/Projects is already this workspace's Projects folder/);
    // Below the root a number is just a name.
    await createFolder(store, { path: "Projects/1-projects", clearance: OWNER, now: NOW });
  });

  test("a note twinning a note by case is refused; an edit of the note itself is not", async () => {
    const store = bucket();
    const error = await capture(() =>
      writeFile(store, { path: "1-projects/Pay.md", text: "# Pay\n", clearance: OWNER, now: NOW }),
    );
    expect(error.message).toMatch(/pay\.md is already here/);
    const stored = await store.get("1-projects/pay.md");
    await writeFile(store, {
      path: "1-projects/pay.md",
      text: "# Pay\n\nmore\n",
      expectedEtag: stored!.etag,
      clearance: OWNER,
      now: NOW,
    });
  });

  test("a rename onto a twin is refused, and a rename that only changes case is not", async () => {
    const store = withProjects();
    store.seed("Projects/Launch/plan.md", "# Plan\n");
    store.seed("Projects/notes.md", "# Notes\n");
    const error = await capture(() =>
      movePath(store, { from: "Projects/notes.md", to: "Projects/launch", clearance: OWNER, now: NOW }),
    );
    expect(error.message).toMatch(/Launch is already here/);
    await movePath(store, { from: "Projects/notes.md", to: "Projects/Notes.md", clearance: OWNER, now: NOW });
    expect(store.objects.has("Projects/Notes.md")).toBe(true);
  });

  test("a twin the caller cannot see is not refused on, so the refusal discloses nothing", async () => {
    const store = bucket();
    await shareProjects(store);
    // `1-projects/pay.md` is private; a team caller is never told about it by name.
    const error = await capture(() =>
      writeFile(store, { path: "1-projects/Pay.md", text: "# Pay\n", clearance: clearanceOf("team"), now: NOW }),
    ).catch(() => null);
    expect(error?.message ?? "").not.toMatch(/already here/);
  });
});
