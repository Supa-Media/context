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
 * In a keyed workspace a name is a tree row, and a note's bytes sit at its
 * `notes/<noteId>.md` key, so every name a write checks is a row the tree
 * holds. Names that only the bucket held (written behind the tree's back) have
 * no keyed form and are not tested here.
 *
 * Sabotage (temporary local edits, reverted), each failing a case here:
 *  - `movePath`'s destination checks reading the tree as empty: "a move onto a
 *    name the tree holds" moves;
 *  - the copy in `movePath` without `onlyIf: { absent: true }` or the tree
 *    check: the drawing the tree holds is overwritten;
 *  - `copyPath`'s destination check reading nothing: the copy onto a held
 *    name copies;
 *  - `writeNewAbout` putting unconditionally: the about note already held is
 *    overwritten;
 *  - the archive free-name loop not asking the tree: the archive lands on the
 *    stamp the tree holds.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
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
import { bodyAtPath } from "./keyedNotes.helpers";

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

async function fixture(
  options: { storage?: MemoryS3Options; conditionalCreate?: boolean; seed?: Record<string, string> } = {},
): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  const backend = memoryS3(FAKE_STORAGE.bucket, options.storage ?? {});
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
  await copyTree(t, workspaceId);
  return { t, owner, workspaceId, backend };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a console write asks the tree which names are taken", { timeout: 60_000 }, () => {
  test("a move onto a name the tree holds is refused, and nothing moves", async () => {
    const f = await fixture({
      seed: { "1-projects/held.excalidraw.md": "# Held\n", "1-projects/sketch.excalidraw.md": "# Sketch\n" },
    });
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.moveEntry, {
        workspaceId: f.workspaceId,
        from: "1-projects/plan.md",
        to: "1-projects/taken.md",
      }),
    );
    expect(errorCode(error)).toBe("DESTINATION_EXISTS");
    expect(await bodyAtPath(f, "1-projects/plan.md")).toBe("# Plan\n");
    expect(await bodyAtPath(f, "1-projects/taken.md")).toBe("# Taken\n");

    // And a drawing, which `movePath` copies itself rather than through the document move.
    const drawing = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.moveEntry, {
        workspaceId: f.workspaceId,
        from: "1-projects/sketch.excalidraw.md",
        to: "1-projects/held.excalidraw.md",
      }),
    );
    expect(errorCode(drawing)).toBe("DESTINATION_EXISTS");
    expect(await bodyAtPath(f, "1-projects/held.excalidraw.md")).toBe("# Held\n");
    expect(await bodyAtPath(f, "1-projects/sketch.excalidraw.md")).toBe("# Sketch\n");
  });

  test("a copy onto a name the tree holds is refused", async () => {
    const f = await fixture();
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.copyEntry, {
        workspaceId: f.workspaceId,
        from: "1-projects/plan.md",
        to: "1-projects/taken.md",
      }),
    );
    expect(errorCode(error)).toBe("DESTINATION_EXISTS");
    expect(await bodyAtPath(f, "1-projects/taken.md")).toBe("# Taken\n");
  });

  test("a new folder whose about note the tree already holds is refused by the write", async () => {
    const f = await fixture();
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "2-areas/fresh/about.md",
      text: "# Somebody's own words\n",
    });
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.createDirectory, {
        workspaceId: f.workspaceId,
        path: "2-areas/fresh",
      }),
    );
    expect(errorCode(error)).toBe("DESTINATION_EXISTS");
    expect(await bodyAtPath(f, "2-areas/fresh/about.md")).toBe("# Somebody's own words\n");
  });

  test("an archive lands beside a name only the tree holds, never on it", async () => {
    // Archive keeps the workspace's shape (`archiveMirror.cjs`), so a second plan.md archived from 1-projects is numbered.
    const archived = "9-archive/1-projects/plan.md";
    const f = await fixture({ seed: { [archived]: "# Archived before\n" } });
    const moved = await asUser(f.t, f.owner).action(api.functions.files.archiveEntry, {
      workspaceId: f.workspaceId,
      path: "1-projects/plan.md",
    });
    expect(moved.to).toBe("9-archive/1-projects/plan (2).md");
    expect(await bodyAtPath(f, moved.to)).toBe("# Plan\n");
    expect(await bodyAtPath(f, archived)).toBe("# Archived before\n");
  });

  test("on storage without conditional create, the tree is the whole answer, and it is still asked", async () => {
    const f = await fixture({ conditionalCreate: false, storage: { ignoreIfMatch: true } });
    const error = await captureError(() =>
      asUser(f.t, f.owner).action(api.functions.files.copyEntry, {
        workspaceId: f.workspaceId,
        from: "1-projects/plan.md",
        to: "1-projects/taken.md",
      }),
    );
    expect(errorCode(error)).toBe("DESTINATION_EXISTS");
  });
});
