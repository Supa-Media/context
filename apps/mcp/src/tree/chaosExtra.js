/**
 * What the chaos score needs beyond a note's key (`scoreKeys`' extras in `chaos/live.js`), read off the note's props:
 * one copy for the control plane's facts (`apps/convex/functions/lib/nodes/facts.ts`) and a workspace object's own
 * (`workspaceStore/facts.js`).
 */

import { CONTACTS_FOLDER, asInboxKey } from "../../../../packages/communications/src/protocol.js";
import { hasReview, isExempt, LONG_NOTE_LINES } from "../chaos/rubric.js";

/**
 * `null` for a note the score needs nothing more of; otherwise its line count, whether it is exempt, and whether it
 * carries a `review:`: a note past the long-note line, or a contact page with a review.
 *
 * @param {string} path
 * @param {string | null | undefined} props `propsOf` as JSON
 * @returns {{ lines: number | null, exempt: boolean, review: boolean } | null}
 */
export function chaosExtraOf(path, props) {
  if (props === null || props === undefined) return null;
  let parsed;
  try {
    parsed = JSON.parse(props);
  } catch {
    return null;
  }
  const properties = parsed?.properties ?? {};
  const lines = typeof parsed?.lines === "number" && Number.isFinite(parsed.lines) ? parsed.lines : null;
  const review = hasReview(properties.review);
  const long = lines !== null && lines > LONG_NOTE_LINES;
  if (!long && !(asInboxKey(path).startsWith(`${CONTACTS_FOLDER}/`) && review)) return null;
  return { lines, exempt: isExempt(path, properties.type, properties.generated), review };
}
