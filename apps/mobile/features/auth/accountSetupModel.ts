/**
 * The rules of "Make your account" (domain sign-up, 2026-10-16), kept out of
 * the screen so they can be read and tested without rendering it.
 *
 * The server decides what is true (`functions/accountSetup.ts`): who needs
 * setup, what the name must be, and that finishing is idempotent. This file
 * only says when the screen may offer Continue and what a failure looks like.
 */

/** Matches `MAX_DISPLAY_NAME_LENGTH` on the server (`functions/lib/workspaces/constants.ts`). */
export const NAME_MAX = 80;

const FALLBACK_FAILURE = "That didn't work. Try again.";

/** Continue is offered only when every answer the setup needs is in. */
export function canFinishSetup({
  name,
  phoneDone,
  emailDone,
  busy,
}: {
  name: string;
  phoneDone: boolean;
  emailDone: boolean;
  busy: boolean;
}): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > NAME_MAX) return false;
  return phoneDone && emailDone && !busy;
}

/**
 * A phone the account already confirmed, so the field is not asked for again.
 * `myPhoneCheck` answers `confirmed` for the account's own phone.
 */
export function phoneAlreadyDone(check: { confirmed: boolean; phone?: string } | undefined): boolean {
  return check?.confirmed === true;
}

/** What `mySetup` answers (`functions/accountSetup.ts`); `null` when signed out. */
export interface SetupAnswer {
  needsSetup: boolean;
  email: string | null;
  suggestedName: string;
}

/** Whether the layout draws this screen. An unanswered question is not a reason to. */
export function setupNeeded(
  answer: { needsSetup: boolean; email?: string | null; suggestedName?: string } | null | undefined,
): boolean {
  return answer?.needsSetup === true;
}

/** The name the field starts with: the server's suggestion, trimmed and kept within the limit. */
export function initialName(suggested: string): string {
  return suggested.trim().slice(0, NAME_MAX);
}

/**
 * What to say when finishing fails. A Convex error carries the server's own
 * sentence in `data.message`; anything else gets the plain fallback.
 */
export function finishFailure(failure: unknown): string {
  const message = (failure as { data?: { message?: unknown } } | undefined)?.data?.message;
  return typeof message === "string" && message.length > 0 ? message : FALLBACK_FAILURE;
}
