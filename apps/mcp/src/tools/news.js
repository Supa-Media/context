/**
 * What changed in this gateway's tools, told through `orient` to the clients
 * still describing them as they were.
 *
 * ## Why this exists
 *
 * A client caches `tools/list` and re-fetches on its own schedule — some at
 * every new chat, some only when a person reconnects (PR #782 found this;
 * `advertised.js` keeps the old names working for the same reason). MCP's
 * own answer, `notifications/tools/list_changed`, needs a stream this
 * stateless gateway does not hold, and nothing a server or a model says can
 * make a client reload. So a connection can go on reading the descriptions of
 * the day it connected, and never learn that `write_note` takes `comment`.
 *
 * What does reach every client is `orient`, which every session calls first.
 * The control plane records when each grant last fetched `tools/list`
 * (`oauthGrants.toolsListedAt`), and `orient` names the entries below that
 * are newer. Arguments are checked against *today's* schema on every call
 * (`tools/session.js`), whatever the client cached, so an agent that reads an
 * entry here can pass the new argument at once. A new *tool* is different: a
 * client calls only tools it has loaded, so for those the line says to
 * reconnect.
 *
 * ## Keeping it honest
 *
 * `toolNews.test.mjs` fingerprints every advertised tool's name and argument
 * names. Changing either fails that test until this list gains an entry and
 * `TOOL_SHAPE` is updated to the value the test prints. Descriptions are not
 * fingerprinted: rewording one is not news.
 */

/**
 * Newest first. `date` is the UTC day it shipped; `text` is written for the
 * model reading orient, naming the tool and the exact argument. `newTool`
 * marks a whole new tool, which a stale client cannot call until it reloads.
 *
 * @type {ReadonlyArray<{date: string, text: string, newTool?: true}>}
 */
export const TOOL_NEWS = Object.freeze([
  {
    date: "2026-10-15",
    text:
      'Mail between agents working on one note: write_note `mail: { join: "builder" }` gives you a mailbox id; ' +
      "pass `mailbox` on every call and answers say when mail is new for you; send with write_note `mail: { text, to }`, " +
      "read with read_note `mail: true`.",
  },
  {
    date: "2026-10-15",
    text:
      "orient `tools: true` lists every tool you may call and its arguments as they are today. " +
      "orient shows that list by itself whenever your app's copy is out of date.",
  },
  {
    date: "2026-10-15",
    text:
      "write_note `upload: [{ name, sha256, bytes }]` hands back a curl command per picture file (sent once, within 10 minutes); " +
      "then `images: [{ name, sha256 }]` embeds it, so a screenshot on disk never goes through base64.",
  },
  {
    date: "2026-10-12",
    text: 'write_note `site: { action: "domain" }` shows or connects a website\'s own domain and the DNS records it needs.',
  },
  {
    date: "2026-10-07",
    text: "remember works without `note`: a fact with no note it belongs in is filed under 0-inbox/memories.",
  },
  {
    date: "2026-10-03",
    text:
      'write_note `site` builds websites: `{ action: "check" }`, `{ action: "publish", draft }`, ' +
      '`{ action: "screenshot", page }` and `{ action: "history" }` to roll back.',
  },
  {
    date: "2026-10-02",
    newTool: true,
    text: "remember saves one durable fact about the person into the note it belongs in.",
  },
  {
    date: "2026-09-30",
    newTool: true,
    text: "report_problem reports a problem with Context itself to the people who build it.",
  },
  {
    date: "2026-09-29",
    text: 'write_note `comment: { action: "delete", thread }` takes back your own latest comment.',
  },
  {
    date: "2026-09-28",
    newTool: true,
    text: "suggest_destination asks which of the workspaces you reach a piece of content belongs in.",
  },
  {
    date: "2026-09-27",
    text:
      "write_note `comment: { action: add|reply|resolve|reopen, quote, thread, text }` comments on a note " +
      "without rewriting it; read_note lists open threads.",
  },
  {
    date: "2026-09-26",
    text: "write_note `images` attaches pictures to a note in the same write.",
  },
]);

/**
 * The fingerprint of every advertised tool's name and argument names at the
 * time of the newest entry above. See `toolNews.test.mjs`.
 */
export const TOOL_SHAPE = "5fb58c31";

/** How many entries orient shows before summing up the rest. */
const NEWS_LIMIT = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The fingerprint `TOOL_SHAPE` is compared with: FNV-1a over each tool's name
 * and sorted argument names, tools sorted by name. Not a security measure,
 * only a tripwire for "the tools changed and nobody wrote it down".
 *
 * @param {Array<{name: string, inputSchema?: {properties?: object}}>} tools
 */
export function toolShape(tools) {
  const text = tools
    .map((tool) => `${tool.name}(${Object.keys(tool.inputSchema?.properties || {}).sort().join(",")})`)
    .sort()
    .join(" ");
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The orient section for a connection that last loaded our tools at
 * `listedAt` (epoch ms), or `null` when there is nothing newer or the time is
 * unknown. An entry dated the same UTC day as the listing is included, since
 * a day's date cannot say which came first; repeating one line is cheaper
 * than hiding one.
 *
 * @param {number | null | undefined} listedAt
 * @param {ReadonlyArray<{date: string, text: string, newTool?: true}>} [news]
 */
export function toolNewsSection(listedAt, news = TOOL_NEWS) {
  if (!Number.isFinite(listedAt)) return null;
  const listedDay = Math.floor(listedAt / DAY_MS) * DAY_MS;
  const fresh = news.filter((entry) => Date.parse(`${entry.date}T00:00:00Z`) >= listedDay);
  if (fresh.length === 0) return null;
  const shown = fresh.slice(0, NEWS_LIMIT);
  const lines = shown.map((entry) =>
    entry.newTool
      ? `- ${entry.date} — new tool: ${entry.text} Your app loads a new tool only when Context is reconnected or a new chat starts.`
      : `- ${entry.date} — ${entry.text}`
  );
  if (fresh.length > shown.length) lines.push(`- …and ${fresh.length - shown.length} older changes.`);
  const since = new Date(listedAt).toISOString().slice(0, 10);
  return (
    `## New in Context's tools since your app loaded them (${since})\n\n` +
    "Your copy of these tools' descriptions may be older than this list. New arguments work anyway: " +
    "pass them exactly as written here, even where your copy of the tool does not list them.\n\n" +
    lines.join("\n")
  );
}
