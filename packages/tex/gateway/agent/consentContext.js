/**
 * WHAT THE CONSENT JUDGE IS TOLD ABOUT THE CHAT (Dev2, 2026-11-22).
 *
 * The Egress judge (`apps/mcp/src/privacy/judge.js`, node `egress`) decides whether a person's own text asks for a
 * step that widens who sees something or changes a setting in their name. It used to get the text and a one-line
 * action and nothing else, so "Tex, share my calendar here too", sent in a group chat, was refused as "ambiguous
 * whether 'here' means the same group chat" (Tex Devs, 2026-11-19), and Sayo's first asks in a new group were
 * refused the same way (2026-11-22). A "yes" to Tex's own offer could not count either: the judge never saw the offer.
 *
 * So a texted turn's judge is given two facts, both built here from what the turn already holds, never from the
 * model's arguments:
 *
 * - `where`: the chat the text was sent in, and who is in it, so "here", "this chat", "everyone here" and "us" have a
 *   meaning. Handles, names and guest labels as the turn knows them; never a phone number.
 * - `offered`: Tex's last text in that chat before this one, so "yes", "do it" or "go ahead" answering it counts.
 * - `owns` (Dev2, 2026-11-26): in a group, the Gmail addresses the sender connected, shared here or not. "Share my
 *   gmail here" from @lena was refused as "the words are from @lena, not the inbox owner": the judge was never told
 *   whose inbox it was. Addresses as the control plane sent them (`askerMail`, and this chat's mail rows that are
 *   the sender's), never the model's arguments.
 *
 * Each goes only when the config's `egress` step names it in its `inSchema` (`texConfig.json`): the graph runner
 * refuses an input field the schema does not name, so the code ships first and the config turns it on.
 */

/** The most of Tex's last text the judge is shown, from its end: the offer is usually the last line. */
export const MAX_OFFERED = 600;
const MAX_PEOPLE_SHOWN = 12;

const JUDGED_FIELDS = new Set(["where", "offered", "owns"]);
const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const MAX_OWNED = 10;

/** Which of `where`, `offered` and `owns` the config's egress step takes. */
function namedFields(config) {
  const node = Array.isArray(config?.nodes) ? config.nodes.find((n) => n?.id === "egress") : null;
  const schema = Array.isArray(node?.inSchema) ? node.inSchema : [];
  return new Set(schema.map((field) => field?.name).filter((name) => JUDGED_FIELDS.has(name)));
}

/** "@ada (Ada Lovelace)", or "@ada" without a name. */
function person(handle, names) {
  const name = names.find((entry) => entry.handle === handle)?.name;
  return name ? `@${handle} (${name})` : `@${handle}`;
}

/** The chat as one plain line, or "" when the turn is not a texted chat. */
export function whereLine(group, { chatTurn = true } = {}) {
  if (!chatTurn) return "";
  if (group === null || group === undefined) {
    return "The words were texted to Tex in the person's own one-to-one chat with Tex. \"Here\" and \"this chat\" mean that chat, which only they and Tex are in.";
  }
  const names = Array.isArray(group.names) ? group.names : [];
  const people = Array.isArray(group.people) ? group.people : [];
  const from = typeof group.from === "string" ? group.from : "";
  const others = people.filter((handle) => handle !== from).map((handle) => person(handle, names));
  const guests = Array.isArray(group.guests) ? group.guests : [];
  const everyone = [...others, ...guests];
  const shown = everyone.slice(0, MAX_PEOPLE_SHOWN);
  const more = everyone.length - shown.length;
  const sender = from ? person(from, names) : group.asker ? String(group.asker) : "a person in the chat";
  const rest = shown.length ? `, with ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : "";
  return (
    `The words were texted by ${sender} in a group text chat with Tex${rest}. ` +
    "\"Here\", \"this chat\", \"this group\", \"everyone here\", \"y'all\" and \"us\" in the words mean this group chat and its people."
  );
}

/** Tex's last text before the person's words, the end of it, or "". */
export function offeredLine(history) {
  if (!Array.isArray(history)) return "";
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry?.role !== "assistant") continue;
    const text = typeof entry.text === "string" ? entry.text : typeof entry.content === "string" ? entry.content : "";
    const plain = text.replace(/\s+/g, " ").trim();
    if (plain === "") continue;
    return plain.length > MAX_OFFERED ? plain.slice(plain.length - MAX_OFFERED) : plain;
  }
  return "";
}

/** The group sender's own connected Gmail addresses, as data (JSON), or "" when the turn has none to name. */
export function ownsLine(group) {
  if (group === null || typeof group !== "object") return "";
  const from = typeof group.from === "string" ? group.from : "";
  if (from === "") return "";
  const unshared = Array.isArray(group.askerMail) ? group.askerMail : [];
  const shared = Array.isArray(group.mail) ? group.mail.filter((row) => row?.handle === from).map((row) => row.address) : [];
  const addresses = [...new Set([...unshared, ...shared].filter((address) => typeof address === "string" && ADDRESS.test(address)).map((address) => address.toLowerCase()))].slice(0, MAX_OWNED);
  if (addresses.length === 0) return "";
  return JSON.stringify({ sender: `@${from}`, senders_own_connected_gmail: addresses });
}

/**
 * The fields a texted turn adds to every Egress judge call, `{}` when the config's step names neither or the turn is
 * not a texted chat.
 */
export function consentContext({ group = null, history = [], chatTurn = false, config = null }) {
  if (!chatTurn) return {};
  const fields = namedFields(config);
  const out = {};
  if (fields.has("where")) {
    const where = whereLine(group);
    if (where) out.where = where;
  }
  if (fields.has("offered")) {
    const offered = offeredLine(history);
    if (offered) out.offered = offered;
  }
  if (fields.has("owns")) {
    const owns = ownsLine(group);
    if (owns) out.owns = owns;
  }
  return out;
}

/** The longest reply that may answer Tex's offer instead of naming the thing itself ("ok yeah go ahead and share it"). */
export const MAX_YES = 160;

/**
 * The code word check before a consent judge: the person's own words name the thing (`pattern`), or (Dev2,
 * 2026-11-22) they are a short reply to Tex's last text and that text names it, so "yes", "go ahead" or "do it" can
 * answer Tex's own offer. Only with a judge (`judged`): the judge, shown the same offer as `offered`, still decides
 * whether the reply agrees to it.
 */
export function namesOrAnswers(pattern, words, offered = "", judged = false) {
  const said = typeof words === "string" ? words.trim() : "";
  if (pattern.test(said)) return true;
  if (!judged || said === "" || said.length > MAX_YES) return false;
  return typeof offered === "string" && offered !== "" && pattern.test(offered);
}
