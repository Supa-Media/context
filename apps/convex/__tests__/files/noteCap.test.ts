/**
 * THE FREE TIER'S NOTE CAP, IN THE CONSOLE'S FILE EDITOR.
 *
 * The console writes through the same store factory the gateway does, and it
 * must be refused at the same count and in the same words — or the cap is a
 * rule for AI clients that a person clicking "New note" walks straight past.
 * And everything that is not a new note must keep working on a full context:
 * editing, moving, deleting.
 *
 * Sabotage: the barrier not passing `noteCap` to the factory fails 1; console
 * moves outside the relocation window fails 1; `toConvexError` not mapping the
 * refusal fails 1 (a generic STORAGE_FAILED instead).
 */

import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { renderPrivacyManifest } from "../../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import { DELETE_CONFIRMATION } from "../../functions/lib/fileOps";
import { managedBucketName } from "../../functions/lib/managedStorage";
import { FREE_MANAGED_NOTE_CAP } from "../../functions/lib/premium";
import { memoryS3, type MemoryS3 } from "../storeStub.helpers";
import {
  FAKE_STORAGE,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import { vi } from "vitest";

/**
 * A free context on a bucket we run, holding exactly `notes` notes: the two
 * structure files and the rest in `1-projects/`, plus plumbing that must not
 * count.
 */
async function freeContext(notes: number, freeManaged = true): Promise<{
  t: TestConvex;
  owner: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}> {
  const t = setupTest();
  const owner = await createUser(t, "free-owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "freecap");
  const bucket = managedBucketName(workspaceId);

  const backend = memoryS3(bucket);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  for (let i = 2; i < notes; i += 1) {
    backend.seed(`1-projects/note-${String(i).padStart(4, "0")}.md`, `# Note ${i}\n`);
  }
  backend.seed(".context/cache/not-a-note.md", "plumbing");
  vi.stubGlobal("fetch", backend.fetchImpl);

  const encryptedSecretAccessKey = await encryptSecret(FAKE_STORAGE.secretAccessKey, requireKeyset(), {
    workspaceId,
  });
  await t.run(async (ctx) => {
    await ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("workspacePlans", {
      workspaceId,
      managedStorage: true,
      fastSearch: false,
      status: "none",
      freeManaged,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
  return { t, owner, workspaceId, backend };
}

describe("the console at the free tier's note cap", () => {
  test("a new note is refused, with the sentence that says what still works", async () => {
    const f = await freeContext(FREE_MANAGED_NOTE_CAP);
    try {
      const error = await captureError(() =>
        asUser(f.t, f.owner).action(api.functions.files.writeNote, {
          workspaceId: f.workspaceId,
          path: "1-projects/one-too-many.md",
          text: "# One too many\n",
        }),
      );
      expect(errorCode(error)).toBe("NOTE_CAP_REACHED");
      expect(JSON.stringify((error as { data?: unknown }).data)).toMatch(/exported/);
      expect(f.backend.snapshot()["1-projects/one-too-many.md"]).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a note that exists is still edited, moved and deleted", async () => {
    const f = await freeContext(FREE_MANAGED_NOTE_CAP);
    try {
      const owner = asUser(f.t, f.owner);
      const read = await owner.action(api.functions.files.readNote, {
        workspaceId: f.workspaceId,
        path: "1-projects/note-0002.md",
      });
      await owner.action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: "1-projects/note-0002.md",
        text: "# Edited\n",
        expectedEtag: (read as { etag: string }).etag,
      });
      expect(f.backend.snapshot()["1-projects/note-0002.md"]).toBe("# Edited\n");

      await owner.action(api.functions.files.moveEntry, {
        workspaceId: f.workspaceId,
        from: "1-projects/note-0002.md",
        to: "1-projects/renamed.md",
      });
      expect(f.backend.snapshot()["1-projects/renamed.md"]).toBe("# Edited\n");

      await owner.action(api.functions.files.deleteEntry, {
        workspaceId: f.workspaceId,
        path: "1-projects/renamed.md",
        confirmation: DELETE_CONFIRMATION,
      });
      // The move was logged to `activity.md`, which is written even at the cap
      // (it is Context's own log) and counted like every other note, as the
      // console's own count counts it. So two go to make room for one.
      await owner.action(api.functions.files.deleteEntry, {
        workspaceId: f.workspaceId,
        path: "1-projects/note-0003.md",
        confirmation: DELETE_CONFIRMATION,
      });
      await owner.action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: "1-projects/room-again.md",
        text: "# Room\n",
      });
      expect(f.backend.snapshot()["1-projects/room-again.md"]).toBe("# Room\n");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("a context that is not on the free tier is never capped", async () => {
    const f = await freeContext(FREE_MANAGED_NOTE_CAP, false);
    try {
      await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
        workspaceId: f.workspaceId,
        path: "1-projects/one-more.md",
        text: "# One more\n",
      });
      expect(f.backend.snapshot()["1-projects/one-more.md"]).toBe("# One more\n");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
