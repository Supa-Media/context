/**
 * A query that came back as an error instead of data, turned into a screen.
 *
 * ## Why a failed query is a *value* here and not a throw
 *
 * Convex's `useQuery` re-throws a failed query **during render**:
 *
 * ```js
 * const result = results["query"];
 * if (result instanceof Error) throw result;   // convex/react
 * ```
 *
 * So a console built on `useQuery` has no failure state — it has an unmount. One
 * transient error on `listMyWorkspaces` (an auth blip, a deploy, a backend
 * hiccup) took the whole console down to a blank dark page, and every
 * `value instanceof Error` guard written against it was dead code, because the
 * throw happened first.
 *
 * `useQueries` is the version of the same subscription that hands the error back
 * as a value, which is what makes this module possible and what
 * `useLiveConsoleData` and `useMembers` now use. See `./querySpec.ts` for the
 * rules a `useQueries` spec has to follow.
 *
 * The rule for the copy is the one `storage/errors.ts` states: **the code
 * decides what to do next, the message says what happened.** An unrecognised
 * failure gets an honest shrug plus whatever the backend said, never invented
 * advice and never a raw runtime string as the headline — that is how a stack
 * trace ends up in a screenshot.
 */

export interface ConsoleFailure {
  /** What happened, in one line. */
  headline: string;
  /** What to do about it. */
  next: string;
  /** The backend's own words, when there are any. */
  detail?: string;
}

/** The `code` and `message` on a thrown `ConvexError`, when there are any. */
function convexErrorParts(error: unknown): {
  code: string | undefined;
  message: string | undefined;
} {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null) {
    const record = data as { code?: unknown; message?: unknown };
    return {
      code: typeof record.code === "string" ? record.code : undefined,
      message: typeof record.message === "string" ? record.message : undefined,
    };
  }
  if (typeof data === "string") return { code: undefined, message: data };
  return { code: undefined, message: undefined };
}

/**
 * Describe a query failure the console cannot carry on without.
 *
 * `subject` names what could not be loaded — "your contexts", "who can reach
 * this context" — so one function serves every pane without any of them saying
 * "an error occurred".
 */
export function describeQueryFailure(error: unknown, subject: string): ConsoleFailure {
  const { code, message } = convexErrorParts(error);

  switch (code) {
    case "NOT_AUTHENTICATED":
      return {
        headline: "Your session ended",
        next: "Sign in again and this will come straight back.",
      };
    case "INSUFFICIENT_ROLE":
      return {
        headline: "You don't have access to this any more",
        next: "Ask an owner of this context to check what you can do.",
      };
    case "WORKSPACE_NOT_FOUND":
      return {
        headline: "This context is no longer available to you",
        next: "You may have been removed from it. Pick a different one.",
      };
    default:
      return {
        headline: `We couldn't load ${subject}`,
        next: "Nothing has happened to your notes — they live in your own bucket. Try again in a moment.",
        detail: message !== undefined && message.trim().length > 0 ? message.trim() : undefined,
      };
  }
}
