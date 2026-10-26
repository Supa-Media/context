/**
 * Whether Tex has texted something else since the ask a bare yes would
 * release, so that yes answers the newer text and not the ask.
 *
 * A routine, a check-in, an agent's ping or a fixed Worker text is Tex
 * speaking first, and a "yes" after it answers it (2026-10-26, @context-lc
 * tex-reviews "stray yes sends pending ask": a "yes" to a routine's reminder
 * sent a bug report held before it, with the person's last 12 texts). Those
 * runs disarm the ask themselves (`route.js`, `heartbeat.js`); this is the
 * second check, at the yes, read from the conversation as the person saw it,
 * so a disarm that missed (a race, a failed delete) still sends nothing.
 *
 * The person's own side texts are not this: an ask survives them (Dev2,
 * 2026-10-22), and only Tex's texts that came by themselves count.
 */

import { TEXTING_TTL_MS } from "../tools/approvals.js";
import { readConversation } from "./conversation.js";
import { folded } from "./folded.js";
import { askLine } from "./textedApprovals.js";

/** The line every text Tex sends by itself is kept under (`conversation.js`, `heartbeat.js`, `attention.js`, `vaultSaved.js`). */
const BY_ITSELF = /^\(Not a text from them\./;
/** Enough of the newest exchanges to reach back past any ask still armed. */
const ENTRIES = 30;

/** When a record was last armed for a texted yes. */
export function armedAt(record) {
  if (Number.isFinite(record.armed_at)) return record.armed_at;
  if (record.kind === "vault_pay") return record.created_at ?? 0;
  return (record.texting_until ?? record.expires_at ?? 0) - TEXTING_TTL_MS;
}

/**
 * True when, after these armed records were last shown, Tex texted something
 * by itself that did not show them again. The turns are oldest first, as
 * `readConversation` returns them; a turn without a time (the old whole-file
 * history) is never counted against an ask.
 */
export function overtaken(turns, armed) {
  if (armed.length === 0) return false;
  const since = Math.min(...armed.map(armedAt));
  const shown = [armed, [...armed].reverse()].map((order) => folded(askLine(order))).filter((line) => line.length > 0);
  let moved = false;
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn.role !== "user" || !Number.isFinite(turn.at) || turn.at <= since) continue;
    const answer = turns[i + 1]?.role === "assistant" ? folded(turns[i + 1].text) : "";
    // The ask shown again, by whatever turn, is the newest thing a yes may answer.
    if (shown.some((line) => answer.includes(line))) moved = false;
    else if (BY_ITSELF.test(turn.text)) moved = true;
  }
  return moved;
}

/** Read the texting conversation and judge; best effort, so a failed read leaves the ask as it was. */
export async function askOvertaken(store, conversation, armed) {
  if (conversation === null || armed.length === 0) return false;
  try {
    return overtaken(await readConversation(store, conversation, { entries: ENTRIES }), armed);
  } catch {
    return false;
  }
}

/** The model's note that an earlier ask was dropped because their yes came after another of Tex's texts, or "". */
export function droppedLine(dropped) {
  if (!Array.isArray(dropped) || dropped.length === 0) return "";
  const each = dropped.map((entry) => `"${String(entry.summary ?? entry.tool).slice(0, 200)}"`).join(", ");
  return (
    `(Context: you had asked for a 👍 to ${each}, but you texted them something else by yourself after it, so their texts now answer that. ` +
    "Nothing was sent, and the earlier ask is dropped. Answer this text; make that call again only if they ask for it, and they are asked again.)"
  );
}
