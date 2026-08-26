/**
 * Reading and seeding the ingestion settings of a **personal** context, and the
 * one definition of which context may receive mail at all.
 *
 * The in-transaction half of `functions/ingestion.ts`, kept separate for the
 * same reason `lib/audit.ts` is: `functions/workspaces.ts` has to seed the row
 * inside the transaction that creates the workspace, and a mutation cannot call
 * another mutation. Everything here takes a ctx and does one small thing.
 *
 * The *rules* — what a valid address is, which senders are allowed, what a
 * folder path may look like — live in `lib/ingestion.ts`, which has no Convex
 * import at all. Nothing in this file may make a policy decision; it stores and
 * retrieves the settings that `senderIsAllowed` is later evaluated against.
 *
 * ============================================================================
 * MAIL LANDS IN A PERSONAL CONTEXT AND NOWHERE ELSE
 * ============================================================================
 *
 * This file used to be neutral about which kind of context it was serving, and
 * `createWorkspace` seeded a policy for every workspace it made — which gave a
 * shared context a live capture address, an allow-list, and an owner-facing
 * switch. That is now a decided product call and the answer is no.
 *
 * Inbound email is unauthenticated by nature: anyone who learns an address can
 * send to it, and the only thing between a stranger and a stored note is an
 * allow-list over a header the sender wrote. Writing into a space several
 * people read is a different risk from writing into your own — and captures are
 * read back by AI clients as trusted context, so a forged one is a
 * prompt-injection primitive with a persistence guarantee. A shared address
 * also survives its members leaving and produces notes attributable to nobody,
 * and the sensible default allow-list — "the address you signed up with" — has
 * no answer at all for a shared context ("whose email?").
 *
 * So a shared context has no ingestion address. Not a disabled one, not one
 * awaiting configuration. Mail gets into a shared context only afterwards, when
 * a person triages a capture out of their own context and moves it — which
 * means everything from outside passed through one accountable owner's hands.
 *
 * `resolvePersonalContextForIngestion` below is the **single** place that
 * decides this. Nothing else may re-derive it.
 */

import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { DEFAULT_TARGET_FOLDER, normalizeSenderEntry } from "./ingestion";
import { findName } from "./nameClaims";

export async function getIngestionSettingsRow(
  ctx: QueryCtx,
  workspaceId: Id<"workspaces">,
): Promise<Doc<"ingestionSettings"> | null> {
  return await ctx.db
    .query("ingestionSettings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
}

/**
 * How many member rows we will read before giving up on a context.
 *
 * A personal context has one. Reading a bounded page and refusing anything
 * larger is what keeps this a constant-cost check on a path a stranger can
 * trigger by sending mail.
 */
const MAX_MEMBERS_SCANNED = 8;

/**
 * A personal context, resolved structurally rather than by its label.
 *
 * `schema.ts` says it in as many words: *"A personal context is a workspace
 * with a single `owner` member. A shared context is the same row with more
 * members."* That sentence is the definition this function implements, and it
 * is why the membership count is checked and not just `kind`. `workspaces.kind`
 * is chosen by whoever called `createWorkspace` and no mutation ever changes
 * it, so it is a reliable *statement of intent* — but it is descriptive, and a
 * context that has since been shared with three people is not somewhere
 * unauthenticated mail may land whatever its row says. Both are required, and
 * the stricter one is the count.
 *
 * Ordering note: `kind` is checked first and the count second, so a shared
 * context costs one document read rather than a member scan.
 *
 * ## Why this resolves through the workspace namespace
 *
 * `infra/email-worker/src/controlPlane.ts` specifies resolution through
 * `names.by_name(...).userId` — the `kind: "user"` arm — as the structurally
 * strongest route, and states as a precondition that signup must claim it.
 * **That precondition is not met and this function does not pretend it is.**
 * Nothing in this codebase has ever written a `kind: "user"` row: the only
 * writer of `names` is `createWorkspace`, which always claims
 * `kind: "workspace"`. Following the user arm today would resolve nothing at
 * all — fail-closed, but for the wrong reason, and it would ship a route that
 * cannot work.
 *
 * What a person actually has is a personal workspace whose slug is their
 * handle, which is what CLAUDE.md means by usernames and workspace slugs
 * sharing one namespace. `functions/invitations.ts`'s `resolveInviteeUser`
 * already resolves a handle to a person exactly this way, and has since before
 * ingestion existed; this is the same rule, one notch stricter (it requires a
 * lone member, not merely a lone owner, because the question here is "may a
 * stranger write here?" rather than "who do I address an invitation to?").
 *
 * If the `kind: "user"` arm is ever claimed at signup, this is the one function
 * that has to learn about it.
 *
 * ## Every "no" is the same "no"
 *
 * `null` covers: no such name, the name is a shared context, the name is a
 * personal context that has since gained members, the workspace row is gone,
 * and the context has no lone owner. The caller must not be able to tell them
 * apart — `<name>@context.lc` is an address anyone on the internet can probe,
 * and a distinguishable answer is a username-enumeration oracle drivable from
 * any mail client. Distinguishing the shared case in particular would publish
 * which names on this domain are teams.
 */
export async function resolvePersonalContextForIngestion(
  ctx: QueryCtx,
  normalizedName: string,
): Promise<{ workspace: Doc<"workspaces">; ownerUserId: Id<"users"> } | null> {
  const claim = await findName(ctx, normalizedName);
  if (claim === null) return null;
  if (claim.workspaceId === undefined) return null;

  const workspace = await ctx.db.get(claim.workspaceId);
  if (workspace === null) return null;
  if (workspace.kind !== "personal") return null;

  const members = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspace._id))
    .take(MAX_MEMBERS_SCANNED);
  if (members.length !== 1) return null;
  if (members[0].role !== "owner") return null;

  return { workspace, ownerUserId: members[0].userId };
}

/**
 * Create a workspace's ingestion settings, closed except for its owner.
 *
 * **The default is the owner's own account email and nothing else.** Widening
 * is always a separate, deliberate act by the owner, and it is audited.
 *
 * Why not open by default: the capture address is semi-public (it is shown in
 * the console and derivable from a public slug), and mail that reaches it
 * becomes a note that the owner's AI clients later read as trusted context. An
 * open inbox is therefore a content-injection channel with a persistence
 * guarantee, not just a spam nuisance. Why the account email specifically: it
 * is the one address we already know the person controls — they authenticated
 * with it — so seeding it makes forwarding-to-yourself work on day one without
 * admitting a single stranger.
 *
 * The seeded value is a snapshot. If the user later changes the email on their
 * account, this entry does not follow: an account-email change must not
 * silently repoint who may write into a context. The console can surface the
 * mismatch; this must not paper over it.
 *
 * Called from `createWorkspace`, inside its transaction, so a *personal*
 * context never exists without a policy. If the account has no usable email —
 * which should not happen under email OTP — the row is still written, with an
 * empty list. That accepts nothing, which is the right answer to "we do not
 * know who you are".
 *
 * ## Refuses a shared context outright
 *
 * A shared context has no ingestion address, so a policy row for one is a row
 * describing a switch that controls nothing — and a row that exists is a row
 * some later read path will happily present as "ingestion is configured". It
 * throws rather than returning quietly: `createWorkspace` already knows the
 * kind and simply must not call this for a shared one, so reaching here is a
 * programming error, and a silent no-op would let a future caller believe it
 * had seeded something.
 */
export async function seedIngestionSettings(
  ctx: MutationCtx,
  options: {
    workspaceId: Id<"workspaces">;
    ownerUserId: Id<"users">;
    now: number;
  },
): Promise<Id<"ingestionSettings">> {
  const workspace = await ctx.db.get(options.workspaceId);
  if (workspace === null || workspace.kind !== "personal") {
    throw new Error(
      "ingestion settings may only be seeded for a personal context",
    );
  }

  const owner = await ctx.db.get(options.ownerUserId);
  const seeded = normalizeSenderEntry(owner?.email);

  return await ctx.db.insert("ingestionSettings", {
    workspaceId: options.workspaceId,
    targetFolder: DEFAULT_TARGET_FOLDER,
    allowedSenders: seeded === null ? [] : [seeded],
    allowedDomains: [],
    allowAnySender: false,
    updatedBy: options.ownerUserId,
    createdAt: options.now,
    updatedAt: options.now,
  });
}
