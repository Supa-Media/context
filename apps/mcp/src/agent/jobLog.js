/**
 * What Tex's own scheduled turns share on the gateway: the nightly dream
 * (`dream.js`) and the daytime check-in (`heartbeat.js`). Each keeps a day's
 * log note in the person's own `tex/` folder, appended one entry per run, and
 * meters the built-in model like a text.
 */

import { wallClock } from "../../../../packages/shared/src/routines.cjs";

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

/**
 * Write `entry` after whatever the day's log already holds, starting it with
 * `heading` when it does not exist. Best effort; a log that can't be read is
 * never overwritten.
 */
export async function appendLogEntry(dispatch, path, entry, heading) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readWithEtag(dispatch, path);
    if (current === null) return false;
    const before = current.missing ? heading : current.body;
    const written = await dispatch("write_note", {
      path,
      content: `${before.replace(/\n*$/, "\n\n")}${entry}`,
      ...(current.missing ? {} : { expected_etag: current.etag }),
    }).catch(() => null);
    if (written && written.isError !== true) return true;
  }
  return false;
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
