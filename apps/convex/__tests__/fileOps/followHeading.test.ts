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
import { NOW, bucket } from "./fixtures.helpers";

const OWNER = { clearance: clearanceOf("private"), now: NOW };

async function rename(store: ReturnType<typeof bucket>, from: string, to: string) {
  const moved = await movePath(store, { from, to, ...OWNER });
  return { moved, etag: await followHeading(store, moved, OWNER) };
}

describe("a rename's heading follows inside the move", () => {
  test("the heading becomes the new name, and the result carries the new version", async () => {
    const store = bucket();
    store.seed("1-projects/kings.md", "# kings\n\nnotes\n");
    const { etag } = await rename(store, "1-projects/kings.md", "1-projects/kings-6.md");
    const after = await store.get("1-projects/kings-6.md");
    expect(await after!.text()).toBe("# kings-6\n\nnotes\n");
    expect(etag).toBe(after!.etag);
  });

  test("an untitled note's placeholder heading takes the name, once", async () => {
    const store = bucket();
    store.seed("1-projects/untitled-2026-10-14.md", "# untitled-2026-10-14\n");
    await rename(store, "1-projects/untitled-2026-10-14.md", "1-projects/kings.md");
    expect(await (await store.get("1-projects/kings.md"))!.text()).toBe("# kings\n");
  });

  test("a write after the move wins: the heading is left alone, not raced", async () => {
    const store = bucket();
    store.seed("1-projects/kings.md", "# kings\n");
    const moved = await movePath(store, { from: "1-projects/kings.md", to: "1-projects/kings-6.md", ...OWNER });
    // The editor saves its own title at the new name before the heading step.
    await store.put("1-projects/kings-6.md", "# kings-9\n");
    expect(await followHeading(store, moved, OWNER)).toBeUndefined();
    expect(await (await store.get("1-projects/kings-6.md"))!.text()).toBe("# kings-9\n");
  });

  test("no heading, an address name, a folder: nothing is written", async () => {
    const store = bucket();
    store.seed("1-projects/plain.md", "just words\n");
    const plain = await rename(store, "1-projects/plain.md", "1-projects/words.md");
    expect(plain.etag).toBeUndefined();
    expect(await (await store.get("1-projects/words.md"))!.text()).toBe("just words\n");

    store.seed("1-projects/notes/about.md", "# Notes\n");
    store.seed("1-projects/notes/a.md", "# a\n");
    const folder = await rename(store, "1-projects/notes", "1-projects/papers");
    expect(folder.etag).toBeUndefined();
    expect(await (await store.get("1-projects/papers/about.md"))!.text()).toBe("# Notes\n");
    expect(await (await store.get("1-projects/papers/a.md"))!.text()).toBe("# a\n");

    store.seed("1-projects/todo-list.md", "# Todo\n");
    const address = await rename(store, "1-projects/todo-list.md", "1-projects/todo.md");
    expect(address.etag).toBeUndefined();
    expect(await (await store.get("1-projects/todo.md"))!.text()).toBe("# Todo\n");
  });

  test("a sort number is kept where the heading carried it, and dropped where it did not", async () => {
    const store = bucket();
    store.seed("1-projects/01-intro.md", "# 01-intro\n");
    store.seed("1-projects/02-plan.md", "# plan\n");
    await rename(store, "1-projects/01-intro.md", "1-projects/01-opening.md");
    await rename(store, "1-projects/02-plan.md", "1-projects/02-roadmap.md");
    expect(await (await store.get("1-projects/01-opening.md"))!.text()).toBe("# 01-opening\n");
    expect(await (await store.get("1-projects/02-roadmap.md"))!.text()).toBe("# roadmap\n");
  });
});
