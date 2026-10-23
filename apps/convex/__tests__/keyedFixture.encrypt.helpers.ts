/**
 * The managed-encryption fixture with its notes keyed: the same staff, owner
 * and managed bucket as `managedEncryption.helpers.ts`, but the seeded notes
 * are copied into the tree and keyed (`copyTree`) before a test runs, so every
 * note is read and written at `notes/<noteId>.md` and named by its row.
 *
 * The plain fixture stays for suites that never read a note by path; a
 * workspace that is not keyed refuses every path read (`NotKeyed`).
 */

import { copyTree } from "./fixtures.helpers";
import { keyAtPath, type NoteBucket } from "./files/keyedNotes.helpers";
import { fixture } from "./managedEncryption.helpers";
import type { MemoryS3Options } from "./storeStub.helpers";

/**
 * Keyed, with the seeded notes and any `extraNotes` (path to text) in the
 * bucket before the copy keys them, so each has a row and a `notes/` key.
 */
export async function keyedFixture(options: MemoryS3Options = {}, extraNotes: Record<string, string> = {}) {
  const f = await fixture(options);
  for (const [path, text] of Object.entries(extraNotes)) f.backend.seed(path, text);
  await copyTree(f.t, f.ours);
  return f;
}

/** The key a note's bytes sit at, read through its row: `notes/<noteId>.md`. */
export async function keyOf(bucket: NoteBucket, path: string): Promise<string> {
  const key = await keyAtPath(bucket, path);
  if (key === null) throw new Error(`no keyed note at ${path}`);
  return key;
}

/**
 * A managed workspace born keyed with an empty bucket: the state a freshly
 * provisioned workspace starts in, before its layout is written.
 */
export async function emptyKeyedFixture(options: MemoryS3Options = {}) {
  const f = await fixture(options);
  f.backend.objects.clear();
  await copyTree(f.t, f.ours);
  return f;
}
