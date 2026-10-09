/**
 * The meeting-summary request, as plain functions with no React in them.
 *
 * The gateway writes a meeting's summary into its note (`POST /meetings/summary`,
 * see `packages/meetings/src/summary.js` for what the model is asked). This app
 * never writes the summary text itself: it asks, and the open editor shows the
 * result as an ordinary external write. So what lives here is only the request,
 * the one line of words a status is worth, and the rule for when a meeting
 * starts one on its own.
 */

import { MAX_INSTRUCTION_CHARS, needsAutomaticSummary } from "@context/meetings/summary";
import { gatewayOriginFrom } from "./gateway";

/** The gateway's route, relative to its origin. */
export const SUMMARY_PATH = "/meetings/summary";

/**
 * The gateway makes two model calls of up to a minute each, so this outlasts
 * both. Shorter and a slow model reads as a failure; longer and a dead
 * connection holds the button on "Writing summary…" for too long.
 */
export const SUMMARY_TIMEOUT_MS = 150_000;

/** Every answer the gateway gives, plus "failed" for anything that never got one. */
export type SummaryStatus =
  | "written"
  | "skipped"
  | "recording"
  | "waiting"
  | "too_short"
  | "unavailable"
  | "failed"
  | "conflict";

const STATUSES: ReadonlySet<string> = new Set<SummaryStatus>([
  "written",
  "skipped",
  "recording",
  "waiting",
  "too_short",
  "unavailable",
  "failed",
  "conflict",
]);

/** `<gateway origin>/meetings/summary` for a workspace endpoint, or `null` when the endpoint is not a URL. */
export function summaryRoute(endpoint: string): string | null {
  const origin = gatewayOriginFrom(endpoint);
  return origin === null ? null : new URL(SUMMARY_PATH, origin).toString();
}

export interface RequestSummaryOptions {
  fetchImpl?: typeof fetch;
  /** The gateway's origin, as `gatewayOriginFrom` derives it. */
  origin: string;
  /** A console grant access token. Sent as a bearer; never logged or stored. */
  token: string;
  /** The note's path in the workspace. */
  path: string;
  /** What should change, from the Redo panel. Omitted for an automatic summary. */
  instruction?: string;
  /** `true` for Redo, which always rewrites; `false` writes only an empty, waiting or failed summary. */
  force: boolean;
  timeoutMs?: number;
}

/**
 * Ask the gateway for a summary and report what it said.
 *
 * Resolves to the gateway's status, or `"failed"` for anything else: a non-2xx
 * answer, a body that is not one of the statuses, a thrown fetch, or no answer
 * before the timeout. It never rejects, because the caller only has one thing
 * to do with a failure, which is to say so in a line.
 */
export async function requestSummary(options: RequestSummaryOptions): Promise<SummaryStatus> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const instruction = options.instruction?.trim().slice(0, MAX_INSTRUCTION_CHARS) ?? "";
  const body: { path: string; force: boolean; instruction?: string } = { path: options.path, force: options.force };
  if (instruction !== "") body.instruction = instruction;

  const abort = typeof AbortController === "function" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The race is what makes the timeout hold even for a fetch that ignores its
  // signal; the abort is what lets a real request stop instead of lingering.
  const deadline = new Promise<SummaryStatus>((resolve) => {
    timer = setTimeout(() => {
      abort?.abort();
      resolve("failed");
    }, timeoutMs);
  });

  const answer = (async (): Promise<SummaryStatus> => {
    try {
      const response = await fetchImpl(new URL(SUMMARY_PATH, options.origin).toString(), {
        method: "POST",
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: abort?.signal,
      });
      if (!response.ok) return "failed";
      const value: unknown = await response.json();
      const status = typeof value === "object" && value !== null ? (value as { status?: unknown }).status : undefined;
      return typeof status === "string" && STATUSES.has(status) ? (status as SummaryStatus) : "failed";
    } catch {
      return "failed";
    }
  })();

  try {
    return await Promise.race([answer, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The one short sentence to show for a status, or `null` when nothing should be
 * said. A written or skipped summary speaks for itself in the note.
 */
export function summaryMessage(status: SummaryStatus): string | null {
  switch (status) {
    case "written":
    case "skipped":
      return null;
    case "recording":
      return "This meeting is still recording. The summary comes when it ends.";
    case "waiting":
      return "Today's summaries are used up. This one will be written tomorrow.";
    case "too_short":
      return "There wasn't enough said to summarize.";
    case "unavailable":
      return "Summaries aren't available right now.";
    case "failed":
      return "Couldn't write the summary. Try again in a moment.";
    case "conflict":
      return "The note changed while the summary was being written. Try again.";
  }
}

/**
 * Whether opening a note should start a summary by itself: the note is a
 * meeting that wants one, somebody may edit it, nothing is already being
 * written for it, and this app session has not already asked for it once.
 *
 * `started` is the session's set of `workspaceId:path` keys that have asked
 * already. It is the caller's, and this function does not change it.
 */
export function automaticSummaryDue(input: {
  key: string;
  text: string;
  canEdit: boolean;
  pending: boolean;
  started: ReadonlySet<string>;
}): boolean {
  return input.canEdit && !input.pending && !input.started.has(input.key) && needsAutomaticSummary(input.text);
}

/** The session key an automatic request is remembered under. */
export function summaryKey(workspaceId: string, path: string): string {
  return `${workspaceId}:${path}`;
}
