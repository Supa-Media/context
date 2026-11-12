/**
 * Who is in a group, kept by the group's own object (`docs/decisions/texting-assistant/group-members.md`).
 *
 * Every group turn reads the app's member list as it starts (`groupInbox.ts`), and an answer goes out only to the
 * people it was written for (`groupModelTurn.ts`). Until 2026-11-12 the check before sending read the list from the
 * app again, every time, and an answer whose second read failed was held as if somebody had joined: the Crystal
 * Care WhatsApp group lost a finished answer to two failed Whapi reads on 2026-11-11.
 *
 * For an app that tells Tex when a group's people change (WhatsApp, through Whapi's `groups` webhook events), the
 * list the turn read is kept here with when it was read, and any change the app reports marks it changed. Before
 * sending, a kept list read recently and unchanged since is the answer; one that is stale or changed is read from
 * the app again, and an unread list still holds the answer, as before. An app with no such events (iMessage on
 * Sendblue) reads the app every time, as it always did.
 */

import type { InboxStorage } from "./inbox";
import type { GroupLine, GroupPlace } from "./groupLine";

const KEPT_KEY = "gmembers";

/**
 * How long a kept list stands without being read from the app again. A turn reads the app as it starts, so this
 * only bounds a long turn or a missed change event; past it the app is asked, as before (Dev2, 2026-11-12).
 */
export const KEPT_FRESH_MS = 10 * 60_000;

type Kept = { list: string[]; at: number; changedAt?: number };

/** The app's list, read now (once more on a failure) and, for an app that reports changes, kept with when it was read. */
export async function readMembersNow(storage: InboxStorage, app: GroupLine, place: GroupPlace, now: () => number, tries = 1): Promise<string[] | null> {
  const started = now();
  let list: string[] | null = null;
  for (let attempt = 0; attempt < tries && list === null; attempt++) list = await app.readMembers(place);
  if (list !== null && app.membershipEvents) {
    const kept = await storage.get<Kept>(KEPT_KEY);
    // A change reported while this read was out is not covered by it: it stays marked.
    const changedAt = kept?.changedAt !== undefined && kept.changedAt >= started ? kept.changedAt : undefined;
    await storage.put<Kept>(KEPT_KEY, { list, at: started, ...(changedAt !== undefined ? { changedAt } : {}) });
  }
  return list;
}

/**
 * Who is in the group before an answer goes out: the kept list when the app reports changes, it was read within
 * `KEPT_FRESH_MS` and nothing changed since; otherwise the app's list, read twice before giving up. Null holds the
 * answer: nobody can say who would see it.
 */
export async function membersBeforeSend(storage: InboxStorage, app: GroupLine, place: GroupPlace, now: () => number): Promise<string[] | null> {
  if (app.membershipEvents) {
    const kept = await storage.get<Kept>(KEPT_KEY);
    const fresh = kept !== undefined && now() - kept.at <= KEPT_FRESH_MS;
    const changed = kept?.changedAt !== undefined && kept.changedAt >= kept.at;
    if (fresh && !changed) {
      log("kept");
      return kept.list;
    }
    log(kept === undefined ? "none_kept" : changed ? "changed" : "stale");
  }
  return await readMembersNow(storage, app, place, now, 2);
}

/** The app said this group's people changed: the kept list is read from the app again before the next answer goes out. */
export async function membersChanged(storage: InboxStorage, at: number): Promise<boolean> {
  const kept = await storage.get<Kept>(KEPT_KEY);
  if (kept === undefined) return false; // nothing kept, nothing to mark: the next turn reads the app anyway
  await storage.put<Kept>(KEPT_KEY, { ...kept, changedAt: at });
  return true;
}

function log(outcome: "kept" | "none_kept" | "changed" | "stale"): void {
  console.log(JSON.stringify({ event: "group_members_before_send", outcome }));
}
