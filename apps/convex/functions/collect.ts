/**
 * Collect mode: an answer from somebody who will never have an account.
 *
 * ## What this changes, stated plainly
 *
 * Every other write in this product resolves a grant or a session to a person
 * with a handle. This one takes an answer through a URL its owner published,
 * from a stranger. That is what an intake form is, and it is a rule this file
 * changes rather than a surface it adds — so the whole file is the narrowing.
 *
 * ## The chain, in order, and why that order
 *
 * 1. **The link resolves** to a live `anyone` row in `collect` mode over a
 *    **note**. A folder link reaches a subtree; collecting through one would
 *    publish every form beneath it on the strength of one decision.
 * 2. **The context is writable** — not a cancelled managed-storage context.
 *    Cancelling makes a context read-only, and a live collect link is a write
 *    path into one that stopped taking writes.
 * 3. **The challenge verifies**, and refuses when it cannot. See
 *    `lib/turnstile.ts` for why failing closed is the production branch.
 * 4. **The link has room** — its own cap, counted on the row.
 * 5. Only then the form action, with a **link actor**: the `member` role, so
 *    a form that takes `editor` submissions refuses through a link, and a
 *    name that is the *link* rather than a handle, so nothing it writes is
 *    ever anybody's to edit by name. See `linkStamp`.
 *
 * Cheap refusals first, and the bucket opened last. An unauthenticated caller
 * must not be able to make us spend a GET against a customer's storage — or
 * their Cloudflare quota — by posting garbage at a URL they guessed.
 *
 * ## One refusal shape for everything about the link
 *
 * Unknown token, revoked, expired, a `read` link, a link over a folder, a
 * workspace that is gone: all `LINK_NOT_COLLECTING`, one sentence. A stranger
 * holding a URL must not be able to tell a link that was taken back from one
 * that never existed, which is the same rule the share preview already keeps.
 *
 * What is NOT uniform, deliberately: a challenge that could not run, a cap
 * that is spent, and answers that do not fit the form each say so. Those are
 * facts about *this* submission that the person can act on, and none of them
 * says anything about the context.
 *
 * ## What it does not offer
 *
 * Editing, withdrawing, voting, and reading the answers. "You can only delete
 * what you can see" already decided that: a stranger cannot read the responses
 * file, so their answer is final — and the page says so before they send.
 */

import { v } from "convex/values";
import { ConvexError } from "convex/values";

import { internal } from "../_generated/api";
import { action, internalMutation, internalQuery } from "../_generated/server";
import { MANAGED_BUCKET_PREFIX } from "./lib/managedStorage";
import { normalizePath } from "./lib/fileOps";
import { findName } from "./lib/nameClaims";
import { cancellationMakesReadOnly } from "./lib/premium";
import { linkStamp } from "./lib/formOps";
import { shortLinkSlugFrom } from "./lib/shareSlug";
import { DEFAULT_COLLECT_CAP } from "./lib/collectLimits";
import { challengeRefusal, verifyHumanChallenge } from "./lib/turnstile";

/** One refusal for everything about the link itself. See the module comment. */
function linkNotCollecting(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "LINK_NOT_COLLECTING",
    message: "This link is not taking answers.",
  });
}

function refuse(code: string, message: string): ConvexError<{ code: string; message: string }> {
  return new ConvexError({ code, message });
}

/**
 * What a collect link points at, or `null`. INTERNAL.
 *
 * Resolves by token or by handle-and-name, because the two addresses of a
 * share reach the same row — and returns the *row's* workspace and path, never
 * anything the caller supplied. The token is not returned: a caller who
 * guessed a short name must not walk away holding the bearer value.
 */
export const collectTarget = internalQuery({
  args: {
    token: v.optional(v.string()),
    handle: v.optional(v.string()),
    slug: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      shareId: v.id("noteShares"),
      workspaceId: v.id("workspaces"),
      entryPath: v.string(),
      handle: v.string(),
      slug: v.union(v.string(), v.null()),
      cap: v.number(),
      taken: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();

    let row = null;
    if (typeof args.token === "string" && /^[0-9a-f]{64}$/.test(args.token)) {
      row = await ctx.db
        .query("noteShares")
        .withIndex("by_token", (q) => q.eq("token", args.token as string))
        .unique();
    } else if (typeof args.handle === "string" && typeof args.slug === "string") {
      const slug = shortLinkSlugFrom(args.slug.toLowerCase());
      if (slug === null) return null;
      const name = await findName(ctx, args.handle.replace(/^@/, "").toLowerCase());
      const workspaceId = name?.workspaceId;
      if (workspaceId === undefined) return null;
      const rows = await ctx.db
        .query("noteShares")
        .withIndex("by_workspace_slug", (q) =>
          q.eq("workspaceId", workspaceId).eq("slug", slug),
        )
        .collect();
      row = rows.find((candidate) => candidate.status === "active") ?? null;
    }

    if (row === null || row.status !== "active") return null;
    if (row.expiresAt !== undefined && row.expiresAt <= now) return null;
    // Only an unlisted link collects. A `members` or a personal share already
    // has a reader with an account, and a form on it is answered the ordinary
    // way — through `submitForm`, under their own handle.
    if (row.recipientKind !== "anyone") return null;
    if (row.mode !== "collect") return null;
    // Note-only. A folder link reaches a subtree.
    if ((row.entryKind ?? "note") !== "note") return null;

    const workspace = await ctx.db.get(row.workspaceId);
    if (workspace === null) return null;

    return {
      shareId: row._id,
      workspaceId: row.workspaceId,
      entryPath: row.entryPath,
      handle: workspace.slug,
      slug: row.slug ?? null,
      cap: row.collectCap ?? DEFAULT_COLLECT_CAP,
      taken: row.collectCount ?? 0,
    };
  },
});

/**
 * Whether this context is still taking writes at all. INTERNAL.
 *
 * `cancellationMakesReadOnly` is the rule and it lives in `lib/premium.ts`;
 * this is the first caller to wire it. Only **managed** storage can be made
 * read-only by a lapse — a customer's own bucket keeps working with their own
 * credentials whatever we think of their card, because revoking our access is
 * their lever and not ours.
 */
export const collectContextWritable = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const binding = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (binding === null) return false;
    const managed = binding.bucket === `${MANAGED_BUCKET_PREFIX}${String(args.workspaceId)}`;
    const plan = await ctx.db
      .query("workspacePlans")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    return !cancellationMakesReadOnly(plan?.status ?? "none", managed);
  },
});

/**
 * Take one off the link's allowance, or refuse. INTERNAL.
 *
 * **Before the write, not after.** Two submissions landing together would each
 * read the same count and each decide there was room; incrementing first, in a
 * transaction Convex serialises, means the second sees the first. A submission
 * that then fails has spent one of the allowance, which is the direction to
 * err in: an owner loses one slot out of hundreds, rather than a cap that can
 * be walked straight through by posting in parallel.
 */
export const spendCollectSlot = internalMutation({
  args: { shareId: v.id("noteShares") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.shareId);
    if (row === null || row.status !== "active") return false;
    const cap = row.collectCap ?? DEFAULT_COLLECT_CAP;
    const taken = row.collectCount ?? 0;
    if (taken >= cap) return false;
    await ctx.db.patch(args.shareId, { collectCount: taken + 1 });
    return true;
  },
});

/**
 * Send one answer to a form through a collect link.
 *
 * Public, and reachable with no session at all — which is the point, and why
 * every line above it exists.
 */
export const submitThroughLink = action({
  args: {
    /** The long link's token, or… */
    token: v.optional(v.string()),
    /** …the short link's two halves. */
    handle: v.optional(v.string()),
    slug: v.optional(v.string()),
    /** The form's id, required only when the note carries more than one. */
    formId: v.optional(v.string()),
    values: v.array(v.object({ field: v.string(), value: v.string() })),
    /** The widget's token. Verified, and refused when it cannot be. */
    challenge: v.optional(v.string()),
  },
  returns: v.object({ ok: v.literal(true) }),
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const target = await ctx.runQuery(internal.functions.collect.collectTarget, {
      ...(args.token === undefined ? {} : { token: args.token }),
      ...(args.handle === undefined ? {} : { handle: args.handle }),
      ...(args.slug === undefined ? {} : { slug: args.slug }),
    });
    if (target === null) throw linkNotCollecting();

    const writable = await ctx.runQuery(
      internal.functions.collect.collectContextWritable,
      { workspaceId: target.workspaceId },
    );
    if (!writable) {
      throw refuse(
        "CONTEXT_READ_ONLY",
        "This context is not taking new answers. Its owner can say more.",
      );
    }

    // Before the bucket is opened and before a slot is spent: a challenge that
    // did not pass must cost nothing but the round trip it already made.
    const outcome = await verifyHumanChallenge(args.challenge);
    if (outcome !== "verified") {
      throw refuse("CHALLENGE_REFUSED", challengeRefusal(outcome));
    }

    const room = await ctx.runMutation(internal.functions.collect.spendCollectSlot, {
      shareId: target.shareId,
    });
    if (!room) {
      throw refuse(
        "COLLECT_CAP_REACHED",
        "This form has taken all the answers it was set up for.",
      );
    }

    const path = normalizePath(target.entryPath);
    if (path === null) throw linkNotCollecting();

    /*
      `scope: "team"` — what the link's readers already read at, and the only
      scope a share has ever used. A stranger is not being given a wider view
      of the context than the link itself gives: this opens exactly the note
      the link points at, and `runFormAction` writes only into the response
      file that note's own form block names.
    */
    await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: target.workspaceId,
      scope: "team",
      operation: {
        kind: "form" as const,
        path,
        ...(args.formId === undefined ? {} : { formId: args.formId }),
        // Stamped from the ROW, never from an argument: `target.handle` and
        // `target.slug` came out of the database a moment ago. This is the
        // same rule `formActor` follows for a person's username, applied to a
        // caller who has no username at all.
        actorName: linkStamp(target.handle, target.slug),
        // The lowest role there is. A form that takes `editor` submissions
        // refuses through a link, which is `roleAtLeast` doing the work rather
        // than a second policy here.
        actorRole: "member" as const,
        action: { kind: "submit" as const, values: args.values },
      },
    });

    // The id is deliberately not returned. It is what `update_submission` and
    // `retract_submission` take, and a stranger holding one could do nothing
    // with it — but handing somebody a handle to a thing they can never act on
    // is an invitation to try, and the page has already told them their answer
    // is final.
    return { ok: true };
  },
});
