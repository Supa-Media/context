/**
 * Staff removal of an archived test account, through the same deletion an
 * account's owner runs (`account.deleteAccount`).
 *
 * Asked for by the owner, 2026-11-02, for the archived test account whose
 * connected bucket refuses every request: "can you spawn a thread to delete
 * that workspace/account? it's been causing issues". The account cannot sign
 * in to press Delete itself, so this runs it by handle from a manual
 * workflow (`.github/workflows/staff-delete-account.yml`).
 *
 * It is deliberately narrow. It only reaches an account that staff already
 * archived (admin › People › Archive), and it refuses, by fixed reason, when
 * the account is the production CUJ account, the directory reviewer, staff,
 * or when any workspace it alone owns has a member whose account is still
 * live: a real person would lose a context. A dry run reports the same
 * checks and changes nothing. The deletion itself is `deleteAccount`'s,
 * objects first (`takeAwayFirst`), then `deleteAccountFor`; a bucket the
 * customer connected is never touched, exactly as there.
 *
 * Internal only, and it answers with booleans and counts, never an id, an
 * address or a bucket name: this repository is public, and so is the log.
 */

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "./lib/rowWatch/mutations";
import { takeAwayFirst } from "./lib/accessHandOff/takeAway";
import { soleOwnerOf } from "./lib/account/soleOwner";
import { managedBucketName } from "./lib/managedStorage";
import { isProductionTestAccount } from "./lib/testAccount";
import { REVIEWER_EMAIL } from "./lib/reviewerAccount";
import { userIsStaff } from "./lib/admin";
import { deleteAccountFor } from "./account";

const BLOCKERS = [
  "not_found",
  "not_personal",
  "not_archived",
  "production_test_account",
  "reviewer_account",
  "staff",
  "live_people_in_owned_workspace",
] as const;
type Blocker = (typeof BLOCKERS)[number];

const reportValidator = v.object({
  found: v.boolean(),
  blockers: v.array(v.string()),
  ownedWorkspaces: v.number(),
  ownedShared: v.number(),
  othersInOwned: v.number(),
  liveOthersInOwned: v.number(),
  otherMemberships: v.number(),
  customerBuckets: v.number(),
  managedBuckets: v.number(),
  bucketsSharedWithOtherWorkspaces: v.number(),
  phoneLinked: v.boolean(),
  archivedAccounts: v.number(),
  deleted: v.boolean(),
  queuedForObjects: v.boolean(),
});
type Report = typeof reportValidator.type;

async function isArchived(ctx: MutationCtx, userId: Id<"users">): Promise<boolean> {
  return (await ctx.db.query("archivedAccounts").withIndex("by_user", (q) => q.eq("userId", userId)).first()) !== null;
}

/** The checks, by handle. `userId` is the account to delete when nothing blocks. */
export async function staffDeletionReport(
  ctx: MutationCtx,
  handle: string,
): Promise<{ report: Report; userId: Id<"users"> | null }> {
  const blockers: Blocker[] = [];
  const archivedAccounts = (await ctx.db.query("archivedAccounts").collect()).length;
  const empty: Report = {
    found: false,
    blockers: ["not_found"],
    ownedWorkspaces: 0,
    ownedShared: 0,
    othersInOwned: 0,
    liveOthersInOwned: 0,
    otherMemberships: 0,
    customerBuckets: 0,
    managedBuckets: 0,
    bucketsSharedWithOtherWorkspaces: 0,
    phoneLinked: false,
    archivedAccounts,
    deleted: false,
    queuedForObjects: false,
  };
  const slug = handle.trim().replace(/^@/, "").toLowerCase();
  const workspace = await ctx.db.query("workspaces").withIndex("by_slug", (q) => q.eq("slug", slug)).unique();
  if (workspace === null) return { report: empty, userId: null };
  if (workspace.kind !== "personal") blockers.push("not_personal");

  const userId = workspace.createdBy;
  const user = await ctx.db.get(userId);
  if (user === null) return { report: { ...empty, blockers: ["not_found"] }, userId: null };
  if (!(await isArchived(ctx, userId))) blockers.push("not_archived");
  if (isProductionTestAccount(user)) blockers.push("production_test_account");
  if (user.email?.trim().toLowerCase() === REVIEWER_EMAIL) blockers.push("reviewer_account");
  if (await userIsStaff(ctx, userId)) blockers.push("staff");

  const memberships = await ctx.db.query("workspaceMembers").withIndex("by_user", (q) => q.eq("userId", userId)).collect();
  let ownedWorkspaces = 0;
  let ownedShared = 0;
  let othersInOwned = 0;
  let liveOthersInOwned = 0;
  let otherMemberships = 0;
  let customerBuckets = 0;
  let managedBuckets = 0;
  let bucketsSharedWithOtherWorkspaces = 0;
  const allBindings = await ctx.db.query("storageBindings").collect();
  for (const membership of memberships) {
    if (!(await soleOwnerOf(ctx, membership, userId))) {
      otherMemberships += 1;
      continue;
    }
    const owned = await ctx.db.get(membership.workspaceId);
    if (owned === null) continue;
    ownedWorkspaces += 1;
    if (owned.kind === "shared") ownedShared += 1;
    const members = await ctx.db.query("workspaceMembers").withIndex("by_workspace", (q) => q.eq("workspaceId", owned._id)).collect();
    for (const member of members) {
      if (member.userId === userId) continue;
      othersInOwned += 1;
      if (!(await isArchived(ctx, member.userId))) liveOthersInOwned += 1;
    }
    const binding = allBindings.find((row) => row.workspaceId === owned._id);
    if (binding !== undefined) {
      if (binding.bucket === managedBucketName(owned._id)) managedBuckets += 1;
      else customerBuckets += 1;
      if (allBindings.some((row) => row.workspaceId !== owned._id && row.bucket === binding.bucket)) bucketsSharedWithOtherWorkspaces += 1;
    }
  }
  if (liveOthersInOwned > 0) blockers.push("live_people_in_owned_workspace");
  const phoneLinked = (await ctx.db.query("phoneLinks").withIndex("by_user", (q) => q.eq("userId", userId)).first()) !== null;

  return {
    report: {
      found: true,
      blockers,
      ownedWorkspaces,
      ownedShared,
      othersInOwned,
      liveOthersInOwned,
      otherMemberships,
      customerBuckets,
      managedBuckets,
      bucketsSharedWithOtherWorkspaces,
      phoneLinked,
      archivedAccounts,
      deleted: false,
      queuedForObjects: false,
    },
    userId,
  };
}

/** Check (dry run) or delete one archived test account by its handle. Counts and fixed reasons only. */
export const deleteArchivedAccount = internalMutation({
  args: { handle: v.string(), dryRun: v.boolean() },
  returns: reportValidator,
  handler: async (ctx, { handle, dryRun }) => {
    const { report, userId } = await staffDeletionReport(ctx, handle);
    if (dryRun || userId === null || report.blockers.length > 0) return report;
    const queued = await takeAwayFirst(ctx, { kind: "account", userId });
    if (!queued) await deleteAccountFor(ctx, userId);
    return { ...report, deleted: true, queuedForObjects: queued };
  },
});
