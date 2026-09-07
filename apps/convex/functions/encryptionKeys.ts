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

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { decryptSecret, encryptSecret, requireKeyset } from "./lib/crypto";

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

/** Base64 AES-256, generated with Web Crypto. Never stored or logged in this form. */
function generateKeyMaterial(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The sealed row, as the query returns it. */
export interface SealedDataKey {
  generation: string;
  encryptedDataKey: string;
}

/** What the gateway is handed: one generation, and the material that opens it. */
export interface OpenedDataKey {
  generation: string;
  /** Radioactive. Decrypt with it, never log it, never cache it past the request. */
  dataKey: string;
}

export const getDataKeyRow = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(
    v.null(),
    v.object({ generation: v.string(), encryptedDataKey: v.string() }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("workspaceDataKeys")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (row === null) return null;
    return { generation: row.generation, encryptedDataKey: row.encryptedDataKey };
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
    const existing = await ctx.db
      .query("workspaceDataKeys")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .unique();
    if (existing !== null) {
      return {
        generation: existing.generation,
        encryptedDataKey: existing.encryptedDataKey,
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
 * Open the workspace's data key for the gateway, creating it on first use.
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
 */
export const openWorkspaceDataKey = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    create: v.optional(v.boolean()),
  },
  returns: v.union(
    v.null(),
    v.object({ generation: v.string(), dataKey: v.string() }),
  ),
  handler: async (ctx, args): Promise<OpenedDataKey | null> => {
    const workspaceId: Id<"workspaces"> = args.workspaceId;
    const existing: SealedDataKey | null = await ctx.runQuery(
      internal.functions.encryptionKeys.getDataKeyRow,
      { workspaceId },
    );

    let sealed: SealedDataKey;
    if (existing !== null) {
      sealed = existing;
    } else {
      if (args.create !== true) return null;
      const material = generateKeyMaterial();
      const encryptedDataKey = await encryptSecret(material, requireKeyset(), {
        workspaceId,
      });
      // Racing callers converge here: the mutation returns whatever row exists
      // after it runs, which is this one or the one that beat it.
      sealed = await ctx.runMutation(
        internal.functions.encryptionKeys.insertDataKeyIfAbsent,
        { workspaceId, generation: INITIAL_KEY_GENERATION, encryptedDataKey },
      );
    }

    const dataKey = await decryptSecret(sealed.encryptedDataKey, requireKeyset(), {
      workspaceId,
    });
    return { generation: sealed.generation, dataKey };
  },
});
