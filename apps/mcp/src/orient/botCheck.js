/**
 * `orient { for: "<bot>", check: true }`: a bot's cheap check-in (decided by the owner, 2026-11-27: "the MCP can just
 * return whether it has anything new in its inbox or not, that way the loops don't burn a lot of tokens, and only when
 * it has something new does it give the agent the mail and give it options to view the mail").
 *
 * The workspace object records the check and hands back what waits for the bot in notes this connection may read
 * (`workspaceStore/botInbox.js`, `store/objectBots.js` `check`). The answer is one line when nothing is new, and
 * otherwise one line per note: who and when, or the routine's name, and its path. Never a message's words: the bot
 * opens what it wants with fetch, or a whole area with `orient { area }`.
 *
 * Its first check-in, and the first after `FULL_AFTER_MS` without one, is answered with the full holder answer
 * instead: how Context works and every area it holds, once a working session (Dev, 2026-11-27: "the full orient does
 * have important things for the bot to know ... so at what point will it call the full orient?").
 */

import { withoutTextExtension } from "../../../../packages/shared/src/fileKinds.cjs";
import { toolError, toolText } from "../tools/results.js";

/** A gap this long between check-ins starts a new working session, answered in full. */
export const FULL_AFTER_MS = 6 * 60 * 60 * 1000;

const when = (ms) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : null);
const quoted = (value) => JSON.stringify(value);
const routineName = (path) => withoutTextExtension(String(path).split("/").pop());

/** One item as a line: paths, names and times only, whatever else the item carries. */
function itemLine(item) {
  if (item.kind === "routine") return `- routine ${routineName(item.note)}${typeof item.area === "string" && item.area !== "" ? ` in ${item.area}` : ""}: ${item.note}`;
  const sender = typeof item.from === "string" && item.from !== "" ? ` from ${item.from}` : "";
  const at = when(item.at);
  const area = typeof item.area === "string" && item.area !== "" ? ` in ${item.area}` : "";
  return `- mail${sender}${at ? `, ${at}` : ""}${area}: ${item.note}`;
}

export async function botCheckAnswer(store, rawBot, full = null, now = Date.now()) {
  const bot = String(rawBot ?? "").trim();
  if (!bot || bot.length > 80) return toolError('invalid: for must be the bot checking in, e.g. "Grok Bot"');
  const everything = `orient { for: ${quoted(bot)} }`;
  let answer = null;
  try {
    answer = typeof store?.objectBots?.check === "function" ? await store.objectBots.check(bot) : null;
  } catch {
    answer = null;
  }
  if (answer === null || !Array.isArray(answer?.items)) return toolText(`Check-ins aren't available in this workspace yet. ${everything} lists your mail.`);
  // A first check-in, or one after a long gap (null: never; undefined: an object that doesn't say), gets everything.
  if (full !== null && (answer.previousAt === null || (typeof answer.previousAt === "number" && now - answer.previousAt > FULL_AFTER_MS))) return await full();
  const items = answer.items.filter((item) => item && typeof item.note === "string");
  if (items.length === 0) return toolText("Nothing new. Check again in 5 minutes.");
  return toolText(
    [`${items.length} new for ${bot}:`, ...items.map(itemLine), `Read one: fetch { id: "<path>", args: { mail: true } }, or its whole area first: orient { area: "<area>" }. Everything: ${everything}.`].join("\n"),
  );
}
