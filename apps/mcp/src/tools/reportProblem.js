/**
 * `report_problem`: an agent reports a problem it hit in Context.
 *
 * The message goes to the control plane with this connection's own token
 * (`store.reportProblem`, attached in `http/routing.js`), which resolves the
 * person and sends it through the same intake as the app's bug button: the
 * same ten-a-day budget, the same destination, nothing of it stored. Nothing
 * in any workspace changes.
 *
 * By text it is a bug report the person files through Tex, and it never goes
 * as it is called: `reportGate.js` holds it until they reply YES to the exact
 * report, and only that approved replay attaches their recent texts. This
 * handler never reads the texts itself, so a call that reached it some other
 * way sends the message alone.
 */

import { toolError, toolText } from "./results.js";

export const REPORT_TOOL = "report_problem";
/** Kept equal to `FEEDBACK_LIMITS.messageChars` in `@context/shared`. */
export const MAX_REPORT_CHARS = 4_000;

const REFUSED = {
  rate_limited: "Not sent: this person has reached today's limit of problem reports. It can be sent tomorrow.",
  not_configured: "Not sent: this Context deployment is not taking problem reports.",
  invalid: "Not sent: the message is empty or too long (4,000 characters at most).",
  unavailable: "The report could not be sent just now. Try again later.",
};

/** The report's message, trimmed, or null when it is empty or too long. */
export function reportMessage(args) {
  const message = typeof args?.message === "string" ? args.message.trim() : "";
  return message === "" || [...message].length > MAX_REPORT_CHARS ? null : message;
}

/** Send one report; `texts` only ever comes from `reportGate.js`, after the person's YES. */
export async function sendReport(store, message, texts = undefined) {
  if (message === null) return toolError(REFUSED.invalid);
  if (typeof store.reportProblem !== "function") return toolError(REFUSED.not_configured);
  let answer;
  try {
    answer = await store.reportProblem(message, texts);
  } catch {
    return toolError(REFUSED.unavailable);
  }
  if (answer?.eventId) return toolText(`Report sent (reference ${answer.eventId}). Thank you.`);
  if (answer?.refused) return toolError(REFUSED[answer.refused] || REFUSED.unavailable);
  return toolError(REFUSED.unavailable);
}

export async function toolReportProblem(store, args) {
  return await sendReport(store, reportMessage(args));
}
