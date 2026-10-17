/**
 * TEX KEEPS HOUSE (owner, 2026-10-17).
 *
 * "A proactive and consistent … in the same proactive loop as a workspace
 * heartbeat … going in and fiercely organizing things, updating project
 * statuses, archiving, getting the chaos score lower … finished projects that
 * should be moved to archive … contacts that need to be merged … folders that
 * only have one file." Built from scratch rather than on the app's
 * auto-organize suggestions, at the owner's word ("I'd rather you start from
 * scratch").
 *
 * One run is one model turn over their own workspace:
 *
 *   1. The gateway reads the workspace's health (`orient about: health`, the
 *      chaos score and its biggest wins) and hands it to the model with the
 *      Supa way of organizing (PARA: inbox, projects, areas, resources,
 *      archive) and the jobs, most valuable first.
 *   2. The model reads what it needs and changes what it is sure of, through
 *      `housekeepingGuard.js`: moves, archives and rewrites of existing notes,
 *      never anything that widens who sees what, never another workspace.
 *   3. The gateway reads the score again and writes `tex/housekeeping/
 *      YYYY-MM-DD.md`: the score before and after, every change with the line
 *      that puts it back, the model's own account, and every step it took.
 *
 * The caller (the workspace heartbeat, which owns when this runs) gets the
 * outcome, the count, the score before and after and one plain sentence it
 * may text the person. Everything goes through the session's own dispatcher,
 * so the privacy engine, each note's history and the audit trail see it like
 * any other change, attributed to the client that ran it.
 */

import { DEFAULT_TIME_ZONE, readTimeZone } from "./localNow.js";
import { eventLines } from "./transcript.js";
import { AgentRefusal, openProvider, runTurn } from "./turn.js";
import { BUILTIN_PROVIDER, builtinModel } from "./builtin.js";
import { aiGatewayConfig } from "./aiGateway.js";
import { ProviderError } from "./providers.js";
import { readAboutMe } from "./aboutMe.js";
import { actorFor, contextsFor } from "../context/identity.js";
import { callToolForSession } from "../tools/session.js";
import { grantedToolsFor } from "./sixTools.js";
import { newLedger } from "../privacy/egress.js";
import { json } from "../http/responses.js";
import { wallClock } from "../../../../packages/shared/src/routines.cjs";
import { HOUSEKEEPING_GRANTS, MAX_HOUSEKEEPING_CHANGES, housekeepingCallTool, housekeepingTools, undoLine } from "./housekeepingGuard.js";

export const HOUSEKEEPING_FOLDER = "tex/housekeeping";

/**
 * Housekeeping's own first-party client, handed a short-lived grant on the
 * person's personal workspace by the control plane when the workspace
 * heartbeat's loop says it is due. Its own client, never the check-in's or the
 * dream's: those only read, or write one note, and this changes many. A
 * texting or MCP connection never keeps house: a run changes things with
 * nobody watching.
 */
export const HOUSEKEEPING_CLIENT_ID = "context_housekeeping";

const HOUSEKEEPING_ROUNDS = 24;
const MAX_WHY_CHARS = 4_000;
const MAX_LINE_CHARS = 280;

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const pad = (value) => String(value).padStart(2, "0");

function dayOf(now, timeZone) {
  const w = wallClock(now, timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** Today's log: `tex/housekeeping/2026-10-17.md`, dated in their zone. */
export function housekeepingPath(now, timeZone) {
  return `${HOUSEKEEPING_FOLDER}/${dayOf(now, timeZone)}.md`;
}

const textOf = (result) => (Array.isArray(result?.content) ? result.content : []).map((part) => part?.text ?? "").join("\n");

/** The chaos score in an `orient about: health` answer, or null where there is none. */
export function chaosFrom(health) {
  const match = /\bChaos (\d+) of 100\b/.exec(String(health ?? ""));
  return match ? Number(match[1]) : null;
}

/** The Supa way, and the jobs in the order they pay off. */
export function housekeepingQuestion({ health, today }) {
  return [
    "This is your housekeeping run, not a text from a person. Nobody is waiting, and nothing you say is texted except your first sentence at the end.",
    `Today is ${today}. Your job: make this workspace calmer and more current, the Supa way, and lower its chaos score. Be bold where you are sure and leave alone what you are not: a note left where it is costs little, a note filed wrong is lost.`,
    "The Supa way (PARA): the inbox takes everything that arrives, raw (contacts live there too). Projects are work that will end. Areas are responsibilities that never end. Resources are reference material. The archive keeps old things in the same structure they had, so nothing is gone. A business also has Clients, Teams and Products at the top. Use the folders this workspace already has (orient names which plays which role); never invent a new top-level folder.",
    health ? `The workspace's health right now:\n\n${health}` : "This workspace has no chaos score yet; judge by the folder map (call orient).",
    [
      "The jobs, most valuable first. Do as many as you can do well:",
      "1. Finished projects. A project whose status says it is done, finished, shipped, cancelled or dropped, or whose own notes say it ended, moves into the archive keeping its path (a folder `1-projects/x/` moves to `<archive>/1-projects/x/` with move_folder, or, where move_folder is not available, its notes with move_many to the same paths; a single note with archive). If its status is stale (the notes say it ended but status still says in progress), first set status to the word the project already uses for done.",
      "2. Project statuses. Where the inbox or a project's own notes show its status changed (started, blocked, finished), update the `status:` front matter to match, using words the workspace already uses.",
      "3. Contacts. Two contact pages that share an email address, phone number or handle are one person: merge them into the fuller page (keep every identifier and every activity link, and anything the person typed), then archive the other. Two pages that only share a name are never merged: add `review: Possible duplicate of <path>?` to the front matter of the newer one instead.",
      "4. Thin folders. A folder holding one note (besides about.md) should not be a folder: move the note up into the folder above. A folder holding only its about.md goes to the archive. Two notes that are one topic can share a folder with a third.",
      "5. Crowded folders. More than 10 items is chaos: group them into 2 to 5 subfolders by clear themes (dated or numbered runs together), with move_many, up to 100 moves a call. Only where the themes are obvious from the names.",
      "6. The inbox keeps about three months. Inbox notes older than that move to the archive under the same folder names they had in the inbox.",
    ].join("\n"),
    "Rules: read before you rewrite, and pass the etag. A rewrite changes front matter or merges duplicates and never cuts text. Never touch tex/, routines/, website/ or the notes at the top of the workspace. Never change who can see anything. If a move is refused by a rule, don't retry it another way; if a tool is simply not available here, use the one that is. Stop when there is nothing you are sure of left, or when you are told it's enough.",
    `At most ${MAX_HOUSEKEEPING_CHANGES} notes change in one run, so start with what calms the most.`,
    "Then answer with two or three plain sentences for the log: what you changed and why, or why nothing needed changing. Make the first sentence one they would be glad to get as a text, under 25 words, like \"I archived 3 finished projects and merged 2 duplicate contacts.\"",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function clock(now, timeZone) {
  const w = wallClock(now, timeZone);
  const h = w.hour % 12 === 0 ? 12 : w.hour % 12;
  return `${h}:${pad(w.minute)} ${w.hour < 12 ? "am" : "pm"}`;
}

function heading(now, timeZone) {
  const w = wallClock(now, timeZone);
  return (
    `# Tex kept house, ${MONTHS[w.month - 1]} ${w.day}, ${w.year}\n\n` +
    "What Tex's housekeeping changed in this workspace, and how to put each change back.\n"
  );
}

const shownScore = (score) => (typeof score === "number" ? String(score) : "no score");

/** What a change was, in a line. */
function changeLine(change) {
  switch (change.do) {
    case "moved":
    case "moved folder":
      return `${change.do === "moved" ? "Moved" : "Moved the folder"} \`${change.from}\` to \`${change.to}\``;
    case "archived":
      return change.to ? `Archived \`${change.from}\` to \`${change.to}\`` : `Archived \`${change.path}\``;
    case "rewrote":
      return `Updated \`${change.path}\``;
    default:
      return "";
  }
}

/** One run's part of the day's log. */
export function housekeepingEntry({ now, timeZone, model, changes, before, after, why, events }) {
  const lines = [`## ${clock(now, timeZone)}`, ""];
  const score = before === null && after === null ? "No chaos score yet" : `Chaos ${shownScore(before)} → ${shownScore(after)} of 100`;
  lines.push(`_${score}${model ? `, on ${model}` : ""}._`, "", "### What changed", "");
  if (changes.length === 0) {
    lines.push("_Nothing changed._");
  } else {
    for (const change of changes) lines.push(`- ${changeLine(change)}. To undo: ${undoLine(change)}.`);
  }
  const said = String(why ?? "").trim();
  if (said) lines.push("", "### Why", "", said.length > MAX_WHY_CHARS ? `${said.slice(0, MAX_WHY_CHARS)}…` : said);
  const steps = events.map(eventLines).filter(Boolean);
  if (steps.length > 0) lines.push("", "### How it went", "", ...steps.map((step) => step.replace(/\n$/, "")));
  return `${lines.join("\n")}\n`;
}

/** The first sentence of the model's account, for the heartbeat to text, or a plain count. */
export function summaryLine(answer, changes) {
  const first = String(answer ?? "").trim().split(/(?<=[.!?])\s+/)[0]?.trim() ?? "";
  if (changes.length === 0) return "";
  if (first && first.length <= MAX_LINE_CHARS) return first;
  return `I tidied ${changes.length} ${changes.length === 1 ? "thing" : "things"} in your notes.`;
}

/** `{ etag, body }`, `{ missing: true }`, or null when the note could not be read. */
async function readWithEtag(dispatch, path) {
  try {
    const result = await dispatch("read_note", { path });
    const text = textOf(result);
    if (result?.isError === true) return /^not found\b/i.test(text.trim()) ? { missing: true } : null;
    const split = text.indexOf("\n\n");
    if (split === -1) return null;
    const etag = /^etag: (.+)$/m.exec(text.slice(0, split))?.[1]?.trim();
    return etag ? { etag, body: text.slice(split + 2) } : null;
  } catch {
    return null;
  }
}

/** Write this run's entry after whatever the day's log already holds. Best effort. */
async function writeLog(dispatch, path, entry, { now, timeZone }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readWithEtag(dispatch, path);
    if (current === null) return false; // a log that can't be read is never overwritten
    const before = current.missing ? heading(now, timeZone) : current.body;
    const written = await dispatch("write_note", {
      path,
      content: `${before.replace(/\n*$/, "\n\n")}${entry}`,
      ...(current.missing ? {} : { expected_etag: current.etag }),
    }).catch(() => null);
    if (written && written.isError !== true) return true;
  }
  return false;
}

async function healthOf(dispatch) {
  try {
    const result = await dispatch("orient", { about: "health" });
    return result?.isError === true ? "" : textOf(result).trim();
  } catch {
    return "";
  }
}

/**
 * One housekeeping run, for whichever turn handler the caller's client is
 * routed to (`http/route.js`). The caller decides when; this decides what.
 */
export async function handleHousekeeping(request, env, store, session, controlPlane) {
  if (session.actorClientId !== HOUSEKEEPING_CLIENT_ID) return json({ error: "invalid_request", error_description: "Only Tex's housekeeping keeps house." }, 403);
  let body = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const asked = body?.housekeeping !== undefined && body.housekeeping !== null && typeof body.housekeeping === "object" && !Array.isArray(body.housekeeping);
  if (!asked) return json({ error: "invalid_request", error_description: "This connection only keeps house." }, 400);

  store.actor = actorFor(session);
  store.contexts = contextsFor(session);
  // Nothing housekeeping reads is sent anywhere, and nothing it changes widens who sees it.
  session.egress = { complete: true, ledger: newLedger(), texting: false };
  const dispatch = (name, args) => callToolForSession({ name, arguments: args }, store, session);

  const timeZone = readTimeZone(body.housekeeping.timeZone) ?? DEFAULT_TIME_ZONE;
  const started = Date.now();
  const offered = await grantedToolsFor(session, store);
  const health = await healthOf(dispatch);
  const before = chaosFrom(health);

  try {
    await openProvider(controlPlane, session, undefined, env);
  } catch (error) {
    if (error instanceof AgentRefusal && error.code === "daily_limit") return json({ error: "daily_limit" }, 429);
    if (error instanceof AgentRefusal) return json({ error: error.code }, 409);
    return json({ error: "model_unavailable" }, 503);
  }

  const events = [];
  const guard = housekeepingCallTool(dispatch);
  const model = builtinModel(env);
  const meter = async (usage, failed, answering = model) => {
    try {
      await controlPlane.recordBuiltinUsage(session.accessToken, session.workspaceId, {
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
        cacheRead: usage?.cacheRead ?? 0,
        cacheWrite: usage?.cacheWrite ?? 0,
        model: typeof answering === "string" ? answering : model,
        decision: 0,
        failed,
        ms: Date.now() - started,
      });
    } catch {
      // A meter that could not be reached costs us a report, not the run.
    }
  };

  let turn = null;
  try {
    const aboutMe = await readAboutMe(dispatch);
    turn = await runTurn({
      question: housekeepingQuestion({ health, today: dayOf(started, timeZone) }),
      tools: housekeepingTools(offered),
      grants: HOUSEKEEPING_GRANTS,
      callTool: guard.callTool,
      env,
      providerOptions: {
        ai: env.AI,
        gateway: aiGatewayConfig(env),
        metadata: { feature: "assistant", workspace: String(session.workspaceId), client: "housekeeping" },
      },
      aboutMe,
      localNow: { now: started, timeZone },
      observe: (event) => events.push(event),
      maxRounds: HOUSEKEEPING_ROUNDS,
    });
  } catch (error) {
    await meter(null, true, error instanceof ProviderError ? error.model : model);
    console.log(
      JSON.stringify({
        event: "housekeeping",
        workspace: session.workspaceId,
        grant: session.grantId,
        outcome: "failed",
        ...(error instanceof ProviderError ? { reason: error.reason, status: error.status } : {}),
      }),
    );
    if (!(error instanceof ProviderError)) throw error;
  }
  if (turn !== null) await meter(turn.usage, false, turn.model);

  const changes = guard.changes;
  const after = changes.length > 0 ? chaosFrom(await healthOf(dispatch)) : before;
  const outcome = changes.length > 0 ? "tidied" : turn === null ? "failed" : "unchanged";
  const now = Date.now();
  const entry = housekeepingEntry({ now, timeZone, model: turn?.model ?? null, changes, before, after, why: turn?.answer ?? "", events });
  const logged = await writeLog(dispatch, housekeepingPath(now, timeZone), entry, { now, timeZone });
  console.log(
    JSON.stringify({
      event: "housekeeping",
      workspace: session.workspaceId,
      grant: session.grantId,
      provider: BUILTIN_PROVIDER,
      outcome,
      changes: changes.length,
      refusals: guard.refusals,
      before,
      after,
      logged,
      ms: now - started,
    }),
  );
  if (outcome === "failed") return json({ error: "model_unavailable", outcome }, 502);
  return json({
    outcome,
    changes: changes.length,
    chaos: { before, after },
    line: summaryLine(turn?.answer, changes),
    log: logged ? housekeepingPath(now, timeZone) : null,
  });
}
