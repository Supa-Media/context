/**
 * Workspaces — the unit that owns a context.
 *
 * A personal context and a shared project context are the same row with
 * different membership. Nothing here special-cases "personal", and nothing
 * should: the moment a second person is added, an app that modelled personal
 * contexts separately needs a migration instead of an insert.
 */

import { ConvexError, v } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import { internal } from "../_generated/api";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { claimName, checkAvailability, nameRejectionError } from "./lib/nameClaims";
import { seedIngestionSettings } from "./lib/ingestionStore";
import { consumeRateLimit } from "./lib/rateLimit";
import { PINNED_CONTEXT_ROLE, isSingleEmoji } from "@context/shared";
import { pinnedContextWorkspace, reachesPinnedContext } from "./lib/pinnedContext";
/*
  The gateway's own gate on this value, not a second one. An offer
  `normalizeMeetingFolder` refuses is an offer the meeting write then rejects,
  so a setting validated any other way could be saved and silently ignored.
*/
import { MEETINGS_FOLDER, normalizeMeetingFolder } from "../../../packages/meetings/src/paths.js";
import { isProductionTestAccount } from "./lib/testAccount";
import {
  type FolderRejection,
  MAX_CUSTOM_FOLDERS,
  MAX_FOLDER_DESCRIPTION_LENGTH,
  MAX_FOLDER_NAME_LENGTH,
  validateCustomFolders,
} from "./lib/scaffold";
import {
  getMembership,
  requireWorkspaceAccess,
  requireWorkspaceRole,
  workspaceNotFound,
} from "./lib/workspaceAuth";

const MAX_DISPLAY_NAME_LENGTH = 80;

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
const MAX_WORKSPACES_PER_USER = 10;
const WORKSPACE_CREATE_LIMIT = 5;
const WORKSPACE_CREATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Caps on how many rows one response carries.
 *
 * An unbounded `.collect()` reads however many rows exist, which is a cost set
 * by whoever can insert them. These bound the read; if a real workspace ever
 * approaches one, it needs pagination rather than a bigger constant.
 */
const MAX_MEMBERS_RETURNED = 200;
const MAX_WORKSPACES_RETURNED = 100;

/**
 * The mark a workspace draws, as it crosses the wire.
 *
 * A union rather than two optional fields, matching the schema: a mark shows
 * one thing, and "photo set, emoji also set" would leave every drawing surface
 * to invent its own tie-break. See `@context/shared`'s `workspaceIcon` module.
 *
 * A photo arrives as its **leaf, not its bytes**. The console asks for the
 * bytes separately, once, and caches them on the leaf — which is a content
 * hash, so the cache is sound forever. Inlining a megabyte per row into a query
 * every console paint re-runs would make the context list a download.
 */
const workspaceIconValidator = v.union(
  v.object({ kind: v.literal("photo"), leaf: v.string() }),
  v.object({ kind: v.literal("emoji"), emoji: v.string() }),
);

const workspaceSummary = v.object({
  workspaceId: v.id("workspaces"),
  slug: v.string(),
  displayName: v.string(),
  kind: v.string(),
  structureTemplate: v.string(),
  role: v.string(),
  /** Absent is the letter, which is what every workspace drew before this. */
  icon: v.optional(workspaceIconValidator),
  /**
   * Where meetings land in this context, when somebody has chosen.
   *
   * Absent means the default, and the *console* resolves that rather than this
   * query substituting one: `MEETINGS_FOLDER` lives in `packages/meetings`,
   * which is the gateway's own gate on the same value, and a second copy here
   * would be a second place for the default to drift.
   */
  meetingsFolder: v.optional(v.string()),
  /**
   * When this context last changed, and when this member last caught up.
   *
   * The pair, rather than a boolean, because the console decides what to draw
   * from it — a dot on this context's mark when the first is newer than the
   * second — and a server-computed `hasNew` would be a second place for that
   * rule to live. Both are absent for a context nothing has been recorded in
   * and a member who has never looked, which reads as "nothing to say" and is
   * the right answer for a context that has just been created.
   *
   * Neither is a count. A count would have to be a count of what *this* reader
   * may see, which is a per-member question over a shared row — the number
   * lives in the context itself, one press away.
   *
   * **`activityAt` is already narrowed to this reader** by the query: an owner
   * is served the context's own stamp, and everybody else the team-tier one,
   * so the dot never reports the time of a private change to somebody the file
   * itself would refuse. See `schema.ts`, `activityTeamAt`.
   */
  activityAt: v.optional(v.number()),
  activitySeenAt: v.optional(v.number()),
  joinedAt: v.number(),
  createdAt: v.number(),
  /**
   * True on the one row that is here because it is **pinned for everybody**
   * rather than because this person is a member of it — see
   * `lib/pinnedContext.ts`.
   *
   * Optional, and absent is false, so every existing consumer keeps reading
   * exactly what it read before. It is on the row rather than in a second query
   * because every consumer that needs it already has the row, and because the
   * two things that must treat it differently would otherwise have to re-derive
   * "is this the pinned one" from the slug:
   *
   *  - **The console draws it apart** — last in the rail, under a rule, marked
   *    read-only (`features/console/rail.ts`).
   *  - **Onboarding must not count it.** The `(app)` gate asks "is there
   *    anything here for you" off this same list, so without this flag a
   *    brand-new account would arrive with one reachable context, skip
   *    `/welcome`, and never claim a name. `standingFrom` filters on it.
   *
   * A real membership wins and is reported as an ordinary row: somebody who
   * owns or edits that workspace sees their real role and no flag.
   */
  pinned: v.optional(v.boolean()),
});

/**
 * Create a workspace, claim its name, and make the creator its owner —
 * atomically.
 *
 * All three writes happen in one Convex mutation, which is a serializable
 * transaction. If the name claim loses a race, or any later step throws, the
 * whole thing rolls back: no orphan workspace with no name, no claimed name
 * pointing at nothing, no workspace with no owner. That last one matters most
 * — a workspace whose only owner failed to be written is a context nobody can
 * ever administer or delete.
 *
 * Do not split this into an action that orchestrates several mutations. The
 * atomicity is the feature.
 */
export const createWorkspace = mutation({
  args: {
    slug: v.string(),
    displayName: v.string(),
    kind: v.union(v.literal("personal"), v.literal("shared")),
    /**
     * The layout this context *expects* to start with. A default written onto
     * the row, nothing more — **creating a workspace writes nothing into any
     * bucket**, and by the time one is connected the owner will have been asked
     * properly. `applyStructure` is what actually lays a layout down, and it
     * overwrites this field with what was chosen then.
     */
    structureTemplate: v.optional(
      v.union(v.literal("para"), v.literal("custom")),
    ),
  },
  returns: v.object({
    workspaceId: v.id("workspaces"),
    slug: v.string(),
  }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const user = await ctx.db.get(userId);
    const isTestAccount = isProductionTestAccount(user);

    const displayName = args.displayName.trim();
    if (displayName.length === 0) {
      throw new ConvexError({
        code: "INVALID_DISPLAY_NAME",
        message: "A workspace needs a display name.",
      });
    }
    if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      throw new ConvexError({
        code: "INVALID_DISPLAY_NAME",
        message: `Display names must be at most ${MAX_DISPLAY_NAME_LENGTH} characters.`,
      });
    }

    // How many contexts this account already owns. Read before the name is
    // even looked at: hitting the cap must not depend on what you asked for.
    const owned = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_WORKSPACES_PER_USER + 1);
    if (!isTestAccount && owned.filter((m) => m.role === "owner").length >= MAX_WORKSPACES_PER_USER) {
      throw new ConvexError({
        code: "WORKSPACE_LIMIT_REACHED",
        message: `You can own at most ${MAX_WORKSPACES_PER_USER} contexts.`,
        limit: MAX_WORKSPACES_PER_USER,
      });
    }

    // Counts commits, not attempts: this whole mutation is one transaction, so
    // a creation that goes on to fail rolls the increment back with it. That
    // is the right unit here — a failed claim takes nothing out of the
    // namespace — but see `lib/rateLimit.ts` for what it does not protect.
    if (!isTestAccount) {
      await consumeRateLimit(ctx, {
        key: `workspace.create:${userId}`,
        limit: WORKSPACE_CREATE_LIMIT,
        windowMs: WORKSPACE_CREATE_WINDOW_MS,
      });
    }

    // Check first so a bad slug fails before we write anything. `claimName`
    // re-checks inside the same transaction, which is what actually enforces
    // uniqueness; this pass only buys a clean early error.
    const availability = await checkAvailability(ctx, args.slug);
    if (!availability.available) {
      throw nameRejectionError(availability.normalized, availability.reason);
    }

    const now = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", {
      slug: availability.normalized,
      displayName,
      createdBy: userId,
      kind: args.kind,
      structureTemplate: args.structureTemplate ?? "para",
      createdAt: now,
      updatedAt: now,
    });

    await claimName(ctx, availability.normalized, userId, {
      kind: "workspace",
      workspaceId,
    });

    await ctx.db.insert("workspaceMembers", {
      workspaceId,
      userId,
      role: "owner",
      joinedAt: now,
    });

    // A **personal** context's capture address `<slug>@context.lc` becomes live
    // the moment the slug is claimed, so the policy governing it has to exist by
    // the time this transaction commits — a context that is addressable but has
    // no stored policy is a window, however brief. Seeded closed: the owner's
    // own account email and nobody else.
    //
    // A shared context gets no row, because it has no capture address to govern.
    // Mail lands in a personal context and nowhere else; a shared context
    // receives a note only when a person moves one there. Read the header of
    // `lib/ingestionStore.ts` before changing this line — the absence of the row
    // is the feature, and `seedIngestionSettings` throws if called anyway.
    if (args.kind === "personal") {
      await seedIngestionSettings(ctx, { workspaceId, ownerUserId: userId, now });
    }

    return { workspaceId, slug: availability.normalized };
  },
});

/* -------------------------------------------------------------------------- */
/*                        choosing the starting layout                        */
/* -------------------------------------------------------------------------- */

/**
 * How often one workspace may ask us to write a starting layout into its
 * bucket.
 *
 * Scaffolding is a handful of outbound writes to a customer-supplied endpoint,
 * so the reasoning is `reverifyStorage`'s: keyed by **workspace**, because the
 * workspace is what has a bucket, and loose enough that a person retrying a
 * failed connect never meets it.
 */
const APPLY_STRUCTURE_LIMIT = 10;
const APPLY_STRUCTURE_WINDOW_MS = 60 * 60 * 1000;

/** The refusal, worded so the person can act on it. Names no key and no bucket. */
function folderRejectionError(
  reason: FolderRejection,
  folder: string | undefined,
): ConvexError<{ code: string; message: string; reason: string }> {
  const named = folder === undefined ? "That folder name" : `"${folder}"`;
  const message: Record<FolderRejection, string> = {
    "too-many": `A starting layout can have at most ${MAX_CUSTOM_FOLDERS} folders. You can add more later.`,
    empty: "Every folder needs a name.",
    untrimmed: `${named} starts or ends with a space. Folder names become part of every file's path, so spaces at the edges are too easy to lose.`,
    "too-long": `${named} is longer than ${MAX_FOLDER_NAME_LENGTH} characters.`,
    "control-character":
      "A folder name contains a character that cannot appear in a file path.",
    backslash: `${named} contains a backslash. Use a plain name — this is one folder, not a path.`,
    "not-a-single-segment": `${named} contains a slash. Name one folder; you can nest inside it afterwards.`,
    traversal: `${named} is not a folder name.`,
    hidden: `${named} starts with a dot. Names beginning with a dot are reserved for plumbing and are hidden from every client.`,
    reserved: `${named} is the name of a file this context already creates.`,
    duplicate: `${named} is listed twice.`,
    "description-empty": `${named} needs a one-line description. It becomes that folder's README.`,
    "description-too-long": `The description for ${named} is longer than ${MAX_FOLDER_DESCRIPTION_LENGTH} characters.`,
    "description-control-character": `The description for ${named} must be a single line.`,
  };
  return new ConvexError({
    code: "INVALID_FOLDER",
    message: message[reason],
    // A code from a closed set, so an interface can point at the offending
    // field without matching on English.
    reason,
  });
}

/**
 * Write the starting layout the owner chose.
 *
 * ## Why this exists at all
 *
 * The scaffold used to fire automatically the moment `bindStorage` succeeded,
 * reading the `structureTemplate` recorded when the workspace was created. In
 * the onboarding order the product actually has — claim a name, connect
 * storage, *then* look at the bucket and ask — that meant the layout was
 * written into the bucket before anybody had been asked which layout they
 * wanted. The question was decoration.
 *
 * So the choice travels with the call: this hands it to
 * `verifyStorageBinding`, which probes the bucket and scaffolds that layout, in
 * one credential open. Nothing reads a frozen field to decide what to write.
 *
 * ## Everything here is reversible, and nothing here can overwrite
 *
 * This writes a `README.md` per folder plus `index.md` and `privacy.md`, all of
 * them ordinary Markdown in the customer's own bucket. Every one can be
 * renamed, edited or deleted afterwards, in the console or in Obsidian. It is a
 * leg-up on an empty bucket, not a schema.
 *
 * The one rule that does not move: **it never overwrites.** The refusal below
 * for a bucket that already holds a context is a courtesy — it gives the person
 * an answer instead of a silent no-op — and it is emphatically not the
 * enforcement. `scaffoldContext` refuses against a non-empty bucket and `get`s
 * every key before it `put`s it, so this mutation's checks could be wrong, or
 * bypassed entirely, and a live workspace would still come through untouched.
 *
 * Owner-only, for `bindStorage`'s reason: it spends the workspace's budget and
 * writes into the workspace's bucket.
 *
 * A mutation that **schedules** rather than an action that probes, for
 * `reverifyStorage`'s reason: `verifyStorageBinding` decrypts, so a public
 * function that *called* it would have a credential in its own scope. A
 * scheduled job's result is discarded by the scheduler and cannot flow back
 * here. Watch `getStorageBinding` for the outcome.
 */
export const applyStructure = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    template: v.union(v.literal("para"), v.literal("custom")),
    /**
     * Required for `custom`, refused for `para`. Each becomes a root folder
     * whose `README.md` carries the description, verbatim.
     */
    folders: v.optional(
      v.array(v.object({ folder: v.string(), description: v.string() })),
    ),
  },
  returns: v.object({
    queued: v.boolean(),
    template: v.string(),
    /** The folder names as they will be written. Echoed so a client can confirm. */
    folders: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

    // Read here, and handed to the scaffolder below, because it decides what
    // `privacy.md` says the new folders default to: a personal workspace starts
    // all-private, a shared workspace starts team-visible to its members. See
    // `startingVisibility` in `lib/scaffold.ts` for why that is not a widening.
    // Loaded from the row rather than taken as an argument — `kind` is fixed at
    // creation, and a client that could name it could scaffold somebody's workspace
    // open.
    // `requireWorkspaceRole` already proved the membership, so this can only be
    // null if the row was deleted between the two reads. Same error either way,
    // from the one helper that constructs it — see `lib/workspaceAuth.ts`.
    const workspace = await ctx.db.get(args.workspaceId);
    if (workspace === null) throw workspaceNotFound();

    const binding = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (binding === null) {
      throw new ConvexError({
        code: "NO_STORAGE_BINDING",
        message: "Connect storage before choosing a folder layout.",
      });
    }
    if (binding.status !== "connected") {
      throw new ConvexError({
        code: "STORAGE_NOT_VERIFIED",
        message:
          "This context's storage has not been verified yet. Wait for the connection check to finish, or fix the error it reported.",
      });
    }
    // FINISHING SOMETHING WE STARTED IS NOT THE SAME AS SCAFFOLDING OVER
    // SOMEBODY'S VAULT, AND THIS IS THE LINE BETWEEN THEM.
    //
    // A scaffold that stopped halfway leaves real files in the bucket, so from
    // then on every detector correctly reports "this bucket holds a context" —
    // and the retry got refused with `CONTEXT_NOT_EMPTY`, telling the owner
    // nothing had been changed while their bucket sat half-written. Finishing
    // it needed a person deleting objects over S3 (issue #22).
    //
    // `scaffoldMissing` is the discriminator, and it is the only thing here
    // that could be: it is written exclusively by an attempt that got past the
    // emptiness guard, which is to say by us, into a bucket we had just
    // observed empty. A vault that was here before we arrived never gets one —
    // the guard refuses before the first `get` — so the refusal below is
    // untouched for the case it exists to protect.
    const unfinished = (binding.scaffoldMissing?.length ?? 0) > 0;
    if (binding.scaffoldReason === "existing-context" && !unfinished) {
      throw new ConvexError({
        code: "CONTEXT_NOT_EMPTY",
        message:
          "This bucket already holds a context, so there is nothing to set up. Nothing has been changed.",
      });
    }
    if (binding.scaffoldReason === "created") {
      throw new ConvexError({
        code: "STRUCTURE_ALREADY_APPLIED",
        message:
          "A starting layout has already been written to this bucket. Rename or add folders from the console.",
      });
    }

    // Validated before anything is written or persisted: these become keys in
    // somebody's own bucket, and a bad one is refused rather than repaired.
    let folders: { folder: string; description: string }[] = [];
    if (args.template === "custom") {
      const proposed = args.folders ?? [];
      if (proposed.length === 0) {
        throw new ConvexError({
          code: "INVALID_STRUCTURE",
          message: "Name at least one folder, or choose the standard layout.",
        });
      }
      const validation = validateCustomFolders(proposed);
      if (!validation.ok) {
        throw folderRejectionError(validation.reason, validation.folder);
      }
      folders = validation.folders;
    } else if (args.folders !== undefined && args.folders.length > 0) {
      // Refused rather than ignored. Silently dropping folders somebody typed
      // would have them look for folders that were never created.
      throw new ConvexError({
        code: "INVALID_STRUCTURE",
        message:
          "The standard layout has its own folders. Choose a custom layout to name your own.",
      });
    }

    // Counted before the schedule, in the same transaction: a refusal throws
    // and rolls the whole thing back, so a scaffold is never queued uncounted.
    await consumeRateLimit(ctx, {
      key: `workspace.applyStructure:${args.workspaceId}`,
      limit: APPLY_STRUCTURE_LIMIT,
      windowMs: APPLY_STRUCTURE_WINDOW_MS,
    });

    // The row records what was asked for. What actually reached the bucket is
    // recorded on the binding as `scaffoldReason`, by the job below — this
    // field is a note for the console, never an input to a later write.
    await ctx.db.patch(args.workspaceId, {
      structureTemplate: args.template,
      customFolders: args.template === "custom" ? folders : undefined,
      updatedAt: Date.now(),
    });

    await ctx.scheduler.runAfter(
      0,
      internal.functions.provisioning.verifyStorageBinding,
      {
        workspaceId: args.workspaceId,
        actorUserId: userId,
        structure: { template: args.template, folders, kind: workspace.kind },
        // Only ever true for a bucket we half-wrote ourselves. The scaffolder
        // still refuses anything it did not write, byte for byte, and still
        // `get`s every key before it `put`s it.
        resume: unfinished,
      },
    );

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "workspace.structure_applied",
      // The folders go in `paths`, which is what that field is for: they are
      // bucket-relative paths, and they are about to exist as keys in the
      // owner's own bucket. The descriptions are not recorded anywhere — they
      // are prose, and prose does not belong in an audit trail.
      paths: folders.map((entry) => `${entry.folder}/README.md`),
      details: {
        template: args.template,
        folderCount: folders.length,
      },
    });

    return {
      queued: true,
      template: args.template,
      folders: folders.map((entry) => entry.folder),
    };
  },
});

/**
 * Every workspace the caller can reach, with their role in each.
 *
 * Driven off `workspaceMembers.by_user`, never off a scan of `workspaces` —
 * so the query is structurally incapable of returning a workspace the caller
 * is not in, rather than relying on a filter someone might later "optimize"
 * away.
 *
 * An authenticated session resolves to a *set* of contexts even while that set
 * has exactly one element today. Clients must not assume `[0]`.
 *
 * ## The pinned context, appended after the sort
 *
 * One row can be here without a membership backing it: `@context-lc`, which
 * every account reaches (`lib/pinnedContext.ts`). It carries `pinned: true`,
 * and two things about where it sits are rules rather than tidiness.
 *
 * **After the sort, not in it.** The rest of this list is ordered oldest-first
 * and the rail's stated rule is that everything after its own pinned top row
 * "keeps the order the control plane sent". The pinned context is older than
 * almost every account that will see it, so sorting it in by `createdAt` would
 * put it *first* — at the head of the list, above the person's own workspace,
 * on every surface that trusts this order. It belongs at the end.
 *
 * **It does not make the query non-empty for somebody with nothing.** That
 * sounds like a property of this function and is really a property of its
 * consumers, which is why `pinned` is on the row: `standingFrom` in the app
 * subtracts it before asking "does this person have anywhere to go", and
 * `ownedContexts` never counted it anyway (it is `shared`/`member`).
 */
export const listMyWorkspaces = query({
  args: {},
  returns: v.array(workspaceSummary),
  handler: async (ctx) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;

    const memberships = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_WORKSPACES_RETURNED);

    const summaries = [];
    for (const membership of memberships) {
      const workspace = await ctx.db.get(membership.workspaceId);
      if (workspace === null) continue;
      summaries.push({
        workspaceId: workspace._id,
        slug: workspace.slug,
        displayName: workspace.displayName,
        kind: workspace.kind,
        structureTemplate: workspace.structureTemplate,
        role: membership.role,
        icon: workspace.icon,
        meetingsFolder: workspace.meetingsFolder,
        /*
          The owner's stamp counts every line; everybody else's counts the
          `team` ones. Narrowed here rather than on the client, because a
          number that reaches a device has been disclosed whatever the device
          then does with it.
        */
        activityAt:
          membership.role === "owner" ? workspace.activityAt : workspace.activityTeamAt,
        activitySeenAt: membership.activitySeenAt,
        joinedAt: membership.joinedAt,
        createdAt: workspace.createdAt,
      });
    }
    summaries.sort((a, b) => a.createdAt - b.createdAt);

    const pinned = await pinnedContextWorkspace(ctx);
    if (
      pinned !== null &&
      !summaries.some((summary) => summary.workspaceId === pinned._id)
    ) {
      summaries.push({
        workspaceId: pinned._id,
        slug: pinned.slug,
        displayName: pinned.displayName,
        kind: pinned.kind,
        structureTemplate: pinned.structureTemplate,
        role: PINNED_CONTEXT_ROLE,
        icon: pinned.icon,
        meetingsFolder: pinned.meetingsFolder,
        /*
          A pinned reader has no membership row, so there is nothing that could
          hold "when did they last look" — and a mark that lights for everybody
          and never goes out is worse than one that never lights. The shared
          context's own activity is still there when they open it.
        */
        activityAt: undefined,
        activitySeenAt: undefined,
        /*
          Nobody joined, so there is no join time. The workspace's own creation
          is the only honest date available and is what the field means for a
          row that has always been there — and it is never read as "when this
          person joined" for this row, because `pinned` says it was not joined.
        */
        joinedAt: pinned.createdAt,
        createdAt: pinned.createdAt,
        pinned: true,
      });
    }

    return summaries;
  },
});

/**
 * One workspace, if the caller is a member of it.
 *
 * A non-member gets `WORKSPACE_NOT_FOUND` — byte-identical to the error for an
 * id that never existed. See `lib/workspaceAuth.ts` for why that matters.
 */
export const getWorkspace = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({
    workspaceId: v.id("workspaces"),
    slug: v.string(),
    displayName: v.string(),
    kind: v.string(),
    structureTemplate: v.string(),
    role: v.string(),
    icon: v.optional(workspaceIconValidator),
    createdAt: v.number(),
    updatedAt: v.number(),
    memberCount: v.number(),
  }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const { workspace, membership } = await requireWorkspaceAccess(
      ctx,
      args.workspaceId,
      userId,
    );

    // Bounded, so `memberCount` saturates at the cap rather than paying for an
    // unbounded read. A context with more members than this does not exist,
    // and if one ever does the number wants pagination, not a full scan.
    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
      .take(MAX_MEMBERS_RETURNED);

    return {
      workspaceId: workspace._id,
      slug: workspace.slug,
      displayName: workspace.displayName,
      kind: workspace.kind,
      structureTemplate: workspace.structureTemplate,
      role: membership.role,
      icon: workspace.icon,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      memberCount: members.length,
    };
  },
});

/**
 * Who else is in this context.
 *
 * Members of a shared context can see each other — that is what makes `team`
 * visibility meaningful ("named people the owner granted access to", not
 * anonymous). Emails are included because a member needs to know *who* they
 * are sharing their notes with; that is exactly the information the sharing
 * decision turns on.
 */
export const listMembers = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(
    v.object({
      userId: v.id("users"),
      role: v.string(),
      email: v.optional(v.string()),
      name: v.optional(v.string()),
      /**
       * Whether this row is the caller, so an interface can say "you" instead
       * of comparing ids it would otherwise have to be told. Same reason
       * `listGrants` carries `isMine`.
       */
      isMe: v.boolean(),
      joinedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceAccess(ctx, args.workspaceId, userId);

    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .take(MAX_MEMBERS_RETURNED);

    const rows = [];
    for (const member of members) {
      const user = await ctx.db.get(member.userId);
      rows.push({
        userId: member.userId,
        role: member.role,
        email: user?.email,
        name: user?.name,
        isMe: member.userId === userId,
        joinedAt: member.joinedAt,
      });
    }
    return rows.sort((a, b) => a.joinedAt - b.joinedAt);
  },
});

/**
 * The refusal for a member this workspace does not have.
 *
 * Safe to be distinct from every other error here, and distinct on purpose:
 * only an `owner` reaches this line, and an owner can already enumerate their
 * own members with `listMembers`. There is nothing for the refusal to disclose,
 * and "that person is not in this context" is the only form of it they can act
 * on.
 */
function memberNotFound(): ConvexError<{ code: string; message: string }> {
  return new ConvexError({
    code: "MEMBER_NOT_FOUND",
    message: "That person is not a member of this context.",
  });
}

/**
 * Remove somebody from a context. Owner-only.
 *
 * ## An owner cannot be removed, including by themselves
 *
 * Every workspace has exactly one `owner` — `createWorkspace` writes it and
 * nothing else ever mints one, because `inviteMember`'s role validator excludes
 * `owner` and `setMemberRole`'s does too. Removing that row would leave a
 * context with a storage credential, an audit trail and possibly other members,
 * and nobody able to administer, rebind or wind it down: unrecoverable, from a
 * single click. Handing a context to somebody else is a separate, deliberate
 * act and is not built, so for now the answer is simply no.
 *
 * ## Already-issued AI-client grants stop working immediately
 *
 * Nothing here touches `oauthGrants`, and that is the design rather than an
 * omission. Every path that turns a token into authority — the access-token
 * resolution in `functions/controlPlane.ts`, the refresh rotation beside it,
 * and `resolveGrantByRefreshToken` in `functions/grants.ts` — re-reads
 * membership on every single call, so deleting this one row cuts off every
 * client the person had connected, in the same instant, without a sweep or a
 * revocation list to get wrong. Marking the grants revoked here as well would
 * add a second mechanism that can silently become the one people rely on;
 * `__tests__/membership.test.ts` proves the first one holds.
 *
 * Removing somebody who is not a member is `{ removed: false }`, not an error:
 * the caller is an owner, so it is idempotent rather than informative.
 */
export const removeMember = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
  },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, args) => {
    const actorId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceRole(ctx, args.workspaceId, actorId, "owner");

    const target = await getMembership(ctx, args.workspaceId, args.userId);
    if (target === null) return { removed: false };

    if (target.role === "owner") {
      throw new ConvexError({
        code: "CANNOT_REMOVE_OWNER",
        message:
          "A context's owner cannot be removed. Transferring ownership is a separate step, and is not built yet.",
      });
    }

    await ctx.db.delete(target._id);

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: actorId,
      action: "member.removed",
      details: { targetUserId: args.userId, previousRole: target.role },
    });

    return { removed: true };
  },
});

/**
 * Choose where meetings land in this context.
 *
 * ## Why this exists
 *
 * It is the one capture destination a person could not change. A Google
 * account carries an editable folder per service; forwarded mail carries a
 * target folder; a meeting carried `MEETINGS_FOLDER`, a constant, interpolated
 * into a sentence on the settings panel with no control beside it. Somebody
 * who files meetings under `2-areas/meetings` had to move every note by hand,
 * forever.
 *
 * ## What it does not change
 *
 * **The destination is still asked for every time, before the microphone
 * opens.** `features/meetings/destination.ts` argues that at length and it is
 * untouched: the first offer is always the person's own workspace, the page they
 * are standing on is offered second with its audience named, and no remembered
 * setting answers silently. This names the folder the *first offer points at*.
 * Those are two decisions, and conflating them is why this setting did not
 * exist.
 *
 * ## The validator is the gateway's own
 *
 * `normalizeMeetingFolder` is what `packages/meetings` uses to decide whether a
 * folder a client asked for is one it will file into, and an offer it refuses
 * is an offer the write then rejects. Calling anything else here would let a
 * person save a folder the gateway will not honour — a setting that appears to
 * work and silently files somewhere else, which is the exact defect that
 * module exists to close.
 *
 * Owner-only, and personal-only. Only the personal-inbox offer reads this, so
 * on a shared workspace it would be a control with no effect.
 */
export const setMeetingsFolder = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    /** A folder, or `null` to go back to the default. */
    folder: v.union(v.string(), v.null()),
  },
  returns: v.object({ folder: v.string() }),
  handler: async (ctx, args) => {
    const actorId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceRole(ctx, args.workspaceId, actorId, "owner");

    const workspace = await ctx.db.get(args.workspaceId);
    /*
      The helper, not a literal. `workspaceAuth.ts` is the one place this error
      is constructed so that "not a member" and "does not exist" stay
      byte-identical, and `workspaceAuth.test.ts` fails if the string appears
      anywhere else in `functions/` — which is how this line was caught.
    */
    if (workspace === null) throw workspaceNotFound();
    if (workspace.kind !== "personal") {
      throw new ConvexError({
        code: "MEETINGS_FOLDER_NOT_PERSONAL",
        message:
          "Meetings are offered your own workspace first, so the folder is a setting on a personal workspace rather than on a shared one.",
      });
    }

    /*
      `null` clears the choice rather than storing the default's spelling. A
      stored "0-inbox/meetings" would stop following the default if it ever
      moved, which is how a person who never expressed a preference ends up
      pinned to an old one.
    */
    const folder =
      args.folder === null ? null : normalizeMeetingFolder(args.folder);
    if (args.folder !== null && folder === null) {
      throw new ConvexError({
        code: "MEETINGS_FOLDER_INVALID",
        message: "Use a folder inside this context — not the root, and not a note.",
      });
    }

    await ctx.db.patch(args.workspaceId, {
      meetingsFolder: folder ?? undefined,
      updatedAt: Date.now(),
    });

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: actorId,
      action: "meetings.folder_set",
      details: { meetingsFolder: folder ?? MEETINGS_FOLDER },
    });

    return { folder: folder ?? MEETINGS_FOLDER };
  },
});

/* -------------------------------------------------------------------------- */
/*                        what a workspace looks like                          */
/* -------------------------------------------------------------------------- */

/**
 * Choose the emoji this workspace draws in its mark, or go back to the letter.
 *
 * ## Why this setting exists
 *
 * `WorkspaceMark` derives one letter from the slug, and a person with `@seyi`
 * and `@supa` gets **S** twice, in the same square, in the same colour, in a
 * control whose whole job is telling them apart. The letter is a good default
 * and a poor identity.
 *
 * ## Owner-only, like every other fact about the workspace
 *
 * An editor writes notes; the workspace's name, its storage and now its face
 * are the owner's. The line matters more here than for `meetingsFolder`,
 * because this one is **seen by everybody**: an icon is rendered in the rail of
 * every member of a shared context, so an editor setting it would be an editor
 * changing what somebody else's screen looks like.
 *
 * ## Why `null` clears rather than storing a letter
 *
 * The same argument `setMeetingsFolder` makes about its default: storing the
 * derived letter would freeze today's derivation, so a workspace that was
 * renamed — or a change to which letter `WorkspaceMark` picks — would leave an
 * old answer behind on a row nobody thinks of as holding one. Absent means "no
 * choice was made", and the mark re-derives every time.
 *
 * ## The photo half is not here
 *
 * A photo's bytes go in the customer's bucket, so setting one is a file
 * operation and lives beside its siblings in `files.ts`
 * (`setWorkspaceIconPhoto`). This writes only what belongs on the row.
 */
export const setWorkspaceIcon = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    /** One emoji, or `null` to go back to the letter. */
    emoji: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const actorId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceRole(ctx, args.workspaceId, actorId, "owner");

    const workspace = await ctx.db.get(args.workspaceId);
    /*
      The helper rather than a literal, so "not a member" and "does not exist"
      stay byte-identical — `workspaceAuth.test.ts` fails if this string is
      built anywhere else in `functions/`.
    */
    if (workspace === null) throw workspaceNotFound();

    if (args.emoji === null) {
      /*
        THE BUCKET OBJECT IS DELIBERATELY LEFT WHERE IT IS.

        Deleting the photo on clear looks tidy and is wrong twice. The store is
        content-addressed, so those bytes may equally be another workspace's
        icon in the same bucket or the target of a paste in a note, and a delete
        here would break both. And it is the customer's bucket: an object we put
        there is theirs to keep or remove.
      */
      await ctx.db.patch(args.workspaceId, { icon: undefined, updatedAt: Date.now() });
      await recordAudit(ctx, {
        workspaceId: args.workspaceId,
        actorUserId: actorId,
        action: "workspace.icon_cleared",
        details: { was: workspace.icon?.kind ?? "none" },
      });
      return null;
    }

    /*
      THE VALIDATOR IS SHARED, AND IT IS STRUCTURAL.

      Not a length check. This value is drawn in an 18pt square on the screen of
      every member of the workspace, so what has to be refused is not "too long"
      but "not one glyph": a right-to-left override, a stack of combining marks
      that draws over the row above, or plain text. `isSingleEmoji` answers that
      shape question, and the console pre-flights the same function so the
      picker can never offer what this refuses.
    */
    if (!isSingleEmoji(args.emoji)) {
      throw new ConvexError({
        code: "WORKSPACE_ICON_INVALID",
        message: "A workspace icon is a single emoji.",
      });
    }

    await ctx.db.patch(args.workspaceId, {
      icon: { kind: "emoji", emoji: args.emoji },
      updatedAt: Date.now(),
    });
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: actorId,
      action: "workspace.icon_set",
      /*
        The emoji is in the audit detail; a photo's leaf is too. Neither is note
        content and neither is a secret — the leaf is a content hash of a
        picture the workspace already shows everybody — and an audit line
        reading "an icon was set" answers none of the questions an audit trail
        is read for.
      */
      details: { icon: "emoji", emoji: args.emoji },
    });
    return null;
  },
});

/**
 * Record a photo that `setWorkspaceIconPhoto` has already written to the bucket.
 *
 * Internal, and it takes a leaf it does not check, which is safe for exactly
 * one reason: **the only caller has just produced that leaf itself**, from a
 * content hash, through `workspaceIconLeaf`, and written the object under it.
 * There is no path from a client argument to this value. If that ever stops
 * being true this needs the leaf rule applied here as well.
 *
 * The role check is repeated rather than trusted. The action checked `owner`
 * before it wrote the bytes, and this is a second entry point into the same
 * row — an internal one today, which is a fact about today.
 */
export const recordWorkspaceIconPhoto = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    actorUserId: v.id("users"),
    leaf: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireWorkspaceRole(ctx, args.workspaceId, args.actorUserId, "owner");
    await ctx.db.patch(args.workspaceId, {
      icon: { kind: "photo", leaf: args.leaf },
      updatedAt: Date.now(),
    });
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      action: "workspace.icon_set",
      details: { icon: "photo", leaf: args.leaf },
    });
    return null;
  },
});

/**
 * The leaf this workspace's icon photo is stored under, for a caller who may
 * see this workspace at all.
 *
 * **This is the whole security argument for workspace icon photos, so it is
 * worth being slow about.**
 *
 * An image in the opaque store has no visibility of its own — it borrows the
 * visibility of the notes that reference it, which is what keeps the store from
 * drifting out of step with `privacy.md`. `readNoteImage` is built on exactly
 * that: name a note you can see, and the image must be mentioned in it.
 *
 * A workspace icon has no note, so that gate cannot answer for it. The
 * temptation is to relax the gate. What happens instead is that **the caller
 * never names the object**: this query takes a `workspaceId` and reads the leaf
 * off the row. There is no argument through which a leaf can be supplied, so
 * the read path that uses this cannot be turned into a general object reader
 * however it is called — which makes it strictly narrower than the note path,
 * not wider. `workspaceIcon.test.ts` pins that by asserting the action's
 * argument shape as well as its refusals.
 *
 * `member` is the floor, and it is the honest one: an icon is drawn in the rail
 * of everyone who can reach the workspace, so every member is already meant to
 * see it. A non-member gets `workspaceNotFound` through `requireWorkspaceAccess`
 * — the same error as for an id that never existed.
 */
export const workspaceIconLeaf = internalQuery({
  args: { workspaceId: v.id("workspaces"), actorUserId: v.id("users") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    /*
      THE PIN IS REACH WITHOUT A MEMBERSHIP ROW, AND THIS HAS TO KNOW THAT.

      `requireWorkspaceAccess` answers from `workspaceMembers`, and nobody is a
      member of `@context-lc` — so asking it alone would refuse the one
      workspace that is in *every* account's rail, after `authorizeFileAccess`
      (which does know about the pin) had already admitted the caller. The two
      gates would disagree on exactly one row in the product.

      Tried before the membership read rather than after a caught failure, for
      the reason `authorizeFileAccess` gives: the refusal is byte-identical for
      "not a member" and "no such workspace", so catching it would mean guessing
      which one this was. Asking the narrower question first needs no guess.
    */
    if (await reachesPinnedContext(ctx, args.workspaceId, args.actorUserId)) {
      const pinned = await ctx.db.get(args.workspaceId);
      return pinned?.icon?.kind === "photo" ? pinned.icon.leaf : null;
    }
    const { workspace } = await requireWorkspaceAccess(
      ctx,
      args.workspaceId,
      args.actorUserId,
    );
    return workspace.icon?.kind === "photo" ? workspace.icon.leaf : null;
  },
});

/**
 * Walk out of somebody else's context.
 *
 * `removeMember` is the owner showing somebody the door; this is the person
 * leaving on their own — the door has to open from both sides, and until it
 * did, an invitee who wanted out had to ask the owner to evict them.
 *
 * An owner cannot leave. For a personal context that would orphan it
 * outright, and for a shared one it is an ownership transfer wearing a
 * different name — the same unrecoverable step `removeMember` refuses to
 * smuggle in. Leaving takes nothing with it: notes the person wrote stay
 * exactly where they are, because they live in the context's storage, not in
 * the membership row.
 */
export const leaveWorkspace = mutation({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ left: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;

    const membership = await getMembership(ctx, args.workspaceId, userId);
    if (membership === null) return { left: false };

    if (membership.role === "owner") {
      throw new ConvexError({
        code: "OWNER_CANNOT_LEAVE",
        message:
          "You own this context, so leaving would orphan it. Transferring ownership is a separate step, and is not built yet.",
      });
    }

    await ctx.db.delete(membership._id);

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "member.left",
      details: { previousRole: membership.role },
    });

    return { left: true };
  },
});

/**
 * Change what somebody may do in a context. Owner-only.
 *
 * `editor` and `member` only — the same closed set `inviteMember` offers, for
 * the same reason. A promotion to `owner` would be an ownership transfer with
 * no confirmation and no way back, and a demotion *from* `owner` is the
 * unrecoverable case `removeMember` describes.
 *
 * Setting the role somebody already has writes nothing and records nothing. An
 * audit trail that logs a change that did not happen makes the trail harder to
 * read, not easier.
 */
export const setMemberRole = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    userId: v.id("users"),
    role: v.union(v.literal("editor"), v.literal("member")),
  },
  returns: v.object({ role: v.string() }),
  handler: async (ctx, args) => {
    const actorId = (await requireAuthId(ctx)) as Id<"users">;
    await requireWorkspaceRole(ctx, args.workspaceId, actorId, "owner");

    const target = await getMembership(ctx, args.workspaceId, args.userId);
    if (target === null) throw memberNotFound();

    if (target.role === "owner") {
      throw new ConvexError({
        code: "CANNOT_CHANGE_OWNER_ROLE",
        message:
          "A context's owner keeps the owner role. Transferring ownership is a separate step, and is not built yet.",
      });
    }

    if (target.role === args.role) return { role: target.role };

    await ctx.db.patch(target._id, { role: args.role });

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: actorId,
      action: "member.role_changed",
      details: {
        targetUserId: args.userId,
        previousRole: target.role,
        role: args.role,
      },
    });

    return { role: args.role };
  },
});
