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
 * A turn that read from outside (a page, an email, a kept file, a job's
 * report: its reply's `outside`) is replayed like any other, and replaying any
 * of its results marks the new turn untrusted exactly as if it had read that
 * content itself (the owner, 2026-11-10; `docs/decisions/texting-assistant/turn-trust.md`):
 * its sends wait for the person's yes and reflect never writes from it.
 * Only `outside` counts, never `clean`: a group's turn is never `clean` (its
 * chat's own words), and those words are no outsider's (`markChatWords`).
 *
 * Stubbed, never replayed:
 * - a result read from another workspace (the ledger never kept it);
 * - in a group, every result of a turn asked by anyone but who asks now: one
 *   member's mail or notes never reach a turn for someone else;
 * - every result read under a carry key other than this turn's (`carryKey`:
 *   the person, workspace or scopes changed mid-stretch), or under none recorded.
 * A stubbed call keeps its name and loses its arguments too: a query, an
 * address or a recipient is as private as what came back.
 */

import { conversationFromLedger } from "./ledgerConversation.js";
import { TEXTS_CLIENT_ID } from "./texEntryPoint/clients.js";

export const STRETCH_GAP_MS = 3_600_000;
/** A carried result longer than this is cut, the same way in every text of the stretch. */
export const MAX_CARRIED_RESULT_CHARS = 8_000;
/** At most this many tool entries are read for one stretch. */
export const MAX_CARRIED_CALLS = 60;

const ACTIVITY = new Set(["text", "reply", "note"]);
export const STUB_OTHER = "(Not carried: asked by someone else in the chat. Call it again if you need it.)";
export const STUB_WITHHELD = "(Not carried: read from another workspace.)";
export const STUB_GRANT = "(Not carried: read under another grant. Call it again if you need it.)";
const STUBS = new Map([[STUB_OTHER, "stubOther"], [STUB_GRANT, "stubGrant"], [STUB_WITHHELD, "stubWorkspace"]]);

/**
 * What a tool entry is recorded under and replayed only under (`ledger.js` `toolEntry` `grant`). The Texts client's
 * token, and so its grant id, is new every text (`personTexting.js`, fifteen minutes), so it keys on the person, the
 * workspace and the scopes it reads with; every other client, a group's included, keeps its grant id, stable per
 * person per chat.
 */
export function carryKey(session) {
  if (session?.actorClientId !== TEXTS_CLIENT_ID) return typeof session?.grantId === "string" ? session.grantId : null;
  return `${session.actorUserId}:${session.workspaceId}:${[...(session.scopes ?? [])].sort().join(",")}`;
}

/** The per-turn counts of a carried stretch, codes and counts only (`readTheHistory.js` logs them). */
export function carryCounts(turns) {
  const counts = { carried: 0, stubOther: 0, stubGrant: 0, stubWorkspace: 0, outside: false, stretch: turns.length };
  for (const turn of turns) {
    for (const call of turn.calls ?? []) {
      const stub = STUBS.get(call.result);
      if (stub === undefined) {
        counts.carried += 1;
        if (turn.outside === true) counts.outside = true;
      } else counts[stub] += 1;
    }
  }
  return counts;
}

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


/** A tool entry as a replayed call: `{id, name, args, result, isError}`. */
function callOf(entry, stub, grant) {
  const as = entry.as && typeof entry.as.name === "string" ? entry.as : null; // the name the model wrote (`turn.js`)
  const stubbed = stub ?? (entry.withheld !== undefined ? STUB_WITHHELD : typeof grant !== "string" || entry.grant !== grant ? STUB_GRANT : null);
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
 * `grant` the carry key this turn runs under (`carryKey`). A
 * turn keeps `outside` when its reply's turn read from outside.
 */
export function stretchTurns(entries, tools, { since, covered = new Set(), group = false, asker = null, grant = null, question = undefined } = {}) {
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
    const stub = other ? STUB_OTHER : null;
    return { ...kept, calls: used.map((entry) => callOf(entry, stub, grant)) };
  });
}
