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

import { internal } from "../_generated/api";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { D1_ACCOUNT_SECRET, D1_TOKEN_SECRET } from "./lib/d1";
import {
  isUsable,
  type BindingStatus,
  type GatewayEncryptionKey,
  type GatewayKeyRotation,
  type GatewaySearchIndex,
  type OpenedGatewayBinding,
} from "./lib/controlPlane/bindingShapes";
import type { ClaimedGatewayJob, OpenedGatewayJob } from "./lib/controlPlane/gatewayJobs";
import * as session from "./lib/controlPlane/session";
import * as authorization from "./lib/controlPlane/authorization";
import * as gatewayJobs from "./lib/controlPlane/gatewayJobs";
import * as validators from "./lib/controlPlane/validators";

export type {
  DropboxGatewayBinding,
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
      workspaces: Array<{ workspaceId: Id<"workspaces"> }>;
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

    let credential;
    try {
      credential = await ctx.runAction(
        internal.functions.storage.getBindingForGateway,
        { workspaceId },
      );
    } catch {
      // `CREDENTIAL_UNAVAILABLE` and anything else alike. The operator sees it
      // in the deployment's own logs; the gateway sees "no binding", because
      // an error here would distinguish "bound but unopenable" from "not
      // bound" for anyone holding the gateway secret and one valid token.
      return null;
    }
    if (credential === null) return null;
    if (!isUsable(credential.status as BindingStatus)) return null;

    /*
      THE INDEX CREDENTIAL, FOR THE SAME WORKSPACE AND NOBODY ELSE'S.

      `workspaceId` here is `covered.workspaceId` — the id read off the row the
      grant resolved to, several lines above, which is the only id in this
      handler that a caller cannot choose. Passing anything else, in particular
      `args.expectedWorkspaceId`, would hand the gateway a way to name whose
      index it gets, and `structure.test.ts` fails the build if that argument is
      ever used to select rather than to compare.

      Absent is the ordinary answer and never an error. A context that never
      opted in, one that opted out, one still provisioning, one whose provision
      failed, and a deployment with no D1 token configured at all are one
      outcome: no `searchIndex` key, and a binding that works exactly as it did
      before this existed. "Off is a working state, not a degraded one"
      (`docs/decisions/search.md`).

      Two `runAction`s rather than a shared helper, and the duplication is
      deliberate: `structure.test.ts` attributes a module-level helper's calls to
      every export in the file, so a `configFor()` sitting outside this handler
      would make every function in `controlPlane.ts` read as decrypt-capable and
      hide this edge in a crowd. The one call that matters is visible here.
    */
    let searchIndex: GatewaySearchIndex | undefined;
    try {
      const target = await ctx.runQuery(
        internal.functions.fastSearch.projectionTargetForWorkspace,
        { workspaceId },
      );
      if (target !== null) {
        const apiToken = await ctx.runAction(
          internal.functions.admin.readIntegrationSecret,
          { name: D1_TOKEN_SECRET },
        );
        const accountId = await ctx.runAction(
          internal.functions.admin.readIntegrationSecret,
          { name: D1_ACCOUNT_SECRET },
        );
        // Both or neither, matching `fastSearchProvision.configFor`: half a
        // configuration reads exactly like none, because there is one cure.
        if (
          typeof apiToken === "string" &&
          apiToken.length > 0 &&
          typeof accountId === "string" &&
          accountId.length > 0
        ) {
          searchIndex = {
            databaseId: target.databaseId,
            accountId,
            apiToken,
            state: target.state,
          };
        }
      }
    } catch {
      /*
        Swallowed, and it must be. The binding is what a person's tool call is
        waiting on; the projection is an accelerator behind it. A failed
        keyset, an unreadable envelope or a deployment mid-rotation must cost
        the search its fast path, never cost somebody their notes.

        Nothing about the failure is reported, for the same reason as the
        `getBindingForGateway` catch above: a caller holding the gateway secret
        must not be able to tell "no index" from "an index we could not open".
        The token cannot appear here either — this catch names no error.
      */
      searchIndex = undefined;
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
      THE ENCRYPTION KEY, FOR THE SAME WORKSPACE AND NOBODY ELSE'S.

      `workspaceId` again — the id read off the row the grant resolved to, the
      only id in this handler a caller cannot choose. Same rule as the index
      credential above, and `structure.test.ts` fails the build if
      `args.expectedWorkspaceId` is ever used to select rather than to compare.

      `create` is deliberately absent, which means false. A read must never be
      the thing that brings a key into existence: a context that has never
      encrypted a note has no row, holds no key, and is one less thing for this
      control plane to be holding on somebody's behalf. The row is written when
      an owner turns encryption on, and not before.

      Absent is therefore the ordinary answer, and a failure is answered the
      same way for the same reason as the two catches above: a caller holding
      the gateway secret must not be able to tell "this context has no key" from
      "we could not open the key it has". The gateway degrades to refusing to
      decrypt, which is a note that reads as locked rather than a note that
      reads as gone.

      A separate `runAction` rather than a shared helper, matching the index
      credential immediately above and for the same stated reason: a
      module-level helper would attribute its calls to every export in this
      file and hide this edge in a crowd.

      Read AFTER a requested rotation start, deliberately: `openWorkspaceDataKey`
      decrypts every live row, so a generation minted a few lines above is
      already among `keys` by the time this runs, and the gateway that asked
      to start a rotation gets the new generation's material in the very same
      response rather than needing a second round trip for it.
    */
    let encryptionKey: GatewayEncryptionKey | undefined;
    try {
      const opened = await ctx.runAction(
        internal.functions.encryptionKeys.openWorkspaceDataKey,
        { workspaceId },
      );
      encryptionKey = opened === null ? undefined : opened;
    } catch {
      encryptionKey = undefined;
    }

    /*
      ROTATION STATUS, FOR THE SAME WORKSPACE. A plain query, no decrypt — safe
      to run on every request, not only one that asked to start or complete
      one, so a gateway that only ever reads can still see a walk outstanding.
    */
    let rotation: GatewayKeyRotation | undefined;
    try {
      const active = await ctx.runQuery(
        internal.functions.encryptionKeys.getActiveWorkspaceKeyRotation,
        { workspaceId },
      );
      rotation =
        active === null ? undefined : { fromGeneration: active.fromGeneration, toGeneration: active.toGeneration };
    } catch {
      rotation = undefined;
    }

    /*
      THE NOTE CAP, FOR THE SAME WORKSPACE. A plain query, no decrypt. Absent
      for every context not on the free managed tier, and absent on a failed
      read too: a billing lookup must never cost somebody their notes, and the
      worst an absent cap costs is a free context briefly holding more.
    */
    let noteCap: number | undefined;
    try {
      const cap = await ctx.runQuery(internal.functions.billing.noteCap, { workspaceId });
      noteCap = cap === null ? undefined : cap;
    } catch {
      noteCap = undefined;
    }

    // Built per provider, never spread. A workspace rebound from a bucket to
    // Dropbox can still have an `accessKeyId` sitting on its row; spread into
    // this payload it would reach the gateway as a credential for storage this
    // binding no longer points at — which the gateway's factory now refuses as
    // a cross-provider credential, so the failure would be loud rather than
    // silent, but the payload should never have carried it.
    if (credential.provider === "dropbox") {
      return {
        binding: {
          // The context this credential was opened for, which is the selected
          // one and not the session's default. The gateway compares it against
          // what *it* resolved and refuses a mismatch, so answering with the
          // default here would make every cross-context call fail as a
          // disagreement about which tenant it is — fail-closed, and completely.
          workspaceId,
          provider: credential.provider,
          accessToken: credential.accessToken,
          rootPrefix: credential.rootPrefix,
          capabilities: credential.capabilities,
          status: "active",
        },
        searchIndex,
        encryptionKey,
        rotation,
        noteCap,
      };
    }

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
        forcePathStyle: credential.forcePathStyle,
        capabilities: credential.capabilities,
        // The contract's vocabulary, not the row's. `connected` is our word for
        // "a probe reached it"; `active` is the gateway's word for "you may
        // build a store from this".
        status: "active",
      },
      searchIndex,
      encryptionKey,
      rotation,
      noteCap,
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
  handler: async (ctx, args): Promise<OpenedGatewayJob | null> => {
    const claimed: ClaimedGatewayJob | null = await ctx.runMutation(
      internal.functions.controlPlane.claimGatewayJob,
      {
        hashedTicket: args.hashedTicket,
      },
    );
    if (claimed === null) return null;

    let credential;
    try {
      credential = await ctx.runAction(internal.functions.storage.getBindingForGateway, {
        workspaceId: claimed.workspaceId,
      });
    } catch {
      await ctx.runMutation(internal.functions.controlPlane.reportGatewayJob, {
        hashedTicket: args.hashedTicket,
        result: { status: "failed", error: "storage_unavailable" },
      });
      return null;
    }
    if (credential === null || !isUsable(credential.status as BindingStatus)) {
      await ctx.runMutation(internal.functions.controlPlane.reportGatewayJob, {
        hashedTicket: args.hashedTicket,
        result: { status: "failed", error: "storage_unavailable" },
      });
      return null;
    }

    let searchIndex: GatewaySearchIndex | undefined;
    try {
      const target: { databaseId: string; state: "backfilling" | "ready" } | null = await ctx.runQuery(
        internal.functions.fastSearch.projectionTargetForWorkspace,
        { workspaceId: claimed.workspaceId },
      );
      if (target !== null) {
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
          searchIndex = {
            databaseId: target.databaseId,
            accountId,
            apiToken,
            state: target.state,
          };
        }
      }
    } catch {
      searchIndex = undefined;
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

    if (credential.provider === "dropbox") {
      return {
        job: claimed,
        binding: {
          workspaceId: claimed.workspaceId,
          provider: credential.provider,
          accessToken: credential.accessToken,
          rootPrefix: credential.rootPrefix,
          capabilities: credential.capabilities,
          status: "active",
        },
        searchIndex,
        encryptionKey,
        rotation,
      };
    }
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
        forcePathStyle: credential.forcePathStyle,
        capabilities: credential.capabilities,
        status: "active",
      },
      searchIndex,
      encryptionKey,
      rotation,
    };
  },
});

export const reportGatewayJob = internalMutation({
  args: gatewayJobs.reportGatewayJobArgs,
  returns: gatewayJobs.reportGatewayJobReturns,
  handler: gatewayJobs.reportGatewayJobHandler,
});
