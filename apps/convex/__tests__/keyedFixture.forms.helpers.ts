/**
 * The forms suite's workspace, keyed: every note lives at `notes/<noteId>.md`
 * and its name is a `nodes` row. `forms.test.ts` and `formsTree.test.ts` share
 * this one fixture, so a test reads a note through its row (`bodyOf`), never by
 * spelling a path into the bucket.
 *
 * The same people and the same form as `forms.helpers.ts`. The difference is the
 * order: the seeded notes are copied and keyed first (`copyTree`), and every
 * write goes through the app after that, as it does in production. A write into
 * a workspace that is not keyed throws `NotKeyed`.
 */

import { vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { renderPrivacyManifest } from "../functions/lib/scaffold";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3, type MemoryS3Options } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  addMember,
  asUser,
  copyTree,
  createUser,
  createWorkspace,
  setupTest,
} from "./fixtures.helpers";
import { FORM_BLOCK, FORM_NOTE, RESPONSES, type Fixture } from "./forms.helpers";

export { FORM_BLOCK, FORM_NOTE, RESPONSES, type Fixture, rewriteForm, submit } from "./forms.helpers";

/** A shared workspace with an owner, an editor, a member, a second member and an outsider, keyed, with the form note written through the app. */
export async function fixture(options: MemoryS3Options & { conditionalWrite?: boolean } = {}): Promise<Fixture> {
  const { conditionalWrite = true, ...bucketOptions } = options;
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const editor = await createUser(t, "editor@example.invalid");
  const member = await createUser(t, "member@example.invalid");
  const other = await createUser(t, "other@example.invalid");
  const stranger = await createUser(t, "stranger@example.invalid");

  // Each person's own workspace, which is where their username lives.
  await createWorkspace(t, owner, "ada");
  await createWorkspace(t, editor, "grace");
  await createWorkspace(t, member, "alan");
  await createWorkspace(t, other, "linus");
  await createWorkspace(t, stranger, "edsger");

  const workspaceId = await createWorkspace(t, owner, "atlas", { kind: "shared" });
  await addMember(t, workspaceId, editor, "editor", owner);
  await addMember(t, workspaceId, member, "member", owner);
  await addMember(t, workspaceId, other, "member", owner);

  const backend = memoryS3(FAKE_STORAGE.bucket, bucketOptions);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  backend.seed("1-projects/README.md", "# Projects\n");
  vi.stubGlobal("fetch", backend.fetchImpl);

  const encryptedSecretAccessKey = await encryptSecret(FAKE_STORAGE.secretAccessKey, requireKeyset(), { workspaceId });
  await t.run((ctx) =>
    ctx.db.insert("storageBindings", {
      workspaceId,
      provider: FAKE_STORAGE.provider,
      endpoint: FAKE_STORAGE.endpoint,
      region: FAKE_STORAGE.region,
      bucket: FAKE_STORAGE.bucket,
      accessKeyId: FAKE_STORAGE.accessKeyId,
      encryptedSecretAccessKey,
      capabilities: { conditionalWrite },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  // Key the seeded notes first; every write below is then the app's own, into a keyed workspace.
  await copyTree(t, workspaceId);
  // `1-projects` is team-visible: `canSee` decides whether a member can open the form's note at all.
  await asUser(t, owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId,
    path: "1-projects",
    visibility: "team",
  });
  // The editor's save is what creates the empty response file.
  await asUser(t, editor).action(api.functions.files.writeNote, {
    workspaceId,
    path: FORM_NOTE,
    text: FORM_BLOCK,
  });
  return { t, owner, editor, member, other, stranger, workspaceId, backend };
}

/** The `nodes` row that is live at `path`, or `undefined`. */
async function liveRowAt(f: Fixture, path: string) {
  const rows = await f.t.run(async (ctx) =>
    await ctx.db
      .query("nodes")
      .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.workspaceId).eq("path", path))
      .collect(),
  );
  return rows.find((row) => row.goneAt === undefined);
}

/** The bucket key a note's bytes sit at, read from its row. */
export async function keyOf(f: Fixture, path: string): Promise<string | undefined> {
  return (await liveRowAt(f, path))?.storageKey;
}

/** The text of the note at `path`, read through its row's key; `undefined` when no live row names it. */
export async function bodyOf(f: Fixture, path: string): Promise<string | undefined> {
  const key = await keyOf(f, path);
  return key === undefined ? undefined : f.backend.snapshot()[key];
}
