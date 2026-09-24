/**
 * What a member may see of their workspace's binding: status, a masked key
 * id, and nothing that opens anything.
 *
 * Split out of `functions/storage.ts`, which keeps every registered storage
 * function and wires this handler to it; this module registers none and opens no credential.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import type { QueryCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { maskAccessKeyId } from "../crypto";
import { managedBucketName } from "../managedStorage";
import { requireWorkspaceAccess } from "../workspaceAuth";
import { storageLayoutStateValidator } from "../storageLayout";
import { capabilitiesValidator } from "./shapes";

export const getStorageBindingArgs = { workspaceId: v.id("workspaces") };

export const getStorageBindingReturns = v.union(
  v.null(),
  v.object({
    provider: v.string(),
    endpoint: v.optional(v.string()),
    region: v.optional(v.string()),
    bucket: v.optional(v.string()),
    rootPrefix: v.optional(v.string()),
    maskedAccessKeyId: v.optional(v.string()),
    forcePathStyle: v.optional(v.boolean()),
    /**
     * Whose Dropbox this is — `dbid:…`, never a token. Absent for every
     * other provider, and absent for a Dropbox binding nobody has finished
     * connecting yet.
     *
     * Not gated by role: it identifies an account the same way `bucket`
     * identifies a bucket, and every member of a context can already see
     * that. It is a live read of the row, so a reconnect onto a different
     * Dropbox account is reflected the moment the binding is patched — the
     * console never caches the account it showed last.
     */
    dropboxAccountId: v.optional(v.string()),
    capabilities: capabilitiesValidator,
    status: v.string(),
    lastVerifiedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    /**
     * A code from a closed set, so a client can branch on the failure
     * without matching on provider prose. See the schema's `errorCode`.
     */
    errorCode: v.optional(v.string()),
    /**
     * WHAT ONBOARDING BRANCHES ON.
     *
     * `scaffoldReason === "existing-context"` means this bucket already holds
     * a context: say so and use it, and do **not** ask which folder layout
     * they want. `"empty"` is the only value that makes that question worth
     * asking. See the schema for the full set.
     *
     * Both absent until something has verified the binding. Neither is a
     * credential, a key name, or note content — `scaffolded` is a boolean we
     * computed and `scaffoldReason` is a code from a closed set we chose, so
     * neither can carry provider text.
     */
    scaffolded: v.optional(v.boolean()),
    scaffoldReason: v.optional(v.string()),
    /**
     * WHAT IS STILL NOT THERE, WHEN `scaffoldReason` IS `partial`.
     *
     * A layout whose `privacy.md` landed and whose `3-resources/README.md`
     * did not is a working context with a gap, and this is the gap: bucket
     * keys, ours, generated. Say so plainly and offer to try again — do not
     * dress a `partial` up as a failure, and do not hide it either. Empty or
     * absent means nothing is outstanding.
     */
    scaffoldMissing: v.optional(v.array(v.string())),
    /**
     * HOW MANY NOTES, AND WHEN SOMETHING LAST LOOKED.
     *
     * All three absent until a verification has walked the bucket, **and
     * absent to everyone but the owner.**
     *
     * The count is of every Markdown file in the bucket, private ones
     * included, while a member of somebody else's context may read only the
     * `team` tier. Handing them the total would let them derive exactly how
     * much they are not being shown — an exact private-note count for a
     * person who deliberately shared a subset. Roles clamp what a client may
     * *read* in three places already; this is the same rule applied to a
     * number about the same notes.
     *
     * A client must render nothing rather than a zero when they are absent —
     * see the schema. `noteCountTruncated` means `noteCount` is a floor; say
     * "40,000+", never "40,000".
     */
    noteCount: v.optional(v.number()),
    noteCountedAt: v.optional(v.number()),
    noteCountTruncated: v.optional(v.boolean()),
    /**
     * Where the storage-layout migration got to, and when we last heard.
     *
     * Absent means nobody has run it through us, which is the only state
     * that still offers it — see `lib/storageLayout.ts` for the other six.
     *
     * Not clamped to the owner, unlike `noteCount`. That number is about
     * private notes and this is about our own plumbing: it names no key and
     * counts nothing of the customer's. Every member of a context can
     * already see its provider, its bucket and its verification status, and
     * this says less than any of them.
     */
    storageLayoutState: v.optional(storageLayoutStateValidator),
    storageLayoutAt: v.optional(v.number()),
    /**
     * Whether the bucket has been *asked*, which is the half that decides
     * whether the console offers at all. Absent state plus absent checked is
     * "nobody has looked"; absent state with this set is the real "nobody
     * has run it". See the schema column for what conflating them cost.
     */
    storageLayoutCheckedAt: v.optional(v.number()),
    /**
     * Which generation of the question that answer came from, so a console
     * can tell an answer the current probe stands behind from one the
     * probe before it got wrong. `storageLayoutAnswerIsCurrent` is the
     * predicate, and the console and `observeStorageLayout` share it rather
     * than each deciding — a console that thought the question was open
     * while the mutation refused to ask it would put the notice back on
     * exactly the buckets this closed it for.
     */
    storageLayoutCheckedVersion: v.optional(v.number()),
    updatedAt: v.number(),
    /** True only for the deterministic bucket this service operates. */
    managed: v.boolean(),
  }),
);

/**
 * What the dashboard is allowed to see: is it connected, to what, and does it
 * support conditional writes.
 *
 * Any member may read this. Knowing that your context is healthy is not a
 * privileged operation, and hiding it from read-only members just means they
 * cannot tell a broken bucket from an empty one. The access key id is masked
 * and the secret is not present in any form.
 */
export async function getStorageBindingHandler(
  ctx: QueryCtx,
  args: ObjectType<typeof getStorageBindingArgs>,
) {
  const userId = (await requireAuthId(ctx)) as Id<"users">;
  const { membership } = await requireWorkspaceAccess(
    ctx,
    args.workspaceId,
    userId,
  );
  const isOwner = membership.role === "owner";

  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (binding === null) return null;

  return {
    provider: binding.provider,
    endpoint: binding.endpoint,
    region: binding.region,
    bucket: binding.bucket,
    rootPrefix: binding.rootPrefix,
    // Absent for Dropbox, which has no access key. `undefined` rather than
    // an empty string, so the console renders nothing instead of a masked
    // credential that does not exist.
    maskedAccessKeyId: binding.accessKeyId
      ? maskAccessKeyId(binding.accessKeyId)
      : undefined,
    forcePathStyle: binding.forcePathStyle,
    dropboxAccountId: binding.dropboxAccountId,
    capabilities: binding.capabilities,
    status: binding.status,
    lastVerifiedAt: binding.lastVerifiedAt,
    lastError: binding.lastError,
    errorCode: binding.errorCode,
    scaffolded: binding.scaffolded,
    scaffoldReason: binding.scaffoldReason,
    scaffoldMissing: binding.scaffoldMissing,
    // Owner only. See the validator above: this is a number about private
    // notes, and a member of this context cannot read them.
    noteCount: isOwner ? binding.noteCount : undefined,
    noteCountedAt: isOwner ? binding.noteCountedAt : undefined,
    noteCountTruncated: isOwner ? binding.noteCountTruncated : undefined,
    storageLayoutState: binding.storageLayoutState,
    storageLayoutAt: binding.storageLayoutAt,
    storageLayoutCheckedAt: binding.storageLayoutCheckedAt,
    storageLayoutCheckedVersion: binding.storageLayoutCheckedVersion,
    updatedAt: binding.updatedAt,
    managed: binding.bucket === managedBucketName(args.workspaceId),
  };
}
