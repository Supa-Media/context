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

/**
 * Which generation of the question produced a recorded answer.
 *
 * `storageLayoutCheckedAt` records that the bucket was **asked**, and the
 * guard on `observeStorageLayout` spends itself the moment it is set — one
 * probe per binding, for ever. That is the right shape for a question whose
 * answer cannot change, and the wrong one for a question we got wrong.
 *
 * Probe 1 asked only "is there a migration state file?", so a bucket we
 * scaffolded ourselves — born on the v1 layout, never the owner of a single
 * pre-v1 object — answered "never run", and every newly created workspace was
 * offered a one-time update with nothing behind it. Probe 2 asks whether there
 * is any pre-v1 plumbing here at all (`apps/mcp/src/storageLayout.js`) and
 * answers `complete` when there is none.
 *
 * Fixing the probe does not fix the rows it already wrote, and those rows are
 * exactly the newly created workspaces the bug was about. So the generation is
 * recorded beside the answer and a stale one is asked once more, on the next
 * console that opens — self-healing, rather than a backfill somebody has to
 * remember to run against every deployment including the self-hosted ones.
 *
 * Bump it when the probe's *question* changes, never when its plumbing does.
 */
export const STORAGE_LAYOUT_PROBE_VERSION = 2;

/**
 * Whether this binding's answer is one the current probe would stand behind.
 *
 * A recorded `state` is the bucket's own word and does not go stale: every
 * generation of the probe reads the state file the same way, and a migration
 * pass writes what it did. It is only the *absence* of a state that a probe
 * generation can be wrong about, so only that is re-asked.
 *
 * Read by the console — as `layoutChecked`, the condition the notice needs
 * before it offers anything — and by `observeStorageLayout`, which refuses a
 * question it has already answered. One predicate, because a console that
 * believed the question was open while the mutation refused to ask it would
 * put the notice back, silently, on exactly the buckets this fixes.
 */
export function storageLayoutAnswerIsCurrent(binding: {
  storageLayoutState?: StorageLayoutState;
  storageLayoutCheckedAt?: number;
  storageLayoutCheckedVersion?: number;
}): boolean {
  if (binding.storageLayoutCheckedAt === undefined) return false;
  if (binding.storageLayoutState !== undefined) return true;
  return binding.storageLayoutCheckedVersion === STORAGE_LAYOUT_PROBE_VERSION;
}
