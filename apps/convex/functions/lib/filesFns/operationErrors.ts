/**
 * Turning a failed operation into an error the console can branch on.
 *
 * Split out of `functions/files.ts`.
 */

import { ConvexError } from "convex/values";
import { FileOpError } from "../fileOps";

/**
 * A `FileOpError` carries a code and a message written for a person. Anything
 * else is a provider or runtime failure whose text we have not vetted, so it
 * becomes one fixed sentence rather than being forwarded — a bucket's error
 * body is not ours to publish, and could echo a request we made.
 */
export function toConvexError(error: unknown): ConvexError<{
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
  return new ConvexError({
    code: "STORAGE_FAILED",
    message: "Your bucket did not complete that request. Try again.",
  });
}
