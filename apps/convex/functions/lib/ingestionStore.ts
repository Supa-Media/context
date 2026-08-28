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
 * A **personal context the owner has since shared is not a shared context**:
 * it keeps its capture address, because its accountable owner still exists,
 * still solely controls the allow-list, and still answers for what lands. The
 * distinction is the `kind` chosen at creation plus a resolvable sole owner,
 * never a member count — see `resolvePersonalContextForIngestion`.
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
 * How many member rows we will read before giving up on finding the owner.
 *
 * Reading one bounded page is what keeps this a constant-cost check on a path
 * a stranger can trigger by sending mail. The page is guaranteed to contain
 * the owner row when one exists: `createWorkspace` writes it inside the
 * transaction that creates the workspace, so it is the oldest member row, and
 * `by_workspace` returns rows for one workspace in creation order. A page
 * with no owner row therefore means the context *has* no owner, and refusing
 * it is fail-closed, not a truncation artifact.
 */
const MAX_MEMBERS_SCANNED = 8;

/**
 * A personal context, resolved to the one person accountable for its mail.
 *
 * Two things are established here, and both are required. `workspaces.kind`
 * must be `"personal"` — chosen at creation and never patched, so it is a
 * reliable statement of what this context *is*; a shared context has no
 * ingestion address at all (see the header). And the context must have
 * exactly one `owner` member, who is returned: the owner is what makes a
 * personal context accountable — their allow-list admits the mail, their
 * inbox receives it, and the capture is attributed to them.
 *
 * ## Members do not kill the address
 *
 * This used to require a lone *member*, so inviting a colleague into your own
 * context silently bounced your mail from that moment on — and because every
 * refusal is byte-identical, nobody was told. That shipped as the cautious
 * guess and was reversed deliberately (2026-08): sharing a personal context
 * is a headline flow, and it must not cost the capture address. The risk the
 * old rule guarded — unauthenticated mail landing where several people read —
 * is governed where it belongs instead: the settings stay owner-only in
 * `functions/ingestion.ts`, captures land in the owner's target folder under
 * the context's own privacy manifest, and everything from outside still
 * passes through one accountable owner's hands.
 *
 * Ordering note: `kind` is checked first and the owner scan second, so a
 * shared context costs one document read rather than a member scan.
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
 * ingestion existed; this is the same rule — a handle addresses the sole
 * owner of the personal context it names.
 *
 * If the `kind: "user"` arm is ever claimed at signup, this is the one function
 * that has to learn about it.
 *
 * ## Every "no" is the same "no"
 *
 * `null` covers: no such name, the name is a shared context, the workspace
 * row is gone, and the context has no resolvable sole owner. The caller must
 * not be able to tell them apart — `<name>@context.lc` is an address anyone
 * on the internet can probe, and a distinguishable answer is a
 * username-enumeration oracle drivable from any mail client. Distinguishing
 * the shared case in particular would publish which names on this domain are
 * teams.
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
  // Exactly one owner: zero means damaged data (`removeMember` refuses to
  // delete an owner), two would mean the sole-owner invariant broke somewhere
  // else. Either way there is no single accountable person, so refuse.
  const owners = members.filter((member) => member.role === "owner");
  if (owners.length !== 1) return null;

  return { workspace, ownerUserId: owners[0].userId };
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
