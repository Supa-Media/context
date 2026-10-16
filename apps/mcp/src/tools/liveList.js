/**
 * Context's tools as they are today, told through `orient` to a client whose
 * own copy of them may be older.
 *
 * ## Why this exists
 *
 * `tools/news.js` tells a stale client what *changed*; this tells it what
 * *is*. A client caches `tools/list` and many re-fetch it only when a person
 * reconnects, so an agent can go on reading the arguments of the day it
 * connected. Arguments are checked against today's schema on every call
 * (`tools/session.js`), whatever the client cached, so an argument this list
 * names works the moment the agent passes it.
 *
 * ## Nothing here is written by hand
 *
 * The list is rendered at request time from the very definitions `tools/list`
 * serves this connection (`toolsForSession`, through `store.offeredTools`), so
 * it cannot drift from them and never names a tool the connection cannot call:
 * a read-only grant sees no write tools here, and a tool masked from a tier
 * (`rotate_encryption_keys`) is absent here exactly as it is from the listing.
 *
 * ## How much orient shows
 *
 * The whole list costs a few thousand characters, so it is shown only where it
 * earns them: when the client's copy is behind (the same test `news.js`
 * applies: a news entry dated on or after its last listing), or when the agent
 * asks with `orient { tools: true }`. Otherwise one line says the copy is
 * current and how to ask.
 */

/** The addressing argument every tool takes, said once rather than 46 times. */
const SHARED_ARGUMENT = "context";

/** How much of a tool's description is kept as its purpose. */
const PURPOSE_CHARS = 140;

/** A first sentence shorter than this ("Personal connection only.") brings the next one along. */
const SHORT_SENTENCE = 40;

/**
 * A description's opening, as the tool's purpose: its first sentence (two,
 * when the first is a short caveat), clipped to `PURPOSE_CHARS`. A sentence
 * ends at `.`, `!` or `?` before a capital or the end, so "(e.g. `a/`)" does
 * not end one.
 */
export function purposeOf(description) {
  const text = String(description || "").replace(/\s+/g, " ").trim();
  const ends = [...text.matchAll(/[.!?](?=\s+[A-Z`"]|$)/g)].map((match) => match.index + 1);
  let cut = ends[0] ?? text.length;
  if (cut < SHORT_SENTENCE && ends.length > 1) cut = ends[1];
  const sentence = text.slice(0, cut);
  return sentence.length <= PURPOSE_CHARS ? sentence : `${sentence.slice(0, PURPOSE_CHARS - 1).trimEnd()}…`;
}

/** A JSON Schema property as a short type: `string`, `"a"|"b"`, `string[]`, `{a, b}`. */
export function typeOf(schema) {
  if (!schema || typeof schema !== "object") return "any";
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join("|");
  const options = schema.oneOf || schema.anyOf;
  if (Array.isArray(options)) return [...new Set(options.map(typeOf))].join("|");
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types
    .map((type) => {
      if (type === "array") return `${typeOf(schema.items)}[]`;
      if (type === "object" && schema.properties && Object.keys(schema.properties).length) {
        const required = new Set(schema.required || []);
        const keys = Object.keys(schema.properties).map((key) => (required.has(key) ? `${key}*` : key));
        return `{${keys.join(", ")}}`;
      }
      return type || "any";
    })
    .join("|");
}

/** One tool, as two lines: name and purpose, then its arguments. */
export function toolLine(tool) {
  const properties = tool.inputSchema?.properties || {};
  const required = new Set(tool.inputSchema?.required || []);
  const args = Object.entries(properties)
    .filter(([name]) => name !== SHARED_ARGUMENT)
    .map(([name, schema]) => `${name}${required.has(name) ? "*" : ""}: ${typeOf(schema)}`);
  return `- ${tool.name} — ${purposeOf(tool.description)}\n  ${args.length ? args.join(" · ") : "(no arguments)"}`;
}

/**
 * Apps that send only the arguments in their own copy of a tool and drop the
 * rest before the call leaves them, so an argument added since they loaded
 * our tools never reaches the gateway, whatever `coercedArguments` would do
 * with it.
 *
 * Found 2026-10-16: Codex stripped `mail` from a stale `write_note`. Matched
 * on the name the client registered, as `CLIENT_FAMILIES` in the control
 * plane's `usage.ts` matches it. The name is the client's own claim, which is
 * fine here: it only chooses which advice an agent reads.
 */
const DROPS_UNKNOWN_ARGUMENTS = /codex/i;

/** Does the app with this registered name drop arguments its copy does not show? */
export function appDropsUnknownArguments(clientName) {
  return typeof clientName === "string" && DROPS_UNKNOWN_ARGUMENTS.test(clientName);
}

/**
 * How a person makes their app load today's tools, by the name it registered.
 * First match wins, so Codex is tested before ChatGPT and Claude Code before
 * Claude. From the 2026-10-16 survey of each app's own docs and issues (the
 * project's `mcp-tool-staleness` notes): none of them refreshes by itself.
 */
const REFRESH_STEPS = [
  [/codex/i, "In Codex, reconnect Context or start a new session."],
  [/chatgpt|openai/i, "In ChatGPT: Settings › Connectors › Context › Refresh."],
  [/claude.?code/i, "In Claude Code, start a new session."],
  [/claude/i, "In Claude, remove the Context connector and add it again (Settings › Connectors)."],
  [/cursor/i, "In Cursor, restart Cursor."],
];

/** The step for this app, or a general one for an app not named above. */
export function refreshStep(clientName) {
  const name = typeof clientName === "string" ? clientName : "";
  const found = REFRESH_STEPS.find(([pattern]) => pattern.test(name));
  return found ? found[1] : "Reconnect Context in your app, or start a new chat.";
}

/**
 * What to do with an argument the app's copy does not show, for the app the
 * agent is running in. Shared with `news.js`, so the two sections never give
 * opposite advice.
 *
 * @param {{dropsUnknown?: boolean, client?: string | null}} [app]
 */
export function unlistedArgumentAdvice({ dropsUnknown = false, client = null } = {}) {
  const refresh = `To load today's tools, ask the person to refresh: ${refreshStep(client)}`;
  return dropsUnknown
    ? "Your app drops any argument its own copy of a tool does not show, so an argument named here that " +
        `your copy lacks never reaches Context. ${refresh} Until then, use what your copy shows.`
    : "Pass arguments exactly as listed here, even where your copy does not show them. If your app refuses " +
        `one or seems to ignore it, ask the person to reconnect. ${refresh}`;
}

/** The app as the advice above needs it, from the store's actor. */
export function appOf(store) {
  const client = store?.actor?.client ?? null;
  return { client, dropsUnknown: appDropsUnknownArguments(client) };
}

/**
 * The full list, as an orient section.
 *
 * @param {Array<{name: string, description?: string, inputSchema?: object}>} tools
 * @param {{dropsUnknown?: boolean, client?: string | null}} [app]
 */
export function liveToolListSection(tools, app = {}) {
  const shared = tools.some((tool) => tool.inputSchema?.properties?.[SHARED_ARGUMENT]);
  return (
    "## Context's tools as they are today\n\n" +
    `Trust this list over your app's copy of these tools, which may be older. ${unlistedArgumentAdvice(app)} ` +
    "A tool listed here that your app does not offer needs Context reconnected (or a new chat) before you " +
    "can call it.\n\n" +
    `\`*\` marks a required argument; \`{a, b}\` is an object with those keys.` +
    (shared ? ` Every tool also takes \`${SHARED_ARGUMENT}: "@name"\` to act in another workspace.` : "") +
    "\n\n" +
    tools.map(toolLine).join("\n")
  );
}

/**
 * The section for this connection, or `null` where nothing says what it was
 * offered (the texting assistant, which is handed today's tools every turn).
 * A listing that fails is no section rather than a failed orient: this is a
 * courtesy, and `tools/session.js` still decides every call.
 *
 * @param {{offeredTools?: () => Promise<Array<object>>, actor?: {toolsListedAt?: number | null}}} store
 * @param {{full: boolean}} options
 */
export async function liveToolsSection(store, { full }) {
  if (typeof store?.offeredTools !== "function") return null;
  if (!full) return liveToolPointer(store.actor?.toolsListedAt);
  try {
    return liveToolListSection(await store.offeredTools(), appOf(store));
  } catch {
    return liveToolPointer(null);
  }
}

/**
 * The short section orient shows instead, when the client's copy is current
 * or nobody recorded when it was loaded. An unknown time says nothing about
 * the copy, rather than guessing it is current.
 *
 * @param {number | null | undefined} listedAt
 */
export function liveToolPointer(listedAt) {
  const ask = "call orient with `tools: true` for the live list of every tool and its arguments.";
  return (
    "## Context's tools\n\n" +
    (Number.isFinite(listedAt)
      ? `Your app's copy of Context's tools (loaded ${new Date(listedAt).toISOString().slice(0, 10)}) is current. ` +
        `If a tool or argument you expect seems missing, ${ask}`
      : `If a tool or argument you expect seems missing from your app's copy of Context's tools, ${ask}`)
  );
}
