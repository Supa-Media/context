/**
 * The Hand-off node, `handoff` (Dev2, 2026-11-18: "the front door stays fast for quick replies. When a job is long or
 * multi-step, it acknowledges right away and hands the job to a background worker that gets more rounds"; on the node
 * shelf until a Lab draft wires it).
 *
 * It is asked at two moments, each by its own wire, and its input's `cause` says which. "rounds" (`fd -> handoff`): the
 * front door is two rounds from its bound and still calling tools (`turn.js`), so the job is bigger than one turn; before
 * this it was told to stop gathering and say what it had. "check" (`answerCheck -> handoff`): the front door's draft
 * would be sent back again, and the answer check's send-back budget is spent (`answerCheck.js`). That is the shape of a job the front door could not finish inside its budget, whatever
 * the ask says: it drafted, a check proved the draft short of the ask (an offer instead of the act, an answer with no
 * read of the record, a claim with no source), and it ran out of tries. Before this the draft went as it was. Now the
 * job goes to a background worker (`background.js`, the same `job` node every job runs as), the person's text gets the
 * usual start tapback, and the worker's report is their answer.
 *
 * No model and no reads: pure code over what it is handed, logged like every node. Output `to`: "hand" with the job's
 * title, brief and done line, or "keep" with why the draft goes as it is.
 */

/**
 * The brief fits the job's own cap (`background.js` MAX_BRIEF, 2,000): their ask first, then what the turn found (what
 * keeps the worker from reading, or writing, it again), then why it was handed on, then the unsent words, each bounded.
 */
export const MAX_BRIEF = 2_000;
const MAX_ASK = 600;
/** The most of the turn's tool results the brief carries: the job reads the rest again if it needs it. */
export const MAX_FOUND = 900;
const MAX_RESULT = 300;
const MAX_DRAFT = 300;
const MAX_TITLE = 80;

const clip = (text, n) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** A job's title from their ask: its first sentence, short. */
export function handoffTitle(ask) {
  const first = String(ask ?? "").trim().split(/(?<=[.!?])\s|\n/)[0] ?? "";
  return clip(first, MAX_TITLE);
}

/** What the turn already found: its tool results, newest last, within `MAX_FOUND`. */
export function foundSoFar(found) {
  const lines = [];
  let used = 0;
  for (const entry of [...(Array.isArray(found) ? found : [])].reverse()) {
    const line = `- ${String(entry?.name ?? "?")}${entry?.isError ? " (failed)" : ""}: ${clip(entry?.text, MAX_RESULT)}`;
    if (used + line.length > MAX_FOUND) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines;
}

/**
 * @param {{ ask: string, draft?: string, notice?: string, found?: { name: string, text: string, isError?: boolean }[], cause?: "rounds" | "check" }} input
 */
export async function handoffNode(input) {
  const ask = String(input?.ask ?? "").trim();
  const notice = String(input?.notice ?? "").trim();
  const rounds = input?.cause === "rounds";
  if (ask === "") return { to: "keep", why: "no ask of theirs to hand on" };
  if (!rounds && notice === "") return { to: "keep", why: "the draft was not held back" };
  const found = foundSoFar(input?.found);
  const brief = [
    `Finish what they asked, all of it, and text them the result: ${clip(ask, MAX_ASK)}`,
    ...(found.length > 0 ? ["Already found this turn (use it; anything that changed something is done, so don't do it again):", ...found] : []),
    rounds ? "The front door ran out of rounds in its turn while it was still looking." : `The front door ran out of tries in its turn. Its last draft was never sent, because: ${clip(notice, 200)}`,
    ...(input?.draft ? [rounds ? `What it last said while working, not sent: ${clip(input.draft, MAX_DRAFT)}` : `That draft, not sent (do what it offered or promised instead of offering it): ${clip(input.draft, MAX_DRAFT)}`] : []),
  ].join("\n").slice(0, MAX_BRIEF);
  return { to: "hand", title: handoffTitle(ask), brief, doneWhen: "every part of their ask is done and they have the result" };
}
