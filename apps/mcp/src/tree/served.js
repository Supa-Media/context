/**
 * The Convex tree, as a listing, for the agent tools that list.
 *
 * `list_notes`, `orient`'s map and counts, `list_contacts`, `list_meetings`,
 * `list_channel_days` and `evaluate_lists` list from the keys the control
 * plane sends (`/gateway/tree/manifest`,
 * `apps/convex/functions/lib/nodes/gatewayManifest.ts`): one request per few
 * thousand keys, read once per tool call and reused by every listing in it.
 * Storage is never listed for them (decided by the owner, 2026-10-13: "the
 * only thing that should be reading from storage directly should be actually
 * opening and editing a note ... I don't want to see even fallbacks").
 *
 * Three things hold it:
 *
 *  - **Privacy is decided twice, never once less.** The control plane hands
 *    back only what this grant's clearance sees, through the unchanged
 *    `syncManifest`; every tool then filters with `canSee` over the
 *    workspace's rules, exactly as it filtered the bucket's own listing. A key
 *    reaches an agent only if both agree.
 *  - **Only `list` changes, and only for note keys.** A listing of plumbing
 *    (`.context/`, a dot folder) is Context's own small data, which the tree
 *    never holds, and every read and write is the bucket's: note text still
 *    comes from the bucket.
 *  - **No tree, no listing.** A workspace the tree does not serve
 *    (`served: false`), and a request that failed, timed out or came back
 *    malformed, are both told the list could not be read just now. Nothing
 *    walks the bucket instead (`TreeUnavailable`).
 *
 * Every session has a control plane (decided by the owner, 2026-10-15: there
 * is no mode without one), so a store with no `treeManifest` refuses every
 * listing of names rather than walking storage for them.
 */

// The listing has no I/O of its own and Tex reads it too: it lives in `packages/shared/src/servedListing.cjs`.
export { TreeUnavailable, TREE_UNREACHABLE, compareKeys, servedListingStore, objectOf } from "../../../../packages/shared/src/servedListing.cjs";
