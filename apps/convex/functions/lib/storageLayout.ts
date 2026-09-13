import { v } from "convex/values";

/**
 * Where the storage-layout migration got to, in the migration's own words.
 *
 * One definition, because three places have to agree about it and they are in
 * three different layers: the `storageBindings` column that remembers it
 * (`schema.ts`), the internal mutation that writes it (`functions/storage.ts`),
 * and the operation result that carries it back from the gateway
 * (`functions/files.ts`). A fourth spelling of the same six words is how a
 * state the console cannot render gets added to one of them.
 *
 * The words are `apps/mcp/src/storageLayout.js`'s and are deliberately not
 * collapsed to a boolean:
 *
 *  - `copying` / `cleaning` — a pass is under way and will schedule the next.
 *  - `copied` — every object is copied and verified, and the legacy copies are
 *    waiting out the seven-day rollback window before anything is deleted.
 *  - `complete` — done. The migration short-circuits on this, so re-running it
 *    is a no-op rather than a second pass.
 *  - `conflict` — a destination changed under the copy. Somebody has to look.
 *  - `unsupported` — the bucket cannot do conflict-safe writes, so this can
 *    never run there. Pressing the button again will not change that, which is
 *    exactly why it is a recorded state and not a transient error.
 *
 * Absent is the sixth answer and the only one that still offers the migration:
 * nobody has run it through us.
 */
export const storageLayoutStateValidator = v.union(
  v.literal("copying"),
  v.literal("copied"),
  v.literal("cleaning"),
  v.literal("conflict"),
  v.literal("unsupported"),
  v.literal("complete"),
);

/** The states that mean this bucket has nothing left to ask its owner for. */
export type StorageLayoutState =
  | "copying"
  | "copied"
  | "cleaning"
  | "conflict"
  | "unsupported"
  | "complete";
