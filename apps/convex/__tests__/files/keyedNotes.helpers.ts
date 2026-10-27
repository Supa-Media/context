/**
 * Reading notes in a keyed workspace: a note's bytes live at its row's
 * `storageKey` (`notes/<noteId>.md`), and its name lives on the `nodes` row.
 * Tests that assert on what the bucket holds find the key through the row,
 * never by spelling a path into the bucket.
 *
 * Used only by the files/ and keyed-workspace suites that share this file's
 * conversions; fixtures.helpers.ts stays the shared setup.
 */

import type { Id } from "../../_generated/dataModel";
import type { TestConvex } from "../fixtures.helpers";
import type { MemoryS3 } from "../storeStub.helpers";
import { nodeAt } from "../../functions/lib/nodes/paths";

export interface NoteBucket {
  t: TestConvex;
  workspaceId: Id<"workspaces">;
  backend: MemoryS3;
}

/** The live `nodes` row a path names, or `null`. */
export async function rowAtPath(bucket: NoteBucket, path: string) {
  // Where the tree says the note is (`paths.ts`), as the product reads it.
  return await bucket.t.run(
    async (ctx) => await nodeAt(ctx.db, bucket.workspaceId, path),
  );
}

/** The key a note's bytes sit at: its row's `storageKey`, or `null` when no row names the path. */
export async function keyAtPath(bucket: NoteBucket, path: string): Promise<string | null> {
  return (await rowAtPath(bucket, path))?.storageKey ?? null;
}

/** The text of the note a path names, read from its key; `null` if there is no such note in the bucket. */
export async function bodyAtPath(bucket: NoteBucket, path: string): Promise<string | null> {
  const key = await keyAtPath(bucket, path);
  if (key === null) return null;
  return bucket.backend.snapshot()[key] ?? null;
}

/** The etag the bucket holds for the note a path names, or `null`. */
export async function etagAtPath(bucket: NoteBucket, path: string): Promise<string | null> {
  const key = await keyAtPath(bucket, path);
  if (key === null) return null;
  return bucket.backend.objects.get(key)?.etag ?? null;
}

/** Every note body in the bucket, keyed by its `notes/` key: for "nothing changed" checks. */
export function noteBodies(backend: MemoryS3): Record<string, string> {
  return Object.fromEntries(
    Object.entries(backend.snapshot()).filter(([key]) => key.startsWith("notes/")),
  );
}

/** The raw bytes of the note a path names, read from its key; `null` if there is no such note in the bucket. */
export async function bytesAtPath(bucket: NoteBucket, path: string): Promise<Uint8Array | null> {
  const key = await keyAtPath(bucket, path);
  if (key === null) return null;
  return bucket.backend.bytesOf(key);
}
