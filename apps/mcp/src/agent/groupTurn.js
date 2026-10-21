/**
 * Tex in an iMessage group chat: what a group turn may do, what it is told,
 * and what it remembers (docs/decisions/texting-assistant/groups.md).
 *
 * The grant decides everything that matters before this module runs. A group
 * turn's grant (`context_texts_group`, `apps/convex/functions/textGroups.ts`)
 * reaches exactly one shared workspace, the one every person in the chat is a
 * member of, at the `team` tier with no granted names, and it stops resolving
 * the moment anyone in the chat leaves that workspace or pauses texting. So
 * the reads here are the ordinary read tools and nothing is filtered twice.
 *
 * What this module narrows is the rest of the texting assistant. A group
 * turn has no computer, no web search, no email, no routines, no delegation,
 * no progress texts and none of the tagger's own `tex/` notes: each of those
 * is somebody's alone, and a group answer is read by everyone in it. Its
 * writes are create and append only, because a note one person in the chat
 * cares about is not another's to rewrite on their say-so.
 *
 * Memory is the chat's own, kept in the bound workspace under `.context/`
 * (plumbing, never a note) and filed by the chat and the exact set of people
 * in it: somebody added later starts a new memory rather than reading what
 * was said before they joined.
 */

import { isWritablePath } from "./textingWrites.js";
import { routineRootOf } from "../../../../packages/shared/src/routines.cjs";
import { toolError } from "../tools/results.js";

/** The group texting client (`apps/convex/functions/textGroups.ts`). */
export const TEXTS_GROUP_CLIENT_ID = "context_texts_group";

/** Where a chat's memory is kept, in the bound workspace. */
export const GROUP_MEMORY_PREFIX = ".context/agent/groups/";
/** How much of a chat is kept: a group needs the thread, not a year of it. */
export const MAX_GROUP_TURNS = 60;
export const MAX_GROUP_CHARS = 30_000;

const HEX64 = /^[0-9a-f]{64}$/;
/** A handle as `functions/lib/names.ts` allows one. */
const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;

export function isGroupSession(session) {
  return session?.actorClientId === TEXTS_GROUP_CLIENT_ID;
}

/**
 * The chat a group turn is in, from the Worker: `key` (the line and Sendblue's
 * group id, hashed), `members` (the participant set, hashed) and `from` (the
 * tagger's handle). Hashes only: no phone number reaches the gateway. Null
 * when any of it is missing or malformed.
 */
export function groupOf(body) {
  const group = body?.group;
  if (group === null || typeof group !== "object" || Array.isArray(group)) return null;
  if (!HEX64.test(group.key ?? "") || !HEX64.test(group.members ?? "")) return null;
  const from = typeof group.from === "string" && HANDLE.test(group.from) ? group.from : "";
  return { key: group.key, members: group.members, from };
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The chat's memory file: one per chat and set of people in it. */
export async function groupMemoryPath(group) {
  return `${GROUP_MEMORY_PREFIX}${await sha256Hex(`${group.key}:${group.members}`)}.json`;
}

function isTurn(value) {
  return value !== null && typeof value === "object" && (value.role === "user" || value.role === "assistant") && typeof value.text === "string";
}

/** The newest turns that fit both bounds, oldest first, starting on a question. */
export function trimGroupTurns(turns) {
  const kept = [];
  let room = MAX_GROUP_CHARS;
  for (let i = turns.length - 1; i >= 0 && kept.length < MAX_GROUP_TURNS; i -= 1) {
    room -= turns[i].text.length;
    if (room < 0) break;
    kept.unshift(turns[i]);
  }
  while (kept.length > 0 && kept[0].role !== "user") kept.shift();
  return kept;
}

/** The chat's memory, or none. A memory that cannot be read is an empty one, never a failed answer. */
export async function readGroupMemory(store, group) {
  try {
    const object = await store.get(await groupMemoryPath(group));
    if (!object) return [];
    const parsed = JSON.parse(await object.text());
    const turns = Array.isArray(parsed?.turns) ? parsed.turns.filter(isTurn) : [];
    return trimGroupTurns(turns.map(({ role, text, tainted }) => ({ role, text, ...(tainted === true ? { tainted: true } : {}) })));
  } catch {
    return [];
  }
}

/** Who asked, as the chat's memory files it: their handle, so a later turn knows which of them said it. */
export function groupQuestionLine(group, question) {
  return group.from ? `@${group.from}: ${question}` : question;
}

/** One exchange added to the chat's memory. */
export async function keepGroupExchange(store, group, history, question, answer, { tainted = false } = {}) {
  const turns = trimGroupTurns([
    ...history,
    { role: "user", text: groupQuestionLine(group, question) },
    { role: "assistant", text: answer, ...(tainted ? { tainted: true } : {}) },
  ]);
  await store.put(await groupMemoryPath(group), JSON.stringify({ version: 1, turns }));
}

/** What a group turn is told, after the built-in words. */
export function groupPrompt(group, workspace) {
  const where = workspace ? `@${workspace}` : "one shared workspace";
  const who = group.from ? `@${group.from} tagged you` : "Someone tagged you";
  return (
    `\n\nTHIS IS AN IMESSAGE GROUP CHAT. ${who}, and everyone in the chat reads your answer. ` +
    `You can read only ${where}, the shared workspace every person here is a member of, and only what its whole team can see. ` +
    "Nobody's personal notes, email, calendar or saved logins are reachable from here, so never offer them; " +
    "say the person can text you on their own for that. " +
    "You can make a new note there or add one fact to a note, and never change, move or delete one that exists. " +
    "You can't browse the web, send email, set reminders or text anyone from a group. " +
    "Answer the person who tagged you, in a line or two; the others didn't ask."
  );
}

const WRITE_DESCRIPTION =
  "Create a new markdown note in this chat's shared workspace. It never changes a note that already exists: " +
  "pick a new path, or add a line to an existing note with remember.";
const REMEMBER_DESCRIPTION =
  "Add one fact, a single plain line, to a note in this chat's shared workspace (or a new note when note is left out). " +
  "It adds and never replaces.";

/** The fields each group write tool takes, and nothing else. */
const GROUP_FIELDS = {
  write_note: ["path", "content"],
  remember: ["fact", "kind", "note"],
};

function narrowed(tool) {
  const fields = GROUP_FIELDS[tool.name];
  const schema = tool.inputSchema ?? { type: "object", properties: {} };
  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([key]) => fields.includes(key)));
  const required = tool.name === "write_note" ? ["path", "content"] : (schema.required ?? []).filter((key) => fields.includes(key));
  return {
    ...tool,
    description: tool.name === "write_note" ? WRITE_DESCRIPTION : REMEMBER_DESCRIPTION,
    inputSchema: { ...schema, properties, required, additionalProperties: false },
  };
}

/**
 * The write tools a group turn adds: `write_note` (create only) and
 * `remember` (append only), each only when the grant itself was offered it,
 * so a member's read-only grant gets neither.
 */
export function groupWriteTools(offered) {
  return offered.filter((tool) => Object.hasOwn(GROUP_FIELDS, tool.name)).map(narrowed);
}

/** Why a group write is refused, or null to let it through. */
function refusalFor(name, args) {
  const extra = Object.keys(args).filter((key) => !GROUP_FIELDS[name].includes(key));
  if (extra.length > 0) return `${extra.join(", ")} can't be passed from a group chat.`;
  for (const path of [args.path, args.note].filter((value) => value !== undefined)) {
    if (!isWritablePath(path)) return "That path can't be used: hidden folders and privacy.md are not editable here.";
    if (routineRootOf(path) !== null) return "Reminders and routines can't be set from a group chat. Text me on your own for one.";
  }
  return null;
}

/**
 * The dispatcher a group turn calls through: group write tools pass only
 * their own fields, on ordinary paths, and `write_note` only for a path no
 * note is at. Everything else goes to the client's own dispatcher as is; it
 * is still the one that decides what this grant may reach.
 */
export function groupAwareCallTool(callTool, writeTools) {
  const writes = new Set(writeTools.map((tool) => tool.name));
  return async (name, args) => {
    // A write tool this turn wasn't given is the turn's allowlist's to refuse; never passed on wider.
    if (Object.hasOwn(GROUP_FIELDS, name) && !writes.has(name)) return toolError(`${name} isn't available in this group chat.`);
    if (!writes.has(name)) return callTool(name, args);
    const given = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const refusal = refusalFor(name, given);
    if (refusal) return toolError(refusal);
    if (name === "write_note") {
      /*
        Create only. A note this grant cannot see answers "not found" too, and
        the dispatcher's own write refuses a path it may not reach; anything
        else from the read (a note, or an error that is not "not found")
        means there is something at that path, and it stays as it is.
      */
      const existing = await callTool("read_note", { path: given.path });
      const said = existing?.content?.[0]?.text ?? "";
      if (!(existing?.isError === true && /not found/i.test(said))) {
        return toolError(`There's already a note at ${given.path}. From a group chat I can only make new notes, or add a line with remember.`);
      }
    }
    return callTool(name, given);
  };
}
