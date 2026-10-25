/**
 * A queued move's links, followed off the move's path (`functions/linkRepairs.ts`; `paths-on-read.md`,
 * "Links follow a move in the background"). Run inside the credential barrier as the `repairLinks`
 * operation, so the store, the rules rendered from the rows and the forwarding ledger are the ones every
 * other operation gets, and the tree's names and link facts are what the rewrite reads
 * (`attachTreeListing`): only the notes that can hold a link to what moved are opened.
 *
 * The queue runs it as the owner, so a private note's link to a moved note follows too, which a move made
 * through a member's connection never reached. That is safe because nothing about what was rewritten goes
 * back to the person who moved, and because a link is never pointed at a name narrower than its own note
 * (`reachableRenames` in `fileOps/references.ts`).
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { Clearance } from "../clearance";
import { loadPrivacyState } from "../fileOps/privacyState";
import { rewriteReferences } from "../fileOps/references";
import type { FileStore } from "../fileOps/store";
import { attachTreeListing } from "./treeNames";

export interface LinkRepairResult {
  kind: "linksRepaired";
  /** Notes rewritten and links moved across them. */
  notes: number;
  links: number;
  /** The rewrite could not run (the rules unreadable, the walk too large or unfinished); the next pass tries again. */
  capped: boolean;
}

export async function repairLinks(
  ctx: ActionCtx,
  workspaceId: Id<"workspaces">,
  store: FileStore,
  clearance: Clearance,
  pairs: readonly { from: string; to: string }[],
): Promise<LinkRepairResult> {
  attachTreeListing(ctx, workspaceId, store);
  const state = await loadPrivacyState(store);
  // Rules that do not read are no rules to judge a referrer's readers by: nothing is rewritten.
  if (state.invalid) return { kind: "linksRepaired", notes: 0, links: 0, capped: true };
  const renames = new Map(pairs.filter((pair) => pair.from !== pair.to).map((pair) => [pair.from, pair.to]));
  const done = await rewriteReferences(store, { clearance, state, renames });
  return { kind: "linksRepaired", notes: done.notes, links: done.links, capped: done.capped };
}

/**
 * Queue the links of the files a move carried (`functions/linkRepairs.ts`). The move has landed: a queue
 * that cannot be reached is logged and left to forwarding, never a failed move.
 */
export async function queueLinkRepair(
  ctx: Pick<ActionCtx, "runMutation">,
  workspaceId: Id<"workspaces">,
  pairs: readonly { from: string; to: string }[],
  now: number,
): Promise<void> {
  if (pairs.length === 0) return;
  try {
    await ctx.runMutation(internal.functions.linkRepairs.enqueue, { workspaceId, pairs: pairs.map(({ from, to }) => ({ from, to })), now });
  } catch {
    console.error(JSON.stringify({ event: "linkRepairs.enqueue_failed", workspaceId, files: pairs.length }));
  }
}
