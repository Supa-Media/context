/**
 * THE FILE EDITOR, THROUGH THE CONTROL PLANE.
 *
 * `fileOps.test.ts` proves the operations against a bucket. This one proves
 * the two things only the Convex layer can get wrong:
 *
 *  1. **Authorization.** Reading needs `member`; writing needs `editor`. A
 *     non-member gets an error byte-identical to the one for a workspace that
 *     never existed, in the style of `isolation.test.ts` — because an endpoint
 *     that distinguishes them is an oracle for which contexts are real.
 *  2. **Note content does not stay here.** The control plane holds metadata
 *     only (CLAUDE.md non-negotiable #1). Content passes through an action and
 *     is returned; it must appear in no table, no audit row, and no error
 *     message. That is asserted by writing a distinctive marker through every
 *     operation and then sweeping the entire database for it.
 *
 * The whole path is real: the real actions, the real `S3Store` doing real
 * SigV4 against a `fetch` stub speaking S3, the real envelope opened by the
 * real `decryptSecret`. Only the socket is fake.
 */

import { afterEach, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { renderPrivacyManifest } from "../../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import { memoryS3, type MemoryS3, type MemoryS3Options } from "../storeStub.helpers";
import {
  FAKE_STORAGE,
  type TestConvex,
  addMember,
  asUser,
  createUser,
  createWorkspace,
  setupTest,
} from "../fixtures.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/**
 * A marker that could only have come from note content.
 *
 * Long, unique, and nothing like a path — so a sweep that finds it has found
 * a leak, not a coincidence.
 */
export const SECRET_BODY_MARKER = "zzq-note-body-marker-9f13c4d2-never-persist";

export interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  editor: Id<"users">;
  reader: Id<"users">;
  stranger: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

/**
 * A workspace with an owner, an editor, a read-only member, a stranger, and a
 * bucket behind it holding a small PARA context.
 *
 * The binding row is inserted directly rather than through `bindStorage`, for
 * the reason `provisioning.test.ts` documents: the public flow also *schedules*
 * a verification, and that scheduled probe would race the action under test.
 * The envelope is produced by the real `encryptSecret`, so the decrypt path
 * exercised here is the real one.
 */
export async function fixture(
  options: MemoryS3Options & { conditionalWrite?: boolean; conditionalCreate?: boolean } = {},
): Promise<Fixture> {
  const { conditionalWrite = true, conditionalCreate = true, ...bucketOptions } = options;
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const editor = await createUser(t, "editor@example.invalid");
  const reader = await createUser(t, "reader@example.invalid");
  const stranger = await createUser(t, "stranger@example.invalid");

  const workspaceId = await createWorkspace(t, owner, "atlas");
  await addMember(t, workspaceId, editor, "editor", owner);
  await addMember(t, workspaceId, reader, "member", owner);
  // The stranger is a real, authenticated user with a context of her own.
  await createWorkspace(t, stranger, "elsewhere");

  const backend = memoryS3(FAKE_STORAGE.bucket, bucketOptions);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  backend.seed("1-projects/README.md", "# Projects\n");
  backend.seed("1-projects/shared.md", "# Shared\n");
  backend.seed("2-areas/README.md", "# Areas\n");
  backend.seed("2-areas/private-note.md", `# Private\n\n${SECRET_BODY_MARKER}\n`);
  vi.stubGlobal("fetch", backend.fetchImpl);

  const encryptedSecretAccessKey = await encryptSecret(
    FAKE_STORAGE.secretAccessKey,
    requireKeyset(),
    { workspaceId },
  );
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: {
        conditionalWrite,
        conditionalCreate,
        conditionalDelete: true,
      },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  return { t, owner, editor, reader, stranger, workspaceId, backend };
}

/** Share `1-projects`, so a `team`-scoped caller has something to see. */
export async function share(f: Fixture): Promise<void> {
  await asUser(f.t, f.owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId: f.workspaceId,
    path: "1-projects",
    visibility: "team",
  });
}

export function errorShape(error: unknown): string {
  return JSON.stringify((error as { data?: unknown }).data ?? null);
}

/**
 * A workspace id that refers to nothing, produced by creating and deleting a
 * row so it is indistinguishable in shape from a live one.
 */
export async function danglingWorkspaceId(t: TestConvex): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    const id = await ctx.db.insert("workspaces", {
      slug: "temporary-placeholder",
      displayName: "Temporary",
      createdBy: (await ctx.db.insert("users", { createdAt: Date.now() })) as Id<"users">,
      kind: "personal",
      structureTemplate: "para",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.delete(id);
    return id;
  });
}
