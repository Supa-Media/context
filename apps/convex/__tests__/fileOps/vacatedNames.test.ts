import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { movePath, readFile, trashPath } from "../../functions/lib/fileOps";
import { NOW, bucket } from "./fixtures.helpers";

/**
 * **"just tried to name a new file kings-20 and got an error, even though I
 * dont see a kings-20 in the tree"** (owner, 2026-10-14). A note renamed or
 * trashed away from a name leaves its editing history's fence there, and a
 * rename of another note onto that name was refused as "Something already
 * exists" for ever after, though nothing was at the name.
 */
describe("a name a note left can be given to another note", () => {
  const owner = clearanceOf("private");

  test("after the note there was renamed away", async () => {
    const store = bucket({ conditional: true });
    store.seed("2-areas/kings-20.md", "# kings-20\n\nfirst\n");
    await movePath(store, { from: "2-areas/kings-20.md", to: "2-areas/kings.md", clearance: owner, now: NOW });
    store.seed("2-areas/untitled-2026-10-14.md", "# kings-20\n\nsecond\n");
    await movePath(store, { from: "2-areas/untitled-2026-10-14.md", to: "2-areas/kings-20.md", clearance: owner, now: NOW + 1 });
    expect((await readFile(store, { path: "2-areas/kings-20.md", clearance: owner })).text).toBe("# kings-20\n\nsecond\n");
    expect((await readFile(store, { path: "2-areas/kings.md", clearance: owner })).text).toBe("# kings-20\n\nfirst\n");
  });

  test("after the note there was moved to the trash", async () => {
    const store = bucket({ conditional: true });
    store.seed("2-areas/kings-20.md", "# kings-20\n\nfirst\n");
    await trashPath(store, { path: "2-areas/kings-20.md", clearance: owner, now: NOW });
    store.seed("2-areas/untitled-2026-10-14.md", "# kings-20\n\nsecond\n");
    await movePath(store, { from: "2-areas/untitled-2026-10-14.md", to: "2-areas/kings-20.md", clearance: owner, now: NOW + 1 });
    expect((await readFile(store, { path: "2-areas/kings-20.md", clearance: owner })).text).toBe("# kings-20\n\nsecond\n");
  });

  test("a name a note still holds is still refused", async () => {
    const store = bucket({ conditional: true });
    store.seed("2-areas/kings-20.md", "# kings-20\n\nfirst\n");
    store.seed("2-areas/untitled-2026-10-14.md", "# kings-20\n\nsecond\n");
    await expect(
      movePath(store, { from: "2-areas/untitled-2026-10-14.md", to: "2-areas/kings-20.md", clearance: owner, now: NOW }),
    ).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });
  });
});
