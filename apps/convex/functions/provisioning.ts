/**
 * Connecting a bucket: verify it, then give it a context if it has none.
 *
 * This is the other half of `functions/storage.ts`. That module stores a
 * credential; this one is the only thing that ever *uses* one from inside the
 * control plane — it opens the envelope, talks to the customer's bucket once,
 * and records honestly what it found.
 *
 * ## Why the adapter is imported from `apps/mcp`
 *
 * `apps/mcp/src/store/` is zero-dependency ESM built for the Workers runtime:
 * `fetch` and Web Crypto, no Node APIs. That is exactly the Convex action
 * runtime too, so `S3Store` and `probeStore` run here unmodified, over a
 * relative path across the two packages.
 *
 * Copying them instead would mean **two implementations of SigV4**, and a
 * signing or key-validation fix landing in one and not the other is the shape
 * of security bug that survives for years — the gateway would reject a
 * traversal key the control plane happily signed, or vice versa. One
 * implementation, one set of tests, one place to fix.
 *
 * (A workspace import — `@context/mcp/store` — would read better than
 * `../../mcp/src/store/s3.js`, but it needs an `exports` map in that package
 * and a lockfile change. The relative path is the same module either way.)
 *
 * ## Why this module is entirely internal
 *
 * Every export here is `internal`. Verification decrypts a credential, so a
 * public entry point — even one that only returned a boolean — would be a
 * public function with the decrypt path in its call graph, and
 * `__tests__/structure.test.ts` would reject it. The user-facing trigger is
 * `bindStorage`, which *schedules* this and never calls it: a scheduled
 * function's result cannot flow back to whoever scheduled it.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import {
  type ActionCtx,
  internalAction,
  internalQuery,
} from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { S3Store } from "../../mcp/src/store/s3.js";
import { probeStore } from "../../mcp/src/store/index.js";
import {
  type ScaffoldStore,
  type StructureTemplate,
  scaffoldContext,
} from "./lib/scaffold";
import {
  type ProbeResult,
  redactSecrets,
  summarizeProbe,
} from "./lib/verification";
import { addressingIsAmbiguous, type GatewayCredential } from "./storage";

/**
 * How long a single request to the customer's endpoint may take.
 *
 * The endpoint is a URL the customer typed. Without a deadline, an endpoint
 * that accepts a connection and then says nothing holds an action open for as
 * long as the runtime allows, and the person who just pasted their credentials
 * watches a spinner. It also bounds the usefulness of the endpoint as an SSRF
 * probe: a hung internal service is indistinguishable from a closed port.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Capped so a provider cannot dictate how much text we store. */
const MAX_RECORDED_ERROR_LENGTH = 300;

/**
 * `fetch` with a per-request deadline.
 *
 * `AbortSignal.timeout` is guarded rather than assumed: this code runs in the
 * Convex action runtime, in `@edge-runtime/vm` under test, and (unchanged)
 * inside the Workers gateway. A missing timeout is a slower failure, not a
 * wrong one, so falling back is better than throwing.
 */
function timeoutFetch(
  input: URL | RequestInfo,
  init?: RequestInit,
): Promise<Response> {
  const timeout =
    typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      : undefined;
  return globalThis.fetch(input, timeout ? { ...init, signal: timeout } : init);
}

/**
 * THE CLOSED SET OF FAILURE CODES.
 *
 * `lastError` is provider prose written for a human; this is the same failure
 * expressed as something a client can branch on. A console that wants to offer
 * "choose an addressing style" for one failure and "paste the key again" for
 * another must not be matching on English.
 *
 * Deliberately coarse — each value maps to a different thing the owner does:
 *
 *  - `CREDENTIAL_UNAVAILABLE` — the envelope would not open. Rebind.
 *  - `AMBIGUOUS_ADDRESSING`   — endpoint and bucket cannot be told apart.
 *                               Rebind with an explicit `forcePathStyle`.
 *  - `INVALID_CONFIGURATION`  — the adapter refused the configuration for some
 *                               other reason (bucket name with a slash in it,
 *                               unusable root prefix). Rebind with it fixed.
 *  - `UNREACHABLE`            — the bucket could not be listed. Endpoint,
 *                               region, bucket name, or list permission.
 *  - `NOT_WRITABLE`           — it lists but will not accept a write. The key
 *                               needs put/delete.
 *  - `PROBE_FAILED`           — the probe itself blew up. Nothing to advise
 *                               beyond retrying, which is what `reverifyStorage`
 *                               is for.
 *
 * Anything a client does not recognise should fall back to showing `lastError`.
 */
export type VerificationErrorCode =
  | "CREDENTIAL_UNAVAILABLE"
  | "AMBIGUOUS_ADDRESSING"
  | "INVALID_CONFIGURATION"
  | "UNREACHABLE"
  | "NOT_WRITABLE"
  | "PROBE_FAILED";

/** What `verifyStorageBinding` reports. Deliberately free of any credential. */
export interface VerificationOutcome {
  verified: boolean;
  reachable: boolean;
  writable: boolean;
  /** Observed, never declared. `false` on B2/Wasabi and any backend that lies. */
  conditionalWrite: boolean;
  scaffolded: boolean;
  scaffoldReason: string;
  error?: string;
  /** Absent when `verified`, and absent when the failure has no useful code. */
  errorCode?: VerificationErrorCode;
}

/**
 * The workspace's chosen starting layout.
 *
 * Internal and deliberately narrow: this is read by the verifying action,
 * which has a decrypted credential in scope, so it gets the one field it needs
 * and nothing else.
 */
export const getStructureTemplate = internalQuery({
  args: { workspaceId: v.id("workspaces") },
  returns: v.union(v.null(), v.literal("para"), v.literal("custom")),
  handler: async (ctx, args) => {
    const workspace = await ctx.db.get(args.workspaceId);
    return workspace === null ? null : workspace.structureTemplate;
  },
});

/**
 * Talk to the customer's bucket, record what is actually true about it, and
 * lay down a starting context if — and only if — the bucket has none.
 *
 * INTERNAL ACTION. It decrypts, so it is unreachable from any client by
 * construction. `bindStorage` schedules it; a cron or an operator can run it
 * again at any time, and running it twice is harmless.
 *
 * Never throws for a bad bucket. A wrong key, a missing bucket, a read-only
 * credential and a hostile endpoint are all *results*, recorded on the binding
 * where the owner can read them, not exceptions that vanish into a log.
 */
export const verifyStorageBinding = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    /** Who caused this, when a person did. Absent for a cron or an operator. */
    actorUserId: v.optional(v.id("users")),
  },
  returns: v.object({
    verified: v.boolean(),
    reachable: v.boolean(),
    writable: v.boolean(),
    conditionalWrite: v.boolean(),
    scaffolded: v.boolean(),
    scaffoldReason: v.string(),
    error: v.optional(v.string()),
    errorCode: v.optional(v.string()),
  }),
  // Annotated rather than inferred: this action calls other functions in the
  // same deployment, which is the same inference cycle `bindStorage` has.
  handler: async (ctx, args): Promise<VerificationOutcome> => {
    let credential: GatewayCredential | null;
    try {
      credential = await ctx.runAction(
        internal.functions.storage.getBindingForGateway,
        { workspaceId: args.workspaceId },
      );
    } catch (error) {
      // The envelope would not open — a rotated-away key, or a row whose
      // credential belongs to another workspace. The owner's move is the same
      // either way: paste the key again.
      return await record(ctx, args, {
        verified: false,
        reachable: false,
        writable: false,
        conditionalWrite: false,
        scaffolded: false,
        scaffoldReason: "not-attempted",
        error: convexErrorMessage(
          error,
          // Same wording as `getBindingForGateway`'s own error, so the owner
          // reads one instruction rather than two that sound different.
          "This workspace's storage credential could not be opened. Rebind storage to replace it.",
        ),
        errorCode: "CREDENTIAL_UNAVAILABLE",
      });
    }

    if (credential === null) {
      // Nothing to verify and nothing to record against — the binding was
      // removed between scheduling and running. Not a failure.
      return {
        verified: false,
        reachable: false,
        writable: false,
        conditionalWrite: false,
        scaffolded: false,
        scaffoldReason: "no-binding",
      };
    }

    // From here on a plaintext secret is in scope. It is used to construct one
    // store, and every string that leaves this function goes through
    // `redactSecrets` before it is recorded.
    const secrets = [credential.secretAccessKey, credential.accessKeyId];

    let store: ScaffoldStore;
    try {
      store = new S3Store({
        endpoint: credential.endpoint,
        region: credential.region,
        bucket: credential.bucket,
        rootPrefix: credential.rootPrefix,
        accessKeyId: credential.accessKeyId,
        secretAccessKey: credential.secretAccessKey,
        // The stored answer to "is the bucket in the host or in the path".
        // Passing it is what makes a virtual-hosted endpoint connectable at
        // all, and passing the *stored* one is what makes the store this probe
        // exercises identical to the store the gateway will build from the same
        // row — a probe that addressed the bucket differently from the gateway
        // would certify a configuration that does not work.
        forcePathStyle: credential.forcePathStyle,
      }) as unknown as ScaffoldStore;
    } catch (error) {
      // Bad configuration rather than a bad bucket: an endpoint whose
      // addressing style is ambiguous, a bucket name with a slash in it.
      //
      // `bindStorage` refuses the ambiguous case up front, so reaching it here
      // means a row written before that check existed. Coding it separately is
      // what lets the console offer the fix instead of "reconnect storage",
      // which would not have helped.
      return await record(ctx, args, {
        verified: false,
        reachable: false,
        writable: false,
        conditionalWrite: false,
        scaffolded: false,
        scaffoldReason: "not-attempted",
        error: redactSecrets(errorMessage(error), secrets),
        errorCode:
          credential.forcePathStyle === undefined &&
          addressingIsAmbiguous(credential.endpoint, credential.bucket)
            ? "AMBIGUOUS_ADDRESSING"
            : "INVALID_CONFIGURATION",
      });
    }

    let probe: ProbeResult;
    try {
      probe = (await probeStore(store)) as unknown as ProbeResult;
    } catch (error) {
      // `probeStore` is documented never to throw; if it ever does, that is
      // still the customer's problem to see rather than ours to swallow.
      return await record(ctx, args, {
        verified: false,
        reachable: false,
        writable: false,
        conditionalWrite: false,
        scaffolded: false,
        scaffoldReason: "not-attempted",
        error: redactSecrets(errorMessage(error), secrets),
        errorCode: "PROBE_FAILED",
      });
    }

    const summary = summarizeProbe(probe, { bucket: credential.bucket });

    if (!summary.ok) {
      return await record(ctx, args, {
        verified: false,
        reachable: summary.reachable,
        writable: summary.writable,
        conditionalWrite: summary.capabilities.conditionalWrite,
        scaffolded: false,
        scaffoldReason: "not-attempted",
        error: redactSecrets(summary.error ?? "Verification failed.", secrets),
        // `summarizeProbe` fails for exactly two reasons and reports which.
        errorCode: summary.reachable ? "NOT_WRITABLE" : "UNREACHABLE",
      });
    }

    // Only now — the bucket answered, and it accepted and removed a write.
    const structureTemplate: StructureTemplate | null = await ctx.runQuery(
      internal.functions.provisioning.getStructureTemplate,
      { workspaceId: args.workspaceId },
    );

    let scaffolded = false;
    let scaffoldReason = "not-attempted";
    let scaffoldError: string | undefined;
    if (structureTemplate !== null) {
      const result = await scaffoldContext(store, { structureTemplate });
      scaffolded = result.scaffolded;
      scaffoldReason = result.reason;
      if (result.error) scaffoldError = redactSecrets(result.error, secrets);
    }

    return await record(ctx, args, {
      // A bucket we could not lay a context into is still connected: the
      // failure is a write we did not need to make, and the owner's existing
      // brain is exactly as it was.
      verified: true,
      reachable: true,
      writable: true,
      conditionalWrite: summary.capabilities.conditionalWrite,
      scaffolded,
      scaffoldReason,
      error: scaffoldError,
    });
  },
});

/**
 * Persist the outcome and hand it back.
 *
 * `recordVerification` throws when the binding has vanished — which is a race,
 * not a bug — so the write is best-effort and the outcome is returned either
 * way.
 */
async function record(
  ctx: ActionCtx,
  args: { workspaceId: Id<"workspaces">; actorUserId?: Id<"users"> },
  outcome: VerificationOutcome,
): Promise<VerificationOutcome> {
  const error = outcome.error
    ? truncate(outcome.error, MAX_RECORDED_ERROR_LENGTH)
    : undefined;
  try {
    await ctx.runMutation(internal.functions.storage.recordVerification, {
      workspaceId: args.workspaceId,
      ok: outcome.verified,
      capabilities: { conditionalWrite: outcome.conditionalWrite },
      error,
      errorCode: outcome.errorCode,
      actorUserId: args.actorUserId,
    });
  } catch {
    // The binding was disconnected while we were probing. Nothing to record.
  }
  return { ...outcome, error };
}

function errorMessage(error: unknown): string {
  return String((error as { message?: unknown })?.message ?? error ?? "unknown error");
}

/** A `ConvexError`'s message, or a fallback. Never the underlying detail. */
function convexErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ConvexError) {
    const data = error.data as { message?: unknown } | undefined;
    if (typeof data?.message === "string") return data.message;
  }
  return fallback;
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
