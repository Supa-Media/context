/**
 * Replacing a whole bucket with an imported vault: clearing it in bounded
 * batches, and landing the imported files.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { canSee } from "../privacy";
import { type Clearance } from "../clearance";
import { LIST_PAGE_CAP, type FileStore } from "./store";
import { FileOpError, notFound } from "./errors";
import { requirePath } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { assertWritablePath } from "./writing";

/** Keys removed per retryable replacement pass. Small enough for every provider. */
export const VAULT_CLEAR_BATCH_OBJECTS = 100;

/**
 * Count or remove a bounded piece of a bucket for an explicitly confirmed
 * vault replacement. This deliberately sees plumbing: "replace everything"
 * means notes, attachments, privacy, audit, and derived indexes alike.
 *
 * Deletion always lists from the beginning. Persisting a continuation cursor
 * while mutating the same listing can skip keys on S3-compatible providers;
 * shrinking the first page makes every retry safe, including a retry after
 * the objects were deleted but before Convex recorded the count.
 */
export async function clearVaultBatch(
  store: FileStore,
  countOnly: boolean,
): Promise<{ mode: "counted" | "deleted"; objects: number; complete: boolean }> {
  if (countOnly) {
    let cursor: string | undefined;
    let objects = 0;
    for (let pageNumber = 0; pageNumber < LIST_PAGE_CAP; pageNumber += 1) {
      const page = await store.list({ cursor, limit: 1_000 });
      objects += page.objects.length;
      if (!page.truncated) return { mode: "counted", objects, complete: true };
      if (!page.cursor || page.cursor === cursor) {
        throw new FileOpError(
          "LISTING_INCOMPLETE",
          "Context could not finish counting this bucket. Try again before replacing it.",
        );
      }
      cursor = page.cursor;
    }
    throw new FileOpError(
      "FOLDER_TOO_LARGE",
      "This bucket is too large to replace safely in this flow.",
    );
  }

  // A logical-delete store can leave a physical tombstone at the front of
  // the listing. Its filtered page is intentionally empty but still carries
  // the provider cursor; follow those pages in this invocation so a vault
  // clear does not make permanent zero-progress passes. We still start from
  // the beginning on every retry because deleting while paging can otherwise
  // skip live keys.
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < LIST_PAGE_CAP; pageNumber += 1) {
    const page = await store.list({ cursor, limit: 1_000 });
    if ((page.objects?.length ?? 0) > 0) {
      const batch = page.objects.slice(0, VAULT_CLEAR_BATCH_OBJECTS);
      for (const object of batch) await store.delete(object.key);
      return {
        mode: "deleted",
        objects: batch.length,
        complete:
          page.truncated !== true && page.objects.length <= VAULT_CLEAR_BATCH_OBJECTS,
      };
    }
    if (!page.truncated) return { mode: "deleted", objects: 0, complete: true };
    if (!page.cursor || page.cursor === cursor) {
      throw new FileOpError(
        "LISTING_INCOMPLETE",
        "Context could not finish clearing this bucket. Try again before replacing it.",
      );
    }
    cursor = page.cursor;
  }
  throw new FileOpError(
    "FOLDER_TOO_LARGE",
    "This bucket is too large to clear safely in this flow.",
  );
}
export interface VaultImportFile {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface VaultImportResult {
  created: string[];
  skipped: string[];
  bytesCreated: number;
}

export const MAX_VAULT_IMPORT_FILE_BYTES = 4_500_000;

const VAULT_IMPORT_CONTENT_TYPES = new Set([
  "text/markdown; charset=utf-8",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/octet-stream",
]);

/**
 * Put a bounded piece of an Obsidian vault into its original bucket path.
 *
 * This is create-only. A retry skips files that landed before a connection
 * failed, and an import into a bucket somebody has already edited never
 * overwrites their newer copy. Hidden folders are refused again here rather
 * than trusted to the browser's picker; `.obsidian` can contain plugin tokens
 * and `.context`/`.audit` are Context's own plumbing.
 *
 * **Create-only is enforced two ways, because one of them is not always
 * available.** `onlyIf: { absent: true }` is what every adapter in this
 * codebase *sends*; whether the bucket behind it obeys is a different
 * question, and the one `initialCapabilities()` answers `false` to until a
 * probe says otherwise — "B2 and arbitrary S3-compatible endpoints do not
 * reliably" support conditional writes. Sending the precondition anyway and
 * trusting the reply is how a write that should have been skipped comes back
 * reported as created, with the owner's own file gone under it: the "lost
 * write with no error" that same comment calls the one failure mode a notes
 * product cannot have, arriving here during onboarding over the vault they
 * are importing. So the capability decides, exactly as `saveNote` and the
 * manifest writers already do, and an unproven backend gets a read-then-create
 * whose residual race is one round trip — the same window `scaffold.ts`
 * documents rather than defends.
 */
export async function importVaultFiles(
  store: FileStore,
  options: { files: readonly VaultImportFile[]; clearance: Clearance },
): Promise<VaultImportResult> {
  const state = await loadPrivacyState(store);
  const conditional = store.capabilities?.conditionalWrite === true;
  const created: string[] = [];
  const skipped: string[] = [];
  let bytesCreated = 0;

  for (const file of options.files) {
    const path = requirePath(file.path);
    assertWritablePath(path);
    if (path.split("/").some((segment) => segment.startsWith("."))) {
      throw new FileOpError("PATH_INVALID", "Hidden folders are not uploaded from an Obsidian vault.");
    }
    if (!canSee(path, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();
    if (file.bytes.byteLength > MAX_VAULT_IMPORT_FILE_BYTES) {
      throw new FileOpError(
        "CONTENT_TOO_LARGE",
        `A vault file must be at most ${MAX_VAULT_IMPORT_FILE_BYTES} bytes.`,
      );
    }
    if (!VAULT_IMPORT_CONTENT_TYPES.has(file.contentType)) {
      throw new FileOpError("PATH_INVALID", "That vault file type cannot be uploaded safely.");
    }

    // The precondition makes retries idempotent and closes the race between a
    // preceding GET and PUT — where the bucket honours it. Where the binding
    // has not proven it does, the read is the check, and the one-round-trip
    // window is stated rather than papered over.
    if (!conditional && (await store.get(path)) !== null) {
      skipped.push(path);
      continue;
    }
    const put = conditional
      ? await store.put(path, file.bytes, {
          onlyIf: { absent: true },
          contentType: file.contentType,
        })
      : await store.put(path, file.bytes, { contentType: file.contentType });
    if (put === null) {
      skipped.push(path);
    } else {
      created.push(path);
      bytesCreated += file.bytes.byteLength;
    }
  }

  return { created, skipped, bytesCreated };
}
