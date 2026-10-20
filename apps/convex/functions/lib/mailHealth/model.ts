/**
 * Whether a person's mailbox is working, in one word
 * (`docs/decisions/communications/mail-health.md`).
 *
 * The owner, 2026-10-20: "make sure this is true for heartbeats routines etc,
 * they should be bubbling up if a connection has gone bad", and "the user
 * shouldn't have to even deal with this unless they have to give a new
 * permission". So the word says whether the person has to act:
 *
 *  - `needs_reconnect`: Google refused the grant, or a permission is missing.
 *    Only the person can fix it, by connecting again.
 *  - `store_full`: the mailbox reached its storage ceiling, so new mail is not
 *    saved. It will not fix itself.
 *  - `stale`: no pass has read mail for `STALE_AFTER_MS`, whatever the reason.
 *    Worth one mention: something is wrong that retrying has not mended.
 *  - `recovering`: the last pass failed (rate-limited, Google briefly down) and
 *    the loop is retrying. Nobody is told.
 *  - `ok`.
 *
 * Read off the connection row only. Nothing here is mail.
 */

import type { Doc } from "../../../_generated/dataModel";

export type MailboxState = "ok" | "needs_reconnect" | "store_full" | "stale" | "recovering";

/** A mailbox with no pass that read mail for this long is stale. */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** A check-in tells the person about one mailbox's one state at most once in this long. */
export const TELL_AGAIN_AFTER_MS = 24 * 60 * 60 * 1000;

/** The pass's own code for a mailbox that hit its ceiling (`lib/filesFns/forwardSync.ts`). */
export const STORE_FULL_CODE = "MAIL_QUOTA_EXCEEDED";

/** The states a person hears about: the two only they can fix, and a long silence. */
export const TELLABLE: ReadonlySet<MailboxState> = new Set(["needs_reconnect", "store_full", "stale"]);

/** The states that need the person to do something (orient names only these). */
export const NEEDS_PERSON: ReadonlySet<MailboxState> = new Set(["needs_reconnect", "store_full"]);

type Connection = Pick<
  Doc<"googleConnections">,
  "products" | "gmail" | "health" | "errorCode" | "disconnectedAt" | "syncBytesWritten" | "createdAt"
>;

/**
 * One live Gmail connection's state, or null for a row that is not one (no
 * Gmail, or disconnected on purpose: the person chose that, nobody is told).
 * Worst news first: a dead grant outranks a full store, which outranks a
 * long silence.
 */
export function mailboxState(row: Connection, now: number): { state: MailboxState; lastSyncedAt: number | null } | null {
  if (row.disconnectedAt !== undefined || !row.products.includes("gmail") || row.gmail === undefined) return null;
  const gmail = row.gmail;
  const lastSyncedAt = gmail.lastSyncedAt ?? null;
  const at = (state: MailboxState) => ({ state, lastSyncedAt });
  if (row.health === "reconnect_required") return at("needs_reconnect");
  const full =
    gmail.lastFailureCode === STORE_FULL_CODE ||
    row.errorCode === STORE_FULL_CODE ||
    (row.syncBytesWritten ?? 0) >= gmail.quotaBytes;
  if (full) return at("store_full");
  // Never read mail: counted from when it was connected, so a new mailbox is not stale at once.
  if (now - (lastSyncedAt ?? row.createdAt) > STALE_AFTER_MS) return at("stale");
  const failing = row.health === "error" || gmail.lastFailureCode !== undefined || row.errorCode !== undefined;
  return at(failing ? "recovering" : "ok");
}

/** One "already told" marker: this mailbox, this state, at this time. */
export type MailNotice = { connectionId: string; state: string; at: number };

/** Whether `notices` hold a telling of this mailbox's state recent enough to stay quiet. */
export function toldRecently(notices: readonly MailNotice[] | undefined, connectionId: string, state: string, now: number): boolean {
  return (notices ?? []).some(
    (notice) => notice.connectionId === connectionId && notice.state === state && now - notice.at < TELL_AGAIN_AFTER_MS,
  );
}

/** The markers still worth keeping: those within the quiet window. */
export function liveNotices<T extends MailNotice>(notices: readonly T[] | undefined, now: number): T[] {
  return (notices ?? []).filter((notice) => now - notice.at < TELL_AGAIN_AFTER_MS);
}
