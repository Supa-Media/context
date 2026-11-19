/**
 * THE CONTEXT A SPECIALIST DOOR READS (`doorTurn.js`, `doorTools.js`). A door reads only what its config node's `ctx`
 * list names (`fdQuick`, `fdRead`, `fdAct` in `packages/shared/src/texConfig.json`): a context part it names is kept,
 * every other part is dropped to its empty value, and the history keeps what `recent:<n>` names.
 * A door whose `ctx` names no context part reads the front door's whole context, as it always did.
 * Entries starting `p-` or `train:` are prompt modules (`texModules`), not context, and are ignored here. Unknown
 * entries (`date`, `tools`, `chat:7:130000`, `summaries:all:30000`) change nothing: the date line is always told, and
 * chat and summaries mean the full history.
 * Pure: imports only the door names.
 */
import { DOOR_NODES } from "./doorTools.js";

/** Each context part, and the runTurn option keys it keeps, with the empty value each key gets when it is dropped. */
export const DOOR_PARTS = Object.freeze({
  about: ["aboutMe", "identity", "voice"],
  jobs: ["jobs"],
  calendar: ["calendar"],
  mail: ["mail"],
  groups: ["groups"],
  workspaces: ["workspaces"],
  devShare: ["devShare"],
  examples: ["examples", "examplesBudgetMs", "examplesFallback"],
});

/** The empty value each option key takes when its part is dropped; `undefined` means the key is removed. */
const EMPTY = Object.freeze({
  aboutMe: null,
  identity: null,
  voice: null,
  jobs: null,
  calendar: null,
  mail: null,
  groups: "",
  workspaces: null,
  devShare: "",
  examples: null,
  examplesBudgetMs: undefined,
  examplesFallback: "",
});

/** The thread-note parts that are always kept: who is in the chat, and the chat's own rules. */
const ALWAYS_THREAD = new Set(["group", "cross", "instructions"]);

/** The non-prompt entries of a ctx list: strings that are neither `p-` prompt modules nor `train:` ones. */
export function doorContextParts(ctx) {
  if (!Array.isArray(ctx)) return [];
  return ctx.filter((entry) => typeof entry === "string" && !entry.startsWith("p-") && !entry.startsWith("train:"));
}

/** The history trimmed to its last `recent:<n>` turns, starting at a user turn; untouched when no `recent:` entry. */
function trimHistory(history, parts) {
  const entry = parts.map((part) => /^recent:(\d+)$/.exec(part)).find((match) => match !== null && Number(match[1]) >= 1 && Number(match[1]) <= 60);
  if (!entry || !Array.isArray(history)) return history;
  const n = Number(entry[1]);
  let kept = history.slice(-n);
  const first = kept.findIndex((turn) => turn?.role === "user");
  if (first !== -1) return kept.slice(first);
  // The last n hold no user turn: keep the last user turn onward, so the door never reads an empty history.
  const lastUser = history.findLastIndex((turn) => turn?.role === "user");
  return lastUser === -1 ? kept : history.slice(lastUser);
}

/** The thread note pairs with every part the ctx does not name blanked; a string stays as it is. */
function trimThread(threadNote, parts) {
  if (!Array.isArray(threadNote)) return threadNote;
  const threads = parts.includes("threads");
  return threadNote.map((pair) => (Array.isArray(pair) && !threads && !ALWAYS_THREAD.has(pair[0]) ? [pair[0], ""] : pair));
}

/**
 * The runTurn options a door runs with: `args` itself when the ctx names no context part, otherwise a copy with each
 * part the ctx does not name dropped, its thread note blanked and its history trimmed.
 */
export function doorArgs(args, ctx) {
  const parts = doorContextParts(ctx);
  if (parts.length === 0) return args;
  const out = { ...args };
  for (const [part, keys] of Object.entries(DOOR_PARTS)) {
    if (parts.includes(part)) continue;
    for (const key of keys) {
      if (EMPTY[key] === undefined) delete out[key];
      else out[key] = EMPTY[key];
    }
  }
  if ("threadNote" in args) out.threadNote = trimThread(args.threadNote, parts);
  if ("history" in args) out.history = trimHistory(args.history, parts);
  return out;
}

/** The `ctx` list of a door's node in the config (`DOOR_NODES`), or null when the node or its list is missing. */
export function doorCtxOf(config, door) {
  const id = DOOR_NODES[door];
  const node = Array.isArray(config?.nodes) ? config.nodes.find((candidate) => candidate?.id === id) : null;
  return Array.isArray(node?.ctx) ? node.ctx : null;
}
