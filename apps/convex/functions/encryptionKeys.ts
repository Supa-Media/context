/**
 * The workspace data key: the key that opens a context's encrypted notes.
 *
 * The design and everything it costs is `docs/decisions/encryption.md`. What
 * this file owns is the smallest possible piece of it: one key per workspace,
 * sealed at rest with the control plane's existing envelope scheme, opened for
 * the gateway on the same route and behind the same two proofs as a bucket
 * credential, and never reachable from anything a client can call.
 *
 * ## It is a second row in a scheme that already exists, not a second scheme
 *
 * `functions/lib/crypto.ts` already seals a customer's bucket secret:
 * AES-256-GCM, a fresh IV per record, the workspace id bound in as AAD, a key
 * id in the envelope so `STORAGE_SECRET_ENCRYPTION_KEY` can be rotated. Every
 * one of those properties is exactly what a workspace data key needs, and every
 * one of them has been argued through and tested. Inventing a second envelope
 * here would mean a second rotation story, a second AAD convention, and a
 * second place for `structure.test.ts` to have to learn about a credential.
 *
 * So: `encryptSecret(material, requireKeyset(), { workspaceId })`, and the
 * `rekeyStorageBindings` pass moves these rows forward with the bindings —
 * which it does because `functions/storage.ts` walks `workspaceDataKeys`
 * explicitly. Sealing a row with a scheme that carries a key id is only half of
 * surviving a rotation; the other half is being *in the pass that retires the
 * old one*, and an envelope that is not is destroyed at step 4 of the operator
 * sequence rather than at step 1.
 *
 * ## The key belongs to the workspace, not to the binding
 *
 * Its own table, not a column on `storageBindings`, and that is load-bearing
 * rather than tidy. A customer who rebinds storage — a new bucket, a new
 * provider, a reconnected Dropbox — replaces their binding row. If the key
 * lived on it, **every note they had already encrypted would become
 * undecryptable at the moment they moved their bucket**, silently, in a flow
 * whose whole purpose is that the notes come with them. `CLAUDE.md` says a
 * storage binding belongs to a `workspaceId` rather than a `userId`; this says
 * the same thing one level further in — the key that opens a context's notes
 * outlives the storage those notes happen to sit in.
 *
 * ## Generated on first use, and never a second time
 *
 * `openWorkspaceDataKey` is get-or-create. The create half is the dangerous
 * one: a code path that mints a *second* key for a workspace that already has
 * one makes every existing encrypted note in that bucket unreadable, and it
 * would look exactly like a fix for "the key was missing". Two things stop it —
 * the insert re-reads under the mutation's own transaction and returns the
 * existing row rather than writing, so a race between two requests resolves to
 * one key; and there is no path in this file, or anywhere, that writes
 * *different material* into `encryptedDataKey`. The single write to that column
 * lives in `functions/storage.ts` and re-seals the same material under a new
 * envelope key, conditional on the bytes it read. **Workspace-key** rotation,
 * when it is built, re-wraps notes' recipients and writes a new *generation*;
 * it does not overwrite this column in place either.
 *
 * ## What may not happen here
 *
 * No `query`, no `mutation`, no `action` — every export is `internal*`, so
 * nothing holding a session token or an OAuth grant can route to one.
 * `__tests__/structure.test.ts` enforces that structurally: it walks the call
 * graph and fails if any public function can transitively reach
 * `decryptSecret`, and `dataKey` is in its forbidden-return-field list so a
 * public function that returned one by name fails the suite rather than merely
 * being a bad idea.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action, internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { decryptSecret, encryptSecret, requireKeyset } from "./lib/crypto";
import { consumeRateLimit } from "./lib/rateLimit";
import { requireWorkspaceRole } from "./lib/workspaceAuth";

/**
 * The generation a freshly created key is written at.
 *
 * It appears in the note's own frontmatter as `context_encryption_key: ws:k1`
 * and in each envelope recipient's `id`, which is what makes a future rotation
 * a resumable re-wrap — a `list` finds what is still on the old generation —
 * rather than a re-encrypt of every note in somebody's bucket.
 *
 * There is deliberately no code here that advances it. A generation bump
 * without the re-wrap pass that goes with it would strand every note written
 * under the old one.
 */
export const INITIAL_KEY_GENERATION = "k1";

/** The rolling window `authorizeEncryptionExport`'s rate limit counts against. */
const ENCRYPTION_EXPORT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Exports allowed per workspace per window. See `authorizeEncryptionExport`. */
const ENCRYPTION_EXPORT_LIMIT = 5;

/** Base64 AES-256, generated with Web Crypto. Never stored or logged in this form. */
function generateKeyMaterial(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The sealed row, as a query returns it. */
export interface SealedDataKey {
  generation: string;
  encryptedDataKey: string;
  /** Absent on the workspace's current generation. See `schema.ts`. */
  retiredAt?: number;
}

/**
 * What the gateway is handed: every live generation's material, and which one
 * is current.
 *
 * `keys` carries **every** row for the workspace, retired ones included — a
 * bucket can hold notes from before the most recent rotation, and a gateway
 * that could only open the current generation would find those notes locked
 * the moment a rotation started. `current` is separate so `encryptNote` knows
 * which one a freshly-written note should use.
 */
export interface OpenedDataKeys {
  current: string;
  /** generation -> material. Radioactive: decrypt with it, never log it, never cache it past the request. */
  keys: Record<string, string>;
}

/** One entry in a key export, matching `renderKeyExport`'s input shape in `apps/mcp/src/encryption.js`. */
export interface ExportedDataKey {
  generation: string;
  /** Radioactive, and the entire point of an export: this leaves the control plane in the clear. */
  material: string;
}

/** All the rows a workspace has, live and retired, oldest first. */
export const listDataKeyRows = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(
    v.object({
      generation: v.string(),
      encryptedDataKey: v.string(),
      retiredAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("workspaceDataKeys")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    return rows
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((row) => ({
        generation: row.generation,
        encryptedDataKey: row.encryptedDataKey,
        retiredAt: row.retiredAt,
      }));
  },
});

/**
 * Write the first key for a workspace, or return the one that is already there.
 *
 * **The re-read inside the mutation is the whole safety property.** Two
 * concurrent first requests both find no row in their own read-only queries and
 * both call this; Convex serialises the mutations, so the second sees the first
 * one's row and returns it instead of inserting a second key. Without that,
 * whichever request lost would have encrypted a note under a key the next read
 * cannot find.
 */
export const insertDataKeyIfAbsent = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    generation: v.string(),
    encryptedDataKey: v.string(),
  },
  returns: v.object({ generation: v.string(), encryptedDataKey: v.string() }),
  handler: async (ctx, args) => {
    // `.collect()`, not `.unique()`: a workspace that has since rotated has
    // more than one row, and this path is reached only when the caller's own
    // read-only query found none — a race with a rotation, not with a second
    // "no key yet" request, but the query must not throw either way.
    const existing = await ctx.db
      .query("workspaceDataKeys")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    const current = existing.find((row) => row.retiredAt === undefined) ?? existing[0];
    if (current !== undefined) {
      return {
        generation: current.generation,
        encryptedDataKey: current.encryptedDataKey,
      };
    }
    await ctx.db.insert("workspaceDataKeys", {
      workspaceId: args.workspaceId,
      generation: args.generation,
      encryptedDataKey: args.encryptedDataKey,
      createdAt: Date.now(),
    });
    return { generation: args.generation, encryptedDataKey: args.encryptedDataKey };
  },
});

/**
 * Every row for a workspace, creating the first one on demand, unopened.
 *
 * The shared read half of `openWorkspaceDataKey` and `exportWorkspaceDataKeys`
 * — both need "every row, and which one is current", and only differ in what
 * they do with the decrypted material afterwards. Kept out of either export so
 * neither is tempted to skip the creation path the other needs.
 */
async function listOrCreateDataKeyRows(
  ctx: { runQuery: any; runMutation: any },
  workspaceId: Id<"workspaces">,
  create: boolean,
): Promise<SealedDataKey[]> {
  const rows: SealedDataKey[] = await ctx.runQuery(
    internal.functions.encryptionKeys.listDataKeyRows,
    { workspaceId },
  );
  if (rows.length > 0) return rows;
  if (!create) return [];

  const material = generateKeyMaterial();
  const encryptedDataKey = await encryptSecret(material, requireKeyset(), { workspaceId });
  // Racing callers converge here: the mutation returns whatever row exists
  // after it runs, which is this one or the one that beat it.
  const sealed = await ctx.runMutation(internal.functions.encryptionKeys.insertDataKeyIfAbsent, {
    workspaceId,
    generation: INITIAL_KEY_GENERATION,
    encryptedDataKey,
  });
  return [sealed];
}

/** The current (non-retired) row among a workspace's rows, or the newest if that invariant ever slips. */
function currentOf(rows: SealedDataKey[]): SealedDataKey | undefined {
  return rows.find((row) => row.retiredAt === undefined) ?? rows[rows.length - 1];
}

/**
 * Open every generation of the workspace's data key for the gateway, creating
 * the first one on first use.
 *
 * INTERNAL ACTION. The caller is `openStorageBinding`, which has already spent
 * both proofs — the gateway secret at the door and the end user's access token
 * resolved to a live grant — and which passes the workspace id **it read off
 * the resolved row**, never one a caller named. The AAD is that same id, so an
 * id-confusion bug upstream is a decrypt failure rather than another
 * workspace's key.
 *
 * `create: false` is for callers that must not bring a key into existence as a
 * side effect of asking. Reading a context that has never encrypted anything
 * should not write a row to it, and a caller that wants to know whether one
 * exists must not be the thing that makes it exist.
 *
 * Every live row is decrypted and returned, not only the current one — a
 * bucket can hold notes from before the workspace's most recent rotation, and
 * this is the one place that can hand the gateway what opens them. See
 * `OpenedDataKeys`.
 */
export const openWorkspaceDataKey = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    create: v.optional(v.boolean()),
  },
  returns: v.union(
    v.null(),
    v.object({ current: v.string(), keys: v.record(v.string(), v.string()) }),
  ),
  handler: async (ctx, args): Promise<OpenedDataKeys | null> => {
    const workspaceId: Id<"workspaces"> = args.workspaceId;
    const rows = await listOrCreateDataKeyRows(ctx, workspaceId, args.create === true);
    if (rows.length === 0) return null;
    const current = currentOf(rows);
    if (current === undefined) return null;

    const keys: Record<string, string> = {};
    for (const row of rows) {
      keys[row.generation] = await decryptSecret(row.encryptedDataKey, requireKeyset(), {
        workspaceId,
      });
    }
    return { current: current.generation, keys };
  },
});

/**
 * THE ACTUAL DISCLOSURE. Every generation's key material, in the clear, for
 * `export_encryption_keys` and the console's export action.
 *
 * CREDENTIAL BARRIER — see `CREDENTIAL_BARRIERS` in `__tests__/structure.test.ts`
 * before changing this function's shape. It is public code's *only* path to a
 * workspace data key's plaintext, and it does exactly one thing with it: opens
 * every row and hands the material back. It performs no authorization of its
 * own — that is `authorizeEncryptionExport`'s job, in a mutation that commits
 * the rate limit and the audit row before this ever runs — because a barrier
 * that also decided who may call it would be two things to get right instead
 * of one.
 *
 * `null` where the workspace has never encrypted a note: exporting is a
 * "there is nothing here to protect you from losing" answer, not a refusal,
 * for a context that has no key at all.
 */
/** What both `exportWorkspaceDataKeys` and `exportEncryptionKeys` return. */
export interface DataKeyExport {
  current: string;
  keys: ExportedDataKey[];
}

export const exportWorkspaceDataKeys = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.null(),
    v.object({
      current: v.string(),
      keys: v.array(v.object({ generation: v.string(), material: v.string() })),
    }),
  ),
  // Explicit return type: this file's own functions reference each other
  // through `internal.functions.encryptionKeys.*`, which resolves through this
  // module's own inferred types — an unannotated handler here is a circular
  // inference TypeScript cannot break on its own.
  handler: async (ctx, args): Promise<DataKeyExport | null> => {
    const workspaceId: Id<"workspaces"> = args.workspaceId;
    const rows = await listOrCreateDataKeyRows(ctx, workspaceId, false);
    if (rows.length === 0) return null;
    const current = currentOf(rows);
    if (current === undefined) return null;

    const keys: ExportedDataKey[] = [];
    for (const row of rows) {
      const material = await decryptSecret(row.encryptedDataKey, requireKeyset(), {
        workspaceId,
      });
      keys.push({ generation: row.generation, material });
    }
    return { current: current.generation, keys };
  },
});

/**
 * Authorize one export: owner role, rate limit, audit row — all three or
 * none, in one transaction, so a rate-limited or unauthorized attempt never
 * shows up in the audit trail as a successful one and a successful one is
 * never left unrecorded by a later failure.
 *
 * Five exports per rolling day. Generous enough that an owner rotating through
 * a real recovery workflow — export, verify, store somewhere safe — is never
 * the one it stops, and tight enough that a compromised session cannot harvest
 * the key by retrying.
 */
export const authorizeEncryptionExport = internalMutation({
  args: { workspaceId: v.id("workspaces"), userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireWorkspaceRole(ctx, args.workspaceId, args.userId, "owner");
    await consumeRateLimit(ctx, {
      key: `encryption.export:${args.workspaceId}`,
      limit: ENCRYPTION_EXPORT_LIMIT,
      windowMs: ENCRYPTION_EXPORT_WINDOW_MS,
    });
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.userId,
      action: "encryption.export",
    });
    return null;
  },
});

/**
 * THE CONSOLE'S EXPORT ACTION. Public, session-authenticated, and reaches a
 * credential's plaintext only by calling the barrier above — which is what
 * keeps this function itself off the credential-reachability graph's public
 * side (`__tests__/structure.test.ts`, "the credential barrier is a pin, not
 * an amnesty").
 *
 * `docs/decisions/encryption.md`'s "Revocation and export" section is the
 * product argument for why this exists at all: the first non-negotiable is
 * only true if the customer can get the key, not only decrypt with it through
 * us.
 */
export const exportEncryptionKeys = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.null(),
    v.object({
      current: v.string(),
      keys: v.array(v.object({ generation: v.string(), material: v.string() })),
    }),
  ),
  handler: async (ctx, args): Promise<DataKeyExport | null> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Sign in required" });
    }
    await ctx.runMutation(internal.functions.encryptionKeys.authorizeEncryptionExport, {
      workspaceId: args.workspaceId,
      userId,
    });
    return await ctx.runAction(internal.functions.encryptionKeys.exportWorkspaceDataKeys, {
      workspaceId: args.workspaceId,
    });
  },
});

/* -------------------------------- rotation -------------------------------- */

/**
 * The generation label that follows `current`. `k1` -> `k2`, `k9` -> `k10`.
 *
 * Every generation this codebase has ever minted matches `k<digits>`
 * (`INITIAL_KEY_GENERATION`, and every one this function produces), so the
 * fallback below is defensive rather than a real path: it only fires for a
 * generation minted by hand outside that scheme, and it still produces a
 * fresh, valid, previously-unused-looking id rather than failing a rotation
 * outright.
 */
function nextGeneration(current: string): string {
  const match = /^([A-Za-z_-]*?)(\d+)$/.exec(current);
  if (match === null) return `${current}-2`;
  const [, prefix, digits] = match;
  return `${prefix}${Number(digits) + 1}`;
}

/** The rotation in progress for a workspace, or `null`. */
export const getActiveWorkspaceKeyRotation = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.null(),
    v.object({ fromGeneration: v.string(), toGeneration: v.string(), startedAt: v.number() }),
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("workspaceKeyRotations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    const active = rows.find((row) => row.status === "in_progress");
    if (active === undefined) return null;
    return {
      fromGeneration: active.fromGeneration,
      toGeneration: active.toGeneration,
      startedAt: active.startedAt,
    };
  },
});

/**
 * Mint the next generation and mark the current one retired — or, if a
 * rotation is already under way, hand back the one already in progress rather
 * than minting a second.
 *
 * **The re-read inside the mutation is the whole safety property**, the same
 * shape `insertDataKeyIfAbsent` already relies on for a workspace's first key.
 * Two concurrent callers both see no active rotation in their own read-only
 * queries and both reach the mutation; Convex serializes mutations, so the
 * second sees the first one's rotation row and returns it instead of minting
 * a third generation. Without that, a workspace could end up with some notes
 * re-wrapped toward `k2` and others toward a `k3` nobody's walk was ever told
 * to look for.
 *
 * `null` where the workspace has no key to rotate — a context that has never
 * encrypted a note has nothing here to protect either.
 */
/** What a rotation start (or an already-in-progress one) reports. */
export interface KeyRotationTarget {
  fromGeneration: string;
  toGeneration: string;
}

export const startWorkspaceKeyRotation = internalAction({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.null(),
    v.object({ fromGeneration: v.string(), toGeneration: v.string() }),
  ),
  // See the comment on `exportWorkspaceDataKeys`'s handler: this file's
  // internal cross-references need an explicit return type to type-check.
  handler: async (ctx, args): Promise<KeyRotationTarget | null> => {
    const workspaceId: Id<"workspaces"> = args.workspaceId;
    const rows = await listOrCreateDataKeyRows(ctx, workspaceId, false);
    const current = currentOf(rows);
    if (current === undefined) return null;

    const toGeneration = nextGeneration(current.generation);
    const material = generateKeyMaterial();
    const encryptedDataKey = await encryptSecret(material, requireKeyset(), { workspaceId });

    return await ctx.runMutation(internal.functions.encryptionKeys.applyStartWorkspaceKeyRotation, {
      workspaceId,
      fromGeneration: current.generation,
      toGeneration,
      encryptedDataKey,
    });
  },
});

/**
 * The mutation half of `startWorkspaceKeyRotation` — see that function for
 * the race it closes. Never call this directly with material a caller chose;
 * `encryptedDataKey` must be freshly minted, random material, exactly once,
 * by the action above.
 */
export const applyStartWorkspaceKeyRotation = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    fromGeneration: v.string(),
    toGeneration: v.string(),
    encryptedDataKey: v.string(),
  },
  returns: v.object({ fromGeneration: v.string(), toGeneration: v.string() }),
  handler: async (ctx, args) => {
    const activeRows = await ctx.db
      .query("workspaceKeyRotations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    const active = activeRows.find((row) => row.status === "in_progress");
    if (active !== undefined) {
      // Somebody already started one — return theirs, mint nothing.
      return { fromGeneration: active.fromGeneration, toGeneration: active.toGeneration };
    }

    const dataKeyRows = await ctx.db
      .query("workspaceDataKeys")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    const current = dataKeyRows.find((row) => row.retiredAt === undefined);
    if (current === undefined || current.generation !== args.fromGeneration) {
      // The workspace's current generation moved between the read above and
      // this transaction — another rotation already ran to completion, or the
      // workspace never had a key at all. Either way, minting on top of a
      // generation that is no longer current would strand this fresh key with
      // nothing that ever names it.
      throw new ConvexError({
        code: "ROTATION_STALE",
        message: "the workspace's key changed before this rotation could start",
      });
    }

    const now = Date.now();
    await ctx.db.patch(current._id, { retiredAt: now });
    await ctx.db.insert("workspaceDataKeys", {
      workspaceId: args.workspaceId,
      generation: args.toGeneration,
      encryptedDataKey: args.encryptedDataKey,
      createdAt: now,
    });
    await ctx.db.insert("workspaceKeyRotations", {
      workspaceId: args.workspaceId,
      fromGeneration: args.fromGeneration,
      toGeneration: args.toGeneration,
      status: "in_progress",
      startedAt: now,
    });
    return { fromGeneration: args.fromGeneration, toGeneration: args.toGeneration };
  },
});

/**
 * Mark a rotation done, so a future one may start.
 *
 * Called by the gateway once its bucket-side walk finds nothing left on
 * `fromGeneration`. Conditional on `toGeneration` matching the active
 * rotation's own, so a stale or duplicate completion call — a retried
 * request, a second gateway instance finishing the same walk — cannot mark
 * the *next* rotation done by naming an old target. Idempotent: completing an
 * already-done (or never-started) rotation is a no-op, not an error, because
 * the gateway's walk cannot always tell which of those it is racing.
 */
export const completeWorkspaceKeyRotation = internalMutation({
  args: { workspaceId: v.id("workspaces"), toGeneration: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("workspaceKeyRotations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();
    const active = rows.find((row) => row.status === "in_progress");
    if (active === undefined || active.toGeneration !== args.toGeneration) return false;
    await ctx.db.patch(active._id, { status: "done", completedAt: Date.now() });
    return true;
  },
});
