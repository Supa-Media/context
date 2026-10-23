/**
 * A copy is never wider than its source.
 *
 * Access lives on each note's tree row, and a copy gets a new row that inherits its destination folder. So a private
 * note pasted into a folder the team reads would be readable by the team unless the copy narrows its own row. These
 * cases pin that narrowing, and the refusal when a store cannot narrow at all.
 */

import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { type FileStore, copyPath, readFile } from "../../functions/lib/fileOps";
import { keyedBucket, liveAt } from "./keyedFixture.fileops1.helpers";
import { setFolderVisibility } from "../seededRules.helpers";

const OWNER = clearanceOf("private");
const TEAM = clearanceOf("team");

async function bucket() {
  const f = await keyedBucket({
    "1-projects/plan.md": "# Plan\n",
    "2-areas/salaries.md": "# Salaries\n\nnot for the team\n",
    "2-areas/hr/review.md": "# Review\n",
  });
  await setFolderVisibility(f.store, { path: "1-projects", visibility: "team", clearance: OWNER });
  return f;
}

async function teamReads(store: FileStore, path: string): Promise<boolean> {
  return await readFile(store, { path, clearance: TEAM }).then(
    () => true,
    () => false,
  );
}

describe("a copy keeps its source's privacy", () => {
  test("a private note pasted into a team folder stays private", async () => {
    const f = await bucket();
    // Non-vacuity: the team reads what is already in the folder.
    expect(await teamReads(f.store, "1-projects/plan.md")).toBe(true);

    await copyPath(f.store, { from: "2-areas/salaries.md", to: "1-projects/salaries.md", clearance: OWNER });

    expect(await liveAt(f, "1-projects/salaries.md")).toBe(true);
    expect(await teamReads(f.store, "1-projects/salaries.md")).toBe(false);
    expect((await readFile(f.store, { path: "1-projects/salaries.md", clearance: OWNER })).visibility).toBe("private");
  });

  test("a private folder pasted into a team folder stays private, with everything in it", async () => {
    const f = await bucket();
    await copyPath(f.store, { from: "2-areas/hr", to: "1-projects/hr", clearance: OWNER });

    expect(await liveAt(f, "1-projects/hr/review.md")).toBe(true);
    expect(await teamReads(f.store, "1-projects/hr/review.md")).toBe(false);
  });

  test("a team note pasted into a team folder stays team", async () => {
    const f = await bucket();
    await copyPath(f.store, { from: "1-projects/plan.md", to: "1-projects/plan-2.md", clearance: OWNER });
    expect(await teamReads(f.store, "1-projects/plan-2.md")).toBe(true);
  });

  test("a store that cannot narrow a row refuses the copy and leaves nothing behind", async () => {
    const f = await bucket();
    const noWriter = Object.create(f.store) as FileStore;
    Object.defineProperty(noWriter, "rowAccess", { value: undefined });

    await expect(
      copyPath(noWriter, { from: "2-areas/salaries.md", to: "1-projects/salaries.md", clearance: OWNER }),
    ).rejects.toMatchObject({ code: "STORAGE_UNSAFE" });
    expect(await teamReads(f.store, "1-projects/salaries.md")).toBe(false);
    expect(await liveAt(f, "1-projects/salaries.md")).toBe(false);
  });
});
