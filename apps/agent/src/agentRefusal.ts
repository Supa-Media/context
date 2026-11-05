/**
 * What `/agent` turned down, and what it heard, as the Worker reads them (`clients.ts` `agentAnswer`).
 *
 * A 4xx other than 401, 408, 409 and 429 is the gateway refusing the request itself before anything ran:
 * asking the same thing again is refused the same way, so a background job stops on it and says why
 * (`jobRun.ts` `rejected`) instead of spending every part on it (2026-11-05: a job started from a voice
 * message was asked nothing, and ten refused parts went in eight seconds). 401 and 408 can pass on a new
 * try: a fresh session, a quieter moment.
 */

/** The gateway hands back at most this much of what it heard (`apps/mcp/src/agent/heardWords.js` `MAX_HEARD_CHARS`). */
export const MAX_HEARD = 3_000;

/** A gateway refusal as one short line for a job's status and the logs: its status and its own reason, a fixed line of the gateway's, never the person's words. Null when it is not a refusal. */
export function refusalOf(status: number, body: Record<string, unknown>): string | null {
  if (status < 400 || status >= 500 || status === 401 || status === 408 || status === 409 || status === 429) return null;
  const why = typeof body.error_description === "string" ? body.error_description : typeof body.error === "string" ? body.error : "";
  return `${status}${why ? ` ${why.replace(/\s+/g, " ").trim()}` : ""}`.slice(0, 160);
}
