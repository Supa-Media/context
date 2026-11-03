/**
 * A note the app makes or saves in a workspace whose notes live in its object lands in the object
 * (`functions/lib/rowWatch/consoleRouting.ts`), the copy the gateway reads and shared editing opens.
 *
 * The console's credential names no workspace, and the store factory routes nothing for a binding without one, so
 * until 2026-11-02 every such write went to the bucket alone: the gateway answered "not found" for a note the app
 * had just made, and the editor, waiting on shared editing, never let anyone type into it.
 *
 * The whole path is real: the app's action, the S3 store against a memory backend, the gateway's door and a workspace
 * object on node:sqlite.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import { keyAtPath } from "./files/keyedNotes.helpers";
import { asUser, copyTree, FAKE_STORAGE, TEST_GATEWAY_SECRET } from "./fixtures.helpers";
import { renderPrivacyManifest } from "./seededRules.helpers";
import { setHome, world } from "./workspaceObjectWorld.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const GATEWAY = "https://gateway.example.invalid";

/** A bound, keyed workspace on the memory bucket, with the object world's door beside it, its notes in its object. */
async function objectHomeWorkspace() {
  const w = await world();
  const door = globalThis.fetch;
  const backend: MemoryS3 = memoryS3(FAKE_STORAGE.bucket);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("1-projects/plan.md", "# Plan\n");
  const encryptedSecretAccessKey = await encryptSecret(FAKE_STORAGE.secretAccessKey, requireKeyset(), { workspaceId: w.workspaceId });
  await w.t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId: w.workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite: true, conditionalCreate: true, conditionalDelete: true },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: w.owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  // The tree is copied and keyed against the bucket alone, as it was before the workspace moved.
  vi.unstubAllEnvs();
  vi.stubGlobal("fetch", backend.fetchImpl);
  await copyTree(w.t, w.workspaceId);
  vi.stubEnv("STORAGE_MOVER_ORIGIN", GATEWAY);
  vi.stubEnv("GATEWAY_SECRET", TEST_GATEWAY_SECRET);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? String(input) : input.url;
    return url.startsWith(GATEWAY) ? door(url, init as RequestInit) : backend.fetchImpl(input as never, init);
  });
  await setHome(w.t, w.workspaceId, "object");
  const bucket = { t: w.t, workspaceId: w.workspaceId as Id<"workspaces">, backend };
  /** The text the workspace's object holds at a key, or `null`. */
  const inObject = (key: string): string | null => {
    const held = w.stores.get(`workspace:${w.workspaceId}`);
    const found = held?.objects.get(key) as { body?: Uint8Array } | null | undefined;
    return found?.body === undefined ? null : new TextDecoder().decode(found.body);
  };
  return { ...w, backend, bucket, inObject };
}

describe("the app's note writes in a workspace read from its object", { timeout: 60_000 }, () => {
  test("a new note's text is in the object, with the bucket's backup copy beside it", async () => {
    const f = await objectHomeWorkspace();
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/daniel-2.md",
      text: "# daniel-2\n\n",
    });
    const key = await keyAtPath(f.bucket, "1-projects/daniel-2.md");
    expect(key).toMatch(/^notes\/[0-9a-f-]+\.md$/);
    expect(f.inObject(key!)).toBe("# daniel-2\n\n");
    expect(f.backend.snapshot()[key!]).toBe("# daniel-2\n\n");
  });

  test("a save over a note reaches the object too", async () => {
    const f = await objectHomeWorkspace();
    const opened = await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/scratch.md",
      text: "# scratch\n",
    });
    const saved = await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/scratch.md",
      text: "# scratch\n\nTyped in the app.\n",
      expectedEtag: opened.etag,
    });
    expect(saved.kind).toBe("written");
    const scratch = await keyAtPath(f.bucket, "1-projects/scratch.md");
    expect(f.inObject(scratch!)).toBe("# scratch\n\nTyped in the app.\n");
  });
});

describe("putting back notes written to the bucket alone", { timeout: 60_000 }, () => {
  test("a recent note the object lacks is restored from the bucket by the recent-writes repair", async () => {
    const f = await objectHomeWorkspace();
    await f.t.run(async (ctx) => {
      await ctx.db.patch(f.workspaceId as Id<"workspaces">, { slug: "example-handle" });
      // Backfilled, as the workspace was: a note the object lacks is never fetched from the bucket on a read.
      const held = await ctx.db.query("workspaceObjectHomes").withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId as Id<"workspaces">)).unique();
      await ctx.db.patch(held!._id, { backfilledAt: Date.now() });
    });
    const since = Date.now() - 1;
    await asUser(f.t, f.owner).action(api.functions.files.writeNote, {
      workspaceId: f.workspaceId,
      path: "1-projects/daniel-2.md",
      text: "# daniel-2\n\n",
    });
    const key = (await keyAtPath(f.bucket, "1-projects/daniel-2.md"))!;
    // As every app write in such a workspace did before the fix: the bucket holds it, the object does not.
    f.stores.get(`workspace:${f.workspaceId}`)!.objects.delete(key);
    expect(f.inObject(key)).toBeNull();

    const dry = await f.t.action(internal.functions.workspaceObjectsRepair.repairRecent, { only: "example-handle", since });
    expect(dry.counts.bucketNewer).toBe(1);
    expect(f.inObject(key)).toBeNull();

    const applied = await f.t.action(internal.functions.workspaceObjectsRepair.repairRecent, { only: "example-handle", since, apply: true });
    expect(applied.counts.restored).toBe(1);
    expect(applied.complete).toBe(true);
    expect(f.inObject(key)).toBe("# daniel-2\n\n");
  });
});
