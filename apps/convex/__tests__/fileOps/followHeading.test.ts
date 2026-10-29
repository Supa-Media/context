/**
 * A rename rewrites the note's first heading inside the move, against the
 * version the move produced, and never over a newer write
 * (`lib/fileOps/followHeading.ts`). The console's own second write raced the
 * editor and merged two titles into "kkingsngs-6" (2026-10-14).
 */
import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { movePath } from "../../functions/lib/fileOps";
import { followHeading } from "../../functions/lib/fileOps/followHeading";
import { readFile } from "../../functions/lib/fileOps/reading";
import { writeFile } from "../../functions/lib/fileOps/writing";
import { NOW } from "./fixtures.helpers";
import { keyedBucket, textAt, type KeyedBucket } from "./keyedFixture.fileops1.helpers";

const OWNER = { clearance: clearanceOf("private"), now: NOW };

async function rename(f: KeyedBucket, from: string, to: string) {
  const moved = await movePath(f.store, { from, to, ...OWNER });
  return { moved, etag: await followHeading(f.store, moved, OWNER) };
}

describe("a rename's heading follows inside the move", () => {
  test("the heading becomes the new name, and the result carries the new version", async () => {
    const f = await keyedBucket({ "1-projects/kings.md": "# kings\n\nnotes\n" });
    const { etag } = await rename(f, "1-projects/kings.md", "1-projects/kings-6.md");
    const after = await readFile(f.store, { path: "1-projects/kings-6.md", clearance: OWNER.clearance, forward: "never" });
    expect(after.text).toBe("# kings-6\n\nnotes\n");
    expect(etag).toBe(after.etag);
  });

  test("an untitled note's placeholder heading takes the name, once", async () => {
    const f = await keyedBucket({ "1-projects/untitled-2026-10-14.md": "# untitled-2026-10-14\n" });
    await rename(f, "1-projects/untitled-2026-10-14.md", "1-projects/kings.md");
    expect(await textAt(f, "1-projects/kings.md")).toBe("# kings\n");
  });

  test("a write after the move wins: the heading is left alone, not raced", async () => {
    const f = await keyedBucket({ "1-projects/kings.md": "# kings\n" });
    const moved = await movePath(f.store, { from: "1-projects/kings.md", to: "1-projects/kings-6.md", ...OWNER });
    // The editor saves its own title at the new name before the heading step.
    await writeFile(f.store, { path: "1-projects/kings-6.md", text: "# kings-9\n", expectedEtag: moved.etag, ...OWNER });
    expect(await followHeading(f.store, moved, OWNER)).toBeUndefined();
    expect(await textAt(f, "1-projects/kings-6.md")).toBe("# kings-9\n");
  });

  // Nothing written still hands back the version its read found (2026-10-29): the move leaves that read to
  // this step (`handOut: false`), so a note gets one read rather than two. A folder is never read.
  const readEtag = async (f: KeyedBucket, path: string) =>
    (await readFile(f.store, { path, clearance: OWNER.clearance, forward: "never" })).etag;

  test("no heading, an address name, a folder: nothing is written", async () => {
    const f = await keyedBucket({ "1-projects/plain.md": "just words\n" });
    const plain = await rename(f, "1-projects/plain.md", "1-projects/words.md");
    expect(plain.etag).toBe(await readEtag(f, "1-projects/words.md"));
    expect(await textAt(f, "1-projects/words.md")).toBe("just words\n");

    await f.store.put("1-projects/notes/about.md", "# Notes\n");
    await f.store.put("1-projects/notes/a.md", "# a\n");
    const folder = await rename(f, "1-projects/notes", "1-projects/papers");
    expect(folder.etag).toBeUndefined();
    expect(await textAt(f, "1-projects/papers/about.md")).toBe("# Notes\n");
    expect(await textAt(f, "1-projects/papers/a.md")).toBe("# a\n");

    await f.store.put("1-projects/todo-list.md", "# Todo\n");
    const address = await rename(f, "1-projects/todo-list.md", "1-projects/todo.md");
    expect(address.etag).toBe(await readEtag(f, "1-projects/todo.md"));
    expect(await textAt(f, "1-projects/todo.md")).toBe("# Todo\n");
  });

  test("a sort number is kept where the heading carried it, and dropped where it did not", async () => {
    const f = await keyedBucket({
      "1-projects/01-intro.md": "# 01-intro\n",
      "1-projects/02-plan.md": "# plan\n",
    });
    await rename(f, "1-projects/01-intro.md", "1-projects/01-opening.md");
    await rename(f, "1-projects/02-plan.md", "1-projects/02-roadmap.md");
    expect(await textAt(f, "1-projects/01-opening.md")).toBe("# 01-opening\n");
    expect(await textAt(f, "1-projects/02-roadmap.md")).toBe("# roadmap\n");
  });
});
