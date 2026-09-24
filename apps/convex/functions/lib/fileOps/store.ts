/**
 * The limits every file operation respects, and the slice of `ContextStore`
 * they run against.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { type ScaffoldStore } from "../scaffold";

/* -------------------------------------------------------------------------- */
/*                                   limits                                   */
/* -------------------------------------------------------------------------- */

/** S3 caps keys at 1024; the gateway's `normalizePath` caps paths at 512. */
export const MAX_PATH_LENGTH = 512;
/** One note. Generous for markdown, small enough that a paste cannot DoS an action. */
export const MAX_NOTE_BYTES = 2_000_000;
/** Pages of a listing we will walk. 1000 keys each. */
// Matched to the gateway's own `LIST_PAGE_CAP`. They disagreed at 20 vs 100,
// which meant a folder `list_notes` walked happily was refused by the console —
// and the page size is a *hint*: S3 may return fewer keys than `max-keys` and
// Dropbox documents `limit` as approximate, so the object count this actually
// corresponds to is provider-dependent and can be far lower than the arithmetic
// suggests. A cap that fires on an ordinary folder is an outage, and the answer
// here is a refusal rather than a silent half-operation.
export const LIST_PAGE_CAP = 100;
/** Keys a single folder move/copy/delete may touch. Same cap the gateway uses. */
export const FOLDER_OPERATION_CAP = 500;
/** Attempts at the compare-and-swap that rewrites `privacy.md`. */
export const MANIFEST_CAS_ATTEMPTS = 5;

/**
 * Legacy only. Nothing writes a `.history/` snapshot any more — versioning is
 * the customer's to enable at their provider — but buckets connected before
 * that change are full of them, so `deletePath` still purges what it finds.
 */

/**
 * Where the one copy this product still keeps for somebody goes.
 *
 * `.context/` is ours the way `.audit/` is: a dot-prefixed segment, so every
 * `isPlumbing` check in both engines already refuses it without being told,
 * and `.context-probe/` is a different segment that no prefix test collides
 * with. `recover/` under it is for a file we replaced that the owner may want
 * back — today only the unreadable `privacy.md` that `resetPrivacyManifest`
 * repairs, whose other forty lines are their record of what was shared.
 *
 * This is deliberately not a general history. It is owner-triggered, one file
 * per repair, and it exists because that file is not recoverable from anywhere
 * else — not from versioning the customer may not have enabled, and not from
 * the notes, which is the test for whether anything else belongs here.
 */
export const RECOVER_PREFIX = ".context/recover/";
export const TRASH_ROOT = ".context/trash";

/**
 * Retired as a constant: which folder is *the* archive is a question about the
 * context's own manifest, not a literal. See `archiveRoot` in `lib/privacy.ts`.
 */

/* -------------------------------------------------------------------------- */
/*                                   store                                    */
/* -------------------------------------------------------------------------- */

/**
 * The slice of `ContextStore` these operations use.
 *
 * `ScaffoldStore` already declares `get`/`put`/`list` structurally (the adapter
 * is JSDoc-typed JavaScript whose typedefs are not importable bindings); this
 * adds the `delete` and the capability descriptor. The real `S3Store` satisfies
 * it by construction, and the tests run the real adapter against a wire-level
 * stub.
 */
export interface FileStore extends ScaffoldStore {
  delete(
    key: string,
    options?: { onlyIf?: { etagMatches?: string } },
  ): Promise<void | null>;
  capabilities?: {
    conditionalWrite: boolean;
    conditionalCreate?: boolean;
    conditionalDelete?: boolean;
  };
}
