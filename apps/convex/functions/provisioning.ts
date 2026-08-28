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
import { type ActionCtx, internalAction } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import { probeStore } from "../../mcp/src/store/index.js";
import {
  type CustomFolder,
  type ScaffoldStore,
  hasExistingContext,
  scaffoldContext,
} from "./lib/scaffold";
import { countNotes } from "./lib/noteCount";
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

/**
 * WHAT WE FOUND IN THE BUCKET, AND WHAT WE DID ABOUT IT.
 *
 * Persisted on the binding (see the schema) and published by
 * `getStorageBinding`, because it is the fact onboarding branches on.
 *
 *  - `existing-context` — the bucket already holds somebody's notes.
 *  - `empty`            — verified and empty. The only state where asking for a
 *                         folder layout makes sense.
 *  - `created`          — a starting layout was written, in full.
 *  - `partial`          — the layout's essential file landed, some best-effort
 *                         folders or READMEs did not. **A success.** The bucket
 *                         is a working context; `scaffoldMissing` names what to
 *                         create by hand or ask an agent for.
 *  - `failed`           — an essential file did not land. Not a context yet.
 *  - `not-attempted`    — verification did not get far enough to look.
 *  - `no-binding`       — there was nothing to verify. Never persisted: there
 *                         is no row to persist it on.
 */
export type ScaffoldState =
  | "existing-context"
  | "empty"
  | "created"
  | "partial"
  | "failed"
  | "not-attempted"
  | "no-binding";

/** What `verifyStorageBinding` reports. Deliberately free of any credential. */
export interface VerificationOutcome {
  verified: boolean;
  reachable: boolean;
  writable: boolean;
  /** Observed, never declared. `false` on B2/Wasabi and any backend that lies. */
  conditionalWrite: boolean;
  scaffolded: boolean;
  scaffoldReason: ScaffoldState;
  /**
   * Keys of the chosen layout that are not in the bucket. Present only when a
   * scaffold actually ran — a look-only probe leaves whatever the last attempt
   * recorded, because it is the record of what we still owe this bucket.
   *
   * These are key names this module generated, never provider text.
   */
  scaffoldMissing?: string[];
  /**
   * Notes counted in the bucket, and whether the walk reached the end.
   *
   * Absent whenever nothing looked — a probe that never reached the bucket, or
   * a listing that broke partway. Absent is not zero: `recordVerification`
   * leaves the previous count standing rather than recording "this context is
   * empty" on the strength of a network error.
   */
  noteCount?: number;
  noteCountTruncated?: boolean;
  error?: string;
  /** Absent when `verified`, and absent when the failure has no useful code. */
  errorCode?: VerificationErrorCode;
}

/**
 * The starting layout to lay down, as the caller supplied it.
 *
 * **Taken at call time, never read off the workspace row**, and that is the
 * whole fix for the sequencing bug this argument exists to close. The row's
 * `structureTemplate` is set when the workspace is created — which, in the
 * onboarding order the product actually has, is *before* the person has been
 * asked anything. A prober that read it would write a PARA layout into the
 * bucket the instant `bindStorage` succeeded, and the question asked afterwards
 * would be decoration over a decision already taken.
 *
 * So the value travels with the request: `applyStructure` is the only thing
 * that supplies one, and it does so with an answer in hand.
 */
export interface StructureChoice {
  template: "para" | "custom";
  /** Validated by `applyStructure` before it gets here. Empty for `para`. */
  folders: CustomFolder[];
}

const structureChoiceValidator = v.object({
  template: v.union(v.literal("para"), v.literal("custom")),
  folders: v.array(v.object({ folder: v.string(), description: v.string() })),
});

/**
 * Talk to the customer's bucket and record what is actually true about it —
 * and, when the caller has an answer in hand, lay down a starting context.
 *
 * ## Two modes, and why the difference is the point
 *
 * **Without `structure` (the default): look, do not touch.** The probe runs,
 * the capability is recorded, and the bucket is *classified* — `empty` or
 * `existing-context`. Not one byte is written. This is what `bindStorage`
 * schedules and what `reverifyStorage` schedules, and it has to be: at the
 * moment a credential is pasted, nobody has been asked which folder layout they
 * want. A verification that scaffolded would answer that question on the user's
 * behalf and then let the interface pretend to ask it.
 *
 * **With `structure`: verify, then scaffold that layout.** Only
 * `applyStructure` supplies one, and only after a person has chosen. Reusing
 * this action rather than adding a second one is deliberate: scaffolding is a
 * write into somebody else's bucket, and it should be preceded by a fresh proof
 * that the bucket is reachable and writable — which is exactly what the probe
 * above it does. One action, one credential open, one place that talks to a
 * customer's storage from the control plane.
 *
 * Either way the no-overwrite rule is the scaffolder's, not this function's:
 * `scaffoldContext` refuses outright against a bucket that already holds a
 * context, and `get`s every key before it `put`s it. A caller that asks for a
 * layout on a live brain gets `existing-context` and an untouched bucket.
 *
 * INTERNAL ACTION. It decrypts, so it is unreachable from any client by
 * construction. Running it twice is harmless.
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
    /**
     * Present only when somebody has actually chosen a layout. Absent means
     * "verify and classify"; see the two modes above.
     */
    structure: v.optional(structureChoiceValidator),
    /**
     * Finish a layout we already began writing into this bucket.
     *
     * Only `applyStructure` sets it, and only from `scaffoldMissing` on the
     * binding — control-plane evidence that this bucket was observed empty and
     * then written into by us. It reaches `scaffoldContext`'s `resume`, which
     * swaps the "is anything here" guard for "is anything here that we did not
     * write". Meaningless without `structure`, and ignored without it.
     */
    resume: v.optional(v.boolean()),
  },
  returns: v.object({
    verified: v.boolean(),
    reachable: v.boolean(),
    writable: v.boolean(),
    conditionalWrite: v.boolean(),
    scaffolded: v.boolean(),
    scaffoldReason: v.string(),
    scaffoldMissing: v.optional(v.array(v.string())),
    noteCount: v.optional(v.number()),
    noteCountTruncated: v.optional(v.boolean()),
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
    // Whatever this credential actually carries. A Dropbox one has an access
    // token and no key pair; listing fields that do not exist would put
    // `undefined` in the redaction set and quietly redact nothing.
    const secrets =
      credential.provider === "dropbox"
        ? [credential.accessToken]
        : [credential.secretAccessKey, credential.accessKeyId];

    let store: ScaffoldStore;
    try {
      // Same table the gateway builds from, so the store this probe
      // exercises is the store that will serve the workspace. A probe that
      // addressed the storage differently would certify a configuration that
      // does not actually work.
      store = storeForBinding(credential) as unknown as ScaffoldStore;
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
        // Ambiguous addressing is a question about a *bucket in a host name*.
        // Dropbox has neither, so asking it there would classify every Dropbox
        // configuration error as an S3 endpoint problem the owner cannot act
        // on.
        errorCode:
          credential.provider !== "dropbox" &&
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

    // The bucket name only exists to name the thing in a message. A Dropbox
    // binding has a folder instead, and saying "folder" is what stops the
    // console telling somebody to check a bucket they never created.
    const summary = summarizeProbe(probe, {
      bucket:
        credential.provider === "dropbox"
          ? (credential.rootPrefix ?? "your Dropbox folder")
          : credential.bucket,
    });

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
    let scaffolded = false;
    let scaffoldReason: ScaffoldState;
    let scaffoldError: string | undefined;
    let scaffoldMissing: string[] | undefined;
    if (args.structure === undefined) {
      // Look, do not touch. `hasExistingContext` is the same detector the
      // scaffolder runs as its first guard, listing **with a delimiter** — a
      // flat listing of a real brain returns `.history/…` first and comes back
      // looking empty, which would tell onboarding to prompt for a layout over
      // the top of a live context.
      scaffoldReason = (await hasExistingContext(store))
        ? "existing-context"
        : "empty";
    } else {
      const result = await scaffoldContext(store, {
        structureTemplate: args.structure.template,
        customFolders: args.structure.folders,
        resume: args.resume === true,
      });
      scaffolded = result.scaffolded;
      scaffoldReason = result.reason;
      if (result.error) scaffoldError = redactSecrets(result.error, secrets);
      // Recorded only when we actually tried to write. `existing-context` means
      // the guard refused before the first `get`, so this attempt learned
      // nothing about what the bucket still owes — and clearing the previous
      // attempt's list there would strand a half-written bucket exactly the way
      // issue #22 describes.
      if (result.reason !== "existing-context") scaffoldMissing = result.missing;
    }

    // The status first, and the census after it. Both orderings record the
    // same two facts; only this one keeps the walk off the critical path.
    // `countNotes` makes up to forty sequential LIST round trips against
    // somebody else's bucket, and with it ahead of `record` all of that sat
    // inside the window where the binding still read `unverified` — and an
    // action that died mid-walk left a good bucket permanently unverified over
    // a number nobody was waiting for.
    const outcome = await record(ctx, args, {
      // A bucket we could not lay a context into is still connected: the
      // failure is a write we did not need to make, and the owner's existing
      // brain is exactly as it was.
      verified: true,
      reachable: true,
      writable: true,
      conditionalWrite: summary.capabilities.conditionalWrite,
      scaffolded,
      scaffoldReason,
      scaffoldMissing,
      error: scaffoldError,
    });

    // Deliberately after the scaffold as well as after the record: a bucket we
    // just laid a layout into is counted as it now stands, not as we found it.
    // `countNotes` returns `null` rather than throwing, so a bucket that stops
    // answering costs the count and nothing else.
    const counted = await countNotes(store);
    if (counted !== null) {
      try {
        await ctx.runMutation(internal.functions.storage.recordNoteCount, {
          workspaceId: args.workspaceId,
          notes: counted.notes,
          truncated: counted.truncated,
        });
      } catch {
        // Disconnected while we were walking. Same race `record` tolerates.
      }
    }

    return {
      ...outcome,
      noteCount: counted?.notes,
      noteCountTruncated: counted?.truncated,
    };
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
      // Only when we actually looked. A probe that failed before it reached the
      // bucket knows nothing new about what is in it, and overwriting a
      // previous `existing-context` with `not-attempted` would turn a transient
      // DNS blip into onboarding offering to scaffold over a live brain.
      scaffolded: outcome.scaffoldReason === "not-attempted" ? undefined : outcome.scaffolded,
      scaffoldReason:
        outcome.scaffoldReason === "not-attempted" ? undefined : outcome.scaffoldReason,
      // Already narrowed by the caller: present only when a scaffold ran.
      scaffoldMissing: outcome.scaffoldMissing,
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
