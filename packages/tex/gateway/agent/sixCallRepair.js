/**
 * A SIX-TOOL CALL IN A SHAPE WITH ONE READING, RUN AS THAT READING (Dev, 2026-11-23: "tex should have a 0% wrong call
 * rate on its own tools"; asked whether the API should block bad calls: "cant we do that ourselves?").
 *
 * Measured, 2026-11-16 to 11-23 (four chats, 791 calls): 68 of Tex's calls (8.6%) were refused for their shape, and 23%
 * of turns had one. Every family tool's `args` is an open object, so Haiku guessed: an email search's dates as `after`,
 * `from`, `to` or a second `query` (33 of the 68), `images` beside a note's `path`, an email's fields beside `action`, a
 * browse's steps as JSON text, `mail: true` on an email id. Each was refused with its fix, and Tex often gave up instead
 * of retrying (the Kansi reply). So where a call can only mean one thing, it is rewritten to that and run; a call that
 * could mean two things, or names something that does not exist, is still refused with the fix written out.
 *
 * This replaces the refusal `sixCallShape.js` gave for keys beside `send`'s action (Dev2, 2026-11-23, "refused, never
 * folded"): the newer ask wins, and the refusal stays only for what cannot be read one way.
 *
 * Only Tex's resolver runs this (`sixTools.js` `resolve`). MCP clients keep the gateway's own shape checks.
 */

import { ACTIONS } from "../../../../apps/mcp/src/tools/v2/actions.js";
import { toolDefinitions } from "../../../../apps/mcp/src/tools/registry.js";

/** What every family call carries itself, never an action's own argument (`sixTools.js` `CALL_KEYS`). */
const CALL_KEYS = new Set(["action", "args", "context", "mailbox", "person_said"]);

/** `write`'s own top-level fields beside `action` (`apps/mcp/src/tools/v2/schemas.js`). */
const WRITE_TOP = new Set(["path", "content", "expected_etag"]);

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = /^(\d{4})[-/](\d{2})[-/](\d{2})$/;
const EPOCH = /^\d{9,13}$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** A Gmail date as Gmail's search reads it: `2026/11/19`, or epoch seconds as they came. */
function gmailDate(value) {
  const text = String(value).trim();
  const day = DAY.exec(text);
  if (day) return `${day[1]}/${day[2]}/${day[3]}`;
  if (EPOCH.test(text)) return String(text.length > 10 ? Math.floor(Number(text) / 1000) : Number(text));
  return null;
}

/** The day after a `YYYY-MM-DD`, so an inclusive `to` becomes Gmail's exclusive `before:`. */
function dayAfter(value) {
  const day = DAY.exec(String(value).trim());
  if (!day) return null;
  const next = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]) + 1));
  return `${next.getUTCFullYear()}/${String(next.getUTCMonth() + 1).padStart(2, "0")}/${String(next.getUTCDate()).padStart(2, "0")}`;
}

/** A number past its schema's bounds, brought inside them. */
function clamped(property, value) {
  if (!property || typeof value !== "number" || !Number.isFinite(value)) return value;
  if (typeof property.maximum === "number" && value > property.maximum) return property.maximum;
  if (typeof property.minimum === "number" && value < property.minimum) return property.minimum;
  return value;
}

/** A call's `context`, with a doubled `@` read as one (`@@supa` is `@supa`). */
function oneAt(call) {
  if (typeof call.context !== "string" || !/^@@+/.test(call.context.trim())) return call;
  return { ...call, context: `@${call.context.trim().replace(/^@+/, "")}` };
}

/**
 * An email search's extra keys as the Gmail query they mean. Gmail's search syntax carries every one of them:
 * `after:`/`before:` for dates (a day or epoch seconds), `newer_than:`/`older_than:` for ages, `label:` for a folder,
 * `from:`/`to:` for a sender or a recipient. A key whose value has no such reading stays, and is refused as before.
 */
function emailSearch(call, carrier) {
  const given = { ...call.args };
  const words = [];
  const add = (operator) => words.push(operator);
  for (const key of ["after", "since"]) {
    if (given[key] === undefined) continue;
    const date = gmailDate(given[key]);
    if (date === null) continue;
    add(`after:${date}`);
    delete given[key];
  }
  if (given.before !== undefined && gmailDate(given.before) !== null) {
    add(`before:${gmailDate(given.before)}`);
    delete given.before;
  }
  for (const key of ["newer_than", "older_than"]) {
    if (typeof given[key] === "string" && /^\d+[dmy]$/.test(given[key].trim())) {
      add(`${key}:${given[key].trim()}`);
      delete given[key];
    }
  }
  // `from` and `to` are a day (the notes search's range, carried over) or a person (Gmail's own operators).
  if (typeof given.from === "string" && given.from.trim() !== "") {
    add(DAY.test(given.from.trim()) ? `after:${gmailDate(given.from)}` : `from:${given.from.trim()}`);
    delete given.from;
  }
  if (typeof given.to === "string" && given.to.trim() !== "") {
    add(DAY.test(given.to.trim()) ? `before:${dayAfter(given.to)}` : `to:${given.to.trim()}`);
    delete given.to;
  }
  for (const key of ["folder", "label"]) {
    if (typeof given[key] === "string" && given[key].trim() !== "") {
      add(`label:${given[key].trim()}`);
      delete given[key];
    }
  }
  // A second query, or a Gmail operator written as a folder (`prefix: "after:…"`), is more of the same query.
  if (typeof given.query === "string") {
    if (given.query.trim() !== "") add(given.query.trim());
    delete given.query;
  }
  if (typeof given.prefix === "string" && /^[a-z_]+:\S/.test(given.prefix.trim())) {
    add(given.prefix.trim());
    delete given.prefix;
  }
  if (given.limit !== undefined) given.limit = clamped(carrier?.inputSchema?.properties?.limit, given.limit);
  const query = [typeof call.query === "string" ? call.query.trim() : "", ...words].filter((part) => part !== "").join(" ");
  return { ...call, query, args: given };
}

/** `search`: the mode its keys name, and an email search's keys as its Gmail query. */
function repairSearch(call, carriers) {
  let next = { ...call };
  // `email: true` beside the query, where `texts` and `groups` would be too: inside args.
  for (const key of ["email", "texts", "groups"]) {
    if (next[key] !== true) continue;
    next = { ...next, args: { ...(isObject(next.args) ? next.args : {}), [key]: true } };
    delete next[key];
  }
  if (!isObject(next.args)) return next;
  const args = { ...next.args };
  // An account (or a sender's address written as mailbox) is only ever an email search's.
  const mode = args.email === true || args.texts === true || args.groups === true;
  if (!mode && (typeof args.account === "string" && ADDRESS.test(args.account.trim()))) args.email = true;
  next = { ...next, args };
  if (args.email === true) return emailSearch(next, carriers.get("search_email"));
  // A notes search's range under the words people use for it.
  if (args.texts !== true && args.groups !== true) {
    if (args.from === undefined && typeof args.after === "string" && DAY.test(args.after.trim())) {
      args.from = args.after.trim().replaceAll("/", "-");
      delete args.after;
    }
    if (args.to === undefined && typeof args.before === "string" && DAY.test(args.before.trim())) {
      args.to = args.before.trim().replaceAll("/", "-");
      delete args.before;
    }
    if (typeof args.query === "string") {
      next = { ...next, query: [next.query, args.query].filter((part) => typeof part === "string" && part.trim() !== "").join(" ") };
      delete args.query;
    }
  }
  return next;
}

/**
 * `fetch`: an email read carries no options of its own (`searchFetch.js`), so `mail: true` and a `from` that is no
 * offset ask for nothing more than the email; a note read is already whole, so `full: true` asks for nothing.
 */
function repairFetch(call) {
  if (!isObject(call.args) || typeof call.id !== "string") return call;
  const args = { ...call.args };
  if (call.id.trim().startsWith("email:")) {
    if (args.mail === true) delete args.mail;
    if (args.from !== undefined && !Number.isInteger(args.from)) delete args.from;
  }
  if (args.full === true) delete args.full;
  const next = { ...call, args };
  if (Object.keys(args).length === 0) delete next.args;
  return next;
}

/** A browse's steps written as JSON text: the list it says. */
function stepsList(steps) {
  if (typeof steps !== "string") return steps;
  try {
    const parsed = JSON.parse(steps);
    return Array.isArray(parsed) ? parsed : steps;
  } catch {
    return steps;
  }
}

/** A browse step under another name for one of its own (`browse.js`'s steps): only names with one meaning. */
const STEP_NAMES = { open: "goto", navigate: "goto", visit: "goto", choose: "select", fill: "type", tap: "click", screenshot: "look" };

function browseSteps(steps) {
  const list = stepsList(steps);
  if (!Array.isArray(list)) return list;
  return list.map((step) => (isObject(step) && typeof step.do === "string" && Object.hasOwn(STEP_NAMES, step.do) ? { ...step, do: STEP_NAMES[step.do] } : step));
}

/**
 * A family call's own arguments written beside its action, moved inside `args` where the action's carrier takes them.
 * Inside `args` wins where both name a key. `write` keeps its own top-level fields where they are.
 */
function foldBeside(family, call, takes) {
  if (!takes) return call;
  const nested = isObject(call.args) ? call.args : call.args === undefined ? {} : null;
  if (nested === null) return call;
  const beside = Object.fromEntries(Object.entries(call).filter(([key, value]) =>
    value !== undefined && !CALL_KEYS.has(key) && !(family === "write" && WRITE_TOP.has(key)) && takes.has(key)));
  if (Object.keys(beside).length === 0) return call;
  const rest = Object.fromEntries(Object.entries(call).filter(([key]) => !Object.hasOwn(beside, key)));
  return { ...rest, args: { ...beside, ...nested } };
}

/** A sender's address written as `mailbox` (the id of a joined note's mail), on an email: its `from`. */
function senderFromMailbox(call) {
  if (!["email", "email_draft"].includes(call.action) || typeof call.mailbox !== "string" || !ADDRESS.test(call.mailbox.trim())) return call;
  const args = isObject(call.args) ? call.args : {};
  const next = { ...call, args: args.from === undefined ? { ...args, from: call.mailbox.trim() } : args };
  delete next.mailbox;
  return next;
}

/**
 * The call as it can only be read, or as it came. `tables` maps each family to its actions (`{ write, manage, send }`,
 * each action naming its carrying `tool`); `carriers` maps a tool's name to its definition; `assistant` names the send
 * actions only Tex has, whose own readers already take keys beside the action (`sixTools.js` `own`).
 *
 * @returns {{ name: string, args: object }}
 */
export function repairSixCall(name, args, { tables, carriers, assistant = new Set() }) {
  if (!isObject(args)) return { name, args };
  let call = oneAt(args);
  if (name === "search") return { name, args: repairSearch(call, carriers) };
  if (name === "fetch") return { name, args: repairFetch(call) };
  if (name !== "write" && name !== "manage" && name !== "send") return { name, args: call };
  // An email search asked for as a send action: the search it names.
  if (name === "send" && call.action === "search_email") {
    const inner = isObject(call.args) ? call.args : {};
    const { query, ...rest } = { ...Object.fromEntries(Object.entries(call).filter(([key]) => !CALL_KEYS.has(key))), ...inner };
    const account = rest.account ?? (typeof call.mailboxes === "string" ? call.mailboxes : undefined);
    delete rest.mailboxes;
    const search = { query: typeof query === "string" ? query : "", args: { ...rest, email: true, ...(account !== undefined ? { account } : {}) } };
    if (typeof call.context === "string") search.context = call.context;
    return { name: "search", args: repairSearch(search, carriers) };
  }
  const action = name === "write" && (call.action === undefined || call.action === "") ? "save" : call.action;
  const entry = typeof action === "string" ? tables[name]?.[action] : undefined;
  if (entry) {
    const carrier = carriers.get(entry.tool);
    const properties = carrier?.inputSchema?.properties ?? carrier?.input_schema?.properties;
    // An assistant action's own reader takes keys beside the action itself (`sixTools.js` `own`).
    if (!(name === "send" && assistant.has(action))) call = foldBeside(name, call, properties ? new Set(Object.keys(properties)) : null);
    if (name === "send") call = senderFromMailbox(call);
  }
  if (name === "send" && action === "browse") {
    if (call.steps !== undefined) call = { ...call, steps: browseSteps(call.steps) };
    if (isObject(call.args) && call.args.steps !== undefined) call = { ...call, args: { ...call.args, steps: browseSteps(call.args.steps) } };
  }
  return { name, args: call };
}

/** The same for an older tool name still called as itself (`browse { steps: "[…]" }`): its one reading. */
export function repairOlderCall(name, args) {
  if (!isObject(args)) return args;
  if (name === "browse" && args.steps !== undefined) return { ...args, steps: browseSteps(args.steps) };
  return args;
}

/** The gateway's own tool definitions by name, read once: a bound (search_email's limit) on a tool a kind's list leaves out. */
let registry = null;
const registryCarriers = () => (registry ??= new Map(toolDefinitions().map((tool) => [tool.name, tool])));

/**
 * `(name, args) => { name, args }` over one turn's tools: `held` and `shown` (`sixTools.js` `sixToolsOver`), and
 * `assistant`, the send actions only Tex has (`ASSISTANT_SEND_ACTIONS`).
 */
export function sixCallRepairer({ held, shown = null, assistant = {} }) {
  const tables = { write: ACTIONS.write, manage: ACTIONS.manage, send: { ...ACTIONS.send, ...assistant } };
  const carriers = new Map([...registryCarriers(), ...(shown instanceof Map ? shown : []), ...held]);
  const names = new Set(Object.keys(assistant));
  const SIX = new Set(["orient", "search", "fetch", "write", "manage", "send"]);
  return (name, args) => (SIX.has(name) ? repairSixCall(name, args, { tables, carriers, assistant: names }) : { name, args: repairOlderCall(name, args) });
}

export const _test = { gmailDate, dayAfter, clamped, STEP_NAMES };
