/**
 * `report_problem`: an agent reports a problem it hit in Context.
 *
 * The message goes to the control plane with this connection's own token
 * (`store.reportProblem`, attached in `http/routing.js`), which resolves the
 * person and sends it through the same intake as the app's bug button: the
 * same ten-a-day budget, the same destination, nothing of it stored. Nothing
 * in any workspace changes.
 */

import { toolError, toolText } from "./results.js";

const REFUSED = {
  rate_limited: "Not sent: this person has reached today's limit of problem reports. It can be sent tomorrow.",
  not_configured: "Not sent: this Context deployment is not taking problem reports.",
  invalid: "Not sent: the message is empty or too long (4,000 characters at most).",
  unavailable: "The report could not be sent just now. Try again later.",
};

export async function toolReportProblem(store, args) {
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (message === "") return toolError(REFUSED.invalid);
  if (typeof store.reportProblem !== "function") return toolError(REFUSED.not_configured);
  let answer;
  try {
    answer = await store.reportProblem(message);
  } catch {
    return toolError(REFUSED.unavailable);
  }
  if (answer?.eventId) return toolText(`Report sent (reference ${answer.eventId}). Thank you.`);
  if (answer?.refused) return toolError(REFUSED[answer.refused] || REFUSED.unavailable);
  return toolError(REFUSED.unavailable);
}
