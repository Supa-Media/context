/**
 * The control-plane half of email ingestion: what the Email Worker is allowed
 * to ask, and what it gets back.
 *
 * `infra/email-worker/src/controlPlane.ts` is the normative contract for the
 * three routes these functions sit behind — request shapes, response shapes,
 * and the reasoning. `http.ts` wires them. Read that file before changing
 * anything here; if it and this disagree, one of them is a bug.
 *
 * ============================================================================
 * MAIL LANDS IN A PERSONAL CONTEXT AND NOWHERE ELSE
 * ============================================================================
 *
 * Every route here resolves through `resolvePersonalContextForIngestion`, which
 * is the single definition of "a context that may receive mail" and refuses a
 * shared one. Nothing in this file re-derives that rule, and nothing here takes
 * a workspace id from a caller.
 *
 * The reasoning lives in `lib/ingestionStore.ts`. The short version: inbound
 * email is unauthenticated by nature, so writing into a space several people
 * read is a different risk from writing into your own — and reserved names are
 * a security control precisely because the apex decides who receives
 * `support@`.
 *
 * ============================================================================
 * EVERY "NO" IS THE SAME "NO"
 * ============================================================================
 *
 * `resolveForIngestion` answers `null` for **all** of: no such name, the name
 * is reserved or malformed, the name belongs to a shared context, the personal
 * context has since gained members, there is no policy row, storage is unbound
 * or unusable, and the caller is over its rate limit.
 *
 * That is not tidiness. `<name>@context.lc` is an address anyone on the
 * internet can send to, so a distinguishable answer would let a stranger
 * enumerate who has an account here one guess at a time from any mail client —
 * and distinguishing the shared case in particular would publish which names on
 * this domain are teams. It is the same property the control plane's
 * byte-identical `{"binding":null}` and the router's frozen link previews
 * exist for, and it would be silly to rebuild the oracle in the one component a
 * stranger can address without authenticating at all.
 *
 * The worker keeps its end of this: `infra/email-worker/src/index.ts` turns
 * every refusal into one frozen SMTP rejection string.
 *
 * ============================================================================
 * THE CALLER CANNOT NAME A CONTEXT
 * ============================================================================
 *
 * `resolveForIngestion` takes a **name** — the local part of the address a
 * sender wrote — and never an id. `openIngestionBinding` and `recordIngestion`
 * take only a ticket hash, and the workspace is read off the row the control
 * plane minted. There is no argument in this module that selects a workspace,
 * which is the surviving half of the gateway's two-proof rule: the caller does
 * not get to pick the tenant, it can only present something we issued.
 *
 * What does *not* survive is the second proof itself. Mail arrives with no user
 * token, so "a real person authorized this just now" cannot be established. The
 * residual risk is stated in full in the worker's contract; it is bounded by
 * personal contexts only, ingestion-enabled owners only, the rate limit below,
 * and a ticket that expires in minutes and is single-use.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { TOKEN_HASH_PATTERN } from "./lib/crypto";
import { DEFAULT_TARGET_FOLDER, INGESTION_DOMAIN } from "./lib/ingestion";
import {
  getIngestionSettingsRow,
  resolvePersonalContextForIngestion,
} from "./lib/ingestionStore";
import { RESERVED_NAMES, normalizeName, validateName } from "./lib/names";
import { consumeRateLimit } from "./lib/rateLimit";

/**
 * How long a ticket is good for.
 *
 * Minutes, not hours. A ticket is a credential-fetch capability with no human
 * behind it, and the worker spends it within one SMTP transaction — the only
 * reason it is not seconds is that a large message still has to be drained and
 * parsed between the mint and the spend.
 */
const TICKET_TTL_MS = 5 * 60 * 1000;

/**
 * How often one name may be resolved.
 *
 * Keyed on the **recipient**, not the sender: the envelope-from is attacker-
 * chosen and rate-limiting on it protects nothing. The recipient is the thing
 * being probed, so limiting per name is what actually bounds the enumeration
 * oracle and the per-person credential path.
 *
 * The cost, stated honestly: someone who floods `seyi@context.lc` can stop
 * Seyi's real mail being captured for the rest of the window. That is a
 * denial of service on one person's ingestion, and it is the right trade —
 * the alternative is an unbounded oracle for everyone. It is generous enough
 * that ordinary forwarding never reaches it.
 */
const RESOLVE_LIMIT = 60;
const RESOLVE_WINDOW_MS = 60 * 60 * 1000;

/** A ceiling on what a policy may ask the worker to read. Matches its own. */
const MAX_MESSAGE_BYTES = 5_000_000;

/**
 * What resolve answers with, minus the ticket.
 *
 * The ticket is minted in the HTTP route, because hashing needs the action
 * runtime — the same reason `approveAuthorization` is an action. The route
 * generates the plaintext, hands us the digest, and returns the plaintext to
 * the worker; the plaintext never exists on this side of the call.
 */
const resolutionValidator = v.object({
  context: v.object({
    kind: v.literal("personal"),
    path: v.string(),
  }),
  targetFolder: v.string(),
  attachmentPolicy: v.string(),
  maxMessageBytes: v.number(),
  policy: v.object({
    allowedSenders: v.array(v.string()),
    allowedDomains: v.array(v.string()),
    allowAnySender: v.boolean(),
  }),
});

/**
 * Resolve a recipient name to the personal context that may receive its mail,
 * and mint a ticket bound to it.
 *
 * The reserved-name check is not a formality and not a duplicate of the
 * worker's. Ingestion is on the apex, so a name in `RESERVED_NAMES` is a
 * mail-interception control (CLAUDE.md, "Ingestion is on the apex"): if
 * `support` were ever claimable, whoever held it would receive mail sent to
 * `support@context.lc`. `validateName` already refuses every reserved name, and
 * the explicit `RESERVED_NAMES.has` after it is a deliberate redundancy against
 * a reordering of that function's checks — the same pair, for the same reason,
 * as `classifyRecipient` in the worker. Neither side may rely on the other
 * having done it: the worker is a separate deployment that a self-hoster can
 * replace.
 */
export const resolveForIngestion = internalMutation({
  args: {
    /** The local part a sender wrote. Attacker-controlled; normalized here. */
    name: v.string(),
    /** SHA-256 of the ticket the route minted. Never the plaintext. */
    hashedTicket: v.string(),
    /** The SMTP-reported message size. Accounting and logging only. */
    sizeBytes: v.number(),
  },
  returns: v.union(resolutionValidator, v.null()),
  handler: async (ctx, args) => {
    if (!TOKEN_HASH_PATTERN.test(args.hashedTicket)) return null;

    const normalized = normalizeName(args.name);
    const validation = validateName(normalized);
    if (!validation.ok) return null;
    // Deliberate redundancy. See the docstring: `validateName` already refuses
    // these, and this line changes no behaviour today — it is here because the
    // check it duplicates is a mail-interception control whose failure mode is
    // silent.
    if (RESERVED_NAMES.has(validation.normalized)) return null;

    // Before any lookup, so a rate-limited caller cannot tell a real name from
    // an invented one by how long the answer took or whether it was counted.
    try {
      await consumeRateLimit(ctx, {
        key: `ingest.resolve:${validation.normalized}`,
        limit: RESOLVE_LIMIT,
        windowMs: RESOLVE_WINDOW_MS,
      });
    } catch {
      // `RATE_LIMITED` folds into the same `null` as everything else. A
      // distinguishable answer here would tell a prober that it had found
      // something worth probing.
      return null;
    }

    const personal = await resolvePersonalContextForIngestion(
      ctx,
      validation.normalized,
    );
    if (personal === null) return null;

    const settings = await getIngestionSettingsRow(ctx, personal.workspace._id);
    // No row is the fail-closed floor: it accepts nothing, so there is no point
    // minting a ticket or opening a credential for it.
    if (settings === null) return null;

    // Storage has to be usable before a ticket exists, so a message that could
    // never have been written causes no ticket row and no later decrypt. Only
    // the row's existence and status are read here — never its secret. This
    // function is not decrypt-capable and must not become so.
    const binding = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", personal.workspace._id))
      .unique();
    if (binding === null || binding.status !== "connected") return null;

    const now = Date.now();
    await ctx.db.insert("ingestionTickets", {
      hashedTicket: args.hashedTicket,
      workspaceId: personal.workspace._id,
      sizeBytes: args.sizeBytes,
      createdAt: now,
      expiresAt: now + TICKET_TTL_MS,
    });

    return {
      // The redundant half of the argument. The worker re-checks that `kind` is
      // `"personal"` and that `path` is the name it asked about, so a control
      // plane that answered wrongly is caught on the other side too.
      context: { kind: "personal" as const, path: personal.workspace.slug },
      targetFolder: settings.targetFolder || DEFAULT_TARGET_FOLDER,
      // Attachments are listed, not stored. Storing bytes a stranger chose,
      // into a bucket we do not own, is a separate decision with a separate
      // quota conversation; listing them tells the owner what arrived without
      // writing any of it.
      attachmentPolicy: "list",
      maxMessageBytes: MAX_MESSAGE_BYTES,
      policy: {
        allowedSenders: settings.allowedSenders,
        allowedDomains: settings.allowedDomains,
        allowAnySender: settings.allowAnySender,
      },
    };
  },
});

/**
 * Spend a ticket: mark it used and say which context it was bound to.
 *
 * Separate from the action below because the check and the stamp have to be one
 * transaction. Two concurrent presentations of the same ticket both read the
 * same row, so the loser conflicts and re-runs, sees `bindingIssuedAt` set, and
 * gets `null`. Doing this in the action — read, then write — would let both
 * through.
 */
export const spendIngestionTicket = internalMutation({
  args: { hashedTicket: v.string() },
  returns: v.union(v.id("workspaces"), v.null()),
  handler: async (ctx, args) => {
    if (!TOKEN_HASH_PATTERN.test(args.hashedTicket)) return null;

    const ticket = await ctx.db
      .query("ingestionTickets")
      .withIndex("by_hashed_ticket", (q) => q.eq("hashedTicket", args.hashedTicket))
      .unique();
    if (ticket === null) return null;
    // Expiry is enforced on read, not by a sweep. A row nobody has swept is
    // still dead.
    if (ticket.expiresAt <= Date.now()) return null;
    if (ticket.bindingIssuedAt !== undefined) return null;

    await ctx.db.patch(ticket._id, { bindingIssuedAt: Date.now() });
    return ticket.workspaceId;
  },
});

/**
 * The credential, in exactly the shape `/gateway/binding` returns.
 *
 * Declared rather than inferred so the handler below can be annotated — see the
 * comment on it.
 */
interface IngestionBinding {
  workspaceId: Id<"workspaces">;
  provider: string;
  endpoint: string;
  region: string;
  bucket: string;
  rootPrefix?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  capabilities: { conditionalWrite: boolean };
  status: string;
}

/**
 * THE CREDENTIAL PATH FOR INBOUND MAIL.
 *
 * The workspace comes from the ticket row, which the control plane bound at
 * mint time to whatever `resolvePersonalContextForIngestion` answered. There is
 * no path in which anything the caller sent selects it — the ticket hash is
 * matched, never used as a key into workspaces.
 *
 * This is the ingest analogue of `openStorageBinding`, and it is decrypt-capable
 * for the same reason: the worker runs in another datacentre and signs S3
 * requests with the customer's own key, so the key has to travel. It is
 * enumerated in `__tests__/structure.test.ts` alongside the four other functions
 * that can reach a decrypt. Read that file's `CREDENTIAL_HTTP_ROUTES` comment
 * before adding anything else to that list.
 */
export const openIngestionBinding = internalAction({
  args: { hashedTicket: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      workspaceId: v.id("workspaces"),
      provider: v.string(),
      endpoint: v.string(),
      region: v.string(),
      bucket: v.string(),
      rootPrefix: v.optional(v.string()),
      accessKeyId: v.string(),
      secretAccessKey: v.string(),
      forcePathStyle: v.optional(v.boolean()),
      capabilities: v.object({ conditionalWrite: v.boolean() }),
      status: v.string(),
    }),
  ),
  // Annotated, not inferred: this handler references its own module through
  // `internal.functions.ingestionGateway.…`, which is an inference cycle. Left
  // to infer, TypeScript gives up here and — worse — the degradation shows up
  // as unrelated `implicitly any` errors in files that merely touch `api`.
  handler: async (ctx, args): Promise<IngestionBinding | null> => {
    const workspaceId: Id<"workspaces"> | null = await ctx.runMutation(
      internal.functions.ingestionGateway.spendIngestionTicket,
      { hashedTicket: args.hashedTicket },
    );
    if (workspaceId === null) return null;

    let credential;
    try {
      credential = await ctx.runAction(
        internal.functions.storage.getBindingForGateway,
        { workspaceId },
      );
    } catch {
      // `CREDENTIAL_UNAVAILABLE` and anything else alike. The operator sees it
      // in the deployment's own logs; the worker sees "no binding", because an
      // error here would distinguish "bound but unopenable" from "not bound"
      // for anyone holding the worker secret.
      return null;
    }
    if (credential === null) return null;
    if (credential.status !== "connected") return null;

    return {
      workspaceId,
      provider: credential.provider,
      endpoint: credential.endpoint,
      region: credential.region,
      bucket: credential.bucket,
      rootPrefix: credential.rootPrefix,
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      forcePathStyle: credential.forcePathStyle,
      capabilities: credential.capabilities,
      // The contract's vocabulary, not the row's — same translation
      // `openStorageBinding` does.
      status: "active",
    };
  },
});

/**
 * Accounting, after the note is already written.
 *
 * Best-effort by construction: the worker calls this last and swallows any
 * failure, because turning a bookkeeping error into an SMTP refusal would tell
 * the sender their message failed when it did not.
 *
 * What it records is an audit row, and what that row carries is deliberately
 * thin: no subject, no body, no sender, no filename. The owner needs to be able
 * to see *that* a capture landed and when; everything about *what* it said is
 * in the note itself, which is theirs. `actorUserId` is left unset — no person
 * acted, and naming the owner as the actor for mail somebody else sent them
 * would be a lie in an append-only trail.
 */
export const recordIngestion = internalMutation({
  args: {
    hashedTicket: v.string(),
    outcome: v.union(v.literal("captured"), v.literal("duplicate")),
    bytes: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!TOKEN_HASH_PATTERN.test(args.hashedTicket)) return false;

    const ticket = await ctx.db
      .query("ingestionTickets")
      .withIndex("by_hashed_ticket", (q) => q.eq("hashedTicket", args.hashedTicket))
      .unique();
    if (ticket === null) return false;
    if (ticket.expiresAt <= Date.now()) return false;
    if (ticket.recordedAt !== undefined) return false;

    await ctx.db.patch(ticket._id, { recordedAt: Date.now() });
    await recordAudit(ctx, {
      workspaceId: ticket.workspaceId,
      action: "ingestion.captured",
      details: {
        outcome: args.outcome,
        bytes: args.bytes,
        source: "email",
        domain: INGESTION_DOMAIN,
      },
    });
    return true;
  },
});
