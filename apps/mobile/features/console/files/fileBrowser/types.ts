/**
 * The types `useFileBrowser` and its parts share. Moved out of
 * `useFileBrowser.ts` verbatim; `FileBrowserOptions` is the hook's options
 * argument, given a name so each part can take the fields it reads.
 */
import type { MoveDestination } from "../browser";
import type { FolderListing } from "../types";
import type { VisibilityTier } from "../../visibility";

export type Listings = Record<string, FolderListing | undefined>;

export interface FileBrowserOptions {
  workspaceId: string | null;
  canEdit: boolean;
  readOnlyReason?: string;
  /**
   * Whether the caller owns this context.
   *
   * Separate from `canEdit`, which an `editor` also has. Only the owner may
   * rewrite the access map, so this is what decides whether the repair control
   * exists — see `canResetPrivacy` on `FileBrowser`.
   */
  isOwner?: boolean;
  /**
   * How much of this context the person at the keyboard can see.
   *
   * Not derivable from `isOwner`, and that is the point: `isOwner === false`
   * covers both "an editor" and "the context list has not landed yet", and
   * those two need opposite answers from a cache. `visibilityTierForRole` is
   * the one place this app decides it, so it is passed rather than re-derived
   * — see `features/offline/keys.ts` for what a copy taken at the wrong
   * clearance costs.
   */
  tier: VisibilityTier;
  /**
   * The context's slug, for the readable team link (`/console/@slug?note=…`).
   *
   * Absent means no team link can be built, and `copyShareLink` copies nothing
   * rather than handing back a URL with `undefined` in it.
   */
  slug?: string;
  /**
   * Whether this bucket's connect-time probe found real conditional writes.
   *
   * Passed in rather than read here, because the binding is a Convex query the
   * console already holds and a second subscription to it would be a second
   * answer that can disagree. `undefined` while it is loading, which the copy
   * treats as "do not claim either way".
   */
  conditionalWrite?: boolean;
  /**
   * The other contexts this person could move something into.
   *
   * Passed in rather than queried here, because the console already holds the
   * list — `listMyWorkspaces`, one subscription — and a second one would be a
   * second answer that can disagree with the rail. Filtered to what the
   * *destination* side needs (`editor` and above there); whether the **source**
   * side allows a move at all is `isOwner`, and this hook applies that itself
   * rather than trusting the caller to have done both.
   */
  destinations?: readonly MoveDestination[];
}

/** One step of a batch — see `runBatch`. */
export interface BatchStep {
  /** How the batch's sentence names this one if it is where the batch stopped. */
  name: string;
  work: () => Promise<{ touched: string[]; undo: () => Promise<unknown> }>;
}
