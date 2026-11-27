/**
 * `orient { for: "<bot>", check: true }`: a bot's cheap check-in (decided by the owner, 2026-11-27: "the MCP can just
 * return whether it has anything new in its inbox or not, that way the loops don't burn a lot of tokens, and only when
 * it has something new does it give the agent the mail and give it options to view the mail").
 *
 * The workspace object records the check and hands back what waits for the bot in notes this connection may read
 * (`workspaceStore/botInbox.js`, `store/objectBots.js` `check`). The answer is one line when nothing is new, and
 * otherwise one line per note: who and when, or the routine's name, and its path. Never a message's words: the bot
 * opens what it wants with fetch.
 */

import { toolError, toolText } from "../tools/results.js";

const when = (ms) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") : null);
const quoted = (value) => JSON.stringify(value);
const routineName = (path) => String(path).replace(/\.md$/i, "").split("/").pop();

/** One item as a line: paths, names and times only, whatever else the item carries. */
function itemLine(item) {
  if (item.kind === "routine") return `- routine ${routineName(item.note)}: ${item.note}`;
  const sender = typeof item.from === "string" && item.from !== "" ? ` from ${item.from}` : "";
  const at = when(item.at);
  return `- mail${sender}${at ? `, ${at}` : ""}: ${item.note}`;
}

export async function botCheckAnswer(store, rawBot) {
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
  const items = answer.items.filter((item) => item && typeof item.note === "string");
  if (items.length === 0) return toolText("Nothing new. Check again in 5 minutes.");
  return toolText(
    [`${items.length} new for ${bot}:`, ...items.map(itemLine), `Read one: fetch { id: "<path>", args: { mail: true } }. Everything: ${everything}.`].join("\n"),
  );
}
