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
 *  - `ok`.
 *
 * Mail is no longer copied into the person's notes (owner, 2026-10-21), so
 * there is no sync pass to fall behind and no store to fill: `stale`,
 * `store_full` and `recovering` described those passes and are never
 * answered now. They stay in the wire's union so a gateway that still names
 * them is understood. A grant Google refuses is still found the moment
 * anything asks Google (a live read, a send), which marks the row.
 *
 * Read off the connection row only. Nothing here is mail.
 */

import type { Doc } from "../../../_generated/dataModel";

export type MailboxState = "ok" | "needs_reconnect" | "store_full" | "stale" | "recovering";

/** A check-in tells the person about one mailbox's one state at most once in this long. */
export const TELL_AGAIN_AFTER_MS = 24 * 60 * 60 * 1000;

/** The states a person hears about: only one, and only they can fix it. */
export const TELLABLE: ReadonlySet<MailboxState> = new Set(["needs_reconnect"]);

type Connection = Pick<Doc<"googleConnections">, "products" | "gmail" | "health" | "disconnectedAt">;

/**
 * One live Gmail connection's state, or null for a row that is not one (no
 * Gmail, or disconnected on purpose: the person chose that, nobody is told).
 */
export function mailboxState(row: Connection, _now: number): { state: MailboxState; lastSyncedAt: number | null } | null {
  if (row.disconnectedAt !== undefined || !row.products.includes("gmail") || row.gmail === undefined) return null;
  const lastSyncedAt = row.gmail.lastSyncedAt ?? null;
  return { state: row.health === "reconnect_required" ? "needs_reconnect" : "ok", lastSyncedAt };
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
