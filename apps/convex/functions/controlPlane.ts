/**
 * The gateway's half of the control plane.
 *
 * `apps/mcp/src/controlPlane.js` is the normative contract; `http.ts` is the
 * wire. This file is the part that touches the database, and everything in it
 * is `internal`: none of it is reachable from a client, from a session token,
 * or from a guessed function name. The only way in is an HTTP route that has
 * already proved it holds the gateway secret.
 *
 * ## The one rule this file exists to hold
 *
 * **The gateway does not get to name the workspace it wants.** Every
 * workspace-scoped answer here is derived from a grant that a presented user
 * token resolved to. `expectedWorkspaceId` appears exactly once, as an
 * equality check against a workspace already chosen by the grant, and it must
 * never become a lookup key. If it ever selects a row, a compromised gateway
 * can walk the customer list with one valid token, and the second proof stops
 * meaning anything.
 *
 * ## Presented tokens arrive verbatim and are hashed at the door
 *
 * Nothing in this file takes a raw token. `http.ts` hashes on arrival and
 * passes the digest down, so a token never reaches a database transaction, a
 * scheduled job, or a log line. The asymmetry is deliberate and it is what
 * makes a dump of `oauthGrants` inert: the stored value is a *digest of* the
 * credential, so replaying it as a token hashes to something else and matches
 * nothing.
 *
 * ## Every negative is the same negative
 *
 * Unknown token, expired token, revoked grant, removed member, deleted client,
 * unbound storage, storage that never verified, and a workspace the grant does
 * not name all return `null`. Distinguishing them would turn these routes into
 * an oracle for who is on the platform and which contexts exist.
 *
 * ## Where the rest of it lives
 *
 * Every function is still registered here, under the same name, kind and
 * validators. `openStorageBinding` and `openGatewayJob` stay here in full:
 * they call the functions that open a credential, and
 * `__tests__/structure.test.ts` reads each registered function's own text to
 * decide what it can reach. The grant resolution, OAuth, binding shapes and
 * job rows are in `./lib/controlPlane/`, which
 * `scripts/check-exit-is-ungated.mjs` scans alongside this file.
 */

import { audienceOfNames } from "./lib/pinnedReaders";
import { readsAsChat } from "./lib/nodes/chatFolders";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalQuery } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import type { Id } from "../_generated/dataModel";
import { D1_ACCOUNT_SECRET, D1_TOKEN_SECRET } from "./lib/d1";
import {
  isUsable,
  type BindingStatus,
  type GatewayEncryptionKey,
  type GatewayKeyRotation,
  type GatewayMeaningIndex,
  type GatewaySearchIndex,
  type OpenedGatewayBinding,
} from "./lib/controlPlane/bindingShapes";
import type { ClaimedGatewayJob, LeasedGatewayJob, OpenedGatewayJob } from "./lib/controlPlane/gatewayJobs";
import * as session from "./lib/controlPlane/session";
import * as authorization from "./lib/controlPlane/authorization";
import * as gatewayJobs from "./lib/controlPlane/gatewayJobs";
import * as validators from "./lib/controlPlane/validators";

export type {
  GatewayBinding,
  GatewayEncryptionKey,
  GatewayKeyRotation,
  GatewaySearchIndex,
  OpenedGatewayBinding,
  S3GatewayBinding,
} from "./lib/controlPlane/bindingShapes";

export const resolveLivePresenceGrants = internalQuery({
  args: session.resolveLivePresenceGrantsArgs,
  returns: session.resolveLivePresenceGrantsReturns,
  handler: session.resolveLivePresenceGrantsHandler,
});

export const resolveGrantByAccessToken = internalQuery({
  args: session.resolveGrantByAccessTokenArgs,
  returns: session.resolveGrantByAccessTokenReturns,
  handler: session.resolveGrantByAccessTokenHandler,
});

/**
 * `/gateway/session`'s read: the session, and whether its grant's "last used"
 * stamp is due. The stamp is written at most every `TOUCH_GRANT_EVERY_MS`, so
 * on almost every request there is nothing to write, and the route no longer
 * spends a mutation round trip learning that.
 */
export const resolveGatewaySession = internalQuery({
  args: session.resolveGrantByAccessTokenArgs,
  returns: v.object({ session: session.resolveGrantByAccessTokenReturns, touchDue: v.boolean() }),
  handler: session.resolveGatewaySessionHandler,
});

export const startAuthorization = internalMutation({
  args: authorization.startAuthorizationArgs,
  returns: authorization.startAuthorizationReturns,
  handler: authorization.startAuthorizationHandler,
});

export const consumeAuthorizationCode = internalMutation({
  args: authorization.consumeAuthorizationCodeArgs,
  returns: authorization.consumeAuthorizationCodeReturns,
  handler: authorization.consumeAuthorizationCodeHandler,
});

export const rotateGrant = internalMutation({
  args: authorization.rotateGrantArgs,
  returns: authorization.rotateGrantReturns,
  handler: authorization.rotateGrantHandler,
});

export const revokeGrantByToken = internalMutation({
  args: authorization.revokeGrantByTokenArgs,
  returns: authorization.revokeGrantByTokenReturns,
  handler: authorization.revokeGrantByTokenHandler,
});

export const ownerClearanceForGateway = internalQuery({
  args: session.ownerClearanceForGatewayArgs,
  returns: session.ownerClearanceForGatewayReturns,
  handler: session.ownerClearanceForGatewayHandler,
});

/** Owner or editor clearance, for publishing a website through an agent. */
export const editorClearanceForGateway = internalQuery({
  args: session.ownerClearanceForGatewayArgs,
  returns: session.editorClearanceForGatewayReturns,
  handler: session.editorClearanceForGatewayHandler,
});

/**
 * Open one workspace's storage credential for the gateway. INTERNAL ACTION,
 * and the second half of the two-factor check.
 *
 * The gateway secret got the caller through the door in `http.ts`. This is
 * where the *user's* proof is spent: the presented access token's hash is
 * resolved to a live grant, independently of anything the gateway concluded a
 * moment ago, and the workspace comes from **that grant**.
 *
 * `expectedWorkspaceId` is the gateway's own independent conclusion, and it
 * **selects within the token's own set, never outside it**. The set comes from
 * the query above — the contexts this token's person is a live member of right
 * now — and the id is only ever *compared* against its members: there is no
 * `ctx.db.get(expectedWorkspaceId)`, no `normalizeId(expectedWorkspaceId)`, and
 * no index lookup keyed by it. What is handed downstream is the id off the
 * resolved row, not the argument. That distinction is the whole two-factor
 * property, and `structure.test.ts` enforces it mechanically because a comment
 * saying "compared, never looked up" cannot fail.
 *
 * It used to be a pure veto, because a grant covered exactly one context and
 * there was nothing to select between. What changed is the size of the set, not
 * who decides it: a compromised gateway holding a valid token can now reach the
 * contexts *that token's person is a member of*, and still cannot name a
 * context outside it or walk the customer list. That cost was accepted with the
 * widening (see `resolveGrantByAccessToken`), and the shape to never allow back
 * is the one the old comment warned about — an id used as a lookup key, which
 * needs no membership at all.
 *
 * Everything that is not a credentialed, connected binding for a context this
 * token covers comes back as `null`, including the decrypt failing — the caller
 * must not be able to tell "that workspace isn't yours" from "that workspace
 * doesn't exist" from "that credential can't be opened".
 */
export const openStorageBinding = internalAction({
  args: validators.openStorageBindingArgs,
  returns: validators.openStorageBindingReturns,
  // Annotated, not inferred: this handler references its own module through
  // `internal.functions.controlPlane.…`, which is an inference cycle.
  handler: async (ctx, args): Promise<OpenedGatewayBinding | null> => {
    const session: {
      workspaceId: Id<"workspaces">;
      workspaces: Array<{ workspaceId: Id<"workspaces">; grantedNames?: string[] }>;
    } | null = await ctx.runQuery(
      internal.functions.controlPlane.resolveGrantByAccessToken,
      { hashedAccessToken: args.hashedAccessToken },
    );
    if (session === null) return null;

    /*
      Selection inside the token's own set, and the set is what the token
      resolved to a line ago. With no id named, the grant's own context — the
      same answer this returned before there was a set. With one named, the
      member of the set that matches it, or nothing.

      What is passed on is `covered.workspaceId`, read off the row this query
      returned. The argument is compared and then dropped, which is why no id
      the caller invents can reach a binding: an id that is not in the set has
      no row to be read off.
    */
    const covered =
      args.expectedWorkspaceId === null
        ? session.workspaces.find((w) => w.workspaceId === session.workspaceId)
        : session.workspaces.find((w) => w.workspaceId === args.expectedWorkspaceId);
    if (covered === undefined) return null;
    const workspaceId = covered.workspaceId;

    /*
      THE BUCKET CREDENTIAL, started first. `CREDENTIAL_UNAVAILABLE` and
      anything else alike answer "no binding": an error here would distinguish
      "bound but unopenable" from "not bound" for anyone holding the gateway
      secret and one valid token. The operator sees it in the deployment's own
      logs.
    */
    const credentialRead = ctx.runAction(internal.functions.storage.getBindingForGateway, { workspaceId }).then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const }),
    );
    const usable = (read: Awaited<typeof credentialRead>) =>
      read.ok && read.value !== null && isUsable(read.value.status as BindingStatus);
    /*
      A rotation step is asked for only by `rotate_encryption_keys`, and then,
      as before 2026-11-02, only once the credential has been found usable,
      and before the key read below, so that read holds a generation minted
      here. Both flags are absent on every ordinary request.
    */
    if (args.startEncryptionRotation === true || typeof args.completeEncryptionRotation === "string") {
      if (!usable(await credentialRead)) return null;
    }
    /*
      A ROTATION THE GATEWAY ASKED TO START OR COMPLETE, FOR THE SAME
      WORKSPACE AND NOBODY ELSE'S.

      Both are no-ops for every ordinary request — `startEncryptionRotation`
      and `completeEncryptionRotation` are absent unless the caller is
      specifically the `rotate_encryption_keys` tool, which itself only runs
      for an owner-scoped grant (checked at the gateway, exactly like
      `set_encryption`). Neither call can fail loudly for the same reason the
      encryption-key fetch below cannot: a caller holding the gateway secret
      must not learn anything from the shape of a failure here that it could
      not learn from an ordinary binding request.

      Order matters once: completing before starting means a single confused
      request that somehow set both flags settles the *older* rotation before
      any new one is considered, never the reverse.
    */
    if (typeof args.completeEncryptionRotation === "string") {
      try {
        await ctx.runMutation(internal.functions.encryptionKeys.completeWorkspaceKeyRotation, {
          workspaceId,
          toGeneration: args.completeEncryptionRotation,
        });
      } catch {
        // Swallowed. The walk that asked to complete will simply see the
        // rotation still "in progress" on its next call and try again.
      }
    }
    if (args.startEncryptionRotation === true) {
      try {
        await ctx.runAction(internal.functions.encryptionKeys.startWorkspaceKeyRotation, {
          workspaceId,
        });
      } catch {
        // Swallowed for the same reason as above. A caller that asked to
        // start a rotation and gets none back tries again or gives up; either
        // is safe, because nothing here is a partial write the next call
        // could double.
      }
    }

    /*
      EVERY OTHER READ, SIDE BY SIDE. Each needs only `workspaceId` (the id
      read off the row the grant resolved to, never `args.expectedWorkspaceId`,
      which `structure.test.ts` holds to comparison only) and none needs
      another's answer, so they run at once rather than one after another:
      before 2026-11-02 they were nine serial round trips inside this action.
      Each keeps its own failure rule, written beside it.
    */
    const [credentialAnswer, indexes, keyRead, rotationRead, capRead, encryptionRead] = await Promise.all([
      credentialRead,
      /*
        THE INDEX CREDENTIAL, FOR THE SAME WORKSPACE AND NOBODY ELSE'S. Absent
        is the ordinary answer and never an error: a context that never opted
        in, opted out, is provisioning, failed to provision, and a deployment
        with no D1 token are one outcome, no `searchIndex` key ("Off is a
        working state, not a degraded one", `docs/decisions/search.md`).
        Search by meaning's sibling rides the same credential on the same
        terms; its own query failing costs only it. Any failure is swallowed
        and unreported: the binding is what a tool call waits on, the
        projection an accelerator behind it, and a caller holding the gateway
        secret must not tell "no index" from "an index we could not open".
      */
      (async (): Promise<{ searchIndex?: GatewaySearchIndex; meaningIndex?: GatewayMeaningIndex }> => {
        try {
          const [target, meaning] = await Promise.all([
            ctx.runQuery(internal.functions.fastSearch.projectionTargetForWorkspace, { workspaceId }),
            ctx
              .runQuery(internal.functions.meaningSearch.writeTargetForWorkspace, { workspaceId })
              .catch(() => null),
          ]);
          if (target === null && meaning === null) return {};
          const [apiToken, accountId] = await Promise.all([
            ctx.runAction(internal.functions.admin.readIntegrationSecret, { name: D1_TOKEN_SECRET }),
            ctx.runAction(internal.functions.admin.readIntegrationSecret, { name: D1_ACCOUNT_SECRET }),
          ]);
          // Both or neither, matching `fastSearchProvision.configFor`: half a
          // configuration reads exactly like none, because there is one cure.
          if (typeof apiToken !== "string" || apiToken.length === 0) return {};
          if (typeof accountId !== "string" || accountId.length === 0) return {};
          return {
            ...(target === null
              ? {}
              : { searchIndex: { databaseId: target.databaseId, accountId, apiToken, state: target.state } }),
            ...(meaning === null
              ? {}
              : { meaningIndex: { indexName: meaning.indexName, accountId, apiToken, state: meaning.state } }),
          };
        } catch {
          return {};
        }
      })(),
      /*
        THE ENCRYPTION KEY, FOR THE SAME WORKSPACE AND NOBODY ELSE'S. `create`
        is deliberately absent (false): a read must never bring a key into
        existence. Absent is the ordinary answer, and a failure is answered the
        same way, so a caller cannot tell "no key" from "a key we could not
        open"; the gateway then shows a locked note rather than a missing one.
        Read after a requested rotation start (above), so a generation minted
        there is already among `keys` in this same response.
      */
      ctx.runAction(internal.functions.encryptionKeys.openWorkspaceDataKey, { workspaceId }).then(
        (opened): GatewayEncryptionKey | undefined => (opened === null ? undefined : opened),
        () => undefined,
      ),
      /* ROTATION STATUS: a plain query, no decrypt, so a gateway that only reads still sees a walk outstanding. */
      ctx.runQuery(internal.functions.encryptionKeys.getActiveWorkspaceKeyRotation, { workspaceId }).then(
        (active): GatewayKeyRotation | undefined =>
          active === null ? undefined : { fromGeneration: active.fromGeneration, toGeneration: active.toGeneration },
        () => undefined,
      ),
      /*
        THE NOTE CAP: absent for every context not on the free managed tier,
        and absent on a failed read too; a billing lookup must never cost
        somebody their notes.
      */
      ctx.runQuery(internal.functions.billing.noteCap, { workspaceId }).then(
        (cap): number | undefined => (cap === null ? undefined : cap),
        () => undefined,
      ),
      /*
        MANAGED-STORAGE ENCRYPTION. Unlike the siblings, a failed read is NOT
        absent: absent builds a plain store, and a plain store over a sealed
        bucket serves sealed bytes as note text. So a failure is no binding.
      */
      ctx.runQuery(internal.functions.managedEncryption.gatewayMode, { workspaceId }).then(
        (mode) => ({ ok: true as const, value: mode === null ? undefined : { mode } }),
        () => ({ ok: false as const }),
      ),
    ]);
    if (!credentialAnswer.ok) return null;
    const credential = credentialAnswer.value;
    if (credential === null) return null;
    if (!isUsable(credential.status as BindingStatus)) return null;
    if (!encryptionRead.ok) return null;
    const { searchIndex, meaningIndex } = indexes;
    const encryptionKey = keyRead;
    const rotation = rotationRead;
    const noteCap = capRead;
    const managedEncryption: { mode: "migrating" | "encrypted" | "decrypting" } | undefined = encryptionRead.value;

    return {
      binding: {
        workspaceId,
        provider: credential.provider,
        endpoint: credential.endpoint,
        region: credential.region,
        bucket: credential.bucket,
        rootPrefix: credential.rootPrefix,
        accessKeyId: credential.accessKeyId,
        secretAccessKey: credential.secretAccessKey,
        ...(credential.sessionToken === undefined ? {} : { sessionToken: credential.sessionToken }),
        forcePathStyle: credential.forcePathStyle,
        capabilities: credential.capabilities,
        // Where the note texts are read from (`functions/workspaceObjects.ts`); absent while `bucket`.
        ...(credential.notesHome === undefined ? {} : { notesHome: credential.notesHome }),
        ...(credential.notesBackfilledAt === undefined ? {} : { notesBackfilledAt: credential.notesBackfilledAt }),
        ...(credential.notesBehind === true ? { notesBehind: true as const } : {}),
        // The contract's vocabulary, not the row's. `connected` is our word for
        // "a probe reached it"; `active` is the gateway's word for "you may
        // build a store from this".
        status: "active",
      },
      searchIndex,
      meaningIndex,
      encryptionKey,
      rotation,
      noteCap,
      managedEncryption,
      // A pin reader's rules are rendered for a guest (`lib/pinnedReaders.ts`), from the names the grant resolved to.
      ...(audienceOfNames(covered.grantedNames) === "guest" ? { audience: "guest" as const } : {}),
      // A Tex guest chat's are read for it, from the same names (`lib/nodes/chatFolders.ts`).
      ...(readsAsChat(covered.grantedNames) ? { chatNames: covered.grantedNames ?? [] } : {}),
    };
  },
});

export const createGatewayJob = internalMutation({
  args: gatewayJobs.createGatewayJobArgs,
  returns: gatewayJobs.createGatewayJobReturns,
  handler: gatewayJobs.createGatewayJobHandler,
});

export const claimGatewayJob = internalMutation({
  args: gatewayJobs.claimGatewayJobArgs,
  returns: gatewayJobs.claimGatewayJobReturns,
  handler: gatewayJobs.claimGatewayJobHandler,
});

export const openGatewayJob = internalAction({
  args: validators.openGatewayJobArgs,
  returns: validators.openGatewayJobReturns,
  handler: async (ctx, args): Promise<OpenedGatewayJob | LeasedGatewayJob | null> => {
    const claimed: ClaimedGatewayJob | LeasedGatewayJob | null = await ctx.runMutation(
      internal.functions.controlPlane.claimGatewayJob,
      {
        hashedTicket: args.hashedTicket,
        contentSha256: args.contentSha256,
      },
    );
    if (claimed === null) return null;
    if ("retryAfterMs" in claimed) return claimed;

    let credential;
    try {
      credential = await ctx.runAction(internal.functions.storage.getBindingForGateway, {
        workspaceId: claimed.workspaceId,
      });
    } catch {
      await ctx.runMutation(internal.functions.controlPlane.reportGatewayJob, {
        hashedTicket: args.hashedTicket,
        result: { status: "queued", error: "storage_unavailable" },
      });
      return { retryAfterMs: 30_000 };
    }
    if (credential === null || !isUsable(credential.status as BindingStatus)) {
      await ctx.runMutation(internal.functions.controlPlane.reportGatewayJob, {
        hashedTicket: args.hashedTicket,
        result: { status: "failed", error: "storage_unavailable" },
      });
      return null;
    }

    let searchIndex: GatewaySearchIndex | undefined;
    let meaningIndex: GatewayMeaningIndex | undefined;
    try {
      const [target, meaning]: [
        { databaseId: string; state: "backfilling" | "ready" } | null,
        { indexName: string; generation: string; state: "backfilling" | "ready" } | null,
      ] = await Promise.all([
        ctx.runQuery(internal.functions.fastSearch.projectionTargetForWorkspace, {
          workspaceId: claimed.workspaceId,
        }),
        ctx
          .runQuery(internal.functions.meaningSearch.writeTargetForWorkspace, {
            workspaceId: claimed.workspaceId,
          })
          .catch(() => null),
      ]);
      if (target !== null || meaning !== null) {
        const apiToken: string | null = await ctx.runAction(internal.functions.admin.readIntegrationSecret, {
          name: D1_TOKEN_SECRET,
        });
        const accountId: string | null = await ctx.runAction(internal.functions.admin.readIntegrationSecret, {
          name: D1_ACCOUNT_SECRET,
        });
        if (
          typeof apiToken === "string" &&
          apiToken.length > 0 &&
          typeof accountId === "string" &&
          accountId.length > 0
        ) {
          if (target !== null) {
            searchIndex = { databaseId: target.databaseId, accountId, apiToken, state: target.state };
          }
          if (meaning !== null) {
            meaningIndex = { indexName: meaning.indexName, accountId, apiToken, state: meaning.state };
          }
        }
      }
    } catch {
      searchIndex = undefined;
      meaningIndex = undefined;
    }

    let encryptionKey: GatewayEncryptionKey | undefined;
    try {
      const opened: GatewayEncryptionKey | null = await ctx.runAction(
        internal.functions.encryptionKeys.openWorkspaceDataKey,
        { workspaceId: claimed.workspaceId },
      );
      encryptionKey = opened === null ? undefined : opened;
    } catch {
      encryptionKey = undefined;
    }

    let rotation: GatewayKeyRotation | undefined;
    try {
      const active: { fromGeneration: string; toGeneration: string } | null = await ctx.runQuery(
        internal.functions.encryptionKeys.getActiveWorkspaceKeyRotation,
        { workspaceId: claimed.workspaceId },
      );
      rotation =
        active === null ? undefined : { fromGeneration: active.fromGeneration, toGeneration: active.toGeneration };
    } catch {
      rotation = undefined;
    }

    // Fail closed for the reason given in `openStorageBinding`.
    let managedEncryption: { mode: "migrating" | "encrypted" | "decrypting" } | undefined;
    try {
      const mode = await ctx.runQuery(internal.functions.managedEncryption.gatewayMode, {
        workspaceId: claimed.workspaceId,
      });
      managedEncryption = mode === null ? undefined : { mode };
    } catch {
      return null;
    }

    // Phase 3: a queued move rewrites `privacy.md`, so it writes through the rules too.
    const privacy = await ctx
      .runQuery(internal.functions.nodesPrivacy.authority, { workspaceId: claimed.workspaceId })
      .then((held) => held ?? undefined);

    return {
      job: claimed,
      binding: {
        workspaceId: claimed.workspaceId,
        provider: credential.provider,
        endpoint: credential.endpoint,
        region: credential.region,
        bucket: credential.bucket,
        rootPrefix: credential.rootPrefix,
        accessKeyId: credential.accessKeyId,
        secretAccessKey: credential.secretAccessKey,
        ...(credential.sessionToken === undefined ? {} : { sessionToken: credential.sessionToken }),
        forcePathStyle: credential.forcePathStyle,
        capabilities: credential.capabilities,
        // Where the note texts are read from (`functions/workspaceObjects.ts`); absent while `bucket`.
        ...(credential.notesHome === undefined ? {} : { notesHome: credential.notesHome }),
        ...(credential.notesBackfilledAt === undefined ? {} : { notesBackfilledAt: credential.notesBackfilledAt }),
        ...(credential.notesBehind === true ? { notesBehind: true as const } : {}),
        status: "active",
      },
      searchIndex,
      meaningIndex,
      encryptionKey,
      rotation,
      managedEncryption,
      privacy,
      // Every workspace is keyed (2026-10-22): the gateway refuses a path-based job.
      keyed: true,
    };
  },
});

export const reportGatewayJob = internalMutation({
  args: gatewayJobs.reportGatewayJobArgs,
  returns: gatewayJobs.reportGatewayJobReturns,
  handler: gatewayJobs.reportGatewayJobHandler,
});

/** Image-upload tickets past their ten minutes (`gatewayJobs.sweepImageUploadsHandler`). */
export const sweepImageUploads = internalMutation({
  args: {},
  returns: v.number(),
  handler: gatewayJobs.sweepImageUploadsHandler,
});
