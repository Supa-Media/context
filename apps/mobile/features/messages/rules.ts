/**
 * Which in-app message is on screen, and whether one has been answered.
 *
 * Every message the app shows unasked is named in `IN_APP_MESSAGES`
 * (`packages/shared`), and this is the one place that decides between them,
 * so nobody is shown a pile (Dev2, 2026-09-29). Pure, so every rule is a test.
 *
 * ## The rules
 *
 * 1. **One at a time.** Whatever the kind or the corner of the screen.
 * 2. **What is up stays up** until it is answered or no longer applies: a
 *    message is never swapped for another under somebody's cursor.
 * 3. **Most important first** (`priority`), and a message whose answer is
 *    still being looked up holds back everything below it, so a less
 *    important one never flashes up ahead of it.
 * 4. **Tips wait for a quiet visit.** Onboarding messages may follow one
 *    another, because they are the steps of getting started. A tip is shown
 *    only in a visit where nothing else has been, and then only one. A visit
 *    is one load of the app: a page load on the web, a launch on a phone.
 */

import {
  IN_APP_MESSAGES,
  messageAnswered,
  type InAppMessageId,
} from "@context/shared";

/** `undefined` while the answer is still being looked up. */
export type Seen = boolean | undefined;

export interface MessageCandidate {
  /** One message in one place: its id, plus the workspace and variant if any. */
  key: string;
  id: InAppMessageId;
  seen: Seen;
}

export interface MessageVisit {
  /** The key on screen now, if any. */
  current: string | null;
  /** Every message shown so far in this visit, in order. */
  shown: readonly InAppMessageId[];
}

export const FRESH_VISIT: MessageVisit = { current: null, shown: [] };

export function messageKey(id: InAppMessageId, workspaceId?: string | null, variant?: string | null): string {
  return [id, workspaceId ?? "", variant ?? ""].join("|");
}

/** The key to put on screen, or `null` for none. */
export function pickMessage(
  candidates: readonly MessageCandidate[],
  visit: MessageVisit,
): string | null {
  const current = candidates.find((candidate) => candidate.key === visit.current);
  if (current !== undefined && current.seen === false) return current.key;

  const ordered = [...candidates].sort(
    (a, b) => IN_APP_MESSAGES[b.id].priority - IN_APP_MESSAGES[a.id].priority,
  );
  for (const candidate of ordered) {
    if (candidate.seen === undefined) return null;
    if (candidate.seen) continue;
    if (IN_APP_MESSAGES[candidate.id].kind === "tip" && visit.shown.length > 0) continue;
    return candidate.key;
  }
  return null;
}

/** The visit after `picked` has been on screen. */
export function nextVisit(visit: MessageVisit, picked: MessageCandidate | null): MessageVisit {
  if (picked === null) return visit.current === null ? visit : { ...visit, current: null };
  if (visit.current === picked.key) return visit;
  return {
    current: picked.key,
    shown: visit.shown.includes(picked.id) ? visit.shown : [...visit.shown, picked.id],
  };
}

export interface MessageRead {
  message: string;
  workspaceId: string | null;
  variant: string | null;
  seenAt: number;
}

/**
 * What the account says about one message: answered or not, `undefined`
 * while its answers are loading, `unavailable` when the backend cannot say
 * (a deploy behind, or down).
 */
export type AccountAnswer = boolean | undefined | "unavailable";

export function accountAnswer(
  reads: readonly MessageRead[] | undefined | "unavailable",
  id: InAppMessageId,
  workspaceId: string | null,
  variant: string | null,
  now: number,
): AccountAnswer {
  if (reads === undefined || reads === "unavailable") return reads;
  return reads.some(
    (read) =>
      read.message === id &&
      read.workspaceId === workspaceId &&
      read.variant === variant &&
      messageAnswered(id, read.seenAt, now),
  );
}

/**
 * Seen or not, from the account and this device's copy. The account decides;
 * the device's copy counts too, so an answer the account missed (a failed
 * save, or one given before the account kept it) still holds here and is
 * `carry`-ed up so every other device stops asking. With no account answer to
 * be had, the device decides alone, as it did before.
 */
export function seenFrom({
  account,
  device,
}: {
  account: AccountAnswer;
  device: boolean | undefined;
}): { seen: Seen; carry: boolean } {
  if (account === true) return { seen: true, carry: false };
  if (device === true) return { seen: true, carry: account === false };
  if (account === undefined || device === undefined) return { seen: undefined, carry: false };
  return { seen: false, carry: false };
}

/** The answers the server sent, or what their absence means. */
export function readsFrom(answer: unknown): readonly MessageRead[] | undefined | "unavailable" {
  if (answer === undefined) return undefined;
  if (Array.isArray(answer)) return answer as MessageRead[];
  // Signed out (`null`) or an error: nothing on the account to go by.
  return "unavailable";
}
