/**
 * The one sentence Browse says about a context with no bucket.
 *
 * It is the server's own STORAGE_NOT_CONNECTED refusal
 * (`apps/convex/functions/lib/filesFns/fileOperationBarrier.ts`), word for
 * word, so the refusal arriving on `files.notice` and the binding being `null`
 * are recognisably the same fact and are drawn once.
 */
export const NO_BUCKET_NOTICE =
  "This context has no bucket connected yet. Connect storage before browsing files.";

/**
 * Whether a file-browser notice is that refusal. Matched on the first
 * sentence, which every STORAGE_NOT_CONNECTED message shares, so a later edit
 * to the second sentence does not bring the duplicate card back.
 */
export function isNoBucketNotice(notice: string | null): boolean {
  return notice !== null && notice.startsWith("This context has no bucket connected yet.");
}
