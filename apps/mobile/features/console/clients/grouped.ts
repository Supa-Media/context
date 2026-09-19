/**
 * The connected AI apps, one row per app rather than one per grant.
 *
 * Seventeen rows was the state of this list on a real workspace, and eight of
 * them were Claude: every machine, every browser profile and every re-auth
 * mints its own grant, and each one drew a row saying "Claude · @seyi · team
 * access · read & write · last used 17 hours ago" with a Revoke beside it. The
 * *count* is the useful fact at rest — how many ways this app can reach my
 * context — and the individual grants matter only when somebody is cutting one
 * off, which is what opening the group is for.
 *
 * Grouped by the app's own name, which is what a person recognises and what
 * they would revoke: two grants called "Claude" are one app whether they were
 * minted on a laptop or a phone. The machine grant Context mints for a desktop
 * carries the machine's name, so it groups as itself rather than folding into
 * anything else.
 *
 * Pure, so the rules below are checked without a renderer.
 */

import type { ConsoleClient } from "../types";

export interface ClientGroup {
  /** The app's name, as it appears on every grant in the group. */
  name: string;
  /** Every grant this app holds, newest use first. */
  clients: ConsoleClient[];
  /**
   * The contexts this app reaches, as "@seyi and @supa".
   *
   * Named rather than counted: a grant belongs to exactly one context, and a
   * group that spans two is the one case where "revoke Claude" is ambiguous.
   * Saying which contexts up front is what stops the group hiding that.
   */
  contexts: string;
  /** What every row in the group agrees on, or the most recent one's words. */
  detail: string;
  /** `warn` if anything in the group needs attention, else the best of them. */
  status: ConsoleClient["status"];
  /** Whether any grant here belongs to somebody else in a shared workspace. */
  hasOthers: boolean;
}

/** "@seyi", "@seyi and @supa", "@seyi, @supa and @public-worship". */
function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/**
 * The worst tone in the group, because a group is only as healthy as its
 * unhealthiest grant — a list that showed "ok" over a grant that has never
 * been used would hide exactly the row somebody is looking for.
 */
const TONE_ORDER: ConsoleClient["status"][] = ["crit", "warn", "neutral", "ok"];

function worstTone(clients: readonly ConsoleClient[]): ConsoleClient["status"] {
  for (const tone of TONE_ORDER) {
    if (clients.some((client) => client.status === tone)) return tone;
  }
  return "ok";
}

/**
 * One group per app, in the order the apps first appear.
 *
 * Input order is preserved rather than sorted by count: the caller hands these
 * over sorted by last use, so the app somebody touched most recently is the
 * first group, and re-sorting would put a big pile of stale grants above the
 * app they are actually using.
 */
export function groupClients(clients: readonly ConsoleClient[]): ClientGroup[] {
  const groups = new Map<string, ConsoleClient[]>();
  for (const client of clients) {
    const existing = groups.get(client.name);
    if (existing === undefined) groups.set(client.name, [client]);
    else existing.push(client);
  }

  return [...groups.entries()].map(([name, members]) => {
    const contexts: string[] = [];
    for (const member of members) {
      if (!contexts.includes(member.context)) contexts.push(member.context);
    }
    return {
      name,
      clients: members,
      contexts: listWords(contexts),
      /*
        The first member's detail, which is the most recently used one — "last
        used 5 minutes ago" for the app as a whole is true of its newest grant
        and is the fact somebody scanning the list wants. A group of one says
        exactly what the ungrouped row said.
      */
      detail: members[0]?.detail ?? "",
      status: worstTone(members),
      hasOthers: members.some((member) => !member.mine),
    };
  });
}

/** "8 connections", "1 connection" — the count, in the group's own words. */
export function connectionCount(group: ClientGroup): string {
  return group.clients.length === 1 ? "1 connection" : `${group.clients.length} connections`;
}
