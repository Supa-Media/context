/**
 * The gate the old-copy cleanup checks before it starts (`noteIdsCleanup.ts`):
 * which refusal a Count or a Delete gets, in plain words. Pure, so the order
 * and the wording are pinned by `__tests__/cleanup/cleanupGate.test.ts`.
 *
 * The owner's rule (`docs/decisions/storage-and-credentials/notes-by-id.md`):
 * "Old keys are deleted seven days after the owner confirms the switch". A
 * Delete also needs a Count that finished within a day and found no live note
 * still read from its old path. Nothing here reads the bucket or a row.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Seven days after the flip to keyed rows before any old key may be deleted. */
export const CLEANUP_WAIT_MS = 7 * DAY_MS;
/** A Count older than this does not allow a Delete: the bucket may have changed since. */
export const COUNT_FRESH_MS = DAY_MS;

export interface CleanupGateInput {
  now: number;
  /** The id copy is paused: nothing new starts. */
  paused: boolean;
  /** `keyedWorkspace`: the switch is at keys and the flip started. */
  keyed: boolean;
  /** When the flip started (the copy row's `keyedAt`). */
  keyedAt: number | undefined;
  cleanup:
    | {
        running?: "count" | "delete";
        countedAt?: number;
        readingPaths: number;
      }
    | undefined;
}

export interface Refusal {
  code: string;
  message: string;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? `${n} ${one}` : `${n} ${many}`);

/** A Count is a dry run: it is refused only while paused or while a run is already going. */
export function countRefusal(input: CleanupGateInput): Refusal | null {
  if (input.paused) return { code: "NOTE_IDS_PAUSED", message: "The id copy is paused. Resume it first." };
  if (input.cleanup?.running !== undefined) {
    return { code: "CLEANUP_RUNNING", message: "A count or a delete is already running for this workspace." };
  }
  return null;
}

/** A Delete is refused in this order: paused, running, not keyed, waiting, not counted, stale count, notes still read by path. */
export function deleteRefusal(input: CleanupGateInput): Refusal | null {
  const running = countRefusal(input);
  if (running !== null) return running;
  if (!input.keyed || input.keyedAt === undefined) {
    return {
      code: "CLEANUP_NOT_KEYED",
      message: "Only a workspace whose notes are keyed can have its old copies deleted.",
    };
  }
  const elapsed = input.now - input.keyedAt;
  if (elapsed < CLEANUP_WAIT_MS) {
    const left = Math.ceil((CLEANUP_WAIT_MS - elapsed) / DAY_MS);
    return { code: "CLEANUP_WAITING", message: `Waits until 7 days after the switch: ${plural(left, "day", "days")} left` };
  }
  const countedAt = input.cleanup?.countedAt;
  if (countedAt === undefined) return { code: "CLEANUP_NOT_COUNTED", message: "Count the old copies first." };
  if (input.now - countedAt > COUNT_FRESH_MS) {
    return { code: "CLEANUP_COUNT_STALE", message: "The count is more than a day old. Count again." };
  }
  const reading = input.cleanup?.readingPaths ?? 0;
  if (reading > 0) {
    const still = reading === 1 ? "is still read from its old path" : "are still read from their old path";
    return {
      code: "CLEANUP_READING_PATHS",
      message: `${plural(reading, "note", "notes")} ${still}. Nothing is deleted while any are.`,
    };
  }
  return null;
}
