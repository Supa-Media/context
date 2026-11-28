/**
 * The day's job-log writes (`jobLog.js`): each takes the tool dispatcher as an argument and holds no Tex state, so the
 * gateway's attention tool (`tools/attention.js`) writes a log the same way the scheduled turns do.
 */

const { wallClock } = require("../routines.cjs");

const pad = (value) => String(value).padStart(2, "0");

/** `3:05 am` of `now` in `timeZone`. */
function clock(now, timeZone) {
  const w = wallClock(now, timeZone);
  const h = w.hour % 12 === 0 ? 12 : w.hour % 12;
  return `${h}:${pad(w.minute)} ${w.hour < 12 ? "am" : "pm"}`;
}

/** `{ etag, body }`, `{ missing: true }`, or null when the note could not be read. */
async function readWithEtag(dispatch, path) {
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
async function appendLogEntry(dispatch, path, entry, heading, extra = {}) {
  return (await appendLogEntryWhy(dispatch, path, entry, heading, extra)) === null;
}

/** `appendLogEntry`, answering null when the entry landed and otherwise why it didn't, in the refusal's leading words. */
async function appendLogEntryWhy(dispatch, path, entry, heading, { images = null } = {}) {
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
      ...(Array.isArray(images) && images.length > 0 ? { images } : {}),
    }).catch((error) => {
      threw = error;
      return null;
    });
    if (written && written.isError !== true) return null;
    why = threw !== null ? `threw ${threw?.name ?? "error"}` : written ? refusalWords(written) : "no answer";
  }
  console.log(JSON.stringify({ event: "job_log", outcome: "not_written", folder: path.split("/").slice(0, -1).join("/"), why }));
  return why;
}

module.exports = { clock, readWithEtag, refusalWords, appendLogEntry, appendLogEntryWhy };
