/**
 * Email ingestion settings — the console's view of who may post into **your own
 * personal context**.
 *
 * Two functions, and both of them are addressed to one person: the sole owner
 * of a personal context reads and writes the policy governing their own capture
 * address. Everything that decides *whether a message is accepted* lives in
 * `lib/ingestion.ts` as a pure function, and the Cloudflare Email Worker in
 * `infra/email-worker/` imports that function rather than reimplementing it.
 * Read that file's header first.
 *
 * ## There is one kind of context here, and it is personal
 *
 * This module used to be neutral about which workspace it was configuring, and
 * reasoned at length about who may write into "everyone's shared context". A
 * shared context no longer has an ingestion address at all — see the header of
 * `lib/ingestionStore.ts` for why — so that distinction has been removed rather
 * than left behind a check.
 *
 * What follows from that, and why the code is shorter than it was:
 *
 *  - **Owner-only, in both directions.** A personal context may have members
 *    now — sharing it no longer kills its capture address — and none of them
 *    may read or write this policy: the allow-list is the owner's
 *    correspondent list, which is not something membership buys. Both
 *    functions require the sole owner, and
 *    `resolvePersonalContextForIngestion` is what establishes that — the same
 *    function the email worker's resolve route goes through, so the console
 *    cannot show a policy for a context that could not receive mail.
 *  - **A shared context reads as `null`.** Not an error: there is genuinely no
 *    policy, because there is nothing for a policy to govern. The console knows
 *    the context's `kind` already and says so in its own words.
 *
 * ## Every change is audited, and none of the contents are
 *
 * The audit row records what moved — counts before and after, how many entries
 * were added or removed, whether the change **widened** the policy — and never
 * the addresses themselves. An allowlist is a list of people the owner
 * corresponds with, and an append-only trail outlives the setting it describes:
 * a context whose notes are later moved, exported, or read by an AI client
 * would carry that correspondent list with it. Counts and a `widened` flag are
 * enough to answer the question an audit trail exists for ("did somebody open
 * this up, and when?") without publishing the list.
 */

import { ConvexError, v } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import { mutation, query } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import {
  DEFAULT_TARGET_FOLDER,
  MAX_ALLOWED_DOMAINS,
  MAX_ALLOWED_SENDERS,
  describeFolderRejection,
  ingestionAddressFor,
  ingestionIsReceiving,
  normalizeDomainEntry,
  normalizeSenderEntry,
  normalizeTargetFolder,
} from "./lib/ingestion";
import {
  getIngestionSettingsRow,
  resolvePersonalContextForIngestion,
} from "./lib/ingestionStore";
import { requireWorkspaceRole } from "./lib/workspaceAuth";

/**
 * What both functions return.
 *
 * `address` is derived from the slug rather than stored — one source of truth,
 * and a stored copy could only ever drift. `null` from `getIngestionSettings`
 * means this workspace has no policy row at all, which is the fail-closed state
 * (accepts nothing) and only reachable for workspaces created before the table
 * existed. Clients must treat `null` as "ingestion is off", never as "loading".
 */
const settingsValidator = v.object({
  address: v.string(),
  /**
   * Whether anything is on the other end of `address`.
   *
   * Part of the contract rather than something the console assumes, because
   * the console cannot know: "is a receiver deployed" is a property of *this
   * deployment*, and only the control plane can see it. `false` today — there
   * is no Email Worker — and a client is required to draw a `false` here by
   * making no claim at all about mail landing, being accepted, or being
   * dropped. `ingestionIsReceiving` in `lib/ingestion.ts` is what flips it.
   *
   * Deliberately *not* stored on the row: it is not a per-workspace setting,
   * and a copy on every row would be one more thing to backfill on the day the
   * receiver ships.
   */
  receiving: v.boolean(),
  targetFolder: v.string(),
  allowedSenders: v.array(v.string()),
  allowedDomains: v.array(v.string()),
  allowAnySender: v.boolean(),
});

function present(workspace: Doc<"workspaces">, row: Doc<"ingestionSettings">) {
  return {
    address: ingestionAddressFor(workspace.slug),
    receiving: ingestionIsReceiving(),
    targetFolder: row.targetFolder,
    allowedSenders: row.allowedSenders,
    allowedDomains: row.allowedDomains,
    allowAnySender: row.allowAnySender,
  };
}

/**
 * The current policy for a personal context, read by its owner.
 *
 * A non-member gets `WORKSPACE_NOT_FOUND` — byte-identical to the error for a
 * workspace id that never existed. See `lib/workspaceAuth.ts`.
 *
 * `null` means "this context has no ingestion policy", which is true of a
 * shared context (it has no capture address) and of a personal context created
 * before the settings table existed. Both are the fail-closed state — accepts
 * nothing — and clients must read `null` as "ingestion is off", never as
 * "loading".
 */
export const getIngestionSettings = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(settingsValidator, v.null()),
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    // Owner, not member: the allow-list names the people the owner
    // corresponds with, so a member of a since-shared personal context may
    // not read it — and asking for the owner means a *shared* context cannot
    // reach the resolve check below by way of one of its readers.
    const { workspace } = await requireWorkspaceRole(
      ctx,
      args.workspaceId,
      userId,
      "owner",
    );

    // The same gate the email worker's resolve route goes through, so the
    // console can never display a capture address for a context that would
    // refuse the mail sent to it.
    const personal = await resolvePersonalContextForIngestion(ctx, workspace.slug);
    if (personal === null || personal.workspace._id !== workspace._id) return null;

    const row = await getIngestionSettingsRow(ctx, args.workspaceId);
    if (row === null) return null;
    return present(workspace, row);
  },
});

/**
 * Change the policy. Owner only.
 *
 * Every argument is optional and omitting one leaves it alone, so the console
 * can save one field without having to round-trip the rest — and, more to the
 * point, so a client that does not yet know about a field cannot blank it.
 *
 * Validation refuses rather than repairs. A malformed address is not silently
 * dropped from the list: an owner who typed `seyi@@example.test` and got a
 * green checkmark would believe an address was allowed that never was, and a
 * silently-shorter allowlist is a silently-different security posture. Each
 * rejection names the offending entry, which is safe — the caller just sent it.
 *
 * A shared context is refused outright with `INGESTION_NOT_AVAILABLE`. It gets
 * an error rather than the read's quiet `null` because the two questions are
 * different: "what is the policy here?" has the honest answer "there isn't
 * one", but "set this policy" is a request that cannot be satisfied, and
 * returning success for a write that governs nothing is how a person ends up
 * believing an address is live.
 */
export const updateIngestionSettings = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    targetFolder: v.optional(v.string()),
    allowedSenders: v.optional(v.array(v.string())),
    allowedDomains: v.optional(v.array(v.string())),
    allowAnySender: v.optional(v.boolean()),
  },
  returns: settingsValidator,
  handler: async (ctx, args) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    const { workspace } = await requireWorkspaceRole(
      ctx,
      args.workspaceId,
      userId,
      "owner",
    );

    // Personal contexts only, decided by the one function that decides it. A
    // shared context has no capture address, so there is no policy to set.
    const personal = await resolvePersonalContextForIngestion(ctx, workspace.slug);
    if (personal === null || personal.workspace._id !== workspace._id) {
      throw new ConvexError({
        code: "INGESTION_NOT_AVAILABLE",
        message:
          "Only a personal context receives email. Notes reach a shared context when someone moves them there.",
      });
    }

    const existing = await getIngestionSettingsRow(ctx, args.workspaceId);

    // A workspace with no row is the fail-closed floor, and materializing one
    // here must not invent an allowlist. The owner's own address is seeded at
    // *creation*; re-deriving it now would be exactly the inference that seed
    // exists to avoid, and would silently widen a policy during an unrelated
    // edit.
    const before = {
      targetFolder: existing?.targetFolder ?? DEFAULT_TARGET_FOLDER,
      allowedSenders: existing?.allowedSenders ?? [],
      allowedDomains: existing?.allowedDomains ?? [],
      allowAnySender: existing?.allowAnySender ?? false,
    };

    const targetFolder =
      args.targetFolder === undefined
        ? before.targetFolder
        : requireTargetFolder(args.targetFolder);

    const allowedSenders =
      args.allowedSenders === undefined
        ? before.allowedSenders
        : normalizeSenderList(args.allowedSenders);

    const allowedDomains =
      args.allowedDomains === undefined
        ? before.allowedDomains
        : normalizeDomainList(args.allowedDomains);

    const allowAnySender = args.allowAnySender ?? before.allowAnySender;

    const now = Date.now();
    if (existing === null) {
      await ctx.db.insert("ingestionSettings", {
        workspaceId: args.workspaceId,
        targetFolder,
        allowedSenders,
        allowedDomains,
        allowAnySender,
        updatedBy: userId,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(existing._id, {
        targetFolder,
        allowedSenders,
        allowedDomains,
        allowAnySender,
        updatedBy: userId,
        updatedAt: now,
      });
    }

    const sendersAdded = countAdded(before.allowedSenders, allowedSenders);
    const domainsAdded = countAdded(before.allowedDomains, allowedDomains);

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "ingestion.settings.updated",
      // A folder path is metadata, exactly like every other `paths` entry in
      // this trail. The allowlist contents are not, and are never recorded.
      paths: [targetFolder],
      details: {
        firstConfiguration: existing === null,
        targetFolderChanged: targetFolder !== before.targetFolder,
        allowedSendersBefore: before.allowedSenders.length,
        allowedSendersAfter: allowedSenders.length,
        allowedDomainsBefore: before.allowedDomains.length,
        allowedDomainsAfter: allowedDomains.length,
        sendersAdded,
        sendersRemoved: countAdded(allowedSenders, before.allowedSenders),
        domainsAdded,
        domainsRemoved: countAdded(allowedDomains, before.allowedDomains),
        allowAnySenderBefore: before.allowAnySender,
        allowAnySenderAfter: allowAnySender,
        // The one flag a human scanning the trail actually cares about: did
        // this change let somebody new in? Recorded rather than derived at read
        // time so it cannot be lost when a display changes.
        widened:
          (allowAnySender && !before.allowAnySender) ||
          sendersAdded > 0 ||
          domainsAdded > 0,
      },
    });

    return {
      address: ingestionAddressFor(workspace.slug),
      receiving: ingestionIsReceiving(),
      targetFolder,
      allowedSenders,
      allowedDomains,
      allowAnySender,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*                                 validation                                 */
/* -------------------------------------------------------------------------- */

function requireTargetFolder(raw: string): string {
  const validation = normalizeTargetFolder(raw);
  if (!validation.ok) {
    throw new ConvexError({
      code: "INVALID_TARGET_FOLDER",
      message: describeFolderRejection(validation.reason),
      reason: validation.reason,
    });
  }
  return validation.folder;
}

/**
 * Normalize, deduplicate, and cap a sender list.
 *
 * Deduplication happens **after** normalization, so `Seyi@Example.test` and
 * `seyi@example.test` collapse to one entry rather than occupying two slots of
 * a bounded list. Order is the caller's, minus duplicates, so the console shows
 * the list back in the order the person arranged it.
 */
function normalizeSenderList(raw: readonly string[]): string[] {
  if (raw.length > MAX_ALLOWED_SENDERS) {
    throw new ConvexError({
      code: "TOO_MANY_ALLOWED_SENDERS",
      message: `You can allow at most ${MAX_ALLOWED_SENDERS} individual addresses. Allow a whole domain instead.`,
      limit: MAX_ALLOWED_SENDERS,
    });
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of raw) {
    const address = normalizeSenderEntry(entry);
    if (address === null) {
      throw new ConvexError({
        code: "INVALID_SENDER_ADDRESS",
        message: `"${entry}" is not an email address we can match against.`,
        entry,
      });
    }
    if (seen.has(address)) continue;
    seen.add(address);
    normalized.push(address);
  }
  return normalized;
}

function normalizeDomainList(raw: readonly string[]): string[] {
  if (raw.length > MAX_ALLOWED_DOMAINS) {
    throw new ConvexError({
      code: "TOO_MANY_ALLOWED_DOMAINS",
      message: `You can allow at most ${MAX_ALLOWED_DOMAINS} domains.`,
      limit: MAX_ALLOWED_DOMAINS,
    });
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of raw) {
    const domain = normalizeDomainEntry(entry);
    if (domain === null) {
      throw new ConvexError({
        code: "INVALID_SENDER_DOMAIN",
        message: `"${entry}" is not a domain. Use the domain on its own, like example.test — subdomains have to be listed separately.`,
        entry,
      });
    }
    if (seen.has(domain)) continue;
    seen.add(domain);
    normalized.push(domain);
  }
  return normalized;
}

/** How many entries of `after` were not already in `before`. */
function countAdded(before: readonly string[], after: readonly string[]): number {
  const known = new Set(before);
  return after.filter((entry) => !known.has(entry)).length;
}
