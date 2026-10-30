/**
 * `orient about: "tools"` and `orient about: "<action>"`: the manual of the
 * six tools and of every action the write, manage and send tools carry.
 *
 * Nothing here is written by hand except the fetch ids, which are the
 * gateway's own spellings. The tools are the connection's offered list
 * (`store.offeredTools`), their arguments are read off the advertised schemas,
 * and the actions are the rows of `tools/v2/actions.js`, so a new action shows
 * here the moment it is a row there.
 */

import { ACTIONS } from "../tools/v2/actions.js";
import { PRIVATE_TIER_ONLY_TOOLS, toolDefinitions } from "../tools/registry.js";
import { V2_TOOLS } from "../tools/advertised.js";
import { appOf, argumentsLine, liveToolListSection } from "../tools/liveList.js";

/** The write-family tools that carry actions, in the order the six are listed. */
const ACTION_FAMILIES = ["write", "manage", "send"];

/** Top-level fields of a `write` call that name a note. */
const NOTE_FIELDS = ["path", "content", "expected_etag"];

/** Fields every tool takes that are addressing, not an action's own argument. */
const ADDRESSING = ["context", "mailbox"];

/** A probe call, to read which top-level fields and nested argument an action's `take` produces. */
const PROBE = { path: "p", content: "c", expected_etag: "e", args: {} };

/**
 * What an action's `take` puts where, read by running it once on a probe.
 * A `nested` action (comment, mail, upload, website, api) returns its own
 * arguments under one key; a note action keeps the note fields at the top;
 * a plain one returns its arguments unchanged.
 */
function shapeOf(entry, carrier = carrierOf(entry)) {
  const produced = entry.take(PROBE) || {};
  const keys = Object.keys(produced);
  // A note field the carrying tool does not take is not one to send at all.
  const takes = carrier?.inputSchema?.properties || {};
  return {
    note: NOTE_FIELDS.filter((field) => keys.includes(field) && Object.hasOwn(takes, field)),
    nested: keys.find((key) => !NOTE_FIELDS.includes(key)) ?? null,
  };
}

/** Every nested argument key any action uses: they are sub-objects, never top-level tool arguments. */
const NESTED_KEYS = new Set(
  Object.values(ACTIONS).flatMap((table) =>
    Object.values(table)
      .map((entry) => shapeOf(entry).nested)
      .filter(Boolean)
  )
);

/** The advertised tool an action is carried by. */
function carrierOf(entry) {
  return toolDefinitions().find((tool) => tool.name === entry.tool) ?? null;
}

/**
 * The argument list an action takes, from its carrying tool's schema: the
 * advertised one, or `carrier` where the caller holds its own definition
 * (the texting assistant's, `agent/sixTools.js`).
 */
export function actionArguments(entry, carrier = carrierOf(entry)) {
  const schema = carrier?.inputSchema || {};
  const { nested } = shapeOf(entry, carrier);
  if (nested) {
    const sub = schema.properties?.[nested];
    // A list (upload's files) travels as `args.files`, see `tools/v2/actions.js`.
    if (sub?.type === "array") return argumentsLine({ files: sub }, ["files"]);
    return argumentsLine(sub?.properties || {}, sub?.required || []);
  }
  // Fields the action keeps at the top level are said there, not here; a
  // `manage` action has no top level, so its path is one of its args.
  return argumentsLine(schema.properties || {}, schema.required || [], [
    ...ADDRESSING,
    ...shapeOf(entry, carrier).note,
    ...NESTED_KEYS,
  ]);
}

/**
 * Whether a connection at this scope is told about an action. An action whose
 * tool is private-tier only (`PRIVATE_TIER_ONLY_TOOLS`, e.g. share_link) is not
 * named to a connection that reads no private notes, exactly as the tool
 * itself is not offered to it.
 */
function visibleTo(scope, entry) {
  return scope === "private" || !PRIVATE_TIER_ONLY_TOOLS.has(entry.tool);
}

/** Every action of one family the connection at `scope` may be told about, as `[name, entry]`. */
function actionsOf(family, scope) {
  return Object.entries(ACTIONS[family] || {}).filter(([, entry]) => visibleTo(scope, entry));
}

/** Every action name across the families this scope may see, for `orient about:` and its error. */
export function actionNames(scope) {
  return ACTION_FAMILIES.flatMap((family) => actionsOf(family, scope).map(([name]) => name));
}

/** The family an action name belongs to, with its entry, or null. */
export function findAction(name, scope) {
  for (const family of ACTION_FAMILIES) {
    if (!Object.hasOwn(ACTIONS[family], name)) continue;
    const entry = ACTIONS[family][name];
    if (visibleTo(scope, entry)) return { family, name, entry };
  }
  return null;
}

/** The connection's tools as tools/list offers them, or null where the listing cannot be read. */
async function offeredToolsOf(store) {
  if (typeof store?.offeredTools !== "function") return toolDefinitions().filter((tool) => V2_TOOLS.has(tool.name));
  try {
    return await store.offeredTools();
  } catch {
    return null;
  }
}

const FETCH_IDS = [
  "- a note path, e.g. `projects/togather/status.md`: that note",
  "- a file path, e.g. a PDF, Word, Excel or picture file a note links (an email's attachments): the words in it; a long one in parts with args `{ from }`, and a CSV's totals with args `{ summary: { by, where: [{ column, contains }], dates } }`",
  "- a folder path ending in `/`, e.g. `projects/`: lists it",
  "- `calendar:` with args `{ date: \"YYYY-MM-DD\", days, account? }`: what is on their calendar that day (and the days after), from every connected account, or only the connected address `account` names",
  "- `meetings:`, `messages:`, `contacts:`, `activity:`, `changes:`, `proposals:` (and `proposals:<id>`), `links:`, `vault:`, `plugins:`, `access:`: each kind, listed or read by id",
  "- `apps:`: the apps the person connects through Context (and which need the browser instead); `apps:<app>` lists one's tools, and with args `{ tool, arguments }` runs a read",
  "- `texts:`: their text conversations (iMessage and SMS), when their Mac backs them up; `texts:<id>`, from it or from `search` with args `{ texts: true, with, since }`, reads one, with args `{ since, before, limit }`",
  "- `email:<address>/<id>`, from `search` with args `{ email: true }`: one email read live from their Gmail; args `{ attachment }` reads one of its files (with `from` and `summary` as for a file)",
  "- `chat:`: their Google Chat spaces, with ids; `chat:<spaces/…>` reads one live, newest messages, args `{ limit }`, and `chat:` with args `{ to }` (a work email) reads the direct message with that person",
].join("\n");

/** The whole manual: the six tools, every action, and the fetch ids. */
export async function toolsManual(store, scope) {
  const offered = await offeredToolsOf(store);
  if (offered === null) {
    return "## Context's tools\n\nThe tool list could not be read just now; try again in a moment.";
  }
  const offeredNames = new Set(offered.map((tool) => tool.name));
  const families = ACTION_FAMILIES.filter((family) => offeredNames.has(family) && actionsOf(family, scope).length > 0).map((family) => {
    const lines = actionsOf(family, scope).map(([name, entry]) => {
      const { note } = shapeOf(entry);
      const top = note.length ? `top level: ${note.join(", ")}; ` : "";
      return `  - ${name} — ${entry.summary}\n    ${top}args: ${actionArguments(entry)}`;
    });
    return `### ${family}\n${lines.join("\n")}`;
  });
  return [
    liveToolListSection(offered, appOf(store)),
    "## Actions\n\n" +
      "`write`, `manage` and `send` each take `action`, and an action's own arguments go in `args`. " +
      "`write` takes a note's `path`, `content` and `expected_etag` at the top level; an action that " +
      "does not name a note takes none. `orient about: \"<action>\"` gives one action in full.\n\n" +
      families.join("\n\n"),
    "## Fetch ids\n\n`fetch` takes one id:\n" + FETCH_IDS,
  ].join("\n\n");
}

/**
 * One action in full: its carrying tool's whole description, its arguments,
 * and how to call it in v2.
 *
 * @param {{family: string, name: string, entry: object}} found from `findAction`
 */
export function actionManual({ family, name, entry }) {
  const tool = carrierOf(entry);
  const { note, nested } = shapeOf(entry);
  const shownNote = note.length ? `path: "<note>", ` : "";
  const call =
    name === "save"
      ? `${family} { path: "<note>", content: "<markdown>", expected_etag: "<etag>" }`
      : `${family} { action: "${name}", ${shownNote}args: {...} }`;
  return [
    `# ${name}`,
    `${family} → \`${entry.tool}\`: ${entry.summary}`,
    `Arguments${nested ? ` (in \`args\`, under \`${nested}\`)` : " (in `args`)"}: ${actionArguments(entry)}`,
    note.length ? `Top level: ${note.join(", ")}.` : "",
    `How to call it: \`${call}\``,
    tool?.description ? `## \`${entry.tool}\`, whole description\n\n${tool.description}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
