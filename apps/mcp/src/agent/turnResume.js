/**
 * An earlier try's rounds put back into a turn (`savedRounds.js`, Dev2 2026-11-17): after the question, as the model
 * left them, so its next round goes on from the last thing a tool returned.
 *
 * Its calls are this turn's own from here: the record that refuses a write asked for twice after a send-back
 * (`sendBack.js`) has them, and so do the turn's `steps`, marked `resumed`. They are not told to the chat's ledger
 * again, because the try that ran them logged them as they ran; the ledger gets one `resumed` step saying from which
 * round, with each call's name, so Replay shows that this try ran none of them (Dev2, 2026-11-14: replay shows only
 * what ran).
 */
import { callsIn, openRounds, sealRounds } from "./savedRounds.js";

/**
 * Puts `resumeFrom` (`{ round, messages }`, or null) after the question in `messages`, and returns the round the turn
 * goes on from: 0 with none. Never past the last round, so a try that comes back on its bound still gets one to answer.
 */
export function resumedRounds({ resumeFrom, rounds, messages, held, steps, tell }) {
  if (resumeFrom === null || resumeFrom === undefined || !Array.isArray(resumeFrom.messages) || resumeFrom.messages.length === 0) return 0;
  messages.push(...resumeFrom.messages.map((message) => ({ ...message })));
  const calls = callsIn(resumeFrom.messages);
  for (const call of calls) {
    held.keep({ kind: "tool", name: call.name, args: call.args, ok: call.ok, resumed: true });
    steps.push({ tool: call.name, ok: call.ok, resumed: true });
  }
  const round = Math.max(0, Math.min(rounds - 1, resumeFrom.round));
  tell({
    kind: "model",
    step: "resumed",
    ok: true,
    input: { round: resumeFrom.round, calls: calls.map((call) => call.name) },
    output: { from: round },
    reason: `went on from round ${resumeFrom.round} of an earlier try of this text: its ${calls.length} call${calls.length === 1 ? "" : "s"} not run again`,
  });
  return round;
}

/**
 * A texted turn's carry: `from`, what an earlier try of this text did (the Worker hands it back as `body.rounds`), and
 * `save`, which seals the rounds so far and sends them down the stream (`{ rounds }`, `progress.js`) for the Worker to
 * keep until the text is answered. Saves go one after another, so the Worker keeps the newest last.
 */
export async function carriedRounds({ env, session, question, body, step }) {
  const from = typeof body?.rounds === "string" ? await openRounds(env, session, question, body.rounds) : null;
  let chain = Promise.resolve();
  const save = (messages, round) => {
    const copy = messages.map((message) => ({ ...message }));
    chain = chain
      .then(async () => {
        const sealed = await sealRounds(env, session, question, copy, round);
        if (sealed !== null) await step("", { rounds: sealed });
      })
      .catch(() => {});
  };
  return { from, save };
}
