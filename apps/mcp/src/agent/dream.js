/**
 * TEX'S NIGHTLY DREAM (owner, 2026-10-15).
 *
 * "There should be a folder inside tex called dreams … we run a nightly job
 * that … updates [about-me] … log the transcript of what exactly the dream
 * changed … set this up for all users so that they have a smarter Tex."
 *
 * Once a night, when the person texted Tex since the last dream (or never had
 * one), the control plane hands the texting Worker a short-lived grant for the
 * `context_dreams` client on their personal workspace, and the Worker asks
 * `/agent` to dream. This file is that turn:
 *
 *   1. It finds the day's transcripts (`tex/transcripts/`, `transcript.js`)
 *      written since the last dream, and reads `tex/about-me.md` (`aboutMe.js`).
 *      With no note yet it is a first look: it also looks around their
 *      workspace and always starts the note (`FIRST_LOOK`).
 *   2. A model reads them and rewrites `tex/about-me.md`, under the same
 *      500-line cap every write to it has. It may read their notes and write
 *      that one note, and nothing else: no other note, no other workspace, no
 *      visibility, no link, no web, no text to anyone.
 *   3. The gateway, by date and never by the model, moves each learned skill
 *      unused for 60 days to `tex/skills/retired/` (`learnedSkills.js`).
 *   4. The gateway reads the note again and writes `tex/dreams/YYYY-MM-DD.md`:
 *      the lines it added and removed, the model's own account of why, and
 *      every step it took (its thinking and tool calls, never a tool's result),
 *      the same way a day's transcript is written.
 *
 * Everything goes through the session's own dispatcher, so the privacy engine,
 * the note's history and the audit trail see it like any other write, and it
 * is attributed to the dreams client. The control plane hears an outcome code.
 */

import { ABOUT_ME_PATH, readAboutMe } from "./aboutMe.js";
import { DEFAULT_TIME_ZONE, readTimeZone } from "./localNow.js";
import { TRANSCRIPTS_FOLDER, eventLines } from "./transcript.js";
import { AgentRefusal, openProvider, runTurn } from "./turn.js";
import { BUILTIN_PROVIDER, builtinModel, canRunBuiltin } from "./builtin.js";
import { aiGatewayConfig } from "./aiGateway.js";
import { ProviderError } from "./providers.js";
import { actorFor, contextsFor } from "../context/identity.js";
import { PRODUCTION_DREAM_PATH, readJobSetup } from "./production.js";
import { callToolForSession } from "../tools/session.js";
import { grantedToolsFor } from "./sixTools.js";
import { newLedger } from "../privacy/egress.js";
import { json } from "../http/responses.js";
import { appendLogEntry, builtinMeter, clock, dayOf, longDate } from "./jobLog.js";
import { RETIRED_SKILLS_FOLDER, UNUSED_SKILL_DAYS, retireUnusedSkills } from "./learnedSkills.js";

/** The dream runner's first-party client (`apps/convex/functions/lib/dreams/model.ts`). Decided by the grant. */
export const DREAMS_CLIENT_ID = "context_dreams";

export const DREAMS_FOLDER = "tex/dreams";

/** The most transcript notes one dream is pointed at, newest kept. */
export const MAX_DREAM_TRANSCRIPTS = 6;
/** A first dream (or one whose `since` is unknown) looks back this many days. */
export const FIRST_DREAM_DAYS = 3;
const DREAM_ROUNDS = 12;
/** A first dream also takes a first look around their workspace, so it gets more rounds. */
export const FIRST_DREAM_ROUNDS = 20;
const MAX_WHY_CHARS = 4_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What the model may call. Reading their own notes, and writing one. */
const DREAM_READS = new Set(["read_note", "list_notes"]);
const DREAM_WRITE_ARGS = new Set(["path", "content", "expected_etag"]);

/** Tonight's log: `tex/dreams/2026-10-16.md`, dated the night it ran, in their zone. */
export function dreamPath(now, timeZone) {
  return `${DREAMS_FOLDER}/${dayOf(now, timeZone)}.md`;
}

/**
 * The transcript notes a dream reads, from a `list_notes` answer: the days
 * from `since` (or the last `FIRST_DREAM_DAYS`) to today, oldest first, at
 * most `MAX_DREAM_TRANSCRIPTS`, newest kept.
 */
export function transcriptsToRead(listing, { since, now, timeZone }) {
  const from = dayOf(typeof since === "number" ? since : now - (FIRST_DREAM_DAYS - 1) * DAY_MS, timeZone);
  const to = dayOf(now, timeZone);
  const found = [];
  const pattern = new RegExp(`^(${TRANSCRIPTS_FOLDER}/(\\d{4}-\\d{2}-\\d{2})(?:-(\\d+))?\\.md) \\(`);
  for (const line of String(listing ?? "").split("\n")) {
    const match = pattern.exec(line.trim());
    if (!match || match[2] < from || match[2] > to) continue;
    found.push({ path: match[1], day: match[2], part: Number(match[3] ?? 1) });
  }
  found.sort((a, b) => (a.day === b.day ? a.part - b.part : a.day < b.day ? -1 : 1));
  return found.slice(-MAX_DREAM_TRANSCRIPTS).map((entry) => entry.path);
}

function refused(text) {
  return { isError: true, content: [{ type: "text", text }] };
}

/**
 * The dream's dispatcher: their own notes to read, and `tex/about-me.md` to
 * write, with nothing but its text and etag. Everything else is refused here,
 * before the session's dispatcher is reached, so a dream steered by something
 * it read can still only change the one note it is for.
 */
export function dreamCallTool(dispatch) {
  return async (name, args) => {
    const given = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    if (given.context !== undefined) return refused("A dream works in their own workspace only.");
    if (DREAM_READS.has(name)) return await dispatch(name, given);
    if (name !== "write_note") return refused(`A dream can't use ${name}.`);
    if (given.path !== ABOUT_ME_PATH) return refused(`A dream writes only ${ABOUT_ME_PATH}.`);
    const extra = Object.keys(given).filter((key) => given[key] !== undefined && !DREAM_WRITE_ARGS.has(key));
    if (extra.length > 0) return refused(`A dream writes only the note's text: ${extra.join(", ")} can't be set.`);
    if (typeof given.content !== "string") return refused("Write the whole note as content.");
    return await dispatch("write_note", {
      path: ABOUT_ME_PATH,
      content: given.content,
      ...(typeof given.expected_etag === "string" ? { expected_etag: given.expected_etag } : {}),
    });
  };
}

/** The tools a dream is offered: the session's own definitions of the four it may call. */
export function dreamTools(offered) {
  return offered.filter((tool) => DREAM_READS.has(tool.name) || tool.name === "write_note");
}

/**
 * The dream's own words when `ai/production/dream.md` is missing or does not
 * validate. The note's body replaces these (the owner, 2026-10-17: "move the
 * prompt into a note for me"); what tonight is about (the days and the
 * transcripts) is always added below them by `dreamQuestion`.
 */
export const DREAM_INSTRUCTIONS = [
  "This is your nightly dream, not a text from a person. Nobody is waiting, and nothing you say is texted to anyone.",
  `Your one job: bring ${ABOUT_ME_PATH} up to date with what you learned about them in the transcripts listed under Tonight.`,
  "Keep what lasts: who they are, the people in their life and how they relate, what they're working on, preferences, how they like you to answer, corrections they gave you, places and routines. " +
    "Leave out one-off requests, anything already done and finished, anything they asked you to forget, and every secret (passwords, codes, card or account numbers): never write those.",
  "Write the whole note back once with write: fetch it first and pass its etag as expected_etag. Short headings, one short line per fact, duplicates merged, stale or contradicted lines dropped, never more than 500 lines. If nothing new is worth keeping, don't write it.",
  "Then answer with two or three plain sentences for the dream log: what you changed and why, or why nothing changed.",
].join("\n\n");

/**
 * A first dream's extra words: `tex/about-me.md` does not exist yet, so it
 * takes a first look around their workspace and starts the note from that,
 * even with no texts to read (the owner, 2026-10-17: "some users do not have
 * an about me and a first look at their workspaces"). Before this a first
 * dream read only `index.md`, and with no front page and no texts it wrote
 * nothing, which left them without the note for good.
 */
export const FIRST_LOOK = [
  `This is your first dream about them, and ${ABOUT_ME_PATH} doesn't exist yet. Take a first look at their workspace before you write:`,
<<<<<<< HEAD
  "list_notes with no prefix for the whole map; index.md, their front page, if it exists; then their newest notes in their projects and areas folders, and their newest mail in inbox/email/ if there is any.",
=======
  "list_notes with no prefix for the whole map; index.md, their front page, if it exists; then their newest notes in their projects and areas folders. Their mail is not in their notes, and a stranger's words never go in this note.",
>>>>>>> origin/main
  `Then write a first ${ABOUT_ME_PATH} from what you found: who they are, what they work on, the people around them, how they keep their notes. ` +
    "Start it even if you learn only a little, and mark a guess as a guess. Never leave it unwritten on a first dream.",
].join(" ");

/**
 * What the dream is asked to do: the setup's words (`instructions`, the
 * production note's body) or the built-in ones, then tonight's facts.
 */
export function dreamQuestion({ transcripts, first, since, timeZone, instructions = null }) {
  const when = first || typeof since !== "number" ? "lately" : `since ${dayOf(since, timeZone)}`;
  const tonight = [
    `Bring ${ABOUT_ME_PATH} up to date with what you learned about them ${when}.`,
    transcripts.length > 0
      ? `Read these transcripts of your texts with them (tool calls and thinking included, never what a tool returned):\n${transcripts.map((path) => `- ${path}`).join("\n")}`
      : "There are no transcripts of your texts with them yet.",
    first ? FIRST_LOOK : "",
  ].filter(Boolean);
  const words = typeof instructions === "string" && instructions.trim() !== "" ? instructions.trim() : DREAM_INSTRUCTIONS;
  return [words, "## Tonight", ...tonight].join("\n\n");
}

/** The lines added to and removed from the note, ignoring blank lines and order. */
export function aboutMeChanges(before, after) {
  const lines = (text) =>
    String(text ?? "")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== "");
  const count = (list) => {
    const counts = new Map();
    for (const line of list) counts.set(line, (counts.get(line) ?? 0) + 1);
    return counts;
  };
  const was = count(lines(before));
  const now = count(lines(after));
  const added = [];
  const removed = [];
  for (const line of lines(after)) {
    if ((was.get(line) ?? 0) > 0) was.set(line, was.get(line) - 1);
    else added.push(line);
  }
  for (const line of lines(before)) {
    if ((now.get(line) ?? 0) > 0) now.set(line, now.get(line) - 1);
    else removed.push(line);
  }
  return { added, removed };
}

function heading(now, timeZone) {
  return (
    `# Tex dreamed, ${longDate(now, timeZone)}\n\n` +
    `What Tex's nightly dream read, thought and changed in \`${ABOUT_ME_PATH}\`.\n`
  );
}

const asCode = (line) => `\`${line.replace(/`/g, "'")}\``;

/** One dream's part of the night's log. */
export function dreamEntry({ now, timeZone, transcripts, model, changes, why, events, outcome, retired = [] }) {
  const lines = [`## ${clock(now, timeZone)}`, ""];
  lines.push(
    transcripts.length > 0
      ? `_Read ${transcripts.map((path) => `\`${path}\``).join(", ")}${model ? `, on ${model}` : ""}._`
      : `_No transcripts to read${model ? `; on ${model}` : ""}._`,
    "",
    `### What changed in \`${ABOUT_ME_PATH}\``,
    "",
  );
  if (changes.added.length === 0 && changes.removed.length === 0) {
    lines.push(outcome === "failed" ? "_Nothing: the dream did not finish._" : "_Nothing changed._");
  } else {
    for (const line of changes.added) lines.push(`- Added ${asCode(line)}`);
    for (const line of changes.removed) lines.push(`- Removed ${asCode(line)}`);
  }
  if (retired.length > 0) {
    lines.push("", "### Skills retired", "", `_Unused for ${UNUSED_SKILL_DAYS} days, moved to \`${RETIRED_SKILLS_FOLDER}/\`; move one back to use it again._`, "");
    for (const name of retired) lines.push(`- ${asCode(name)}`);
  }
  const said = String(why ?? "").trim();
  if (said) lines.push("", "### Why", "", said.length > MAX_WHY_CHARS ? `${said.slice(0, MAX_WHY_CHARS)}…` : said);
  const steps = events.map(eventLines).filter(Boolean);
  if (steps.length > 0) lines.push("", "### How it went", "", ...steps.map((step) => step.replace(/\n$/, "")));
  return `${lines.join("\n")}\n`;
}

/** Write tonight's entry after whatever the night's log already holds. Best effort. */
function writeLog(dispatch, path, entry, { now, timeZone }) {
  return appendLogEntry(dispatch, path, entry, heading(now, timeZone));
}

/**
 * `/agent` for the dreams client (`http/route.js` sends it here by the
 * grant's client, never by the body): it dreams, and does nothing else. A
 * `dream` body from any other client goes to the ordinary turn, which has
 * no use for it.
 */
export async function handleDream(request, env, store, session, controlPlane) {
  if (session.actorClientId !== DREAMS_CLIENT_ID) return json({ error: "invalid_request", error_description: "Only Tex's dreams dream." }, 403);
  let body = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const asked = body?.dream !== undefined && body.dream !== null && typeof body.dream === "object" && !Array.isArray(body.dream);
  if (!asked) return json({ error: "invalid_request", error_description: "This connection only dreams." }, 400);

  store.actor = actorFor(session);
  store.contexts = contextsFor(session);
  // Nothing a dream reads is sent anywhere, and the one thing it writes is in their own workspace.
  session.egress = { complete: true, ledger: newLedger(), texting: false };
  const dispatch = (name, args) => callToolForSession({ name, arguments: args }, store, session);

  const timeZone = readTimeZone(body.dream.timeZone) ?? DEFAULT_TIME_ZONE;
  const since = typeof body.dream.since === "number" && Number.isFinite(body.dream.since) ? body.dream.since : null;
  const started = Date.now();
  const listed = await dispatch("list_notes", { prefix: TRANSCRIPTS_FOLDER }).catch(() => null);
  const listing = listed?.isError === true ? "" : (listed?.content ?? []).map((part) => part?.text ?? "").join("\n");
  const transcripts = transcriptsToRead(listing, { since, now: started, timeZone });
  const before = await readAboutMe(dispatch);
  // No note yet is a first dream, whatever `since` says: an earlier first dream
  // that wrote nothing must not leave them without one.
  const first = before === "";
  // Nothing new to read and a note already started: tonight is quiet, and costs no model turn.
  if (transcripts.length === 0 && !first) return json({ outcome: "nothing_new" });

  try {
    await openProvider(controlPlane, session, undefined, env);
  } catch (error) {
    if (error instanceof AgentRefusal && error.code === "daily_limit") return json({ error: "daily_limit" }, 429);
    if (error instanceof AgentRefusal) return json({ error: error.code }, 409);
    return json({ error: "model_unavailable" }, 503);
  }

  // Learned skills nobody used in 60 days leave the index, by date and never by the model (`learnedSkills.js`).
  const retired = await retireUnusedSkills(dispatch, started);
  const events = [];
  const offered = await grantedToolsFor(session, store);
  // The dream's setup note (`ai/production/dream.md`): its words, and its model
  // when this deployment can call it. Missing or invalid is the built-in ones.
  const setup = await readJobSetup(store, session, PRODUCTION_DREAM_PATH);
  const chosen = setup !== null && canRunBuiltin(setup.model, env) ? setup.model : null;
  const model = chosen ?? builtinModel(env);
  const meter = builtinMeter(controlPlane, session, model, started);

  let turn = null;
  try {
    turn = await runTurn({
      question: dreamQuestion({ transcripts, first, since, timeZone, instructions: setup?.prompt ?? null }),
      tools: dreamTools(offered),
      grants: { write: ["save"] }, // its one write is the note's own text (`dreamCallTool`)
      callTool: dreamCallTool(dispatch),
      env,
      builtinModelOverride: chosen,
      providerOptions: {
        ai: env.AI,
        gateway: aiGatewayConfig(env),
        metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "dreams", ...(setup !== null ? { setup: setup.version } : {}) },
      },
      aboutMe: before,
      localNow: { now: started, timeZone },
      observe: (event) => events.push(event),
      maxRounds: first ? FIRST_DREAM_ROUNDS : DREAM_ROUNDS,
      // Without this, runTurn's default cap (8) would silently cut both down.
      roundCap: FIRST_DREAM_ROUNDS,
    });
  } catch (error) {
    await meter(null, true, error instanceof ProviderError ? error.model : model);
    console.log(
      JSON.stringify({
        event: "dream",
        workspace: session.workspaceId,
        grant: session.grantId,
        outcome: "failed",
        ...(error instanceof ProviderError ? { reason: error.reason, status: error.status } : {}),
      }),
    );
    if (!(error instanceof ProviderError)) throw error;
  }
  if (turn !== null) await meter(turn.usage, false, turn.model);

  const after = await readAboutMe(dispatch);
  const changes = aboutMeChanges(before, after);
  const changed = changes.added.length > 0 || changes.removed.length > 0;
  const outcome = turn === null || turn.exhausted ? (changed ? "dreamed" : "failed") : changed ? "dreamed" : "unchanged";
  const now = Date.now();
  const entry = dreamEntry({
    now,
    timeZone,
    transcripts,
    model: turn?.model ?? null,
    changes,
    why: turn?.answer ?? "",
    events,
    outcome,
    retired,
  });
  const logged = await writeLog(dispatch, dreamPath(now, timeZone), entry, { now, timeZone });
  console.log(
    JSON.stringify({
      event: "dream",
      workspace: session.workspaceId,
      grant: session.grantId,
      provider: BUILTIN_PROVIDER,
      outcome,
      transcripts: transcripts.length,
      added: changes.added.length,
      removed: changes.removed.length,
      retired: retired.length,
      logged,
      ms: now - started,
    }),
  );
  if (outcome === "failed") return json({ error: "model_unavailable", outcome }, 502);
  return json({ outcome, steps: turn?.steps ?? [] });
}
