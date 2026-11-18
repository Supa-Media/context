/**
 * A Front door row's steps: what its turn did, in one short line, read from the turn's trace (`controlPlane.turnReports`,
 * which `src/agent/turnLog.js` keeps) and the answer the turn gave. A quiet row used to say only "(stayed quiet: ...)"
 * with words from whichever model call ran last, so nobody could tell which step stopped the reply (Lab, 2026-11-18).
 *
 *   tools search_mail ok, read_mail ok, tex_instructions_set failed | answer check: sent back (hands_back), went on round 2 | outcome: quiet (send say_nothing)
 *
 * Tool names, verdict codes and counts only, never a word of a note, a text or a model's answer: a name or a code that
 * is not shaped like one is written as "tool" or "not a code". At most `STEPS_CHARS`; the tool list is cut first, so the
 * outcome always survives.
 */

/** The longest summary kept, in characters: a row's steps line stays inside its detail's cap (`scripts/tex-lab-run.mjs`). */
export const STEPS_CHARS = 400;

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
const CODE = /^[a-z][a-z_]{0,39}$/;

const nameOf = (value) => (typeof value === "string" && NAME.test(value) ? value : "tool");

function toolStep(entry) {
  const action = typeof entry.action === "string" && NAME.test(entry.action) ? ` ${entry.action}` : "";
  const status = entry.held === true ? "held" : entry.ok === false ? "failed" : "ok";
  return `${nameOf(entry.tool)}${action} ${status}`;
}

function checkStep(entry, later) {
  const verdict = typeof entry.verdict === "string" ? (CODE.test(entry.verdict) ? entry.verdict : "not a code") : "no verdict";
  const round = entry.acted === true && later ? `, went on round ${later}` : "";
  return `answer check: ${entry.acted === true ? "sent back" : "let go"} (${verdict})${round}`;
}

const toolsPart = (shown, hidden) => (shown.length === 0 && hidden === 0 ? "tools none" : shown.length === 0 ? `tools +${hidden} more` : `tools ${shown.join(", ")}${hidden > 0 ? `, +${hidden} more` : ""}`);

/**
 * The turn's steps as one line. `trace` is the turn's wire trace (`turnLog.js` `wireTraceEntry`); `answer` is what the
 * turn texted ("" when it was quiet); `cancelled` when the Worker stopped the turn.
 */
export function turnSteps(trace, { answer = "", cancelled = false } = {}) {
  const entries = (Array.isArray(trace) ? trace : []).filter((entry) => entry && typeof entry === "object");
  const tools = entries.filter((entry) => entry.kind === "tool").map(toolStep);
  const checks = [];
  let rounds = 0;
  entries.forEach((entry, i) => {
    if (entry.kind === "model" && entry.ok !== false) rounds += 1;
    if (entry.kind === "judge" && (typeof entry.verdict === "string" || entry.acted === true)) {
      const later = entries.slice(i + 1).some((next) => next.kind === "model" && next.ok !== false);
      checks.push(checkStep(entry, later ? rounds + 1 : 0));
    }
  });
  const sayNothing = entries.some((entry) => entry.kind === "tool" && entry.action === "say_nothing" && entry.ok !== false);
  const outcome = cancelled ? "outcome: cancelled" : answer !== "" ? "outcome: replied" : sayNothing ? "outcome: quiet (send say_nothing)" : "outcome: quiet";
  const build = (shown, hidden) => [toolsPart(shown, hidden), ...checks, outcome].join(" | ");
  let shown = tools.length;
  let text = build(tools, 0);
  while (text.length > STEPS_CHARS && shown > 0) {
    shown -= 1;
    text = build(tools.slice(0, shown), tools.length - shown);
  }
  return text.length > STEPS_CHARS ? `${text.slice(0, STEPS_CHARS - 1)}…` : text;
}
