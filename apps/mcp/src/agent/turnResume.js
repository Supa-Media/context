/**
 * A texted turn's snapshot, kept as it goes and put back on the next try of the same text (`savedRounds.js`; Dev2,
 * 2026-11-17).
 *
 * Put back after the question, as the model left it, so its next round goes on from the last thing a tool returned.
 * Its calls are this turn's own from here: the record that refuses a write asked for twice after a send-back
 * (`sendBack.js`) has them, and so do the turn's `steps`, marked `resumed`. They are not told to the chat's ledger
 * again, because the try that ran them logged them as they ran; the ledger gets one `resumed` step naming the round
 * and each call, so Replay shows that this try ran none of them (Dev2, 2026-11-14: replay shows only what ran).
 */
import { ledgerPlace } from "./ledger.js";
import { readOf } from "./toldFacts.js";
import { callsIn, carriesOn, checkedSnapshot, jobKey, keptMessage, ROUNDS_MAX_CHARS, textKey } from "./savedRounds.js";

/**
 * Puts `resumeFrom` (`{ round, messages }`, or null) after the question in `messages`, and returns the round the turn
 * goes on from: 0 with none. Never past the last round, so a try that comes back on its bound still gets one to answer.
 */
export function resumedRounds({ resumeFrom, rounds, messages, held, steps, tell }) {
  if (resumeFrom === null || resumeFrom === undefined || !Array.isArray(resumeFrom.messages) || resumeFrom.messages.length === 0) return 0;
  messages.push(...resumeFrom.messages.map((message) => ({ ...message })));
  const calls = callsIn(resumeFrom.messages, resumeFrom.ran);
  for (const call of calls) {
    held.keep({ kind: "tool", name: call.name, args: call.args, ok: call.ok, resumed: true });
    steps.push({ tool: call.name, ok: call.ok, resumed: true });
  }
  // A job's part carried from the part before starts its own count, and a part tried again keeps room to finish (`leave`).
  const round = resumeFrom.restart === true ? 0 : Math.max(0, Math.min(rounds - Math.max(1, resumeFrom.leave ?? 1), resumeFrom.round));
  const from = Number.isSafeInteger(resumeFrom.part) ? `part ${resumeFrom.part} of this job` : "an earlier try of this text";
  tell({
    kind: "model",
    step: "resumed",
    ok: true,
    input: { round: resumeFrom.round, calls: calls.map((call) => call.name), ...(Number.isSafeInteger(resumeFrom.part) ? { part: resumeFrom.part } : {}) },
    output: { from: round },
    reason: `went on from round ${resumeFrom.round} of ${from}: its ${calls.length} call${calls.length === 1 ? "" : "s"} not run again`,
  });
  return round;
}

/**
 * Keeps a turn's snapshot as its calls return (`turn.js`): `roundStarted()` once a round's calls are in `messages`,
 * `called(call, result, round)` after each one's result is, `freeze()` when a call settles the turn. Each snapshot is
 * every round so far whose calls all carry on (`carriesOn`), and of the round running, the calls that returned; the
 * first call that doesn't carry on freezes it, so a try after a crash runs that call again. `keep(snapshot)` is never
 * awaited and never throws into the turn.
 */
export function roundsKeeper({ messages, roundsFrom, readOnly, keep, marks = () => ({}), carried = {} }) {
  let frozen = false;
  let assistantAt = -1;
  let done = [];
  const ran = { ...carried }; // each kept call as it ran, the six resolved (`sixTools.js`): what a try after tells its checks
  const snapshot = (round) => {
    const asked = messages[assistantAt];
    const ids = new Set(done);
    const answer = keptMessage(asked);
    if (done.length < (asked.toolCalls?.length ?? 0)) {
      // Part of a round: only the calls that returned, and none of its thinking, which named the rest.
      answer.toolCalls = answer.toolCalls.filter((call) => ids.has(call.id));
      delete answer.content;
    }
    const results = messages.slice(assistantAt + 1).filter((message) => message.role === "tool" && ids.has(message.id)).map(keptMessage);
    return { v: 1, round: round + 1, ...marks(), ran: { ...ran }, messages: [...messages.slice(roundsFrom, assistantAt).map(keptMessage), answer, ...results] };
  };
  return {
    roundStarted() {
      assistantAt = messages.length - 1;
      done = [];
    },
    called(call, result, round) {
      if (frozen || assistantAt < roundsFrom) return;
      if (!carriesOn(call, result, readOnly)) return void (frozen = true);
      done.push(call.id);
      ran[call.id] = { name: call.name, args: call.args };
      try {
        const kept = snapshot(round);
        if (JSON.stringify(kept).length <= ROUNDS_MAX_CHARS) keep(kept);
      } catch {
        /* a lost snapshot costs a later try its head start, never this turn */
      }
    },
    freeze() {
      frozen = true;
    },
  };
}

/** What a job's part is told when it goes on from a part's saved rounds: they are right below, so it reads them rather than its notes. */
export function carriedLine(from) {
  if (!Number.isSafeInteger(from?.part)) return "";
  return `\nThe calls after your task, with what each returned, were made by ${from.restart ? `part ${from.part}, cut off before it answered` : "this part's last try, which died"}. Go on from them: don't make them again, and read the note or the list of saved calls in your task only for what they don't cover.`;
}

/** The rounds a job's part tried again is left to finish in, however far its last try got (`progress.js` `LONG_MAX_ROUNDS`). */
export const JOB_ROUNDS_LEFT = 10;

/**
 * A texted turn's carry: `from`, the snapshot an earlier try of this text kept (checked, or null), and `keep`, which
 * stores each new one in the chat's own home beside its ledger (`texStore/rounds.js`), one after another so the newest
 * lands last; `from` only when the Worker says this is a try after one that failed (`again`). None for a turn whose text names no chat events, whose chat keeps no ledger, or, for `keep`, a
 * provisional run (`steer.js`): what it writes before its go may be put back, so nothing it did is carried on.
 * A background job's part (`job`, `background.js` `jobOf`) keeps under its own part and reads only the part the Worker
 * names in `resumeFrom` (`apps/agent/src/jobPartResume.ts`).
 * An earlier try's outside-read mark goes on `egress` (`privacy/egress.js`): the resumed turn read what it read.
 */
export async function carriedRounds({ store, session, body, question, job = null, egress = null, log = (line) => console.log(JSON.stringify(line)) }) {
  const place = ledgerPlace(session);
  const home = place === null || typeof store?.texLedger !== "function" ? null : store.texLedger(place.owner.chat ?? null);
  if (home === null || typeof home?.roundsOf !== "function" || typeof home.keepRounds !== "function") return null;
  const groupChat = Array.isArray(body?.group?.chat) ? body.group.chat : null;
  // A job's part keeps under its own part, and reads the part the Worker names (`background.js` `jobOf`).
  const key = job ? await jobKey({ id: job.id, resumes: job.resumes, part: job.attempt }) : await textKey({ question, covers: body?.covers, groupChat });
  if (key === null) return null;
  // A job's try told to start fresh (`resumeFrom: 0`) drops what an earlier try of its part kept, so it is never carried again.
  if (job && job.resumeFrom === 0) await home.forgetRounds?.(place.chat, key)?.catch?.(() => {});
  const readKey = !job ? (body?.again === true ? key : null) : !job.resumeFrom ? null : job.resumeFrom === job.attempt ? key : await jobKey({ id: job.id, resumes: job.resumes, part: job.resumeFrom });
  // Read only on a try after one that failed (the Worker says so), so a first try costs no store call before its model.
  const read = readKey === null ? null : checkedSnapshot(await home.roundsOf(place.chat, readKey).catch(() => null));
  // A job's part from the part before starts its round count over; a part tried again keeps ten rounds to finish in.
  const from = read === null || !job ? read : { ...read, part: job.resumeFrom, ...(job.resumeFrom === job.attempt ? { leave: JOB_ROUNDS_LEFT } : { restart: true }) };
  if (from !== null) {
    if (egress && from.untrusted) egress.untrusted = true;
    if (egress && from.outside) egress.outside = true;
    // How often a try goes on from an earlier one, and how much it skipped: counts only, never words (Fable's review, 2026-11-17).
    log({ event: "turn_resumed", round: from.round, calls: callsIn(from.messages, from.ran).length, group: groupChat !== null, ...(job ? { job: true, part: job.attempt, from: job.resumeFrom } : {}) });
  }
  let chain = Promise.resolve();
  let stored = from !== null;
  const keep =
    body?.provisional === true
      ? null
      : (snapshot) => {
          stored = true;
          chain = chain.then(() => home.keepRounds(place.chat, key, snapshot)).catch(() => {});
        };
  const marks = () => ({ ...(egress?.untrusted ? { untrusted: true } : {}), ...(egress?.outside ? { outside: true } : {}) });
  // The text is answered: its snapshot goes, after any keep still on its way, so none lands after. Never awaited by the
  // reply; a row it misses goes stale in half an hour (`texStore/rounds.js`).
  const forget = () => {
    if (!stored) return chain; // nothing kept for this text: no store call
    stored = false;
    // A job's part forgets the part it went on from too: that part's work is this one's now.
    for (const gone of new Set([key, readKey].filter((one) => one !== null))) chain = chain.then(() => (typeof home.forgetRounds === "function" ? home.forgetRounds(place.chat, gone) : null)).catch(() => {});
    return chain;
  };
  return { from, keep, marks, forget, flush: () => chain };
}

/**
 * What the carried calls read, told again to what keeps count of it this try: the claim check (`claimCheck.js`
 * `reread`), so a figure or link the answer takes from a carried read is backed, and the facts its reply keeps
 * (`toldFacts.js`). Returns the reads, for `t.reads`; empty with no snapshot.
 */
export function rereadCarried(from, claims = null) {
  if (from === null || from === undefined) return [];
  const reads = [];
  for (const call of callsIn(from.messages, from.ran)) {
    const result = { content: [{ type: "text", text: call.text }], ...(call.ok ? {} : { isError: true }) };
    claims?.reread?.(call.name, call.args, result);
    const read = readOf({ kind: "tool", ok: call.ok, name: call.name, args: call.args, result: call.text });
    if (read !== null) reads.push(read);
  }
  return reads;
}
