/**
 * The return validators for `functions/files.ts`: listings, notes, writes,
 * moves, visibility, storage layout, activity and durable moves.
 *
 * Split out of `functions/files.ts`, which registers every function that uses
 * them; that file's header holds the rules they keep. Convex enforces each of
 * these on the way out, which is why none has a field that could hold a
 * credential.
 */

import { storageLayoutStateValidator } from "../storageLayout";
import { v } from "convex/values";

/* -------------------------------------------------------------------------- */
/*                                 validators                                 */
/* -------------------------------------------------------------------------- */

/**
 * What a console caller may ASK for. Two-valued, and it stays that way.
 *
 * A rule naming a group reaches `privacy.md` from the console's own group
 * controls or a person's editor — never from `setNoteVisibility` or
 * `setFolderVisibility`, whose whole job is the two tiers. Widening this
 * would make every path that takes a visibility a way to mint a rule, which
 * is the opposite of the gateway's position that no AI client can.
 */
export const visibilityValidator = v.union(v.literal("private"), v.literal("team"));

/**
 * What a visibility may be on the way OUT.
 *
 * `v.string()` rather than the two literals, because a rule may name a group
 * and a bucket can already hold one. The narrow validator did not merely
 * mislabel such a note — it **threw at the boundary**, so one hand-edited rule
 * took the whole console listing down. What a group name may contain is
 * enforced where it is parsed (`GROUP_SCOPE_PATTERN` in `lib/privacy.ts`),
 * which fails the manifest closed rather than per response; there is nothing
 * left for this validator to check that the parser has not.
 */
const visibilityReadValidator = v.string();

const entryValidator = v.object({
  kind: v.union(v.literal("file"), v.literal("folder")),
  path: v.string(),
  name: v.string(),
  visibility: visibilityReadValidator,
  inherited: visibilityReadValidator,
  exception: v.boolean(),
  readOnly: v.boolean(),
  size: v.optional(v.number()),
  updatedAt: v.optional(v.number()),
});

export const listingValidator = v.object({
  kind: v.literal("listing"),
  path: v.string(),
  folderDefault: visibilityReadValidator,
  entries: v.array(entryValidator),
  truncated: v.boolean(),
  manifestUsable: v.boolean(),
});

export const imageWrittenValidator = v.object({
  kind: v.literal("imageWritten"),
  key: v.string(),
  etag: v.string(),
});

export const imageValidator = v.object({
  kind: v.literal("image"),
  bytes: v.bytes(),
});

export const emojiListValidator = v.object({
  kind: v.literal("emojiList"),
  emoji: v.array(v.object({ name: v.string(), leaf: v.string() })),
});

export const emojiImageValidator = v.object({
  kind: v.literal("emojiImage"),
  bytes: v.bytes(),
  contentType: v.string(),
});

export const emojiStoredValidator = v.object({
  kind: v.literal("emojiStored"),
  name: v.string(),
  leaf: v.string(),
});

export const emojiRemovedValidator = v.object({ kind: v.literal("emojiRemoved") });

export const vaultImportResultValidator = v.object({
  kind: v.literal("vaultImported"),
  created: v.array(v.string()),
  skipped: v.array(v.string()),
  bytesCreated: v.number(),
});

export const vaultClearResultValidator = v.object({
  kind: v.literal("vaultCleared"),
  mode: v.union(v.literal("counted"), v.literal("deleted")),
  objects: v.number(),
  complete: v.boolean(),
});

const replacementStatusValidator = v.object({
  phase: v.union(v.literal("counting"), v.literal("deleting"), v.literal("uploading")),
  totalObjects: v.number(),
  deletedObjects: v.number(),
});

export const vaultImportJobStatusValidator = v.object({
  jobId: v.id("vaultImportJobs"),
  strategy: v.union(v.literal("merge"), v.literal("folder"), v.literal("replace")),
  status: v.union(v.literal("active"), v.literal("paused"), v.literal("complete")),
  totalFiles: v.number(),
  completedFiles: v.number(),
  createdFiles: v.number(),
  skippedFiles: v.number(),
  completedBatches: v.array(v.number()),
  replacement: v.optional(replacementStatusValidator),
});

export const fileValidator = v.object({
  kind: v.literal("file"),
  path: v.string(),
  text: v.string(),
  etag: v.string(),
  rawEtag: v.optional(v.string()),
  updatedAt: v.optional(v.number()),
  visibility: visibilityReadValidator,
  inherited: visibilityReadValidator,
  exception: v.boolean(),
  readOnly: v.boolean(),
  /**
   * The note is stored encrypted and `text` is its ciphertext.
   *
   * `readOnly` is already true whenever this is, so a console that predates the
   * field still refuses to edit one — the flag adds the *explanation*, not the
   * protection. See `docs/decisions/encryption.md`.
   */
  encrypted: v.boolean(),
  /** Present for ordinary Markdown notes backed by the collaboration engine. */
  documentId: v.optional(v.string()),
  update: v.optional(v.string()),
});

/**
 * One object in the offline mirror's manifest. See `ManifestEntry` in
 * `lib/fileOps.ts`: the visibility fields are a listing's, `etag` is the
 * store's own from the listing and is absent only where the store gave none.
 */
const manifestEntryValidator = v.object({
  path: v.string(),
  etag: v.optional(v.string()),
  size: v.optional(v.number()),
  updatedAt: v.optional(v.number()),
  visibility: visibilityReadValidator,
  inherited: visibilityReadValidator,
  exception: v.boolean(),
  readOnly: v.boolean(),
});

export const manifestValidator = v.object({
  kind: v.literal("manifest"),
  entries: v.array(manifestEntryValidator),
  /**
   * Every folder the tree would draw for this caller, the root first. See
   * `ManifestFolder` in `lib/fileOps.ts`.
   */
  folders: v.array(v.object({ path: v.string(), visibility: visibilityReadValidator })),
  /** Pass back to get what follows. Always a path this caller was given. */
  cursor: v.union(v.string(), v.null()),
  /** The walk could not finish: the pages so far are a floor, not a total. */
  truncated: v.boolean(),
  manifestUsable: v.boolean(),
});

/**
 * A batch read. Each note is `fileValidator` itself — the very shape
 * `readNote` returns — and a refusal is the code and message `readNote` would
 * have thrown, so a hidden note and a missing one are the same row.
 */
export const notesValidator = v.object({
  kind: v.literal("notes"),
  results: v.array(
    v.union(
      v.object({ path: v.string(), outcome: v.literal("read"), note: fileValidator }),
      v.object({
        path: v.string(),
        outcome: v.literal("error"),
        code: v.string(),
        message: v.string(),
      }),
      v.object({ path: v.string(), outcome: v.literal("deferred") }),
    ),
  ),
});

/**
 * What a form block's response files did on this write.
 *
 * Two lists of paths and reasons — never a body, never an etag of somebody
 * else's note. It is reported back to the author because a `responses:` aimed
 * at a file that already holds something is a form that will silently collect
 * nothing, and they are the only person who can re-aim it.
 */
const formSeedValidator = v.object({
  created: v.array(v.string()),
  occupied: v.array(v.string()),
});

export const writtenValidator = v.object({
  kind: v.literal("written"),
  path: v.string(),
  etag: v.string(),
  /** What was stored, in bytes. See `WriteResult` — it is for `activity.md`. */
  bytes: v.number(),
  conflictCheck: v.union(v.literal("conditional"), v.literal("read-compare")),
  forms: formSeedValidator,
});

export const movedValidator = v.object({
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
  /**
   * A single note's etag at its new path, where the bucket answered with one.
   * The offline queue carries it on to whatever it was asked to do next with
   * that note — see `movePath`.
   */
  etag: v.optional(v.string()),
});

export const deletedValidator = v.object({
  kind: v.literal("deleted"),
  paths: v.array(v.string()),
});

export const folderPathsValidator = v.object({
  kind: v.literal("folderPaths"),
  folders: v.array(v.string()),
  /** The walk hit a ceiling. The list is a floor, and the picker says so. */
  truncated: v.boolean(),
});

export const contextMoveExportedValidator = v.object({
  kind: v.literal("contextMoveExported"),
  objects: v.array(v.object({
    source: v.string(),
    destination: v.string(),
    bytes: v.bytes(),
    etag: v.string(),
    collaborationEtag: v.optional(v.string()),
    sourceVisibility: v.union(v.literal("private"), v.literal("team")),
  })),
  skipped: v.array(v.object({
    path: v.string(),
    reason: v.literal("encrypted"),
  })),
  remaining: v.boolean(),
});

export const contextMoveLandedValidator = v.object({
  kind: v.literal("contextMoveLanded"),
  landed: v.array(v.object({
    source: v.string(),
    destination: v.string(),
    etag: v.string(),
  })),
  /**
   * Why the batch stopped short, when it did.
   *
   * Reported rather than thrown, because the sources of everything in `landed`
   * still have to be removed — see `importContextMoveBatch`. A thrown error
   * here would leave the same objects in both buckets with nothing recording
   * which of them is the copy.
   */
  failure: v.union(
    v.null(),
    v.object({ destination: v.string(), code: v.string(), message: v.string() }),
  ),
});

export const contextMoveRemovedValidator = v.object({
  kind: v.literal("contextMoveRemoved"),
  deleted: v.array(v.string()),
  conflicts: v.array(v.string()),
});

export const contextMoveFinishedValidator = v.object({
  kind: v.literal("contextMoveFinished"),
});

export const visibilityResultValidator = v.object({
  kind: v.literal("visibility"),
  path: v.string(),
  visibility: visibilityReadValidator,
  inherited: visibilityReadValidator,
  exception: v.boolean(),
});

export const folderCreatedValidator = v.object({
  kind: v.literal("folderCreated"),
  path: v.string(),
  readme: v.string(),
});

export const privacyResetValidator = v.object({
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

export const storageMigrationResultValidator = v.object({
  kind: v.literal("storageMigrated"),
  state: storageLayoutStateValidator,
  objectsCopied: v.number(),
  objectsVerified: v.number(),
  objectsDeleted: v.number(),
  conflicts: v.number(),
  error: v.optional(v.string()),
});

/**
 * What `readStorageLayout` hands back: an observation, not an outcome.
 *
 * `observed: false` is a bucket that would not answer, and it carries no state
 * — the caller records nothing rather than writing down a guess. `observed`
 * with `state: null` is the real answer "there is pre-v1 plumbing here and
 * nothing has moved it", which is a different fact and the one the console was
 * missing. A bucket that never held any answers `complete`, because that is
 * what its hidden files are — see `apps/mcp/src/storageLayout.js`.
 */
export const storageLayoutReadValidator = v.object({
  kind: v.literal("storageLayoutRead"),
  observed: v.boolean(),
  state: v.union(storageLayoutStateValidator, v.null()),
});

/**
 * One activity entry, as the console draws it.
 *
 * Paths, names, a kind and a time. No note text, by construction — the file it
 * comes from has none either, which is the point of recording paths rather
 * than diffs.
 */
export const activityEntryValidator = v.object({
  at: v.string(),
  kind: v.string(),
  paths: v.array(v.string()),
  n: v.number(),
  vis: v.union(v.literal("team"), v.literal("private")),
  by: v.union(v.string(), v.null()),
  via: v.union(v.string(), v.null()),
  note: v.union(v.string(), v.null()),
});

export const activityValidator = v.object({
  kind: v.literal("activity"),
  entries: v.array(activityEntryValidator),
});

export const durableMoveValidator = v.object({
  jobId: v.id("gatewayJobs"),
  status: v.union(
    v.literal("queued"),
    v.literal("running"),
    v.literal("complete"),
    v.literal("failed"),
  ),
  phase: v.optional(v.union(v.literal("copying"), v.literal("deleting"))),
  completed: v.optional(v.number()),
  total: v.optional(v.number()),
  updatedAt: v.number(),
});
