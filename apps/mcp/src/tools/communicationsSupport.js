/** Limits and labels the meeting and contact tools share. Moved verbatim out of `src/index.js`. */

/**
 * How many store operations one note-path resolution may spend, once the
 * direct read at the stored path has already come back missing.
 *
 * Small on purpose: this only runs at all on a 404, and it answers "where did
 * this one note go", not "search the bucket" — a handful of shard reads is the
 * whole cost, and anything left over belongs to the request that follows.
 */
export const MEETING_RESOLVE_SEARCH_BUDGET = 20;

/**
 * How many ranked candidates a resolution reads before giving up.
 *
 * Wider than 1 on purpose — see `resolveMeetingNotePath`'s note on why the
 * query cannot be the meeting id itself. A handful of frontmatter reads is
 * still small next to a bucket listing, and each one is a note this search
 * already ranked as plausible.
 */
export const MEETING_RESOLVE_CANDIDATES = 8;

/** The last segment of a key: `…/2026-03-04-sync-8h9jkmnp.md` → the filename. */
export function meetingFileName(key) {
  return key.slice(key.lastIndexOf("/") + 1);
}

/**
 * How many activity entries a contact page shows before it says how many more
 * there are.
 *
 * A contact page is small by construction — it holds links, never message text
 * — but a person the user has corresponded with for three years holds a link
 * per message, and the whole point of the default read is that a tool call
 * does not spend a model's context on a list it did not ask for. Five is
 * "when did we last speak, and about what", which is the question that brings
 * anybody here; `activity: true` is the rest.
 */
export const CONTACT_ACTIVITY_PREVIEW = 5;

/**
 * The one line that has to be said about every contact page, wherever it is
 * printed.
 *
 * A contact page is the only thing this product writes whose **filename was
 * chosen by whoever sent the user a message** (`contactPathForDraft`, and the
 * security review that named that fact). Its name, its organization and its
 * identifiers are values off inbound mail: a sender who signs himself the
 * user's accountant gets a page that says so. Nothing here verified any of it,
 * and a model that is handed this page without being told will read it as the
 * context's own claim about a person.
 *
 * So the sentence is a constant used by both tools rather than a nicety one of
 * them remembers: the listing is where somebody decides who to read about, and
 * the read is where they decide what to believe.
 */
export const CONTACT_PROVENANCE =
  "A contact page is built from what correspondents wrote in their own messages, at a path " +
  "their own address chose. Every name, organization and identifier on one is a claim its " +
  "sender made; none of it was verified here.";
