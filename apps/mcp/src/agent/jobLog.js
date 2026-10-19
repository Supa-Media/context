/**
 * What Tex's own scheduled turns share on the gateway: the nightly dream
 * (`dream.js`) and the daytime check-in (`heartbeat.js`). Each keeps a day's
 * log note in the person's own `tex/` folder, appended one entry per run, and
 * meters the built-in model like a text.
 */

import { wallClock } from "../../../../packages/shared/src/routines.cjs";
import { AgentRefusal } from "./turn.js";

const pad = (value) => String(value).padStart(2, "0");

/** `YYYY-MM-DD` of `now` in `timeZone`. */
export function dayOf(now, timeZone) {
  const w = wallClock(now, timeZone);
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

/** `3:05 am` of `now` in `timeZone`. */
export function clock(now, timeZone) {
  const w = wallClock(now, timeZone);
  const h = w.hour % 12 === 0 ? 12 : w.hour % 12;
  return `${h}:${pad(w.minute)} ${w.hour < 12 ? "am" : "pm"}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** `October 17, 2026` of `now` in `timeZone`. */
export function longDate(now, timeZone) {
  const w = wallClock(now, timeZone);
  return `${MONTHS[w.month - 1]} ${w.day}, ${w.year}`;
}

/** `{ etag, body }`, `{ missing: true }`, or null when the note could not be read. */
export async function readWithEtag(dispatch, path) {
  try {
    const result = await dispatch("read_note", { path });
    const text = (Array.isArray(result?.content) ? result.content : []).map((part) => part?.text ?? "").join("\n");
    if (result?.isError === true) return /^not found\b/i.test(text.trim()) ? { missing: true } : null;
    const split = text.indexOf("\n\n");
    if (split === -1) return null;
    const etag = /^etag: (.+)$/m.exec(text.slice(0, split))?.[1]?.trim();
    return etag ? { etag, body: text.slice(split + 2) } : null;
  } catch {
    return null;
  }
}

/** A tool refusal's leading words ("conflict", "permission denied"): never the note text a conflict carries. */
function refusalWords(result) {
  const text = (Array.isArray(result?.content) ? result.content : []).map((part) => part?.text ?? "").join("\n");
  return text.split(/[:\n(]/, 1)[0].trim().slice(0, 60) || "refused";
}

/**
 * Write `entry` after whatever the day's log already holds, starting it with
 * `heading` when it does not exist. Best effort; a log that can't be read is
 * never overwritten. A read or write that fails is tried once more, and a log
 * that still could not be written says why in the Worker's log (`job_log`),
 * never with the entry's or the note's words.
 */
export async function appendLogEntry(dispatch, path, entry, heading) {
  let why = "unreadable";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readWithEtag(dispatch, path);
    if (current === null) {
      why = "unreadable";
      continue;
    }
    const before = current.missing ? heading : current.body;
    let threw = null;
    const written = await dispatch("write_note", {
      path,
      content: `${before.replace(/\n*$/, "\n\n")}${entry}`,
      ...(current.missing ? {} : { expected_etag: current.etag }),
    }).catch((error) => {
      threw = error;
      return null;
    });
    if (written && written.isError !== true) return true;
    why = threw !== null ? `threw ${threw?.name ?? "error"}` : written ? refusalWords(written) : "no answer";
  }
  console.log(JSON.stringify({ event: "job_log", outcome: "not_written", folder: path.split("/").slice(0, -1).join("/"), why }));
  return false;
}

/**
 * Why a run ended before its model ran, as its day's log says it. Every run
 * that reaches the gateway leaves a line (owner, 2026-10-19: "We should be
 * able to track the skipped runs"), so a day with nothing else in its log
 * still shows the job ran and why it stopped.
 */
export const SKIPPED_WORDS = {
  no_provider: "Skipped: the built-in model isn't available to this account.",
  daily_limit: "Skipped: today's questions are used up.",
  model_unavailable: "Skipped: the model couldn't be reached. The next run tries again.",
};

/** One skipped run's part of the day's log: the time and why. */
export function skippedEntry(now, timeZone, words) {
  return `## ${clock(now, timeZone)}\n\n_${words}_\n`;
}

/** Log a run that ran no model. Best effort: a log that can't be written never changes the run's answer. */
export async function logSkipped(dispatch, { path, heading, now, timeZone, words }) {
  try {
    await appendLogEntry(dispatch, path, skippedEntry(now, timeZone, words), heading);
  } catch {
    // The outcome still reaches the control plane.
  }
}

/**
 * The refusal `openProvider` threw, as the run's answer, logged first:
 * `daily_limit` (429), any other refusal (409), or no model reachable (503).
 */
export async function refusedRun(error, log) {
  if (error instanceof AgentRefusal && error.code === "daily_limit") {
    await log(SKIPPED_WORDS.daily_limit);
    return { status: 429, body: { error: "daily_limit" } };
  }
  if (error instanceof AgentRefusal) {
    await log(SKIPPED_WORDS.no_provider);
    return { status: 409, body: { error: error.code } };
  }
  await log(SKIPPED_WORDS.model_unavailable);
  return { status: 503, body: { error: "model_unavailable" } };
}

/** Report a turn's built-in usage to the control plane. A meter that can't be reached costs a report, never the turn. */
export function builtinMeter(controlPlane, session, model, started) {
  return async (usage, failed, answering = model) => {
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
      // A meter that could not be reached costs us a report, not the turn.
    }
  };
}
