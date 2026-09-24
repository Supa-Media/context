/**
 * Workspaces — the unit that owns a context.
 *
 * A personal context and a shared project context are the same row with
 * different membership. Nothing here special-cases "personal", and nothing
 * should: the moment a second person is added, an app that modelled personal
 * contexts separately needs a migration instead of an insert.
 *
 * Every export below is a thin Convex registration — name, args and returns
 * validator here, in the one file Convex derives `api.workspaces.*` from —
 * whose handler delegates to `lib/workspaces/`, where the logic (and its
 * comments) actually live. See that folder for the how; this file's doc
 * comments are the what and the why of each function's contract.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { createWorkspaceHandler } from "./lib/workspaces/create";
import { applyStructureHandler } from "./lib/workspaces/structure";
import { listMyWorkspacesHandler } from "./lib/workspaces/list";
import { getWorkspaceHandler } from "./lib/workspaces/read";
import {
  leaveWorkspaceHandler,
  listMembersHandler,
  removeMemberHandler,
  setMemberRoleHandler,
} from "./lib/workspaces/members";
import { setMeetingsFolderHandler } from "./lib/workspaces/settings";
import {
  recordWorkspaceIconPhotoHandler,
  setWorkspaceIconHandler,
  workspaceIconLeafHandler,
} from "./lib/workspaces/icon";
import { workspaceIconValidator, workspaceSummary } from "./lib/workspaces/validators";

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
  handler: (ctx, args) => createWorkspaceHandler(ctx, args),
});

/* -------------------------------------------------------------------------- */
/*                        choosing the starting layout                        */
/* -------------------------------------------------------------------------- */

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
  handler: (ctx, args) => applyStructureHandler(ctx, args),
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
  handler: (ctx) => listMyWorkspacesHandler(ctx),
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
  handler: (ctx, args) => getWorkspaceHandler(ctx, args),
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
  handler: (ctx, args) => listMembersHandler(ctx, args),
});

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
  handler: (ctx, args) => removeMemberHandler(ctx, args),
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
  handler: (ctx, args) => setMeetingsFolderHandler(ctx, args),
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
  handler: (ctx, args) => setWorkspaceIconHandler(ctx, args),
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
  handler: (ctx, args) => recordWorkspaceIconPhotoHandler(ctx, args),
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
  handler: (ctx, args) => workspaceIconLeafHandler(ctx, args),
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
  handler: (ctx, args) => leaveWorkspaceHandler(ctx, args),
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
  handler: (ctx, args) => setMemberRoleHandler(ctx, args),
});
