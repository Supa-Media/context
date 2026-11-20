/**
 * Connect (`graph/nodes/connect.js`; Dev2, 2026-11-20: "it can't make connections to notes beyond names"): after a
 * turn that wrote notes, a model reads each written note and the notes the finder puts beside it (`related_notes`,
 * which reads what a note's prose is about), and names the few that share something real: a person, place or source,
 * the same story told again, a thread the person is following, a question it answers. Code writes each one both ways,
 * one line under the note's `## Connections` heading, `- [[Other note]]: why`, and never touches any other line, so
 * the person's words stay theirs. The model only reads; it can never write.
 *
 * What good is, as the bench scores it (`link` label lines, `apps/mcp/bench/noteLinks.mjs`): grounded in both notes,
 * says why on its own line, both ways, voice kept, and never a navigation or template link.
 */

import { builtinMeter, readWithEtag } from "./jobLog.js";
import { AgentRefusal, openProvider, runTurn } from "./turn.js";
import { builtinModel, canRunBuiltin } from "./builtin.js";
import { aiGatewayConfig } from "./aiGateway.js";
import { ProviderError } from "./providers.js";
import { TEX_CONFIG } from "./texConfig.js";

/** What the model may call: reads of their notes and the finder. Never a write. */
export const CONNECT_READS = Object.freeze(["read_note", "related_notes", "search_notes"]);
/** Notes one turn connects, links one note gets, and the model's rounds; the node's `limits` and `rounds` override. */
export const CONNECT_MAX_NOTES = 3;
export const CONNECT_MAX_LINKS = 4;
const CONNECT_ROUNDS = 8;
/** A reason's length on its line. */
const WHY_CHARS = 160;
/** Words that say where a link goes but not why (as the bench's `reasonOf`). */
const NAV_WORDS = new Set(["previous", "prev", "next", "chapter", "book", "see", "also", "related", "link", "links", "linked", "to", "from", "back", "up", "index", "parent", "connections", "connection", "and", "the", "a", "an", "of", "in", "same", "folder", "template", "note", "notes"]);

/** A note's name as a wiki link names it: its file name without `.md`. */
export function noteName(path) {
  return String(path ?? "").split("/").pop().replace(/\.md$/i, "");
}

/**
 * The notes a turn wrote that are the person's own writing: Markdown, not Tex's own files, not plumbing, not a
 * template. Each once, in the order written, at most `max`.
 */
export function notesToConnect(paths, max = CONNECT_MAX_NOTES) {
  const out = [];
  for (const path of Array.isArray(paths) ? paths : []) {
    if (typeof path !== "string" || !/\.md$/i.test(path) || out.includes(path)) continue;
    if (/^(tex|\.context|\.obsidian|inbox)\//i.test(path) || /(^|\/)templates?\//i.test(path) || /(^|\/)\./.test(path)) continue;
    out.push(path);
    if (out.length === max) break;
  }
  return out;
}

/** Whether a reason says something besides navigation words (three words or more). */
export function givesReason(why) {
  const words = String(why ?? "").toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((w) => w !== "" && !NAV_WORDS.has(w));
  return words.length >= 3;
}

/**
 * The model's answer as links: a JSON array of `{ from, to, why }`, `from` one of `seeds`, `to` any other note path,
 * `why` a reason on one line. Anything else is dropped, never repaired.
 */
export function linksOf(answer, seeds, maxPerNote = CONNECT_MAX_LINKS) {
  const text = String(answer ?? "");
  const start = text.indexOf("["), end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let list;
  try {
    list = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out = [], per = new Map();
  for (const entry of list) {
    const from = typeof entry?.from === "string" ? entry.from.trim() : "";
    const to = typeof entry?.to === "string" ? entry.to.trim() : "";
    const why = typeof entry?.why === "string" ? entry.why.replace(/\s+/g, " ").replace(/[[\]]/g, "").trim().slice(0, WHY_CHARS) : "";
    if (!seeds.includes(from) || !/\.md$/i.test(to) || to === from || noteName(to) === noteName(from)) continue;
    if (/(^|\/)templates?\//i.test(to) || /^(tex|\.context)\//i.test(to) || !givesReason(why)) continue;
    if (out.some((l) => l.from === from && l.to === to)) continue;
    if ((per.get(from) ?? 0) >= maxPerNote) continue;
    per.set(from, (per.get(from) ?? 0) + 1);
    out.push({ from, to, why });
  }
  return out;
}

/** Whether `body` already links to the note named `name`. */
export function linksTo(body, name) {
  const want = name.toLowerCase();
  for (const match of String(body ?? "").matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
    if (match[1].trim().split("/").pop().replace(/\.md$/i, "").toLowerCase() === want) return true;
  }
  return false;
}

/**
 * `body` with `- [[name]]: why` at the end of its `## Connections` section (one is added at the end when there is
 * none), every other line as it was; null when it already links there.
 */
export function withConnection(body, name, why) {
  const text = String(body ?? "");
  if (linksTo(text, name)) return null;
  const line = `- [[${name}]]: ${why}`;
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^#{1,6}\s+connections\s*$/i.test(l.trim()));
  if (at === -1) return `${text.replace(/\s*$/, "")}\n\n## Connections\n\n${line}\n`;
  const level = /^(#+)/.exec(lines[at].trim())[1].length;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i += 1) {
    const heading = /^(#+)\s/.exec(lines[i]);
    if (heading && heading[1].length <= level) {
      end = i;
      break;
    }
  }
  let last = end;
  while (last > at + 1 && lines[last - 1].trim() === "") last -= 1;
  const before = lines.slice(0, last), after = lines.slice(last);
  if (last === at + 1) before.push("");
  return [...before, line, ...(after.length > 0 && after[0].trim() !== "" ? [""] : []), ...after].join("\n");
}

/** The connect model's dispatcher: only `CONNECT_READS`, in their own workspace. */
export function connectCallTool(dispatch) {
  return async (name, args) => {
    const given = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    if (!CONNECT_READS.includes(name)) return { isError: true, content: [{ type: "text", text: `Connect only reads: ${name} can't be used.` }] };
    if (given.context !== undefined) return { isError: true, content: [{ type: "text", text: "Only their own workspace: leave context out." }] };
    return await dispatch(name, given);
  };
}

/** What the model is asked: the written notes, what the person said, and the finder's notes beside each. */
export function connectQuestion(seeds, { question, nearby }) {
  return [
    "This is Tex connecting the person's notes after a turn, not a text from a person. Nobody is waiting, and nothing you say is texted.",
    "The notes below were just written. For each, find the few other notes of theirs that share something real with it: the same person, place or source; the same story or pattern told again; a thread they are following across notes; a question one of them asks that the other answers. Read a note before you name it (read_note), and use related_notes or search_notes to look further.",
    "Never a link by name, number or folder alone (the next chapter, a note made from the same template). If the person said this turn how two notes connect, that link comes first, in their words.",
    "Answer with only a JSON array, at most four links per note, best first: " +
      '[{"from": "Study/Judges/Judges 19.md", "to": "Study/Genesis/Genesis 19.md", "why": "the same crowd at the door of a guest\'s house, told again in Gibeah"}]. ' +
      "`why` is one short line in plain words that says what the two share. If nothing real connects, answer [].",
    question ? `## What the person said this turn\n\n${String(question).slice(0, 2_000)}` : "",
    ...seeds.map((path) => `## ${path}\n\nBeside it (related_notes): ${nearby.get(path) || "(none found)"}`),
  ].filter(Boolean).join("\n\n");
}

/** Write `why` into the note at `path` as a link to `name`; the outcome word. */
async function connectOne(dispatch, path, name, why) {
  const note = await readWithEtag(dispatch, path);
  if (note === null || note.missing) return "unread";
  const text = withConnection(note.body, name, why);
  if (text === null) return "had";
  const written = await dispatch("write_note", { path, content: text, expected_etag: note.etag }).catch(() => null);
  return written && written.isError !== true ? "written" : "refused";
}

/**
 * Connect the notes a turn wrote. Answers `{ outcome, ... }`: "nothing_written", "tainted", "group", "no_links", "connected"
 * (with `links`: each `{ from, to, why, there, back }`), or a refusal ("daily_limit", "no_provider",
 * "model_unavailable").
 */
export async function connectNotes({ env, controlPlane, session, dispatch, offered, paths, question, tainted = false, group = false, timeZone, now = Date.now(), node = null }) {
  const limits = node?.limits ?? {};
  const seeds = notesToConnect(paths, limits.notes ?? CONNECT_MAX_NOTES);
  if (seeds.length === 0) return { outcome: "nothing_written" };
  // Words from outside (a page, an email) never steer what is written into their notes.
  if (tainted) return { outcome: "tainted", notes: seeds.length };
  // A group chat's words are several people's: none of them steers what is written into one person's notes.
  if (group) return { outcome: "group", notes: seeds.length };
  const nearby = new Map();
  for (const path of seeds) {
    const found = await dispatch("related_notes", { path, limit: 8 }).catch(() => null);
    const text = (Array.isArray(found?.content) ? found.content : []).map((p) => p?.text ?? "").join("\n");
    nearby.set(path, found?.isError === true ? "" : text.split("\n").filter((l) => l && !/^may be incomplete/.test(l)).join("; "));
  }
  try {
    await openProvider(controlPlane, session, undefined, env);
  } catch (error) {
    if (error instanceof AgentRefusal) return { outcome: error.code === "daily_limit" ? "daily_limit" : "no_provider" };
    return { outcome: "model_unavailable" };
  }
  const wanted = typeof node?.model === "string" ? TEX_CONFIG.models?.[node.model] : null;
  const chosen = typeof wanted === "string" && canRunBuiltin(wanted, env) ? wanted : null;
  const model = chosen ?? builtinModel(env);
  const meter = builtinMeter(controlPlane, session, model, now);
  let turn;
  try {
    turn = await runTurn({
      question: connectQuestion(seeds, { question, nearby }),
      tools: (Array.isArray(offered) ? offered : []).filter((tool) => CONNECT_READS.includes(tool.name)),
      grants: { write: [] },
      callTool: connectCallTool(dispatch),
      sandboxedBelow: true, // reads only, refused above before the session's dispatcher
      env,
      builtinModelOverride: chosen,
      providerOptions: { ai: env.AI, gateway: aiGatewayConfig(env), metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "note_connect" } },
      localNow: { now, timeZone },
      maxRounds: node?.rounds ?? CONNECT_ROUNDS,
      roundCap: Math.max(node?.rounds ?? CONNECT_ROUNDS, CONNECT_ROUNDS),
    });
  } catch (error) {
    await meter(null, true, error instanceof ProviderError ? error.model : model);
    if (!(error instanceof ProviderError)) throw error;
    return { outcome: "model_unavailable", model: error.model ?? model };
  }
  await meter(turn.usage, false, turn.model);
  const links = linksOf(turn.answer, seeds, limits.links ?? CONNECT_MAX_LINKS);
  if (links.length === 0) return { outcome: "no_links", notes: seeds.length, model: turn.model };
  return { outcome: "connected", notes: seeds.length, model: turn.model, links: await writeLinks(dispatch, links) };
}

/**
 * Write each link both ways, each with its outcome (`there`, `back`: "written", "had", "refused", "unread",
 * "skipped"). The far note first: a note the model named that is not there, or not theirs to read, gets no link at all.
 */
export async function writeLinks(dispatch, links) {
  const done = [];
  for (const link of links) {
    const back = await connectOne(dispatch, link.to, noteName(link.from), link.why);
    const there = back === "unread" ? "skipped" : await connectOne(dispatch, link.from, noteName(link.to), link.why);
    done.push({ ...link, there, back });
  }
  return done;
}
