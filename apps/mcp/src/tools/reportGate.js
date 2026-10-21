/**
 * THE BUG-REPORT GATE: a bug report filed by text goes to the Context team
 * only on the person's YES to that exact report, and their texts go with it
 * only then (decided by the owner, 2026-10-17;
 * `docs/decisions/texting-assistant/bug-reports.md`).
 *
 * "Maybe we have Tex summarize it and say, can I send this to the team, and
 * then with their explicit yes we're able to send it." The texts are theirs,
 * in their own bucket (`agent/conversation.js`); nobody on the team reads them
 * unless the person hands them over. So, held in `egressGate` like an email:
 *
 *   1. From another AI, `report_problem` runs as it always has: the message
 *      alone, no texts, and `share_texts` is refused.
 *   2. By text, the call is held as a pending approval whose record carries
 *      the whole report and says whether their texts go with it. Only a
 *      YES releases it, or a yes that says to send it ("yes, file it",
 *      `agent/textedApprovals.js`); any other text disarms it.
 *   3. The approved replay sends it. Only that replay reads the texts, off
 *      the person's own conversation file, never from anything the model
 *      wrote: the model can say whether they go, never what they say.
 *   4. A report with none of their texts, on a turn whose own text asks for
 *      a bug to be filed ("if you can't do it, file a bug to the
 *      developers"), is sent at once: that text is the yes (the owner,
 *      2026-10-21, after Tex drafted the report they had just asked for and
 *      then waited on a thumbs-up). The texts still only ever go on a yes to
 *      the report that says they go with it.
 */

import { readConversation, shownHistory } from "../agent/conversation.js";
import { callKey, createPending, findPending } from "./approvals.js";
import { REPORT_TOOL, reportMessage, sendReport } from "./reportProblem.js";
import { toolError } from "./results.js";

export { REPORT_TOOL };

/** How many messages between them go with a report, newest last: the ask and their answer included. */
export const REPORT_TEXTS_TURNS = 12;
/** The longest report shown by text: with the line about texts, one text under `TEXTED_ASK_CAP`. */
export const TEXTED_REPORT_CAP = 2_000;
/** The texts attached, in characters. Kept equal to `MAX_REPORT_TEXTS_CHARS` in the control plane. */
export const MAX_REPORT_TEXTS_CHARS = 16_000;

/** The line about texts, wherever a model copied it into the report. */
const SHARE_LINES = /\s*(?:None of our texts go with it\.|Up to the last \d+ messages between us go with it, so they can see what happened\.)\s*/g;

/** What the person reads before their YES: the report, and whether their texts go with it. */
export function reportCopy(message, shareTexts) {
  const texts = shareTexts
    ? `Up to the last ${REPORT_TEXTS_TURNS} messages between us go with it, so they can see what happened.`
    : "None of our texts go with it.";
  // A model that read an earlier copy writes the line in itself; it is said once (the group chat of 2026-10-21).
  const said = message.replace(SHARE_LINES, "").trim();
  return `${said}\n\n${texts}`;
}

/** "file a bug", "send a bug report to the team", "report this to the developers". */
const ASKS_TO_FILE = [
  /\b(?:file|send|submit|open|log|raise|write up|make)\b[^.?!\n]{0,30}?\b(?:bug|issue|ticket|bug report)\b/i,
  /\breport\s+(?:it|this|that)\b[^.?!\n]{0,20}\b(?:team|devs?|developers?|engineers?)\b/i,
];

/** Whether the person's own text, this turn, asks for a bug to be filed. */
export function asksToFile(words) {
  const said = String(words ?? "");
  return ASKS_TO_FILE.some((pattern) => pattern.test(said));
}

/** The person's recent texts with Tex, as plain lines, or undefined when there are none. */
export async function recentTexts(store) {
  const turns = shownHistory(await readConversation(store, "texts"), REPORT_TEXTS_TURNS);
  if (turns.length === 0) return undefined;
  const lines = turns.map((turn) => `${turn.role === "user" ? "Them" : "Tex"}: ${turn.text.trim()}`).join("\n\n");
  return lines.length > MAX_REPORT_TEXTS_CHARS ? lines.slice(lines.length - MAX_REPORT_TEXTS_CHARS) : lines;
}

/**
 * `null` to let another AI's report through to `report_problem` as it always
 * went, or the answer to give instead: a refusal, the sent report, or a hold.
 */
export async function reportGate(supplied, { store, session }) {
  const shareTexts = supplied?.share_texts === true;
  if (session.egress?.approved === true) {
    return await sendReport(store, reportMessage(supplied), shareTexts ? await recentTexts(store) : undefined);
  }
  const texting = session.egress?.texting === true;
  if (!texting) {
    return shareTexts ? toolError("Not sent: share_texts is only for a report the person files by text with Tex. Send the message alone.") : null;
  }
  const message = reportMessage(supplied);
  if (message === null) return await sendReport(store, null);
  if ([...message].length > TEXTED_REPORT_CAP) {
    return toolError(`Not sent: a bug report by text is at most ${TEXTED_REPORT_CAP.toLocaleString("en-US")} characters, so the person can read it whole. Shorten it.`);
  }

  // Their own text asked for it, and none of their texts go: sent now (4. above).
  if (!shareTexts && asksToFile(session.egress?.turn?.question)) return await sendReport(store, message, undefined);

  const ledger = session.egress?.ledger ?? null;
  if (ledger?.asked.some((asked) => asked.tool === REPORT_TOOL && asked.key !== callKey(REPORT_TOOL, supplied))) {
    return toolError("Not sent: one bug report at a time by text. Ask about this one after the person answers.");
  }
  const userId = session.actorUserId;
  const existing = await findPending(store, { name: REPORT_TOOL, args: supplied, userId });
  const record =
    existing?.record ??
    (await createPending(store, {
      name: REPORT_TOOL,
      args: supplied,
      actor: store.actor,
      tier: session.scope,
      scopes: session.scopes,
      widening: { summary: "send a bug report to the Context team", audience: "outside" },
      detail: reportCopy(message, shareTexts),
      workspaceId: session.workspaceId,
      texting,
      armed: false, // armed by `textedAsk` once the ask goes out whole
    }));
  if (record === null) {
    return toolError("Not sent: the person has too many things waiting for their OK. Ask them to clear some first.");
  }
  if (ledger && !ledger.asked.some((asked) => asked.id === record.id)) ledger.asked.push(record);
  return {
    ...toolError(
      "Held for their YES, and nothing failed: right after your answer they are texted this exact report and asked to say yes, and it sends then. " +
        "Say in a line, as yourself (\"I\", never \"Context\"), that you wrote it up, without repeating it or asking for their yes: " +
        "the next text shows it and asks. Don't call this again in this turn.",
    ),
    held: true,
  };
}
