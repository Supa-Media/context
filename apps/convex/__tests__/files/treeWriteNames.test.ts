/**
 * THE CONSOLE'S WRITES ASK THE TREE WHICH NAMES ARE TAKEN, NEVER THE BUCKET.
 *
 * Step 3 of the convex-only plan (owner, 2026-10-13: "the only thing that
 * should be reading from storage directly should be actually opening and
 * editing a note"). A move's or a copy's destination, an archive's free name
 * and a new folder's name are asked of the Convex tree through the barrier's
 * `treeListing` seam (`lib/nodes/treeNames.ts`, `lib/fileOps/treeChecks.ts`),
 * and the write itself is `onlyIf: { absent: true }` wherever the store can
 * hold that, which is the truth for a name the tree has not heard of yet.
 *
 * The bucket and the tree are steered apart: a name only the tree holds
 * proves the tree was asked; a name only the bucket holds proves the
 * conditional write still refuses it.
 *
 * Sabotage (temporary local edits, reverted), each failing a case here:
 *  - `movePath`'s destination checks reading `store.get` again (the note's,
 *    and the drawing's pair check): "a move onto a name only the tree holds"
 *    moves;
 *  - the copy in `movePath` without `onlyIf: { absent: true }`: the drawing
 *    the tree has not heard of is overwritten;
 *  - `copyPath`'s destination check reading the bucket: both copy cases copy;
 *  - `writeNewAbout` putting unconditionally: the about note written a
 *    second ago is overwritten;
 *  - the archive free-name loop asking `store.get`: the archive lands on the
 *    stamp only the tree holds;
 *  - `attachTreeListing` listing the bucket, and calling every name free,
 *    while the tree loads: the loading case moves the note.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { renderPrivacyManifest } from "../../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import { memoryS3, type MemoryS3, type MemoryS3Options } from "../storeStub.helpers";
import {
  FAKE_STORAGE,
  asUser,
  captureError,
  copyTree,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

async function fixture(
  options: { copied?: boolean; storage?: MemoryS3Options; conditionalCreate?: boolean; seed?: Record<string, string> } = {},
): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  const backend = memoryS3(FAKE_STORAGE.bucket, options.storage ?? {});
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  backend.seed("1-projects/plan.md", "# Plan\n");
  backend.seed("1-projects/taken.md", "# Taken\n");
  backend.seed("2-areas/held/note.md", "# Held\n");
  for (const [key, body] of Object.entries(options.seed ?? {})) backend.seed(key, body);
  vi.stubGlobal("fetch", backend.fetchImpl);
  const encryptedSecretAccessKey = await encryptSecret(FAKE_STORAGE.secretAccessKey, requireKeyset(), { workspaceId });
  const conditional = options.conditionalCreate ?? true;
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: conditional, conditionalCreate: conditional, conditionalDelete: conditional },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  if (options.copied ?? true) await copyTree(t, workspaceId);
  return { t, owner, workspaceId, backend };
}

/** Names the tree holds that the bucket no longer does: only asking the tree finds them. */
function onlyInTree(f: Fixture, ...keys: string[]) {
  for (const key of keys) f.backend.objects.delete(key);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a console write asks the tree which names are taken", () => {
  test("a move onto a name only the tree holds is refused, and nothing moves", async () => {
    const f = await fixture({
      seed: { "1-projects/held.excalidraw.md": "# Held\n", "1-projects/sketch.excalidraw.md": "# Sketch\n" },
    });
    onlyInTree(f, "1-projects/taken.md", "1-projects/held.excalidraw.md");
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.moveEntry, {
        workspaceId: f.workspaceId,
        from: "1-projects/plan.md",
        to: "1-projects/taken.md",
      }),
    );
    expect(errorCode(error)).toBe("DESTINATION_EXISTS");
    expect(f.backend.snapshot()["1-projects/plan.md"]).toBe("# Plan\n");
    expect(f.backend.snapshot()["1-projects/taken.md"]).toBeUndefined();

    // And a drawing, which `movePath` copies itself rather than through the document move.
    const drawing = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.moveEntry, {
        workspaceId: f.workspaceId,
        from: "1-projects/sketch.excalidraw.md",
        to: "1-projects/held.excalidraw.md",
      }),
    );
    expect(errorCode(drawing)).toBe("DESTINATION_EXISTS");
    expect(f.backend.snapshot()["1-projects/held.excalidraw.md"]).toBeUndefined();
  });

  test("a move onto a note the tree has not heard of yet is refused by the write, never an overwrite", async () => {
    const f = await fixture();
    f.backend.seed("1-projects/just-written.md", "# Written a second ago\n");
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.moveEntry, {
        workspaceId: f.workspaceId,
        from: "1-projects/plan.md",
        to: "1-projects/just-written.md",
      }),
    );
    expect(errorCode(error)).toBe("DESTINATION_EXISTS");
    expect(f.backend.snapshot()["1-projects/just-written.md"]).toBe("# Written a second ago\n");
    expect(f.backend.snapshot()["1-projects/plan.md"]).toBe("# Plan\n");
  });

  test("a drawing moved onto one the tree has not heard of yet is refused by the write too", async () => {
    // Not collaboratively edited, so it takes `movePath`'s own copy rather than the document move.
    const f = await fixture({ seed: { "1-projects/sketch.excalidraw.md": "# Sketch\n" } });
    f.backend.seed("1-projects/fresh.excalidraw.md", "# Drawn a second ago\n");
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.moveEntry, {
        workspaceId: f.workspaceId,
        from: "1-projects/sketch.excalidraw.md",
        to: "1-projects/fresh.excalidraw.md",
      }),
    );
    expect(errorCode(error)).toBe("DESTINATION_EXISTS");
    expect(f.backend.snapshot()["1-projects/fresh.excalidraw.md"]).toBe("# Drawn a second ago\n");
    expect(f.backend.snapshot()["1-projects/sketch.excalidraw.md"]).toBe("# Sketch\n");
  });

  test("a copy onto a name only the tree holds is refused", async () => {
    const f = await fixture();
    onlyInTree(f, "1-projects/taken.md");
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.copyEntry, {
        workspaceId: f.workspaceId,
        from: "1-projects/plan.md",
        to: "1-projects/taken.md",
      }),
    );
    expect(errorCode(error)).toBe("DESTINATION_EXISTS");
    expect(f.backend.snapshot()["1-projects/taken.md"]).toBeUndefined();
  });

  test("a new folder whose about note was written a second ago is refused by the write", async () => {
    const f = await fixture();
    f.backend.seed("2-areas/fresh/about.md", "# Somebody's own words\n");
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.createDirectory, {
        workspaceId: f.workspaceId,
        path: "2-areas/fresh",
      }),
    );
    expect(errorCode(error)).toBe("DESTINATION_EXISTS");
    expect(f.backend.snapshot()["2-areas/fresh/about.md"]).toBe("# Somebody's own words\n");
  });

  test("an archive lands beside a name only the tree holds, never on it", async () => {
    // Archive keeps the workspace's shape (`archiveMirror.cjs`), so a second plan.md archived from 1-projects is numbered.
    const archived = "9-archive/1-projects/plan.md";
    const f = await fixture({ seed: { [archived]: "# Archived before\n" } });
    onlyInTree(f, archived);
    const moved = await asUser(f.t, f.owner).action(api.functions.files.archiveEntry, {
      workspaceId: f.workspaceId,
      path: "1-projects/plan.md",
    });
    expect(moved.to).toBe("9-archive/1-projects/plan (2).md");
    expect(f.backend.snapshot()[moved.to]).toBe("# Plan\n");
  });

  test("on storage without conditional create, the tree is the whole answer, and it is still asked", async () => {
    const f = await fixture({ conditionalCreate: false, storage: { ignoreIfMatch: true } });
    onlyInTree(f, "1-projects/taken.md");
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.copyEntry, {
        workspaceId: f.workspaceId,
        from: "1-projects/plan.md",
        to: "1-projects/taken.md",
      }),
    );
    expect(errorCode(error)).toBe("DESTINATION_EXISTS");
  });

  test("a workspace whose tree is still loading is told so, and nothing is moved on a guess", async () => {
    const f = await fixture({ copied: false });
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.moveEntry, {
        workspaceId: f.workspaceId,
        from: "1-projects/plan.md",
        to: "1-projects/renamed.md",
      }),
    );
    expect(errorCode(error)).toBe("TREE_LOADING");
    expect(f.backend.snapshot()["1-projects/plan.md"]).toBe("# Plan\n");
    expect(f.backend.snapshot()["1-projects/renamed.md"]).toBeUndefined();
  });
});
