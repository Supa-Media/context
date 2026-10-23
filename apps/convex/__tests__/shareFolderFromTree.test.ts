/**
 * A FOLDER LINK READS ITS NAMES AND ITS SEALED STATE FROM THE TREE.
 *
 * Decided by the owner, 2026-10-13 and 2026-10-14: which notes exist, their
 * names, and their front matter come from the Convex tree; the bucket is read
 * only to open a note's body. A shared folder's listing is the one-folder
 * `list`, which the barrier answers from the tree (`isTreeRead`) and refuses
 * with `TREE_LOADING` rather than walking the bucket, so a file written
 * straight into the bucket and never copied to the tree is not listed.
 *
 * A note is refused through an unlisted link when it is sealed. The body check
 * (`isEncryptedNote`) reads the bucket object; the tree's `sealed` flag is
 * recorded from the same body when its facts are read. Either one refuses.
 * The tree check is the one that holds when the two disagree, which is the
 * case the second test below builds: a note sealed when the tree last read it,
 * whose bucket body now reads as plaintext.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { memoryS3, type MemoryS3 } from "./storeStub.helpers";
import {
  FAKE_STORAGE,
  asUser,
  captureError,
  copyTree,
  createUser,
  createWorkspace,
  errorCode,
  readIntoTree,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import { renderPrivacyManifest } from "./seededRules.helpers";

afterEach(() => {
  vi.unstubAllGlobals();
});

const SHARED = "1-projects/transition";
const INSIDE = "1-projects/transition/overview.md";
const HELD_BACK = "1-projects/transition/salaries.md";
const HELD_MARKER = "zzq-held-back-marker-3d80-never-shared";
const BUCKET_ONLY = "1-projects/transition/written-outside-app.md";
const BUCKET_ONLY_MARKER = "zzq-bucket-only-marker-61ce-never-listed";
const SEALED = "1-projects/transition/sealed.md";
const SEALED_MARKER = "zzq-sealed-plaintext-marker-b4e7-never-served";

/**
 * An encrypted note, in the shape the gateway stores one. See
 * `shareAnyone.test.ts`, which keeps this shape and the gateway's agreeing.
 */
const ENCRYPTED_NOTE = [
  "---",
  "context_encryption: v1",
  "context_encryption_key: ws:k1",
  "---",
  "",
  "```context-encrypted",
  '{"v":1,"alg":"A256GCM","iv":"AAAAAAAAAAAAAAAA","ct":"AAAA","aad":"context-note-v1:ws","recipients":[{"kind":"workspace","id":"k1","alg":"A256GCM","iv":"AAAAAAAAAAAAAAAA","wrapped":"AAAA"}]}',
  "```",
  "",
].join("\n");

function errorShape(error: unknown): string {
  return JSON.stringify((error as { data?: unknown }).data ?? null);
}

interface Fixture {
  t: TestConvex;
  owner: Id<"users">;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

async function fixture(): Promise<Fixture> {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");

  const backend = memoryS3(FAKE_STORAGE.bucket);
  backend.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  backend.seed("index.md", "# Context\n");
  backend.seed(INSIDE, "# Overview\n\nThe plan.\n");
  backend.seed(HELD_BACK, `# Salaries\n\n${HELD_MARKER}\n`);
  backend.seed(SEALED, ENCRYPTED_NOTE);
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
      capabilities: { conditionalWrite: true },
      status: "connected" as const,
      lastVerifiedAt: Date.now(),
      boundBy: owner,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );

  await copyTree(t, workspaceId);
  await asUser(t, owner).action(api.functions.files.setDirectoryVisibility, {
    workspaceId,
    path: "1-projects",
    visibility: "team",
  });
  await asUser(t, owner).action(api.functions.files.setNoteVisibility, {
    workspaceId,
    path: HELD_BACK,
    visibility: "private",
  });

  return { t, owner, workspaceId, backend };
}

/** Mint an unlisted folder link as the owner. */
async function link(f: Fixture): Promise<string> {
  const made = await asUser(f.t, f.owner).action(api.functions.shares.createLinkShare, {
    workspaceId: f.workspaceId,
    path: SHARED,
    kind: "folder",
  });
  return made.token;
}

/** Read through a link with no session at all. */
async function anon(f: Fixture, token: string, path?: string) {
  return await f.t.action(api.functions.shares.readSharedNote, { token, path });
}

describe("a folder link lists from the tree, not the bucket", () => {
  test("a child the tree has is listed", async () => {
    const f = await fixture();
    const opened = await anon(f, await link(f));
    expect(opened.entries.map((entry) => entry.path)).toContain(INSIDE);
  });

  test("a file present only in the bucket is not listed", async () => {
    const f = await fixture();
    const token = await link(f);

    // Written outside the app: the tree never copies it, and nothing in the
    // share read may go to the bucket to find it.
    f.backend.seed(BUCKET_ONLY, `# Outside\n\n${BUCKET_ONLY_MARKER}\n`);

    const opened = await anon(f, token);
    expect(opened.entries.map((entry) => entry.path)).not.toContain(BUCKET_ONLY);
    expect(errorShape(opened)).not.toContain(BUCKET_ONLY_MARKER);
  });

  test("a note held back by name is absent from the listing and refused by path", async () => {
    const f = await fixture();
    const token = await link(f);

    const opened = await anon(f, token);
    expect(opened.entries.map((entry) => entry.path)).not.toContain(HELD_BACK);

    const refused = await captureError(() => anon(f, token, HELD_BACK));
    expect(errorCode(refused)).toBe("NOT_AUTHENTICATED");
    expect(errorShape(refused)).not.toContain(HELD_MARKER);
  });
});

describe("a folder link refuses a sealed note by the tree's word, not only the body's", () => {
  test("a note the tree holds as sealed is refused even when its bucket body reads as plaintext", async () => {
    const f = await fixture();
    const token = await link(f);

    // The tree reads the note's body as sealed and records it.
    await readIntoTree(f.t, f.workspaceId);

    // The bucket body is now plaintext, so the body check alone would serve it.
    f.backend.seed(SEALED, `# Sealed\n\n${SEALED_MARKER}\n`);

    const refused = await captureError(() => anon(f, token, SEALED));
    expect(errorCode(refused)).toBe("NOT_AUTHENTICATED");
    expect(errorShape(refused)).not.toContain(SEALED_MARKER);
  });

  test("a plaintext note in the same folder still opens, so the refusal above is the seal and not the folder", async () => {
    const f = await fixture();
    const token = await link(f);
    await readIntoTree(f.t, f.workspaceId);

    const note = await anon(f, token, INSIDE);
    expect(note.text).toContain("The plan.");
  });
});
