/**
 * THE NIGHTLY HAND-BACK COUNT: what went out, read again after the day.
 *
 * The owner adopted the hand-back rule on 2026-10-22
 * (docs/decisions/texting-assistant/handing-back.md), and with it mining the
 * transcripts for hand-backs. The hand-back judge (`handbackJudge.js`) reads
 * an answer before it goes and may send it back once, so what a person was
 * really texted can still hand them work: a second answer the judge never
 * saw, or one it let through. This reads what went out.
 *
 * Once a night, after the dream (`dream.js`), the gateway (never a model with
 * tools) reads the turns of the transcripts the dream read
 * (`tex/transcripts/`, `transcript.js`) that happened since the last dream.
 * Each texted answer that may ask the person something (`mayAsk`) goes to the
 * same judge, with the person's text and the names of the tools the turn ran,
 * never their results. Then:
 *
 *   - the person's own `tex/handbacks/YYYY-MM-DD.md` gets an entry: how many
 *     answers were read, and each ask the judge found, by its code, with the
 *     time and the judge's quote of Tex's words. It is in their personal
 *     workspace, theirs to read and delete, like the transcripts;
 *   - the Worker's log gets `handbacks_mined` with counts by code and nothing
 *     else, which is the production count across people.
 *
 * A turn's id starts with when it began (`transcript.js` `openTranscript`),
 * so a turn already counted by an earlier night is never counted twice. A
 * night reads at most `MAX_MINED_TURNS` answers, newest kept. Best effort: a
 * miss costs a count, never the dream.
 */

import { judgeAsks, mayAsk } from "./handbackJudge.js";
import { appendLogEntry, clock, dayOf, longDate } from "./jobLog.js";

export const HANDBACKS_FOLDER = "tex/handbacks";
/** The most answers one night reads: each is one small-model call. */
export const MAX_MINED_TURNS = 30;
const MAX_QUOTE_CHARS = 200;

const TURN = /<!-- tex-turn ([0-9a-z]+)-[0-9a-z]+ -->\n([\s\S]*?)\n<!-- \/tex-turn \1-[0-9a-z]+ -->/g;
const TOOL_LINE = /^- `([^`]+)` `.*` → (ok|held for their yes|failed)/;

/**
 * A transcript note's turns, oldest first: when each began, the person's
 * text, the tools it ran (name and whether it worked), and Tex's answer.
 * A routine's run, and a turn with no answer, are left out: nobody texted it.
 */
export function turnsOf(body) {
  const turns = [];
  for (const match of String(body ?? "").matchAll(TURN)) {
    const at = parseInt(match[1], 36);
    const text = match[2];
    const them = /^\*\*Them:\*\* ([\s\S]*?)\n(?=\n|- `|\*\*|_|>|!\[)/m.exec(`${text}\n`);
    const tex = /^\*\*Tex:\*\* ([\s\S]*)$/m.exec(text);
    if (!Number.isFinite(at) || them === null || tex === null) continue;
    const steps = text
      .split("\n")
      .map((line) => TOOL_LINE.exec(line))
      .filter(Boolean)
      .map((m) => ({ name: m[1], ok: m[2] !== "failed" }));
    turns.push({ at, question: them[1].trim(), steps, answer: tex[1].trim() });
  }
  return turns;
}

/** One night's entry in `tex/handbacks/`. */
export function handbacksEntry({ now, timeZone, read, found }) {
  const handed = found.filter((f) => f.code.startsWith("H"));
  const lines = [
    `## ${clock(now, timeZone)}`,
    "",
    `${read} ${read === 1 ? "answer" : "answers"} read, ${handed.length === 0 ? "none handing you work Tex could do" : `${handed.length} handing you work Tex could do`}.`,
    "",
  ];
  for (const f of found) {
    lines.push(`- ${clock(f.at, timeZone)}, ${f.code}${f.code.startsWith("H") ? " (hand-back)" : " (fair ask)"}: "${f.quote.slice(0, MAX_QUOTE_CHARS)}"`);
  }
  return `${lines.join("\n").replace(/\n*$/, "\n")}`;
}

/**
 * Read the turns since `since` in `transcripts` (paths the dream read) and
 * write the night's entry. Answers `{ read, codes }`, or null when it did
 * not run.
 */
export async function mineHandbacks({ dispatch, transcripts, since, now, timeZone, config, request, metadata, log = (line) => console.log(line) }) {
  if (!config || transcripts.length === 0) return null;
  const turns = [];
  for (const path of transcripts) {
    const result = await dispatch("read_note", { path }).catch(() => null);
    if (result === null || result?.isError === true) continue;
    const text = (Array.isArray(result.content) ? result.content : []).map((part) => part?.text ?? "").join("\n");
    turns.push(...turnsOf(text));
  }
  const fresh = turns.filter((turn) => (since === null || turn.at >= since) && mayAsk(turn.answer)).slice(-MAX_MINED_TURNS);
  const found = [];
  let read = 0;
  for (const turn of fresh) {
    const asks = await judgeAsks({ question: turn.question, answer: turn.answer, steps: turn.steps, config, request, metadata });
    if (asks === null) continue;
    read += 1;
    for (const ask of asks) found.push({ at: turn.at, code: ask.code, quote: ask.quote });
  }
  const codes = {};
  for (const f of found) codes[f.code] = (codes[f.code] ?? 0) + 1;
  let logged = false;
  if (fresh.length > 0) {
    const path = `${HANDBACKS_FOLDER}/${dayOf(now, timeZone)}.md`;
    const heading = `# Hand-backs, ${longDate(now, timeZone)}\n\nTex's texted answers, read again after they went. H codes are work handed to you that Tex could have done; K, Y, C, F and B are fair asks (a sign-in, a yes, a choice, a fact, something in person).\n\n`;
    logged = await appendLogEntry(dispatch, path, handbacksEntry({ now, timeZone, read, found }), heading);
  }
  // Counts only: never the person's words or Tex's.
  log(JSON.stringify({ event: "handbacks_mined", workspace: metadata?.workspace ?? null, turns: fresh.length, read, codes, logged }));
  return { read, codes };
}
