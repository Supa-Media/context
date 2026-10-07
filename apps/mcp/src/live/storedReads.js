/**
 * `GET /agent-activity?reads_since=<ms>&reads_until=<ms>` — the reads a replay
 * draws: what AI clients read in that stretch, as `live/readLog.js` stored it,
 * filtered for this caller.
 *
 * The console's own client only, as the heartbeat parameters are: a replay is
 * a page somebody opens, and a tool has `list_changes` for the same trail.
 * Any other caller is answered with no reads rather than a refusal.
 *
 * What a caller gets is decided twice, both times against them:
 *
 *  - **when it was read**: below owner, only reads of a note that was `team`
 *    at that moment (`team_visible`). A note read while private never shows
 *    its read to the team, even after it is shared;
 *  - **now**: the path is forwarded to where the note is today, through the
 *    ledger `read_activity` follows, and must pass `canSee` against the live
 *    `privacy.md` (groups as private, as everywhere in this feed).
 *
 * A read either test refuses is absent, never counted.
 */

import { canSee, isPlumbing } from "../privacy/engine.js";
import { forwardPath, readForwarding } from "../forwarding.js";
import { isConsoleActor } from "./presence.js";
import { readsBetween, storageBudget } from "./readLog.js";
import { searchBudgetFor } from "../search/budget.js";

/** Whether this ask is for stored reads at all. */
export function asksForStoredReads(params) {
  return params.has("reads_since");
}

/**
 * The per-caller filter over stored reads, for this route and for
 * `list_changes`: the event-time flag below owner, then the note's path today
 * (through the forwarding ledger) against the live manifest. Answers the path
 * to show, or `null`.
 */
export async function readFilterFor(store, scope, rules, overrides) {
  let forwarding = null;
  try {
    forwarding = await readForwarding(store);
  } catch {
    forwarding = null;
  }
  const owner = scope === "private";
  return (record) => {
    if (!owner && record.teamVisible !== true) return null;
    const path = forwarding ? forwardPath(forwarding, record.path) : record.path;
    if (typeof path !== "string" || !path || isPlumbing(path)) return null;
    return canSee(path, scope, rules, overrides) ? path : null;
  };
}

export async function storedReadsAnswer(session, store, privacy, params, env, now = Date.now()) {
  const empty = { reads: [], readsTruncated: false };
  if (!isConsoleActor({ clientId: session.actorClientId })) return empty;
  if (privacy.error) return empty;
  const from = Number(params.get("reads_since"));
  const toParam = params.has("reads_until") ? Number(params.get("reads_until")) : now;
  const to = Number.isFinite(toParam) ? Math.min(toParam, now) : now;
  if (!Number.isFinite(from) || from < 0 || from > to) return empty;

  const visible = await readFilterFor(store, session.scope, privacy.rules, privacy.overrides);
  const { reads, truncated } = await readsBetween(store, {
    from,
    to,
    budget: storageBudget(searchBudgetFor(env)),
    visible,
  });
  return {
    reads: reads.map((read) => ({ at: read.at, path: read.path, tool: read.tool, by: read.by, via: read.via })),
    readsTruncated: truncated,
  };
}
