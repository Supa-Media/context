import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { recordAudit } from "./lib/audit";
import { decryptSecret, encryptSecret, hashToken, requireKeyset } from "./lib/crypto";
import { requireWorkspaceAccess, requireWorkspaceRole } from "./lib/workspaceAuth";

/**
 * The model account the agent spends, stored the way a storage credential is.
 *
 * The customer connects their own Anthropic or OpenAI key — their bill, no
 * markup, nothing new that a cancellation could strand — and non-negotiable #1
 * then governs it word for word: encrypted at rest, never in Markdown, never
 * in the bucket, never in a log, never in a URL, never on a device.
 *
 * ## The rule this module is built around, and where it came from
 *
 * **A credential must not be reachable from a failure.** #661 is the reason
 * that sentence is first rather than implied. A fourth key was added to
 * `storageBindings.capabilities`; two routes in `controlPlane.ts` had restated
 * the capability shape inline; `v.object` is exact, so `openStorageBinding`'s
 * own `returns` validator refused the object it had just built. The outage was
 * the headline — every client told its storage was gone — but the quieter half
 * is that `s3BindingValidator` carries `secretAccessKey`, and a validation
 * error names what it rejected. A live R2 secret and a D1 token went into the
 * production logs, and no happy-path test could have seen it.
 *
 * So the shapes here are deliberately small and flat. `openProviderForGateway`
 * returns two fields and no nested object, because the drift that broke #661
 * happened inside a nested one. Every refusal below is written to name the
 * *provider* and never the key, and `providerCredentials.test.ts` drives each
 * of those paths and searches the thrown value, its message, its stack and its
 * own property values for the key it was given.
 *
 * ## What is not here
 *
 * **A customer-supplied base URL**, and that is this diff's own review finding
 * rather than an omission. An OpenAI-compatible endpoint needs one, and the
 * first draft took it as a plain string — which hands anyone who can write to
 * a *shared* workspace a way to point the gateway at a host of theirs and have
 * the owner's key delivered to it, plus the ordinary SSRF of a fetch aimed at
 * a loopback or link-local address. `storage.ts` already refuses exactly that
 * for a bucket endpoint (`assertUsableEndpoint`, `BLOCKED_HOST_PATTERNS`), and
 * those are private to that module. Reaching for them is a refactor of a
 * security surface that deserves its own tests, and the fetch this URL feeds
 * does not exist yet. So `compatible` waits for the phase that makes the
 * request, and the two providers here have fixed endpoints.
 *
 * Which provider answers a question. That is a fact about the agent, not about
 * a credential, and putting a `selected` column on this table would let two
 * rows both claim it.
 */

/** The providers this build knows how to spend. A closed set, not a string. */
export const PROVIDERS = ["anthropic", "openai"] as const;

export type Provider = (typeof PROVIDERS)[number];

const providerValidator = v.union(v.literal("anthropic"), v.literal("openai"));

/**
 * The longest key any of these providers issues, with room to spare.
 *
 * A bound rather than a format: matching `sk-ant-` here would refuse a key
 * whose prefix changed and produce a support ticket blaming us for somebody
 * else's rename. What is checked is what we can be sure of — that it is
 * present, that it is one token, and that it is not a paragraph somebody
 * pasted by accident.
 */
const MAX_KEY_LENGTH = 512;

/**
 * Whether this could be a key at all, said without ever quoting it.
 *
 * Every branch returns a code and a sentence about the *shape*. The tempting
 * line — "expected a key beginning with sk-, got <value>" — is #661 written by
 * hand, and `a refused key is refused without being quoted back` is the test
 * that it stays unwritten.
 */
function assertUsableKey(apiKey: string): void {
  if (apiKey.length === 0) {
    throw new ConvexError({
      code: "INVALID_PROVIDER_KEY",
      message: "A key is required.",
    });
  }
  if (apiKey.length > MAX_KEY_LENGTH) {
    throw new ConvexError({
      code: "INVALID_PROVIDER_KEY",
      message: "That is longer than any key these providers issue.",
    });
  }
  if (apiKey.trim() !== apiKey || /\s/.test(apiKey)) {
    throw new ConvexError({
      code: "INVALID_PROVIDER_KEY",
      message: "A key has no spaces or line breaks in it. Check what was pasted.",
    });
  }
}

/**
 * Eight hex of the key's SHA-256.
 *
 * A hash and not a prefix, which `appSecrets` already decided: "what appears
 * in a screenshot is not a fragment of the real value". It matters more here
 * than there, because this credential was issued by somebody else's console —
 * a leaked fragment is a clue to a secret we cannot rotate.
 *
 * Its job is support: two people comparing whether the key in the console is
 * the key in the vault, without either of them reading a key out loud.
 */
async function fingerprintOf(apiKey: string): Promise<string> {
  return (await hashToken(apiKey)).slice(0, 8);
}

export const connectProvider = action({
  args: {
    workspaceId: v.id("workspaces"),
    provider: v.string(),
    apiKey: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
    }

    /*
      Validated here rather than by the argument validator, so an unknown
      provider is a sentence somebody can act on instead of a schema error —
      and so that the refusal is written by us, holding the key, and can be
      tested for what it does not say.
    */
    if (!(PROVIDERS as readonly string[]).includes(args.provider)) {
      throw new ConvexError({
        code: "UNKNOWN_PROVIDER",
        message: `No provider called "${args.provider}".`,
      });
    }
    assertUsableKey(args.apiKey);

    await ctx.runQuery(internal.functions.providers.assertMayWrite, {
      workspaceId: args.workspaceId,
      userId,
    });

    /*
      Encrypted before it is stored and bound by AAD to this workspace, which
      is what makes a row lifted out of the table useless in another tenant.
      `an envelope does not open under another workspace` asserts it directly.
    */
    const encryptedApiKey = await encryptSecret(args.apiKey, requireKeyset(), {
      workspaceId: args.workspaceId,
    });
    const fingerprint = await fingerprintOf(args.apiKey);

    await ctx.runMutation(internal.functions.providers.writeCredential, {
      workspaceId: args.workspaceId,
      provider: args.provider as Provider,
      encryptedApiKey,
      fingerprint,
      connectedBy: userId,
    });

    return null;
  },
});

/**
 * The role check, as its own query so the action can run it before encrypting.
 *
 * Separate because an action cannot read the database, and doing the work
 * first and the check second would mean a refused caller had still spent a
 * key derivation — and, worse, had a plaintext key alive in a handler that was
 * about to throw.
 */
export const assertMayWrite = internalQuery({
  args: { workspaceId: v.id("workspaces"), userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireWorkspaceRole(ctx, args.workspaceId, args.userId, "editor");
    return null;
  },
});

export const writeCredential = internalMutation({
  args: {
    workspaceId: v.id("workspaces"),
    provider: providerValidator,
    encryptedApiKey: v.string(),
    fingerprint: v.string(),
    connectedBy: v.id("users"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("providerCredentials")
      .withIndex("by_workspace_provider", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("provider", args.provider),
      )
      .unique();

    const fields = {
      workspaceId: args.workspaceId,
      provider: args.provider,
      encryptedApiKey: args.encryptedApiKey,
      fingerprint: args.fingerprint,
      connectedBy: args.connectedBy,
      connectedAt: Date.now(),
    };

    // Replaced rather than appended: one provider, one credential. Two rows
    // for the same provider is a state nothing downstream could choose between.
    if (existing === null) await ctx.db.insert("providerCredentials", fields);
    else await ctx.db.patch(existing._id, fields);

    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: args.connectedBy,
      action: existing === null ? "agent.provider.connected" : "agent.provider.replaced",
      details: {
        provider: args.provider,
        // The fingerprint, never the key. `the audit trail records that it
        // happened, not what it was` is the test.
        fingerprint: args.fingerprint,
      },
    });

    return null;
  },
});

export const listProviders = query({
  args: { workspaceId: v.id("workspaces") },
  returns: v.array(
    v.object({
      provider: v.string(),
      fingerprint: v.string(),
      connectedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
    }
    await requireWorkspaceAccess(ctx, args.workspaceId, userId);

    const rows = await ctx.db
      .query("providerCredentials")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
      .collect();

    /*
      Built field by field rather than spread. A spread would carry
      `encryptedApiKey` out to every caller of a client-callable query the
      moment somebody added a field to the row, which is the same class of
      accident as #661: a shape that drifted while nobody was looking at the
      boundary it crossed.
    */
    return rows.map((row) => ({
      provider: row.provider,
      fingerprint: row.fingerprint,
      connectedAt: row.connectedAt,
    }));
  },
});

export const disconnectProvider = mutation({
  args: { workspaceId: v.id("workspaces"), provider: providerValidator },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
    }
    await requireWorkspaceRole(ctx, args.workspaceId, userId, "editor");

    const existing = await ctx.db
      .query("providerCredentials")
      .withIndex("by_workspace_provider", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("provider", args.provider),
      )
      .unique();
    if (existing === null) return null;

    await ctx.db.delete(existing._id);
    await recordAudit(ctx, {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      action: "agent.provider.disconnected",
      details: { provider: args.provider, fingerprint: existing.fingerprint },
    });

    return null;
  },
});

/**
 * The one function that answers with a key, and `/gateway/provider` is its
 * only caller.
 *
 * ## Why this shape is two flat fields
 *
 * #661 broke on a *nested* validator: `capabilities` drifted, `v.object`
 * refused the answer, and the error serialized the credential beside it. There
 * is nothing nested here to drift, and nothing beside the key that would be
 * worth printing — which is as close to "a validation error cannot leak this"
 * as a returns validator gets.
 *
 * It is also why the model key did not become a fifth sibling on
 * `/gateway/binding`, which is otherwise exactly where a new gateway-facing
 * credential goes (`searchIndex`, `encryptionKey` and `rotation` all did, to
 * avoid a new entry in `CREDENTIAL_HTTP_ROUTES`). Folding it in would put a
 * model key inside the same returns validator as `secretAccessKey`, so one
 * drift could spill both. A door with a two-field validator behind it is a
 * smaller blast radius than a sibling on a nine-field one, and the door spends
 * the identical two proofs.
 *
 * ## The two proofs, and where each is spent
 *
 * The gateway secret got the caller through `gatewayRoute` in `http.ts`. This
 * is where the *user's* proof is spent, and it is spent exactly as
 * `controlPlane.openStorageBinding` spends it: the presented token's hash
 * resolves to a live grant, the set of contexts that grant's person is a member
 * of *right now* comes back with it, and `expectedWorkspaceId` **selects within
 * that set and never outside it**.
 *
 * What goes downstream is `covered.workspaceId`, read off the resolved row.
 * There is no `ctx.db.get(args.expectedWorkspaceId)` and no index lookup keyed
 * by it, because an id used as a lookup key needs no membership at all —
 * `structure.test.ts` enforces that mechanically, and
 * `a token for one workspace cannot open another's credential` is the
 * behavioural half.
 *
 * ## No scope beyond a live grant, deliberately
 *
 * A token that opens this can already open the same workspace's *storage*
 * credential through `/gateway/binding` — the whole bucket, read and write. A
 * model key that bills the owner's own provider account is strictly less than
 * that, so a extra scope check here would be theatre rather than a bound. What
 * bounds it is what bounds the binding: the grant is live, it is revocable, and
 * the connection is named in the audit trail.
 *
 * ## Everything that is not a hit is `null`
 *
 * An unknown token, an expired one, a revoked one, a workspace outside the
 * set, a provider this build does not know, a provider nobody connected, and a
 * decrypt that fails are one answer. The caller must not be able to tell "not
 * yours" from "not connected" from "does not exist".
 */
export const openProviderForGateway = internalAction({
  args: {
    hashedAccessToken: v.string(),
    expectedWorkspaceId: v.union(v.string(), v.null()),
    /*
      A plain string, not `providerValidator`, and that is load-bearing. An
      argument validator refuses out of band — Convex throws before the handler
      runs and the route answers differently from every other refusal, which is
      an enumeration oracle for the provider set. Checked below instead, where
      the answer is the same `null` as everything else.
    */
    provider: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      provider: v.string(),
      apiKey: v.string(),
    }),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<{ provider: string; apiKey: string } | null> => {
    if (!(PROVIDERS as readonly string[]).includes(args.provider)) return null;
    const provider = args.provider as Provider;

    const session: {
      workspaceId: Id<"workspaces">;
      workspaces: Array<{ workspaceId: Id<"workspaces"> }>;
    } | null = await ctx.runQuery(
      internal.functions.controlPlane.resolveGrantByAccessToken,
      { hashedAccessToken: args.hashedAccessToken },
    );
    if (session === null) return null;

    const covered =
      args.expectedWorkspaceId === null
        ? session.workspaces.find((w) => w.workspaceId === session.workspaceId)
        : session.workspaces.find((w) => w.workspaceId === args.expectedWorkspaceId);
    if (covered === undefined) return null;

    const row = await ctx.runQuery(internal.functions.providers.credentialRow, {
      workspaceId: covered.workspaceId,
      provider,
    });
    if (row === null) return null;

    try {
      /*
        Opened under the row's own workspace, never the caller's argument. They
        are the same value on every real call; writing it this way means the AAD
        is derived from the thing that was stored rather than from the thing that
        was asked for, so a future caller that passes an id it should not have
        gets a decryption failure instead of a credential.
      */
      const apiKey = await decryptSecret(row.encryptedApiKey, requireKeyset(), {
        workspaceId: row.workspaceId,
      });
      return { provider: row.provider, apiKey };
    } catch {
      /*
        A missing keyset, a retired key generation, an envelope from another
        deployment. The operator sees it in this deployment's own logs; the
        gateway sees "not connected", because an error here would distinguish
        "connected but unopenable" from "not connected" for anyone holding the
        gateway secret and one valid token — and, worse, would be an error path
        with the ciphertext in scope, which is the #661 shape.
      */
      return null;
    }
  },
});

export const credentialRow = internalQuery({
  args: { workspaceId: v.id("workspaces"), provider: providerValidator },
  returns: v.union(
    v.null(),
    v.object({
      workspaceId: v.id("workspaces"),
      provider: v.string(),
      encryptedApiKey: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("providerCredentials")
      .withIndex("by_workspace_provider", (q) =>
        q.eq("workspaceId", args.workspaceId).eq("provider", args.provider),
      )
      .unique();
    if (row === null) return null;

    return {
      workspaceId: row.workspaceId,
      provider: row.provider,
      encryptedApiKey: row.encryptedApiKey,
    };
  },
});
