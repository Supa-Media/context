import { ConvexError } from "convex/values";
import type { FileError } from "../types";

/**
 * What a thrown thing is allowed to say on somebody's screen.
 *
 * The single funnel between anything the file actions throw and the copy the
 * console renders — every notice, save failure and toast in `useFileBrowser`
 * comes through here. It lives in this module rather than in the hook because
 * a decision no test can reach is a decision nothing is holding, and this one
 * had six call sites and no test at all.
 *
 * The rule is the one `../failure.ts` states for the query side: **never a raw
 * runtime string as the headline — that is how a stack trace ends up in a
 * screenshot.** Only a `ConvexError` carrying a shaped payload reaches a
 * person; anything else is replaced wholesale. That is worth more here than in
 * most consoles, because the far side of these actions is a
 * customer-configured storage endpoint reached with a decrypted credential,
 * and an adapter throw can carry a bucket name, a host, a signed URL or a
 * provider's raw XML. The server is careful about what goes into a
 * `FileOpError`; this is the guard for everything that is not one.
 *
 * The `instanceof` check and the shape check are both load-bearing, and they
 * are not the same check. Reading `.data` off anything would surface the
 * message of any object that happens to have one; trusting the wrapper without
 * inspecting the contents would surface a `ConvexError` carrying a bare string.
 *
 * **Deliberately not built on `../failure.ts`'s `convexErrorParts`, and that is
 * a measured decision rather than duplication left in place.** Sharing it was
 * the first attempt here, on the reasoning that one answer to "what may be read
 * off a failure" beats two that can drift. It is a *widening*: that helper
 * accepts `data` as a bare string, so `new ConvexError("<a signed URL>")` would
 * have surfaced verbatim where this refuses it. The two want different
 * policies for good reasons — `describeQueryFailure` renders such a string as
 * secondary `detail` under a fixed headline, while this becomes the notice
 * itself — so they stay separate, and the test below pins the case that
 * separates them.
 */
export function toFileError(error: unknown): FileError {
  const data = serverPayload(error);
  if (data !== null) {
    return {
      code: typeof data.code === "string" ? data.code : "UNKNOWN",
      message: data.message,
      currentEtag: typeof data.currentEtag === "string" ? data.currentEtag : undefined,
    };
  }
  return { code: "UNKNOWN", message: "That did not work. Try again." };
}

/**
 * The one shape check, so the two questions asked of it cannot drift.
 *
 * Both callers below need the same fact — *did the server evaluate this and
 * answer* — and a second copy of the `instanceof` plus the `typeof` would be a
 * second place for one of them to be widened.
 */
function serverPayload(error: unknown): (Partial<FileError> & { message: string }) | null {
  if (!(error instanceof ConvexError)) return null;
  const data = error.data as Partial<FileError> | undefined;
  return typeof data?.message === "string"
    ? (data as Partial<FileError> & { message: string })
    : null;
}

/**
 * Whether the server received this request, evaluated it, and said no.
 *
 * The line the offline read paths fall back on. A **refusal** — a membership
 * removed, a grant revoked, a note whose visibility moved under a `team`
 * viewer, a note deleted — must never be overridden by a copy on the device:
 * rendering the cached body to somebody the control plane has just refused is
 * a disclosure, and doing it under an age stamp makes it read as considered.
 * A **transport** failure is the opposite case, and the whole reason the
 * fallback exists: a captive portal, a dead uplink, a socket that closed. The
 * bucket has not said anything, and a stamped copy beats an empty screen.
 *
 * The two are told apart by exactly what `toFileError` uses to decide whether
 * a message may be shown at all, which is not an accident: a `ConvexError`
 * carrying a shaped `{ code, message }` is the only thing this product's
 * server produces deliberately. Anything else — a `fetch` throw, a timeout, a
 * `ConvexError` wrapping a bare string — is not an answer, and is treated as
 * transport. That direction is deliberate: an unshaped failure is one nothing
 * vouched for, so it may not deny somebody their own cached note.
 *
 * **Two answers are not refusals, and they are enumerated rather than
 * guessed.** `STORAGE_NOT_CONNECTED` and `STORAGE_UNUSABLE` are raised inside
 * `runFileOperation` *before* `executeOperation` is called — before any path,
 * any note and any visibility decision — and that action's own callers have
 * each already established membership and a sufficient role. So by the time
 * either reaches here, authorization has **passed** and no per-note question
 * has been asked. Serving a cached copy under them cannot override a refusal,
 * because nothing was refused: the bucket was unreachable.
 *
 * That case is not a corner. It is a revoked key, a rebind in progress, and
 * Cloudflare's 10042 — a card that failed months after signup, which
 * `CLAUDE.md` records as leaving the customer's data intact and warns reads as
 * us having lost their notes. A person whose bucket is down is exactly who an
 * offline copy is for, and a "fix" that blanks their notes during an outage
 * would be a regression shipped under a security banner.
 *
 * **The list is of codes safe to override, never of codes that are refusals**,
 * and that direction is the whole safety argument. An unknown code — a denial
 * added to the server next month that nobody thinks about here — is not on the
 * list, so it is treated as a refusal and the cache stays shut. The inverted
 * list, "these codes are denials, everything else is transport", fails the
 * other way and would serve note text to somebody the server had just refused.
 *
 * `STORAGE_FAILED` is deliberately **not** on it. It is `toConvexError`'s
 * catch-all for a failure whose text we have not vetted, so it can be thrown
 * from anywhere, including from inside an operation that had already reached a
 * note. A code that means "something unexpected" cannot carry a promise about
 * when it was raised.
 *
 * `__tests__/cachedAfterRefusal.test.ts` pins the behaviour, and the Convex
 * suite pins the premise: the two codes must keep being raised before
 * `executeOperation`, or this allow-list is describing a version of the server
 * that no longer exists.
 */
const OVERRIDABLE_STORAGE_CODES = new Set(["STORAGE_NOT_CONNECTED", "STORAGE_UNUSABLE"]);

export function isServerRefusal(error: unknown): boolean {
  const payload = serverPayload(error);
  if (payload === null) return false;
  return !(typeof payload.code === "string" && OVERRIDABLE_STORAGE_CODES.has(payload.code));
}
