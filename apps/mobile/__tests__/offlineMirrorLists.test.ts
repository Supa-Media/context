/**
 * The notes a folder list chooses from, read off the device's copy.
 *
 * What matters is what it must not read: a body filed at another clearance, an
 * encrypted note's envelope, or anything after the workspace was forgotten.
 */
import { beforeEach, describe, expect, test } from "@jest/globals";
import { currentEpoch } from "../features/offline/epoch";
import type { CacheScope } from "../features/offline/keys";
import { NOTHING_NEEDED, putMirroredNotes } from "../features/offline/mirror";
import { forgetMirrorLists, mirroredListNotes } from "../features/offline/mirrorLists";
import { memoryMirrorStore, type MirrorStore } from "../features/offline/mirrorStoreCore";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const WS = "ws_one";
let store: MirrorStore;

beforeEach(() => {
  store = memoryMirrorStore();
});

async function put(
  notes: Array<{ path: string; text: string; encrypted?: boolean; etag?: string }>,
  scope: CacheScope = "private",
): Promise<void> {
  await putMirroredNotes(
    store,
    currentEpoch(),
    scope,
    WS,
    notes.map((note) => ({
      path: note.path,
      text: note.text,
      etag: note.etag ?? `e-${note.path}`,
      visibility: scope === "private" ? "private" : "team",
      inherited: scope === "private" ? "private" : "team",
      exception: false,
      readOnly: note.encrypted === true,
      ...(note.encrypted === true ? { encrypted: true } : {}),
    })),
    NOTHING_NEEDED,
    NOW,
  );
}

const paths = (source: { notes: readonly { path: string }[] } | null) =>
  (source?.notes ?? []).map((note) => note.path).sort();

describe("reading a folder's notes for a list", () => {
  test("the folder's notes, with their frontmatter as properties", async () => {
    await put([
      { path: "1-projects/a.md", text: "---\nstatus: active\ntags: [x, y]\n---\n# A" },
      { path: "1-projects/b.md", text: "# B" },
      { path: "1-projects/deep/c.md", text: "# C" },
      { path: "2-areas/d.md", text: "# D" },
      { path: "1-projects/photo.png", text: "" },
    ]);
    const source = await mirroredListNotes(store, "private", WS, "1-projects", false);
    expect(paths(source)).toEqual(["1-projects/a.md", "1-projects/b.md"]);
    const a = source!.notes.find((note) => note.path === "1-projects/a.md")!;
    expect(a.properties.status).toBe("active");
    expect(a.properties.tags).toEqual(["x", "y"]);
    expect(paths(await mirroredListNotes(store, "private", WS, "1-projects", true))).toContain(
      "1-projects/deep/c.md",
    );
  });

  test("reads exactly the clearance asked for, never a wider one", async () => {
    await put([{ path: "1-projects/secret.md", text: "# S" }], "private");
    await put([{ path: "1-projects/shared.md", text: "# T" }], "team");
    expect(paths(await mirroredListNotes(store, "team", WS, "1-projects", false))).toEqual([
      "1-projects/shared.md",
    ]);
  });

  test("an encrypted note is left out, frontmatter and all", async () => {
    await put([
      { path: "1-projects/sealed.md", text: "ENVELOPE", encrypted: true },
      { path: "1-projects/open.md", text: "# O" },
    ]);
    expect(paths(await mirroredListNotes(store, "private", WS, "1-projects", false))).toEqual([
      "1-projects/open.md",
    ]);
  });

  test("a changed note is read again at its new version", async () => {
    await put([{ path: "1-projects/a.md", text: "---\nstatus: active\n---\n" }]);
    await mirroredListNotes(store, "private", WS, "1-projects", false);
    await put([{ path: "1-projects/a.md", text: "---\nstatus: done\n---\n", etag: "e2" }]);
    const source = await mirroredListNotes(store, "private", WS, "1-projects", false);
    expect(source!.notes[0].properties.status).toBe("done");
  });

  test("a workspace with nothing on the device answers null, not an empty list", async () => {
    expect(await mirroredListNotes(store, "private", "ws_other", "1-projects", false)).toBeNull();
  });

  test("forgetting drops what was held", async () => {
    await put([{ path: "1-projects/a.md", text: "---\nstatus: active\n---\n" }]);
    await mirroredListNotes(store, "private", WS, "1-projects", false);
    forgetMirrorLists(WS);
    await store.forgetWorkspace(WS);
    expect(await mirroredListNotes(store, "private", WS, "1-projects", false)).toBeNull();
  });
});
