/**
 * The texting assistant's tools, shown as the six every connected app holds
 * (decided by the owner, 2026-10-16: "it makes sense for both tex and other
 * connected agents to have the same 6 tools, but different levels of access
 * with each tool"; and "Fold in" for the assistant's own abilities).
 *
 * WHAT IT MAY CALL IS STILL DECIDED BY THE OLDER TOOLS.
 *
 * Every surface narrows the assistant's reach by the older tools' names —
 * `agentTools`, `textingWriteTools`, the dream's three, Try it's read-only
 * list, the computer's tools only on a text — and each of those guards stays
 * exactly as it was. This module only changes what the model is shown: the
 * six tools, each listing just the actions whose carrying tool the turn was
 * granted. A call to one is translated back into its carrying tool (the
 * gateway's own `translateV2Params`, plus the rows below for the abilities
 * only the assistant has) and then has to pass `runTurn`'s allowlist of
 * granted tools, like any other call. An action the turn was not granted is
 * refused there, whatever the model was told.
 *
 * The older names stay callable as themselves, as they do on the MCP: a setup
 * note or an earlier turn that names `write_note` still works.
 */

import { ACTIONS } from "../tools/v2/actions.js";
import { translateV2Params } from "../tools/v2/translate.js";
import { toolDefinitions } from "../tools/registry.js";
import { toolsForSession } from "../tools/advertised.js";
import { actionArguments } from "../orient/manual.js";

/** The six, in the order they are listed. */
export const SIX_TOOLS = ["orient", "search", "fetch", "write", "manage", "send"];
const SIX = new Set(SIX_TOOLS);

const own = (call) => (call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {});

/**
 * What only the assistant can do outside Context, as `send` actions: the
 * computer's tools (`computer.js`, `fillLogin.js`) and the line it can text
 * while it works (`progress.js`). An MCP connection is never granted these:
 * nothing it holds carries them.
 */
export const ASSISTANT_SEND_ACTIONS = {
  search_web: { tool: "search_web", summary: "Search the web.", take: own },
  open_page: { tool: "open_page", summary: "Read web pages by their address.", take: own },
  travel_time: { tool: "travel_time", summary: "How long a trip takes, from Google Maps directions; never estimate one.", take: own },
  browse: { tool: "browse", summary: "Drive a browser step by step.", take: own },
  fill_login: { tool: "fill_login", summary: "Sign in on the open page with a saved login you never see.", take: own },
  fill_card: { tool: "fill_card", summary: "Fill the checkout's card boxes with a saved card you never see, on the person's yes in the app.", take: own },
  progress: { tool: "text_progress", summary: "Text the person a short line while you work.", take: own },
  delegate: { tool: "delegate", summary: "Hand a whole sub-project to Claude Code, Codex, Claude, Claude Design or ChatGPT.", take: own },
  background: { tool: "start_background_job", summary: "Hand a long task to a background job, so several things run at once.", take: own }, // `background.js`
  steer_job: { tool: "steer_background_job", summary: "Pass their text to a background job that is still running, or stop it.", take: own },
  mail_agent: { tool: "mail_agent", summary: "Mail the agent doing the job you supervise.", take: own },
  draw_visual: { tool: "draw_visual", summary: "Turn your answer into one of your designed picture cards (options, photos, a trip, a day, a plan, a board, a chart), to text them.", take: own },
  draw_picture: { tool: "draw_picture", summary: "Make a graphic from an HTML page you write, to text them. Make it first; guess what they left out.", take: own },
  make_picture: { tool: "make_picture", summary: "Generate or edit a photo with an image model, to text them. Make it first; guess what they left out.", take: own },
};

/** `fetch` ids only the assistant has: its skills (`skills.js`, `learnedSkills.js`) and the conversation's earlier texts. */
const ASSISTANT_FETCH_IDS = [
  { prefix: "skill:", tool: "read_skill", args: (rest) => ({ name: rest }) },
  { prefix: "learned:", tool: "read_learned_skill", args: (rest) => ({ name: rest }) }, // `learnedSkills.js`
  { prefix: "texts:", tool: "earlier_texts", args: () => ({}) },
  { prefix: "chat:", tool: "earlier_chat", args: () => ({}) }, // a group chat's (`groupTurn.js`)
];

/** Which carrying tool reads ordinary `fetch` ids: a note or a folder. */
const FETCH_CARRIERS = ["read_note", "list_notes"];

/** The six tools' advertised definitions, for their schemas. */
function advertised() {
  return new Map(toolDefinitions().filter((tool) => SIX.has(tool.name)).map((tool) => [tool.name, tool]));
}

/** The first paragraph of a description: what a model reads to pick an action. */
function firstParagraph(text) {
  const description = typeof text === "string" ? text : "";
  const end = description.search(/\r?\n\s*\r?\n/);
  return (end === -1 ? description : description.slice(0, end)).trim();
}

/** Each family's granted actions, as `[name, entry]`, in the order the table lists them. */
function grantedActions(family, held, grants) {
  const table = family === "send" ? { ...ACTIONS.send, ...ASSISTANT_SEND_ACTIONS } : ACTIONS[family] || {};
  // Named grants are the whole of a surface's reach: a family they leave out allows nothing.
  const allowed = grants === null ? null : grants[family] ?? [];
  return Object.entries(table).filter(([name, entry]) => held.has(entry.tool) && (allowed === null || allowed.includes(name)));
}

const FAMILY_INTRO = {
  write:
    "Add to or change the person's notes. To save a note: write { path, content, expected_etag } (pass the etag you " +
    "read). Any other action: write { action, path, args }, its own arguments in args.",
  manage:
    "Change where something lives or who sees it, in ways Context can undo: manage { action, args }. Ask the person " +
    "before anything that lets more people see something.",
  send:
    "Do something outside Context: send { action, args }. Ask the person before anything that cannot be taken back.",
};

/** A family's tool, its description listing only what this turn may do with it. */
function familyTool(family, base, actions, held) {
  const lines = actions.map(([name, entry]) => {
    const carrier = held.get(entry.tool);
    const args = actionArguments(entry, carrier);
    const line = `- ${name}: ${entry.summary} args: ${args}`;
    // The assistant's own abilities, and a plain save, keep their own words:
    // what a browser step takes, how a routine is written.
    const own = family === "send" && Object.hasOwn(ASSISTANT_SEND_ACTIONS, name);
    const words = own ? carrier?.description : name === "save" ? firstParagraph(carrier?.description) : "";
    return words ? `${line}\n  ${words.replace(/\n/g, "\n  ")}` : line;
  });
  return { ...base, description: `${FAMILY_INTRO[family]}\n\nYour actions:\n${lines.join("\n")}` };
}

/** `fetch`, listing the assistant's own ids where it holds them. */
function fetchTool(base, held) {
  const extra = [];
  const skills = held.get("read_skill");
  if (skills) {
    const names = skills.inputSchema?.properties?.name?.enum ?? [];
    extra.push(`skill:<name> reads one of your skills in full (${names.join(", ")}). ${firstParagraph(skills.description)}`);
  }
  const learned = held.get("read_learned_skill");
  if (learned) extra.push(`learned:<name> reads a skill you wrote yourself. ${firstParagraph(learned.description)}`);
  if (held.has("earlier_texts")) {
    extra.push(`texts: reads this conversation's earlier texts. ${firstParagraph(held.get("earlier_texts").description)}`);
  }
  if (held.has("earlier_chat")) {
    extra.push(`chat: reads this group chat's earlier messages. ${firstParagraph(held.get("earlier_chat").description)}`);
  }
  if (extra.length === 0) return base;
  return { ...base, description: `${base.description}\n\nAlso:\n${extra.map((line) => `- ${line}`).join("\n")}` };
}

/**
 * The six over the tools a turn was granted.
 *
 * @param {object[]} granted the older tools this turn may call, each surface's guards already applied
 * @param {{write?: string[], manage?: string[], send?: string[]} | null} [grants] where a surface
 *   narrows further than its tools do, the actions it allows by name, every family it leaves out
 *   allowing none (the dream: `{ write: ["save"] }`); null allows every action the held tools carry
 * @returns {{tools: object[], resolve: (name: string, args: object) => {name?: string, args?: object, error?: string}}}
 */
export function sixToolsOver(granted, grants = null) {
  const held = new Map(granted.map((tool) => [tool.name, tool]));
  const base = advertised();
  const tools = [];
  if (held.has("orient")) tools.push(held.get("orient"));
  if (held.has("search_notes")) tools.push(base.get("search"));
  const fetchable = FETCH_CARRIERS.some((name) => held.has(name)) || ASSISTANT_FETCH_IDS.some((id) => held.has(id.tool));
  if (fetchable) tools.push(fetchTool(base.get("fetch"), held));
  const allowedActions = {};
  for (const family of ["write", "manage", "send"]) {
    const actions = grantedActions(family, held, grants);
    allowedActions[family] = new Set(actions.map(([name]) => name));
    if (actions.length > 0) tools.push(familyTool(family, base.get(family), actions, held));
  }

  function resolve(name, args) {
    // An older name is itself: the turn's allowlist decides it.
    if (!SIX.has(name)) return { name, args };
    const call = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    if (name === "orient") return { name, args: call };
    if (name === "fetch" && typeof call.id === "string") {
      const id = ASSISTANT_FETCH_IDS.find((entry) => call.id.startsWith(entry.prefix));
      if (id) return { name: id.tool, args: id.args(call.id.slice(id.prefix.length)) };
    }
    if (name === "write" || name === "manage" || name === "send") {
      const action = name === "write" && (call.action === undefined || call.action === "") ? "save" : call.action;
      if (typeof action === "string" && !allowedActions[name].has(action)) {
        // Called on the wrong family (write { action: "progress" }): run it where it lives,
        // under that family's own grants, rather than fail a step the turn may take.
        const home = ["write", "manage", "send"].find((family) => family !== name && allowedActions[family].has(action));
        if (home) return resolve(home, call);
        const list = [...allowedActions[name]].join(", ") || "none";
        return { error: `${name} has no action "${action.slice(0, 40)}" for you. Yours: ${list}.` };
      }
      const assistant = name === "send" ? ASSISTANT_SEND_ACTIONS[action] : undefined;
      if (assistant) return { name: assistant.tool, args: assistant.take(call) };
    }
    // The gateway's own translation, as for any connected app; never ChatGPT's search shape.
    const translated = translateV2Params({ name, arguments: call }, undefined, { app: { client: null } });
    if (translated.error) return { error: translated.error };
    return { name: translated.params.name, args: translated.params.arguments };
  }

  return { tools, resolve };
}

/**
 * The older tools a turn may call, before each surface narrows them: the
 * list every guard here is written against. And `orient`, answering on this
 * store, is told its caller holds the six, so it speaks their names.
 */
export async function grantedToolsFor(session, store) {
  store.offeredTools ??= () => toolsForSession(session, store);
  return toolsForSession(session, store, { shape: "v1" });
}
