/** The acknowledgement used before an irreversible destructive action. */
export const DESTRUCTIVE_ACTION_ACKNOWLEDGEMENT = "I understand";

/**
 * A typed acknowledgement should verify the words, not the user's casing or
 * accidental surrounding whitespace. Keep this shared so client gating and
 * server enforcement cannot disagree.
 */
export function matchesDestructiveActionAcknowledgement(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === DESTRUCTIVE_ACTION_ACKNOWLEDGEMENT.toLowerCase();
}
