/**
 * EVERY TOOL CALL THAT FAILS IS KEPT WITH ITS CAUSE (Dev2, 2026-11-10: "whenever there is a tool call
 * failure, I want it logged and visible for us to understand why, that way as time goes on we are
 * looking at why tool calls fail and fix").
 *
 * Every Tex model that holds tools runs `runTurn` (`turn.js`): the front door, a job's turns, a
 * routine, a check-in, housekeeping, a dream. The advisor and the judges hold none. So `runTurn` is
 * the one place a failure is seen, and it records each one here as:
 *
 * - `tool`: the tool's name, or the name the model wrote when it named no real tool;
 * - `cause`: one of `CAUSES`, a code;
 * - `why`: the reason in one line, with every value taken out (`failureShape`): a path, a quote, a
 *   link, an address, a number or a handle becomes `<path>`, `<q>`, `<url>`, `<email>`, `<n>`,
 *   `<@>`. What is left is the sentence our code wrote, so the same failure reads the same in every
 *   chat and they group, and nobody's note name or search rides along.
 *
 * Where it goes: a `tex_tool_failed` line in this Worker's logs at once (`logToolFailure`), and,
 * after the answer, rows with no person, workspace or chat on them in the control plane
 * (`apps/convex/functions/texToolFailures.ts`), which tex.lc/admin reads as "Why tools fail". The
 * chat's own history keeps the whole result as before (`ledger.js`), for whoever can read that chat.
 *
 * A thrown error's own words never reach the model (`turn.js` says why); its class and shaped
 * message are what the log needs to say why, so they are kept here and only here.
 */

/** Why a call failed, as a code. */
export const CAUSES = Object.freeze([
  "refused", // the tool answered with an error: our code said no, or what it reached did
  "threw", // the tool threw; its words stay out of the model's sight
  "timed_out", // ran past its time and was stopped
  "out_of_time", // asked for after the turn's tool time was spent
  "not_offered", // a tool the turn was never given
  "no_such_action", // one of the six with an action it does not have
  "repeated", // a write already made this turn, asked again
]);

/** The longest `why` kept. */
export const MAX_WHY = 160;
/** The most failures one turn reports: a turn has at most 24 rounds, and a runaway one is not worth more rows. */
export const MAX_FAILURES_PER_TURN = 20;

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/*
  Order matters: a link holds a path and an address holds an @, so they go first, and a quote is
  taken whole before anything inside it is looked at.
*/
const SHAPES = [
  [/https?:\/\/\S+/gi, "<url>"],
  [/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, "<email>"],
  [/"[^"]*"|“[^”]*”|‘[^’]*’|`[^`]*`|(?<![\w])'[^']*'(?![\w])/g, "<q>"],
  [/(^|[\s(\[])@[\w.-]+/g, "$1<@>"],
  // A path: anything with a slash in it, or a file name with an extension.
  [/[\w.~-]*\/(?:[\w./~@-]*[\w~@-])?|\b[\w-]+\.(md|txt|pdf|png|jpe?g|gif|webp|heic|csv|json|html?|ics|docx?|xlsx?|pptx?|zip|mp3|m4a|mp4|mov)\b/gi, "<path>"],
  [/\+?\d[\d\s().:,/-]*\d|\d/g, "<n>"],
];

/** The reason in one line with every value taken out: what our code said, never what it was said about. */
export function failureShape(text) {
  if (typeof text !== "string") return "";
  let line = text.split("\n").find((part) => part.trim() !== "") ?? "";
  line = line.replace(/[\u0000-\u001f\u007f]/g, " ");
  for (const [pattern, mark] of SHAPES) line = line.replace(pattern, mark);
  line = line.replace(/\s+/g, " ").trim();
  return line.length > MAX_WHY ? `${line.slice(0, MAX_WHY - 1)}…` : line;
}

/** The text of a tool's answer, as the model read it. */
function resultText(result) {
  if (typeof result?.why === "string" && result.why.trim()) return result.why;
  const part = Array.isArray(result?.content) ? result.content.find((item) => item?.type === "text") : null;
  return typeof part?.text === "string" ? part.text : "";
}

/**
 * One failure as it is kept. `result` is what the model read; `error`, when the tool threw, is
 * the error itself, whose class and message say why where the model's "That call failed" does not.
 */
export function toolFailure({ tool, cause, result = null, error = null, text = null, ms = 0, model = null, round = null }) {
  const name = typeof tool === "string" && TOOL_NAME.test(tool) ? tool : "unknown_tool";
  const why = error !== null && error !== undefined
    ? failureShape(`${error?.name && error.name !== "Error" ? `${error.name}: ` : ""}${error?.message ?? String(error)}`)
    : failureShape(text ?? resultText(result));
  return {
    tool: name,
    cause: CAUSES.includes(cause) ? cause : "refused",
    why: why || "(no reason given)",
    ms: Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0,
    ...(typeof model === "string" && model ? { model } : {}),
    ...(Number.isInteger(round) ? { round } : {}),
  };
}

/** One `tex_tool_failed` line in this Worker's logs, at once: who it was for, never their words. */
export function logToolFailure(failure, { client = null, workspace = null } = {}) {
  try {
    console.log(JSON.stringify({ event: "tex_tool_failed", ...(client ? { client } : {}), ...(workspace ? { workspace } : {}), ...failure }));
  } catch {
    // A log line never fails a turn.
  }
}

/** A turn's failures as the control plane takes them: the codes and the shaped line, at most `MAX_FAILURES_PER_TURN`. */
export function wireFailures(failures) {
  if (!Array.isArray(failures)) return [];
  return failures.slice(0, MAX_FAILURES_PER_TURN).map(({ tool, cause, why, model }) => ({ tool, cause, why, ...(model ? { model } : {}) }));
}

/**
 * Sends a finished run's failures to the control plane (`/gateway/tool-failures`), best effort:
 * nothing when there were none, and a control plane that could not be reached costs us rows,
 * never anybody their answer.
 */
export async function reportToolFailures(controlPlane, session, kind, failures) {
  const wire = wireFailures(failures);
  if (wire.length === 0 || typeof controlPlane?.recordToolFailures !== "function") return false;
  try {
    await controlPlane.recordToolFailures(session.accessToken, session.workspaceId, { kind, failures: wire });
    return true;
  } catch {
    return false;
  }
}
