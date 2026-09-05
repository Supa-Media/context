/**
 * The file editor's data path.
 *
 * This is what lets a person actually *edit their context* from the console —
 * create, rename, move, duplicate, copy, archive, delete, and change what a
 * note is visible to — instead of opening Obsidian to do it.
 *
 * ## Where the bytes live, and where they do not
 *
 * Note content lives in the customer's bucket and nowhere else. It travels
 * through an action and is returned to the caller; it is **never** written to
 * a table, an audit `details` field, a log line, or an error message. That is
 * CLAUDE.md non-negotiable #1, and `__tests__/fileContent.test.ts` asserts it
 * behaviourally across every operation rather than trusting this paragraph.
 *
 * What *is* recorded is the audit trail: which identity did what, to which
 * paths. Paths are metadata. Content is not.
 *
 * ## The credential barrier
 *
 * There is exactly one new function in this codebase that can obtain a
 * decrypted bucket credential: `runFileOperation`. It is an `internalAction`,
 * so no client can reach it. It opens the credential, builds one `S3Store`,
 * hands that store to `lib/fileOps.ts`, and returns a **result** — a listing, a
 * note, an etag. It never returns the credential, never puts it in an error,
 * and never stores it.
 *
 * The public actions below call it. That is a real change to the property
 * `__tests__/structure.test.ts` enforces — previously *no* public function
 * could transitively reach the decrypt path at all — and it is made
 * deliberately, with the guard strengthened rather than loosened around it:
 *
 *  - the set of "barrier" functions is enumerated and pinned in that test, so
 *    adding a second one is a visible, reviewed change, not an accident;
 *  - a public function may reach the decrypt path **only** through a barrier.
 *    Calling `getBindingForGateway` directly is still a hard failure, which is
 *    exactly the attack that test was written around;
 *  - the analyzer now also treats a module-level `internal.…` reference as
 *    tainting the whole module, closing the "hide the call in a helper above
 *    the first export" hole that would otherwise make the barrier optional.
 *
 * Read the block comment in `structure.test.ts` before adding a barrier.
 *
 * ## Authorization
 *
 * Every operation resolves the caller's membership through the same
 * `requireWorkspaceAccess` / `requireWorkspaceRole` the rest of the control
 * plane uses. Reading needs `member`; writing needs `editor` or `owner`. A
 * non-member gets `WORKSPACE_NOT_FOUND` — the same error as for a workspace
 * that never existed.
 *
 * ## Visibility
 *
 * The caller's *scope* comes from their role, and it is deliberately strict:
 *
 *   owner  → `private` scope — sees everything, including private notes
 *   editor → `team` scope
 *   member → `team` scope
 *
 * `private` means "only you" (CLAUDE.md #5). Anyone who is in your workspace
 * because you put them there is, by definition, "named people you granted
 * access to" — which is `team`. Being able to *write* is a separate grant from
 * being able to see what you marked private, and conflating them is how an
 * editor invited to help with one project ends up reading a private folder.
 *
 * This is a product decision as much as a technical one; it is called out in
 * the build report.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "../_generated/api";
import {
  type ActionCtx,
  action,
  internalAction,
  internalQuery,
} from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import {
  DELETE_CONFIRMATION,
  FileOpError,
  type FileStore,
  archivePath,
  copyPath,
  createFolder,
  deletePath,
  duplicatePath,
  listFolder,
  movePath,
  readFile,
  maintainSearchIndex,
  searchNotes,
  type SearchResults,
  resetPrivacyManifest,
  setFolderVisibility,
  setVisibility,
  writeFile,
  writeImage,
  readImage,
} from "./lib/fileOps";
import type { Scope } from "./lib/privacy";
import {
  type WorkspaceRole,
  requireWorkspaceAccess,
  requireWorkspaceRole,
} from "./lib/workspaceAuth";
import type { GatewayCredential } from "./storage";

/** Same deadline `functions/provisioning.ts` puts on the customer's endpoint. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Maintenance passes that may chain behind one search's worth of work.
 *
 * A brain of a few thousand notes does not index in one pass, and the
 * alternative to chaining is what the project note calls out as still open:
 * "the complete backfill finishes without requiring repeated user searches".
 * Making somebody search eight times to finish their own index is making them
 * do the system's work.
 *
 * Each link is scheduled only by a pass that **made progress and did not
 * finish**, so a converged bucket stops at one and a bucket that cannot
 * converge — an unreadable folder, a shard that will not fit — stops as soon
 * as it stops changing rather than looping on the customer's request quota.
 * The bound is the backstop for the case both of those miss.
 */
const INDEX_SYNC_CHAIN = 12;

export { DELETE_CONFIRMATION };

/* -------------------------------------------------------------------------- */
/*                                 validators                                 */
/* -------------------------------------------------------------------------- */

const visibilityValidator = v.union(v.literal("private"), v.literal("team"));

const entryValidator = v.object({
  kind: v.union(v.literal("file"), v.literal("folder")),
  path: v.string(),
  name: v.string(),
  visibility: visibilityValidator,
  inherited: visibilityValidator,
  exception: v.boolean(),
  readOnly: v.boolean(),
  size: v.optional(v.number()),
  updatedAt: v.optional(v.number()),
});

const listingValidator = v.object({
  kind: v.literal("listing"),
  path: v.string(),
  folderDefault: visibilityValidator,
  entries: v.array(entryValidator),
  truncated: v.boolean(),
  manifestUsable: v.boolean(),
});

const imageWrittenValidator = v.object({
  kind: v.literal("imageWritten"),
  key: v.string(),
  etag: v.string(),
});

const imageValidator = v.object({
  kind: v.literal("image"),
  bytes: v.bytes(),
});

const fileValidator = v.object({
  kind: v.literal("file"),
  path: v.string(),
  text: v.string(),
  etag: v.string(),
  visibility: visibilityValidator,
  inherited: visibilityValidator,
  exception: v.boolean(),
  readOnly: v.boolean(),
});

const writtenValidator = v.object({
  kind: v.literal("written"),
  path: v.string(),
  etag: v.string(),
  conflictCheck: v.union(v.literal("conditional"), v.literal("read-compare")),
});

const movedValidator = v.object({
  kind: v.literal("moved"),
  from: v.string(),
  to: v.string(),
  paths: v.array(v.string()),
  /**
   * What the link rewrite did, and **optional on purpose**.
   *
   * `copyPath` shares this validator and rewrites nothing — a copy leaves every
   * original where it was, so there is no reference to follow — and a move that
   * found nothing to do reports zeroes rather than omitting the field. Required
   * would force `copyEntry` to invent a shape describing work it never does.
   */
  references: v.optional(
    v.object({ notes: v.number(), links: v.number(), capped: v.boolean() }),
  ),
});

const deletedValidator = v.object({
  kind: v.literal("deleted"),
  paths: v.array(v.string()),
});

const visibilityResultValidator = v.object({
  kind: v.literal("visibility"),
  path: v.string(),
  visibility: visibilityValidator,
  inherited: visibilityValidator,
  exception: v.boolean(),
});

const folderCreatedValidator = v.object({
  kind: v.literal("folderCreated"),
  path: v.string(),
  readme: v.string(),
});

const privacyResetValidator = v.object({
  kind: v.literal("privacyReset"),
  path: v.string(),
  folders: v.array(v.string()),
  /**
   * A `.context/recover/` key, and the one place the console is told one.
   *
   * Shown because "we replaced your file" and "we replaced your file and here
   * is where the old one went" are different sentences to somebody whose
   * manifest had forty rules in it. This is the only copy this product still
   * keeps of anything: `.history/` snapshots are gone, and versioning is the
   * customer's to enable at their provider.
   */
  backedUpTo: v.union(v.string(), v.null()),
  /** `folders` is short: the walk hit its cap, or a name could not be a rule. */
  partial: v.boolean(),
});

const searchResultsValidator = v.object({
  kind: v.literal("searchResults"),
  hits: v.array(
    v.object({ path: v.string(), title: v.string(), snippets: v.array(v.string()) }),
  ),
  matchCount: v.number(),
  matchCountIsFloor: v.boolean(),
  indexIncomplete: v.boolean(),
  /**
   * Nothing has indexed this bucket yet. Distinct from "no matches" on
   * purpose — see `searchNotes` in `lib/fileOps.ts` on why collapsing the two
   * would tell somebody their note does not exist.
   */
  indexMissing: v.boolean(),
});

/**
 * What one maintenance pass got through. Counts about the index's own
 * progress, and deliberately nothing about the notes it read: an indexing pass
 * is scope-blind, so a field naming a path or a term here would be an
 * existence oracle for the private half of somebody's bucket.
 */
const indexMaintainedValidator = v.object({
  kind: v.literal("indexMaintained"),
  pending: v.number(),
  changed: v.boolean(),
  complete: v.boolean(),
});

const operationResultValidator = v.union(
  listingValidator,
  fileValidator,
  writtenValidator,
  movedValidator,
  deletedValidator,
  visibilityResultValidator,
  folderCreatedValidator,
  privacyResetValidator,
  imageWrittenValidator,
  imageValidator,
  searchResultsValidator,
  indexMaintainedValidator,
);

const operationValidator = v.union(
  v.object({ kind: v.literal("list"), path: v.string() }),
  v.object({ kind: v.literal("read"), path: v.string() }),
  v.object({
    kind: v.literal("search"),
    query: v.string(),
    prefix: v.optional(v.string()),
  }),
  /**
   * Bring the search index a pass further. Scheduled, never called by a client
   * — there is no public action that reaches this variant.
   *
   * `passes` is how many *more* passes may be chained behind this one when it
   * makes progress and does not finish. A cold brain needs several, and
   * requiring a person to search repeatedly to finish their own backfill is
   * the acceptance criterion this closes; the bound is what stops a bucket
   * that never converges from scheduling itself forever.
   */
  v.object({ kind: v.literal("maintainIndex"), passes: v.optional(v.number()) }),
  v.object({
    kind: v.literal("write"),
    path: v.string(),
    text: v.string(),
    expectedEtag: v.optional(v.string()),
  }),
  v.object({ kind: v.literal("createFolder"), path: v.string() }),
  /**
   * Bytes into the opaque store, and back out again.
   *
   * Deliberately not `write`/`read` with a flag. Those carry a path and consult
   * `privacy.md`; these carry a *leaf* and must not, because an object under
   * `.images/` has no visibility of its own — it borrows the visibility of
   * whatever note references it. Sharing the variant would mean sharing the
   * question, and the manifest has no answer for a key it does not describe.
   */
  v.object({
    kind: v.literal("writeImage"),
    leaf: v.string(),
    bytes: v.bytes(),
    contentType: v.string(),
  }),
  v.object({ kind: v.literal("readImage"), leaf: v.string() }),
  v.object({ kind: v.literal("move"), from: v.string(), to: v.string() }),
  v.object({ kind: v.literal("copy"), from: v.string(), to: v.string() }),
  v.object({ kind: v.literal("duplicate"), path: v.string() }),
  v.object({ kind: v.literal("archive"), path: v.string() }),
  v.object({
    kind: v.literal("delete"),
    path: v.string(),
    confirmation: v.string(),
  }),
  v.object({
    kind: v.literal("setVisibility"),
    path: v.string(),
    visibility: visibilityValidator,
  }),
  v.object({
    kind: v.literal("setFolderVisibility"),
    path: v.string(),
    visibility: visibilityValidator,
  }),
  v.object({ kind: v.literal("resetPrivacy") }),
);

type FileOperation =
  | { kind: "list"; path: string }
  | { kind: "read"; path: string }
  | { kind: "search"; query: string; prefix?: string }
  | { kind: "maintainIndex"; passes?: number }
  | { kind: "write"; path: string; text: string; expectedEtag?: string }
  | { kind: "createFolder"; path: string }
  | { kind: "move"; from: string; to: string }
  | { kind: "copy"; from: string; to: string }
  | { kind: "duplicate"; path: string }
  | { kind: "archive"; path: string }
  | { kind: "delete"; path: string; confirmation: string }
  | { kind: "setVisibility"; path: string; visibility: "private" | "team" }
  | { kind: "setFolderVisibility"; path: string; visibility: "private" | "team" }
  | { kind: "writeImage"; leaf: string; bytes: ArrayBuffer; contentType: string }
  | { kind: "readImage"; leaf: string }
  | { kind: "resetPrivacy" };

type OperationResult =
  | ({ kind: "searchResults" } & SearchResults)
  | { kind: "indexMaintained"; pending: number; changed: boolean; complete: boolean }
  | {
      kind: "listing";
      path: string;
      folderDefault: "private" | "team";
      entries: Array<{
        kind: "file" | "folder";
        path: string;
        name: string;
        visibility: "private" | "team";
        inherited: "private" | "team";
        exception: boolean;
        readOnly: boolean;
        size?: number;
        updatedAt?: number;
      }>;
      truncated: boolean;
      manifestUsable: boolean;
    }
  | {
      kind: "file";
      path: string;
      text: string;
      etag: string;
      visibility: "private" | "team";
      inherited: "private" | "team";
      exception: boolean;
      readOnly: boolean;
    }
  | {
      kind: "written";
      path: string;
      etag: string;
      conflictCheck: "conditional" | "read-compare";
    }
  | { kind: "moved"; from: string; to: string; paths: string[] }
  | { kind: "deleted"; paths: string[] }
  | {
      kind: "visibility";
      path: string;
      visibility: "private" | "team";
      inherited: "private" | "team";
      exception: boolean;
    }
  | { kind: "folderCreated"; path: string; readme: string }
  | {
      kind: "privacyReset";
      path: string;
      folders: string[];
      backedUpTo: string | null;
      partial: boolean;
    }
  | { kind: "imageWritten"; key: string; etag: string }
  | { kind: "image"; bytes: ArrayBuffer };

/* -------------------------------------------------------------------------- */
/*                               authorization                                */
/* -------------------------------------------------------------------------- */

/**
 * A role's visibility clearance. See the module comment for why an `editor`
 * gets `team` rather than `private`.
 */
export function scopeForRole(role: WorkspaceRole): Scope {
  return role === "owner" ? "private" : "team";
}

/**
 * Resolve membership and clearance.
 *
 * INTERNAL. `actorUserId` is supplied by the calling public action, which read
 * it from the session — the same arrangement `storage.applyBinding` uses, and
 * safe for the same reason: an internal function is unreachable from any
 * client, so there is nobody who could pass a forged one.
 */
export const authorizeFileAccess = internalQuery({
  args: {
    actorUserId: v.id("users"),
    workspaceId: v.id("workspaces"),
    minimum: v.union(v.literal("member"), v.literal("editor"), v.literal("owner")),
  },
  returns: v.object({
    role: v.union(v.literal("owner"), v.literal("editor"), v.literal("member")),
    scope: v.union(v.literal("private"), v.literal("team")),
  }),
  handler: async (ctx, args) => {
    const access =
      args.minimum === "member"
        ? await requireWorkspaceAccess(ctx, args.workspaceId, args.actorUserId)
        : await requireWorkspaceRole(
            ctx,
            args.workspaceId,
            args.actorUserId,
            args.minimum,
          );
    return {
      role: access.membership.role,
      scope: scopeForRole(access.membership.role),
    };
  },
});

/* -------------------------------------------------------------------------- */
/*                            the credential barrier                          */
/* -------------------------------------------------------------------------- */

/**
 * THE CREDENTIAL BARRIER. Read the module comment before changing this.
 *
 * The only function added by the file editor that opens a bucket credential.
 * It builds one store, performs one operation, and returns a result that by
 * construction contains no credential: `operationResultValidator` has no field
 * that could hold one, and Convex enforces that validator on the way out.
 *
 * INTERNAL ACTION, so no client can call it. Its callers are the public
 * actions below, each of which has already established that the caller is a
 * member of this workspace with a sufficient role.
 */
export const runFileOperation = internalAction({
  args: {
    workspaceId: v.id("workspaces"),
    scope: v.union(v.literal("private"), v.literal("team")),
    operation: operationValidator,
  },
  returns: operationResultValidator,
  // Annotated rather than inferred: this action calls another function in the
  // same deployment, which is the inference cycle `bindStorage` has.
  handler: async (ctx, args): Promise<OperationResult> => {
    const credential: GatewayCredential | null = await ctx.runAction(
      internal.functions.storage.getBindingForGateway,
      { workspaceId: args.workspaceId },
    );
    if (credential === null) {
      throw new ConvexError({
        code: "STORAGE_NOT_CONNECTED",
        message:
          "This context has no bucket connected yet. Connect storage before browsing files.",
      });
    }

    // A plaintext secret is in scope from here to the end of this function. It
    // is used to construct one store and nothing else — it is not logged, not
    // returned, and not passed to `lib/fileOps.ts`, which only ever sees the
    // store.
    let store: FileStore;
    try {
      // One table decides which backend this workspace got — the same table
      // the gateway uses, so the console reads and writes exactly what an AI
      // client does. A second switch here would be the second place to forget
      // a new backend, and the direction that forgetting fails is "built an
      // S3 store out of a Dropbox binding".
      //
      // `timeoutFetch` is forwarded because a console request has somebody
      // waiting on it; the gateway does not need one.
      //
      // `S3Store` *declares* conditional writes because it sends `If-Match`.
      // Whether the backend honours it is a different question, and it was
      // already answered — at connect time, by `probeStore`, against this
      // actual bucket. Backblaze B2 and Wasabi accept the header and write
      // anyway. Taking the declaration would make every save look conflict-safe
      // on exactly the backends where it is not; the observed capability makes
      // `writeFile` fall back to a read-compare and say so.
      //
      // That used to be applied here, on the next line, by hand — and only
      // here, so the gateway's own stores claimed a guarantee they did not
      // have. `storeForBinding` reads the binding's probed capability itself
      // now, for every caller and every backend.
      store = storeForBinding(credential, undefined, {
        fetchImpl: timeoutFetch,
      }) as unknown as FileStore;
    } catch {
      // The constructor's message can quote the endpoint the customer typed.
      // Nothing it says helps here, and re-throwing it would put provider text
      // in front of the user with no way to know what else is in it.
      throw new ConvexError({
        code: "STORAGE_UNUSABLE",
        message:
          "This context's bucket configuration could not be used. Reconnect storage.",
      });
    }

    const result = await executeOperation(store, args.scope, args.operation as FileOperation);

    // A maintenance pass that got somewhere and is not finished schedules the
    // next one. Here rather than in a job of its own because a second internal
    // action that opens a bucket credential is a second credential barrier,
    // and `CREDENTIAL_BARRIERS` holding one entry with a long warning attached
    // is the point of it — see CLAUDE.md, "Credential barriers are enumerated,
    // never inferred". Scheduling from inside the barrier propagates no taint.
    if (
      args.operation.kind === "maintainIndex" &&
      result.kind === "indexMaintained" &&
      result.changed &&
      !result.complete
    ) {
      const passes = Math.floor(args.operation.passes ?? 0);
      if (passes > 0) {
        await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
          workspaceId: args.workspaceId,
          scope: args.scope,
          operation: { kind: "maintainIndex", passes: passes - 1 },
        });
      }
    }
    return result;
  },
});

/**
 * `fetch` with a per-request deadline.
 *
 * Guarded rather than assumed, exactly as in `functions/provisioning.ts`: this
 * runs in the Convex action runtime and in `@edge-runtime/vm` under test, and a
 * missing timeout is a slower failure rather than a wrong one.
 */
function timeoutFetch(
  input: URL | RequestInfo,
  init?: RequestInit,
): Promise<Response> {
  const timeout =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      : undefined;
  return globalThis.fetch(input, timeout ? { ...init, signal: timeout } : init);
}

/**
 * Dispatch, and turn a `FileOpError` into a `ConvexError` the console can
 * branch on.
 *
 * Exported so `__tests__/fileOps.test.ts` can drive every operation against an
 * in-memory bucket without a credential, a workspace, or a session — which is
 * what keeps the barrier above small enough to audit.
 */
export async function executeOperation(
  store: FileStore,
  scope: Scope,
  operation: FileOperation,
  now: number = Date.now(),
): Promise<OperationResult> {
  try {
    switch (operation.kind) {
      case "list": {
        const listing = await listFolder(store, { path: operation.path, scope });
        return { kind: "listing", ...listing };
      }
      case "read": {
        const file = await readFile(store, { path: operation.path, scope });
        return { kind: "file", ...file };
      }
      case "search": {
        const results = await searchNotes(store, {
          query: operation.query,
          prefix: operation.prefix,
          scope,
        });
        return { kind: "searchResults", ...results };
      }
      case "maintainIndex": {
        // Scope-blind on purpose: an index describes the bucket, and building
        // it per caller would mean one index per membership. What is scoped is
        // every path, snippet and count that leaves a *search* — `isVisible`
        // in `searchNotes`, never here.
        const pass = await maintainSearchIndex(store);
        return { kind: "indexMaintained", ...pass };
      }
      case "write": {
        const written = await writeFile(store, {
          path: operation.path,
          text: operation.text,
          expectedEtag: operation.expectedEtag,
          scope,
          now,
        });
        return { kind: "written", ...written };
      }
      case "createFolder": {
        const created = await createFolder(store, { path: operation.path, scope, now });
        return { kind: "folderCreated", ...created };
      }
      case "move": {
        const moved = await movePath(store, {
          from: operation.from,
          to: operation.to,
          scope,
          now,
        });
        return { kind: "moved", ...moved };
      }
      case "copy": {
        const copied = await copyPath(store, {
          from: operation.from,
          to: operation.to,
          scope,
        });
        return { kind: "moved", ...copied };
      }
      case "duplicate": {
        const copied = await duplicatePath(store, { path: operation.path, scope });
        return { kind: "moved", ...copied };
      }
      case "archive": {
        const moved = await archivePath(store, { path: operation.path, scope, now });
        return { kind: "moved", ...moved };
      }
      case "delete": {
        const deleted = await deletePath(store, {
          path: operation.path,
          confirmation: operation.confirmation,
          scope,
        });
        return { kind: "deleted", ...deleted };
      }
      case "setVisibility": {
        const result = await setVisibility(store, {
          path: operation.path,
          visibility: operation.visibility,
          scope,
        });
        return { kind: "visibility", ...result };
      }
      case "setFolderVisibility": {
        const result = await setFolderVisibility(store, {
          path: operation.path,
          visibility: operation.visibility,
          scope,
        });
        return { kind: "visibility", ...result };
      }
      case "writeImage": {
        const written = await writeImage(store, {
          leaf: operation.leaf,
          bytes: new Uint8Array(operation.bytes),
          contentType: operation.contentType,
        });
        return { kind: "imageWritten", ...written };
      }
      case "readImage": {
        const bytes = await readImage(store, operation.leaf);
        return { kind: "image", bytes };
      }
      case "resetPrivacy": {
        const result = await resetPrivacyManifest(store, { scope, now });
        return { kind: "privacyReset", ...result };
      }
    }
  } catch (error) {
    throw toConvexError(error);
  }
}

/**
 * A `FileOpError` carries a code and a message written for a person. Anything
 * else is a provider or runtime failure whose text we have not vetted, so it
 * becomes one fixed sentence rather than being forwarded — a bucket's error
 * body is not ours to publish, and could echo a request we made.
 */
function toConvexError(error: unknown): ConvexError<{
  code: string;
  message: string;
  currentEtag?: string;
}> {
  if (error instanceof FileOpError) {
    return new ConvexError({
      code: error.code,
      message: error.message,
      ...(error.currentEtag === undefined ? {} : { currentEtag: error.currentEtag }),
    });
  }
  if (error instanceof ConvexError) return error;
  return new ConvexError({
    code: "STORAGE_FAILED",
    message: "Your bucket did not complete that request. Try again.",
  });
}

/* -------------------------------------------------------------------------- */
/*                              the public surface                            */
/* -------------------------------------------------------------------------- */

/**
 * The signed-in user, or a `ConvexError` a client can act on.
 *
 * A plain `Error` would be scrubbed to "Server Error" and dead-end the person
 * in the root error boundary with nothing to do about it — see the note at the
 * top of `lib/workspaceAuth.ts`.
 */
async function callerId(ctx: ActionCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
  }
  return userId as Id<"users">;
}

/** One folder's contents. Any member may read. */
export const listFiles = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: listingValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "listing" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "member",
    });
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "list", path: args.path },
    });
    return result as Extract<OperationResult, { kind: "listing" }>;
  },
});

/** One note's markdown. Any member may read what their scope can see. */
export const readNote = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: fileValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "file" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "member",
    });
    const result = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "read", path: args.path },
    });
    return result as Extract<OperationResult, { kind: "file" }>;
  },
});

/**
 * Search this context's notes. Any member may search what their scope can see.
 *
 * The console's palette used to filter the folders somebody had happened to
 * expand, and said so — "only folders you have opened are searched". That is
 * a file picker, not search: the answer to "where did I write about Ikenna"
 * lived in a folder the person had not opened, which is exactly the case
 * search exists for. This asks the bucket, through the same index and the
 * same code an AI client's `search_notes` answers from.
 */
export const searchContext = action({
  args: {
    workspaceId: v.id("workspaces"),
    query: v.string(),
    prefix: v.optional(v.string()),
  },
  returns: searchResultsValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "searchResults" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "member",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "search", query: args.query, prefix: args.prefix },
    })) as Extract<OperationResult, { kind: "searchResults" }>;

    // The index this answer read is the index some earlier pass built, and a
    // search does no maintenance of its own — that is what took a console
    // search over a real brain from twenty-odd seconds to a fraction of one.
    // So the answer's own report of how far behind the index is decides
    // whether a pass runs behind it.
    //
    // **Scheduled, never called.** `ctx.runAction` would put a full listing of
    // the customer's bucket back in front of the person waiting, which is the
    // whole defect; `ctx.scheduler.runAfter` enqueues a job in a separate
    // transaction whose return value is discarded, so this action returns as
    // soon as it has an answer (CLAUDE.md, "Scheduling is not calling"). The
    // target is a statically resolvable `internal.` reference, as that rule
    // requires.
    //
    // Nothing is scheduled for a converged index. A pass per search over a
    // bucket with no work in it is a full listing per search, billed to the
    // customer, to discover there was nothing to do.
    if (result.indexMissing || result.indexIncomplete) {
      await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
        workspaceId: args.workspaceId,
        scope,
        operation: { kind: "maintainIndex", passes: INDEX_SYNC_CHAIN },
      });
    }
    return result;
  },
});

/**
 * Save a note. Requires `editor`.
 *
 * `expectedEtag` is what the editor read. Omit it only to create a new file —
 * omitting it for an existing path is a conflict, not an overwrite. There is
 * no "force" flag; the console reloads and lets the person merge.
 */
export const writeNote = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    text: v.string(),
    expectedEtag: v.optional(v.string()),
  },
  returns: writtenValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "written" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: {
        kind: "write",
        path: args.path,
        text: args.text,
        expectedEtag: args.expectedEtag,
      },
    })) as Extract<OperationResult, { kind: "written" }>;

    // Paths and an outcome. Never the text — the schema's flat-scalar `details`
    // makes an accidental `{ body }` impossible, and this is the deliberate
    // half of that rule.
    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: args.expectedEtag === undefined ? "file.create" : "file.write",
      paths: [result.path],
      details: { conflictCheck: result.conflictCheck },
    });
    return result;
  },
});

/** Create a folder. Requires `editor`. */
export const createDirectory = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: folderCreatedValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "folderCreated" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "createFolder", path: args.path },
    })) as Extract<OperationResult, { kind: "folderCreated" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "folder.create",
      paths: [result.path],
    });
    return result;
  },
});

/** Move or rename a file or folder. Requires `editor`. */
export const moveEntry = action({
  args: { workspaceId: v.id("workspaces"), from: v.string(), to: v.string() },
  returns: movedValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "moved" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "move", from: args.from, to: args.to },
    })) as Extract<OperationResult, { kind: "moved" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.move",
      paths: [result.from, result.to],
      details: { files: result.paths.length },
    });
    return result;
  },
});

/** Paste a copy at an explicit destination. Requires `editor`. */
export const copyEntry = action({
  args: { workspaceId: v.id("workspaces"), from: v.string(), to: v.string() },
  returns: movedValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "moved" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "copy", from: args.from, to: args.to },
    })) as Extract<OperationResult, { kind: "moved" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.copy",
      paths: [result.from, result.to],
      details: { files: result.paths.length },
    });
    return result;
  },
});

/** Copy beside itself under a free "… copy" name. Requires `editor`. */
export const duplicateEntry = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: movedValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "moved" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "duplicate", path: args.path },
    })) as Extract<OperationResult, { kind: "moved" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.duplicate",
      paths: [result.from, result.to],
      details: { files: result.paths.length },
    });
    return result;
  },
});

/**
 * Archive: move into `4-archive/<timestamp>/…`, recoverable by moving it back.
 *
 * This is the destructive-looking action the console offers first, precisely
 * because it is not destructive. Requires `editor`.
 */
export const archiveEntry = action({
  args: { workspaceId: v.id("workspaces"), path: v.string() },
  returns: movedValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "moved" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "archive", path: args.path },
    })) as Extract<OperationResult, { kind: "moved" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.archive",
      paths: [result.from, result.to],
      details: { files: result.paths.length, recoverable: true },
    });
    return result;
  },
});

/**
 * Delete permanently. Requires `editor` **and** the literal confirmation
 * string, which the console only sends after the person has been told plainly
 * that the file cannot be recovered.
 *
 * Nothing this product controls is kept: no archive, and **the legacy
 * `.history/` snapshots for that path are purged too** — that last clause is the
 * one this comment used to imply and the code did not do. Nothing writes new
 * snapshots any more.
 *
 * What it cannot reach is the customer's own object versioning, which we tell
 * them to enable and cannot see or delete. `lib/fileOps.ts` has the full
 * argument, and `describeDeleteForever` is the sentence the console has to keep
 * true.
 */
export const deleteEntry = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    confirmation: v.string(),
  },
  returns: deletedValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "deleted" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "editor",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: {
        kind: "delete",
        path: args.path,
        confirmation: args.confirmation,
      },
    })) as Extract<OperationResult, { kind: "deleted" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "file.delete",
      paths: result.paths,
      details: { recoverable: false },
    });
    return result;
  },
});

/**
 * Change one note's visibility, through the privacy manifest. Requires
 * `owner` — see `setDirectoryVisibility` for why, learned the hard way.
 *
 * Setting a note to its folder's default removes the exception rather than
 * writing a redundant one — which is what keeps `privacy.md` a readable
 * statement of what is unusual, and what the tree's markers read.
 */
export const setNoteVisibility = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    visibility: visibilityValidator,
  },
  returns: visibilityResultValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "visibility" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: {
        kind: "setVisibility",
        path: args.path,
        visibility: args.visibility,
      },
    })) as Extract<OperationResult, { kind: "visibility" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "visibility.note",
      paths: [result.path],
      details: { visibility: result.visibility, exception: result.exception },
    });
    return result;
  },
});

/**
 * Change a folder's default, which every note without an exception follows.
 * Requires `owner`.
 *
 * It said `editor` once, and that was a live breach: an invited editor
 * flipped private folders to `team` and read everything behind them —
 * deciding their own clearance, which is exactly the authority
 * `resetPrivacy`'s comment already reserved for the owner. All three
 * privacy-manifest writers now carry the same gate, and `lib/fileOps.ts`
 * refuses a non-`private` scope besides, so no future caller can reopen
 * this by getting one minimum wrong.
 */
export const setDirectoryVisibility = action({
  args: {
    workspaceId: v.id("workspaces"),
    path: v.string(),
    visibility: visibilityValidator,
  },
  returns: visibilityResultValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "visibility" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: {
        kind: "setFolderVisibility",
        path: args.path,
        visibility: args.visibility,
      },
    })) as Extract<OperationResult, { kind: "visibility" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "visibility.folder",
      paths: [result.path],
      details: { visibility: result.visibility },
    });
    return result;
  },
});

/**
 * Write a working `privacy.md` over a missing or unreadable one.
 *
 * Owner-only, and the one operation here that is. Every other write is an
 * editor's to make; this one replaces the file that decides what an editor is
 * allowed to see at all, and an editor rewriting it would be deciding their own
 * clearance. `authorizeFileAccess` with `minimum: "owner"` is also what makes
 * the scope handed down `private`, which `resetPrivacyManifest` requires.
 *
 * It cannot touch a manifest that parses — see `lib/fileOps.ts` for why that
 * check, rather than this one, is the safety argument — and what it writes is
 * every folder `private`, so a person cannot use it to publish anything.
 */
export const resetPrivacy = action({
  args: { workspaceId: v.id("workspaces") },
  returns: privacyResetValidator,
  handler: async (
      ctx,
      args,
    ): Promise<Extract<OperationResult, { kind: "privacyReset" }>> => {
    const actorUserId = await callerId(ctx);
    const { scope } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
      actorUserId,
      workspaceId: args.workspaceId,
      minimum: "owner",
    });
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: args.workspaceId,
      scope,
      operation: { kind: "resetPrivacy" },
    })) as Extract<OperationResult, { kind: "privacyReset" }>;

    await ctx.runMutation(internal.functions.audit.recordEvent, {
      workspaceId: args.workspaceId,
      actorUserId,
      action: "privacy.reset",
      paths: [result.path],
      // The folder *names* are metadata the audit log already records for every
      // other operation, and the count is what says how much of a map was
      // rebuilt. No rule is recorded because there is only one: private.
      details: {
        folders: result.folders.length,
        partial: result.partial,
        restored: result.backedUpTo !== null,
      },
    });
    return result;
  },
});
