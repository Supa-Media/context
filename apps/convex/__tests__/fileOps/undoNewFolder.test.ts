import { describe, expect, test } from "vitest";
import { clearanceOf } from "../../functions/lib/clearance";
import { createFolder, removeNewFolder, setVisibility, writeFile } from "../../functions/lib/fileOps";
import { NOW, bucket, capture, shareProjects } from "./fixtures.helpers";

/**
 * Undo after "New folder" (board 05c of the phone Home artboards, approved by
 * the owner on 2026-09-30): the toast says "Created Hiring in Team · Undo",
 * and Undo takes the folder away again **while it is still empty**.
 *
 * "Still empty" is the whole contract. The folder exists as one placeholder
 * `README.md`; the moment anything else is in it — a note somebody made, a
 * note somebody else made that this caller cannot even see, or words written
 * into the placeholder itself — Undo keeps the folder and says so, because
 * the alternative is a permanent delete of somebody's work behind a button
 * labelled Undo.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. Skipping the "only one key" check.          → "a note put in it since keeps the folder"
 *  2. Listing only what the caller can see.        → "a note the caller cannot see still keeps it"
 *  3. Skipping the placeholder-text comparison.    → "words written into the placeholder keep it"
 *  4. Dropping the visibility check.               → "a hidden folder with things in it answers not found too"
 */
describe("undoing a new folder", () => {
  const owner = clearanceOf("private");

  test("an untouched new folder goes away completely", async () => {
    const store = bucket();
    await createFolder(store, { path: "2-areas/hiring", clearance: owner, now: NOW });
    const removed = await removeNewFolder(store, { path: "2-areas/hiring", clearance: owner });
    expect(removed.paths).toEqual(["2-areas/hiring/README.md"]);
    expect(Object.keys(store.snapshot()).filter((key) => key.startsWith("2-areas/hiring"))).toEqual([]);
  });

  test("a note put in it since keeps the folder", async () => {
    const store = bucket();
    await createFolder(store, { path: "2-areas/hiring", clearance: owner, now: NOW });
    await writeFile(store, { path: "2-areas/hiring/plan.md", text: "# Plan\n", clearance: owner, now: NOW });
    const error = await capture(() => removeNewFolder(store, { path: "2-areas/hiring", clearance: owner }));
    expect(error.code).toBe("FOLDER_NOT_EMPTY");
    expect(error.message).toBe("hiring has something in it now, so it was kept.");
    expect(store.snapshot()["2-areas/hiring/README.md"]).toContain("Folder placeholder.");
    expect(store.snapshot()["2-areas/hiring/plan.md"]).toBe("# Plan\n");
  });

  test("a note the caller cannot see still keeps it", async () => {
    const store = bucket();
    await shareProjects(store);
    // A team reader made it; the owner then filed something private inside.
    await createFolder(store, { path: "1-projects/hiring", clearance: clearanceOf("team"), now: NOW });
    await writeFile(store, { path: "1-projects/hiring/pay.md", text: "# Pay\n", clearance: owner, now: NOW });
    await setVisibility(store, { path: "1-projects/hiring/pay.md", visibility: "private", clearance: owner });
    const error = await capture(() =>
      removeNewFolder(store, { path: "1-projects/hiring", clearance: clearanceOf("team") }),
    );
    expect(error.code).toBe("FOLDER_NOT_EMPTY");
    expect(store.snapshot()["1-projects/hiring/pay.md"]).toBe("# Pay\n");
  });

  test("words written into the placeholder keep it", async () => {
    const store = bucket();
    await createFolder(store, { path: "2-areas/hiring", clearance: owner, now: NOW });
    const written = await store.get("2-areas/hiring/README.md");
    await writeFile(store, {
      path: "2-areas/hiring/README.md",
      expectedEtag: written!.etag,
      text: "# Hiring\n\nWho we are looking for.\n",
      clearance: owner,
      now: NOW,
    });
    const error = await capture(() => removeNewFolder(store, { path: "2-areas/hiring", clearance: owner }));
    expect(error.code).toBe("FOLDER_NOT_EMPTY");
    expect(store.snapshot()["2-areas/hiring/README.md"]).toContain("Who we are looking for.");
  });

  test("a folder that is not there, or not the caller's to see, answers not found", async () => {
    const store = bucket();
    const missing = await capture(() => removeNewFolder(store, { path: "2-areas/nothing", clearance: owner }));
    expect(missing.code).toBe("FILE_NOT_FOUND");
    // `2-areas` is private in the PARA scaffold: a team caller must get the same answer.
    await createFolder(store, { path: "2-areas/hiring", clearance: owner, now: NOW });
    const hidden = await capture(() =>
      removeNewFolder(store, { path: "2-areas/hiring", clearance: clearanceOf("team") }),
    );
    expect(hidden.code).toBe(missing.code);
    expect(hidden.message).toBe(missing.message);
    expect(store.snapshot()["2-areas/hiring/README.md"]).toContain("Folder placeholder.");
  });

  test("a hidden folder with things in it answers not found too, not \"kept\"", async () => {
    const store = bucket();
    // `2-areas` holds two notes a team caller cannot see; "kept" would say it exists.
    const hidden = await capture(() => removeNewFolder(store, { path: "2-areas", clearance: clearanceOf("team") }));
    expect(hidden.code).toBe("FILE_NOT_FOUND");
  });

  test("the top of the workspace and plumbing are never a new folder", async () => {
    const store = bucket();
    expect((await capture(() => removeNewFolder(store, { path: "", clearance: owner }))).code).toBe("PATH_INVALID");
    expect((await capture(() => removeNewFolder(store, { path: ".context", clearance: owner }))).code).toBe(
      "PATH_INVALID",
    );
  });
});
