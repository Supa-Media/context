/**
 * Turning a failed operation into an error the console can branch on.
 *
 * Split out of `functions/files.ts`.
 */

import { ConvexError } from "convex/values";
import { FileOpError } from "../fileOps";
import { NOTE_CAP_REACHED, NoteCapReached } from "../../../../mcp/src/store/noteCap.js";
import { readFailureKind } from "../../../../mcp/src/store/readFailure.js";
import { encryptedUnreadable } from "../managedEncryptionFns/storeOption";

/**
 * A `FileOpError` carries a code and a message written for a person. Anything
 * else is a provider or runtime failure whose text we have not vetted, so it
 * becomes one fixed sentence rather than being forwarded — a bucket's error
 * body is not ours to publish, and could echo a request we made.
 *
 * That fixed sentence used to be the only trace: nothing was logged, so a
 * workspace that would not open (@shyoh, 2026-10-19) left no word in Convex's
 * logs to say why. Every failure that lands here is now logged as closed,
 * path-free words beside the workspace id (`describeFailure`).
 */
export function toConvexError(
  error: unknown,
  /** For the log line only; never in what the caller sees. */
  workspaceId?: string,
): ConvexError<{
  code: string;
  message: string;
  currentEtag?: string;
}> {
  if (error instanceof FileOpError) {
    return new ConvexError({
      code: error.code,
      message: error.message,
      ...(error.currentEtag === undefined ? {} : { currentEtag: error.currentEtag }),
    });
  }
  if (error instanceof ConvexError) return error;
  // The free managed tier's cap, refused inside the store. Our own sentence,
  // naming what still works and both ways to more room.
  if (error instanceof NoteCapReached) {
    return new ConvexError({ code: NOTE_CAP_REACHED, message: error.message });
  }
  console.error("file_operation.failed", { workspaceId: workspaceId ?? null, ...describeFailure(error) });
  // A sealed note that will not open, or a plain one in a workspace that only
  // serves sealed bytes. Retrying cannot cure either, so it is the console's
  // "can't be opened" refusal (`console/files/unreadable.ts`), not a bucket
  // hiccup the app retries forever. Matched by name, as `rethrowUnreadable`
  // does, because this error used to reach that function already converted.
  if ((error as { name?: unknown } | null)?.name === "ManagedEncryptionError") {
    return encryptedUnreadable();
  }
  return new ConvexError({
    code: "STORAGE_FAILED",
    message: "Your bucket did not complete that request. Try again.",
  });
}

/**
 * What an operator may read about a failure: closed words and numbers only.
 *
 * Never the message: an S3 error names the key, a constructor's message can
 * quote the endpoint the customer typed, and a provider's body is theirs. The
 * HTTP status and verb are read out of our own adapter's fixed sentence
 * (`S3 <VERB> … failed with <status>`), and the encryption code and detail
 * are `ManagedEncryptionError`'s own fixed words.
 */
export function describeFailure(error: unknown): {
  kind: string;
  name: string | null;
  code: string | null;
  detail: string | null;
  verb: string | null;
  status: number | null;
  at: string[];
} {
  const shaped = (error ?? null) as { name?: unknown; code?: unknown; detail?: unknown; message?: unknown; stack?: unknown } | null;
  const word = (value: unknown, pattern: RegExp): string | null =>
    typeof value === "string" && pattern.test(value) ? value : null;
  const message = typeof shaped?.message === "string" ? shaped.message : "";
  const s3 = /^S3 ([A-Z]{2,12}) .* failed with (\d{3})\b/.exec(message);
  const encryption = shaped?.name === "ManagedEncryptionError";
  return {
    kind: readFailureKind(error),
    name: word(shaped?.name, /^[A-Za-z]{1,40}$/),
    code: encryption ? word(shaped?.code, /^[A-Z_]{1,40}$/) : null,
    detail: encryption ? word(shaped?.detail, /^[a-z ]{1,60}$/) : null,
    verb: s3?.[1] ?? null,
    status: s3 === null ? null : Number(s3[2]),
    at: framesOf(shaped),
  };
}

/**
 * Where it was thrown: the top stack frames, each a function name and a
 * source location in this repository's own code. A plain `Error` from our
 * code (kind `other`, @shyoh again) says nothing else. The message leads the
 * stack and never reaches the log: its lines are dropped by count, because a
 * multi-line message can carry a line shaped exactly like a frame, and only
 * lines shaped like one are kept from what is left.
 */
function framesOf(shaped: { stack?: unknown; message?: unknown } | null): string[] {
  const stack = typeof shaped?.stack === "string" ? shaped.stack : "";
  const lines = stack.split("\n");
  // The message leads the stack and is not ours — a provider's words, or words built around
  // something a person named — and it may hold newlines. Its own lines are dropped by count
  // rather than by shape, since a line inside a message can be shaped exactly like a frame.
  const message = typeof shaped?.message === "string" ? shaped.message : "";
  const head = message.split("\n");
  const led = message !== "" && (lines[0] ?? "").includes(head[0]!);
  return lines
    .slice(led ? head.length : 0)
    .map((line) => line.trim())
    .filter((line) => /^at (?:[\w$.<>\[\] ]{1,80} \()?[\w./@:-]{1,200}:\d+:\d+\)?$/.test(line))
    .slice(0, 6);
}
