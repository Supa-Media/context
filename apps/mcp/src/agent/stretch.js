/**
 * WHAT A TEXT CARRIES OF THE TEXTS JUST BEFORE IT (owner-approved, Dev2,
 * 2026-11-10, 80/20 step 4): the tool calls and results of the chat's current
 * stretch, so a follow-up reuses what Tex already looked up instead of
 * looking it up again.
 *
 * A stretch is the run of the chat's activity with no gap over an hour, the
 * life of the one-hour prompt cache (`aiGateway.js` `HOUR_MARK`). Inside it,
 * each earlier turn is replayed as messages: their words, Tex's calls
 * (`tool_use`), what came back (`tool_result`), then Tex's reply, so every
 * carried turn ends on its own reply and the new text stays a turn of its own
 * with its preamble. After an hour quiet the stretch is over and the chat is
 * words only, as before. Thinking is not carried (a later step).
 *
 * Built only from what the ledger already keeps (`ledger.js` `toolEntry`):
 * the call's id is made from the entry's own id, so the same call has the same
 * bytes in every later text of the stretch and the cache keeps reading them.
 * Every cut and stub below is fixed per entry and never revised, for the same
 * reason; the size of the whole is trimmed server-side by context editing
 * (`aiGateway.js` `CONTEXT_EDITS`).
 *
 * Stubbed, never replayed (`docs/decisions/texting-assistant/turn-trust.md`):
 * - a result read from another workspace (the ledger never kept it);
 * - every result of a turn that read from outside (its reply not `clean`):
 *   outside words never reach a later turn, so a later turn is not untrusted
 *   by what an earlier one read;
 * - in a group, every result of a turn asked by anyone but who asks now: one
 *   member's mail or notes never reach a turn for someone else. Except a read
 *   of the chat's own home (Dev2, 2026-11-10; `sharedHomeRead`), which every
 *   member opens alike;
 * - every result read under a grant other than this turn's (a grant changed,
 *   narrowed or revoked mid-stretch), or under none recorded. A group grant is
 *   one per person per chat (`textGroups.ts`), so a home read only needs a
 *   grant recorded on both sides: the home is the same folder under each.
 * A stubbed call keeps its name and loses its arguments too: a query, an
 * address or a recipient is as private as what came back.
 */

import { conversationFromLedger } from "./ledgerConversation.js";
import { PINNED_CONTEXT_NAME } from "../orient/globalNote.js";

export const STRETCH_GAP_MS = 3_600_000;
/** A carried result longer than this is cut, the same way in every text of the stretch. */
export const MAX_CARRIED_RESULT_CHARS = 8_000;
/** At most this many tool entries are read for one stretch. */
export const MAX_CARRIED_CALLS = 60;

const ACTIVITY = new Set(["text", "reply", "note"]);
export const STUB_OUTSIDE = "(Not carried: this turn read from outside their notes. Call it again if you need it.)";
export const STUB_OTHER = "(Not carried: asked by someone else in the chat. Call it again if you need it.)";
export const STUB_WITHHELD = "(Not carried: read from another workspace.)";
export const STUB_GRANT = "(Not carried: read under another grant. Call it again if you need it.)";

/** When the stretch holding the chat's newest activity began, or null with no activity. */
export function stretchSince(entries) {
  const ats = (Array.isArray(entries) ? entries : []).filter((entry) => ACTIVITY.has(entry?.kind) && Number.isSafeInteger(entry.at)).map((entry) => entry.at).sort((a, b) => b - a);
  if (ats.length === 0) return null;
  let since = ats[0];
  for (const at of ats.slice(1)) {
    if (since - at > STRETCH_GAP_MS) break;
    since = at;
  }
  return since;
}


/** Note reads whose target is a path (`read_note`) or a folder (`list_notes`, `search_notes` `prefix`). */
const HOME_READS = new Set(["read_note", "list_notes", "search_notes"]);

/**
 * Whether a tool entry read the chat's own home (`chatHome.js`), from what the ledger kept of the call that ran
 * (never the model's words in `as`): a note read, in the pin or the turn's own workspace, whose path or folder is
 * the home or beneath it, with no mail asked for. `home` is the grant's own folder (`session.setupReach.chatHome`).
 * Anything else, or no home, is not shared.
 */
export function sharedHomeRead(entry, home) {
  if (typeof home !== "string" || home === "" || entry.withheld !== undefined || !HOME_READS.has(entry.name)) return false;
  const args = entry.args && typeof entry.args === "object" ? entry.args : {};
  if (args.mail !== undefined && args.mail !== false) return false;
  if (args.context !== undefined && String(args.context).trim().replace(/^@*/, "@").toLowerCase() !== PINNED_CONTEXT_NAME) return false;
  const target = entry.name === "read_note" ? args.path : args.prefix;
  if (typeof target !== "string") return false;
  const path = target.trim().replace(/^\/+|\/+$/g, "");
  return !path.split("/").includes("..") && (path === home || path.startsWith(`${home}/`));
}

/** A tool entry as a replayed call: `{id, name, args, result, isError}`. */
function callOf(entry, stub, grant, shared = false) {
  const as = entry.as && typeof entry.as.name === "string" ? entry.as : null; // the name the model wrote (`turn.js`)
  const granted = typeof grant === "string" && typeof entry.grant === "string" && (shared ? entry.grant !== "" : entry.grant === grant);
  const stubbed = stub ?? (entry.withheld !== undefined ? STUB_WITHHELD : !granted ? STUB_GRANT : null);
  const result = stubbed ?? (typeof entry.result === "string" ? entry.result : "(no result)");
  const text = result.length > MAX_CARRIED_RESULT_CHARS ? `${result.slice(0, MAX_CARRIED_RESULT_CHARS)}… [cut, ${result.length} characters]` : result;
  return { id: `toolu_${String(entry.id).replace(/[^A-Za-z0-9_-]/g, "")}`, name: as?.name ?? entry.name, args: stubbed !== null ? {} : (as ?? entry).args ?? {}, result: text, isError: entry.ok !== true && entry.held !== true };
}

/**
 * The stretch's earlier turns as history, oldest first: user turns with their
 * words and time, assistant turns with `calls` beside their reply. `entries`
 * are the chat's slim ledger entries, `tools` its full `tool` entries since
 * `since`, `covered` the event ids this turn answers (left out: they are the
 * question). `asker` is who asks now in a group (null in a one-to-one chat),
 * `grant` the grant id this turn runs under, `home` a group's home folder.
 */
export function stretchTurns(entries, tools, { since, covered = new Set(), group = false, asker = null, grant = null, home = null, question = undefined } = {}) {
  if (!Number.isSafeInteger(since)) return [];
  const inStretch = entries.filter((entry) => Number.isSafeInteger(entry?.at) && entry.at >= since && !(typeof entry.eid === "string" && covered.has(entry.eid)));
  const turns = conversationFromLedger(inStretch, { marked: true, ...(question ? { question } : {}) });
  const byTurn = new Map();
  for (const entry of [...(Array.isArray(tools) ? tools : [])].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) {
    if (entry?.kind !== "tool" || typeof entry.turn !== "string" || typeof entry.name !== "string") continue;
    byTurn.set(entry.turn, [...(byTurn.get(entry.turn) ?? []), entry]);
  }
  return turns.map((turn) => {
    const used = turn.role === "assistant" && turn.text.trim() !== "" ? byTurn.get(turn.turn) : undefined;
    const { turn: _id, askers: asked, ...kept } = turn;
    if (!used) return kept;
    const other = group && (asker === null || asked?.length !== 1 || asked[0] !== asker);
    return {
      ...kept,
      calls: used.map((entry) => {
        const shared = group && sharedHomeRead(entry, home);
        return callOf(entry, turn.tainted ? STUB_OUTSIDE : other && !shared ? STUB_OTHER : null, grant, shared);
      }),
    };
  });
}
