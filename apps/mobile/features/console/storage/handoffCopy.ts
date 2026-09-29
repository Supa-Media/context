/**
 * What the owner reads when a move out of managed storage stops.
 *
 * Keyed by the closed error codes the move records (`functions/managedProvisioning.ts`),
 * never by a provider's own text. Every message says the managed copy is
 * still live, because it is: a move that stops has switched nothing.
 */
const STILL_LIVE = "Your workspace keeps running from Context's storage, unchanged.";

export function describeHandoffFailure(code: string | undefined): string {
  switch (code) {
    case "DESTINATION_NOT_EMPTY":
      return (
        "That bucket already has files in it, and Context won't change or delete them. " +
        "Choose an empty bucket, or add a root prefix to use an empty folder inside it. " +
        STILL_LIVE
      );
    case "TARGET_NOT_READY":
      return `Context couldn't reach that bucket with the key you gave. Check the key, then try again. ${STILL_LIVE}`;
    case "OBJECT_TOO_LARGE":
      return `A file is too large to move this way yet. ${STILL_LIVE}`;
    default:
      return `The move stopped before switching over. ${STILL_LIVE} Re-enter the destination to retry.`;
  }
}

/** The line above the destination form. */
export const HANDOFF_FORM_LEDE =
  "Choose a bucket you own. It must be empty, or give a root prefix for an empty folder inside it. " +
  "Your files arrive as plain Markdown and attachments, and your workspace keeps running from " +
  "Context's storage until every file matches.";
