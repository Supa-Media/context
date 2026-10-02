/**
 * Every message the app shows somebody without being asked: one list, read by
 * the app (which decides what is on screen) and by the control plane (which
 * remembers who has answered what).
 *
 * The rule this list exists for (Dev2, 2026-09-29): a person answers a message
 * once, on their account, and the app never piles messages on them. So a
 * message that is not named here cannot be remembered by the server, and the
 * app's one arbiter (`apps/mobile/features/messages/`) shows at most one of
 * them at a time.
 *
 * - `kind`: `onboarding` messages may follow one another in a visit, because
 *   they are the steps of getting started. A `tip` is shown only in a visit
 *   where nothing else has been, and then only one.
 * - `priority`: higher goes first when several are waiting.
 * - `scope`: what an answer covers. `account` is everywhere; `workspace` is one
 *   workspace, so an owner of two answers for each.
 * - `store`: where the answer is kept. `messageReads` is the shared table;
 *   `own` is a message whose answer already lives on the row it is about
 *   (the setup checklist on the membership, auto-organize's notice on its
 *   settings) and so is only arbitrated here, never written through it.
 * - `askAgainAfterMs`: a message that may come back, at most this often.
 *   Absent means answered for good.
 * - `variants`: whether an answer is kept per variant (see
 *   `MESSAGE_VARIANT_PATTERN`). Only a message that says so takes one.
 *
 * Names are stable identifiers stored on the control plane: never rename one,
 * retire it.
 */

export type InAppMessageKind = "onboarding" | "tip";
export type InAppMessageScope = "account" | "workspace";

export interface InAppMessageSpec {
  kind: InAppMessageKind;
  priority: number;
  scope: InAppMessageScope;
  store: "messageReads" | "own";
  askAgainAfterMs?: number;
  variants?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const IN_APP_MESSAGES = {
  /** `/welcome`, the first-run steps: nothing else while somebody is in them. */
  "first-run": { kind: "onboarding", priority: 100, scope: "account", store: "own" },
  /** `/welcome?resume=storage`: the storage step, picked back up at sign-in. */
  "resume-storage": {
    kind: "onboarding",
    priority: 90,
    scope: "account",
    store: "messageReads",
    askAgainAfterMs: 7 * DAY_MS,
  },
  /** "Context is in early beta". */
  "beta-notice": { kind: "onboarding", priority: 80, scope: "account", store: "messageReads" },
  /** The console's setup checklist and its "You're set up." card. */
  "setup-checklist": { kind: "onboarding", priority: 70, scope: "workspace", store: "own" },
  /** What a shared workspace is to somebody who does not own it. */
  "context-intro": {
    kind: "onboarding",
    priority: 60,
    scope: "workspace",
    store: "messageReads",
    variants: true,
  },
  /** Auto-organize's one-time notice for people already on Premium. */
  "organizer-notice": { kind: "tip", priority: 30, scope: "workspace", store: "own" },
  /**
   * Dropbox support is ending: an owner of a Dropbox workspace is asked to
   * move it to a bucket of theirs or to Context storage. It comes back two
   * weeks after it is put away, because the ending does not go away.
   */
  "dropbox-ending": {
    kind: "tip",
    priority: 25,
    scope: "workspace",
    store: "messageReads",
    askAgainAfterMs: 14 * DAY_MS,
  },
  /** The one-time storage layout update. */
  "storage-layout-offer": { kind: "tip", priority: 20, scope: "workspace", store: "messageReads" },
  /** "Track these folders by status?" */
  "track-by-status": { kind: "tip", priority: 10, scope: "workspace", store: "messageReads" },
} as const satisfies Record<string, InAppMessageSpec>;

export type InAppMessageId = keyof typeof IN_APP_MESSAGES;

/** The messages whose answers the control plane keeps in `messageReads`. */
export const STORED_MESSAGE_IDS = (Object.keys(IN_APP_MESSAGES) as InAppMessageId[]).filter(
  (id) => IN_APP_MESSAGES[id].store === "messageReads",
);

export function isInAppMessageId(value: string): value is InAppMessageId {
  return Object.prototype.hasOwnProperty.call(IN_APP_MESSAGES, value);
}

/**
 * A variant narrows an answer within its scope — the context intro differs by
 * role, so a member who becomes an editor is told what that means. Short
 * lowercase words only: a variant is a label, never text from a note.
 */
export const MESSAGE_VARIANT_PATTERN = /^[a-z][a-z+-]{0,39}$/;

/**
 * Whether an answer given at `seenAt` still stands at `now`.
 */
export function messageAnswered(id: InAppMessageId, seenAt: number, now: number): boolean {
  const spec: InAppMessageSpec = IN_APP_MESSAGES[id];
  return spec.askAgainAfterMs === undefined || now - seenAt < spec.askAgainAfterMs;
}
