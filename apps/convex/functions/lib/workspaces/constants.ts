/**
 * Caps and limits shared by the `workspaces.ts` Convex functions.
 *
 * Split out of `functions/workspaces.ts` — see that file's header for what
 * owns a context and why a personal and a shared context are the same row.
 */

export const MAX_DISPLAY_NAME_LENGTH = 80;

/**
 * How many contexts one account may own, and how fast it may create them.
 *
 * ## Why there is a limit at all
 *
 * Creating a workspace claims a name out of a single global namespace that has
 * no release, rename, or delete path — a claim is permanent. The short end of
 * `[a-z0-9-]{2,32}` is small (~1.3k two-character names, ~46k three-character
 * ones), so an unlimited account can exhaust the memorable part of the
 * namespace in minutes and keep it forever. Names are also the addressing
 * scheme (`@name/1-projects/foo.md`) and a future subdomain, which makes a
 * squatted name an impersonation surface as well as a denial of one.
 *
 * ## The numbers, and what they are a guess at
 *
 * These are a **product decision made here rather than left implicit**, and
 * they are deliberately loose enough that no honest user meets them:
 *
 *  - `MAX_WORKSPACES_PER_USER` — one personal context plus a healthy number of
 *    shared ones. Someone genuinely running more than this is a case to look
 *    at, and raising a constant is a one-line change; un-squatting a namespace
 *    is not.
 *  - `WORKSPACE_CREATE_*` — a burst limit, aimed at scripted claiming rather
 *    than at people. Creating ten contexts in an hour by hand does not happen.
 *
 * Ownership is counted from `workspaceMembers`, so this bounds contexts a user
 * *owns*, not contexts they were invited into: being added to a colleague's
 * shared context must never use up your own allowance.
 */
export const MAX_WORKSPACES_PER_USER = 10;
export const WORKSPACE_CREATE_LIMIT = 5;
export const WORKSPACE_CREATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Caps on how many rows one response carries.
 *
 * An unbounded `.collect()` reads however many rows exist, which is a cost set
 * by whoever can insert them. These bound the read; if a real workspace ever
 * approaches one, it needs pagination rather than a bigger constant.
 */
export const MAX_MEMBERS_RETURNED = 200;
export const MAX_WORKSPACES_RETURNED = 100;

/**
 * How often one workspace may ask us to write a starting layout into its
 * bucket.
 *
 * Scaffolding is a handful of outbound writes to a customer-supplied endpoint,
 * so the reasoning is `reverifyStorage`'s: keyed by **workspace**, because the
 * workspace is what has a bucket, and loose enough that a person retrying a
 * failed connect never meets it.
 */
export const APPLY_STRUCTURE_LIMIT = 10;
export const APPLY_STRUCTURE_WINDOW_MS = 60 * 60 * 1000;
