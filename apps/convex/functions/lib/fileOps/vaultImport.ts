/**
 * Replacing a whole bucket with an imported vault: clearing it in bounded
 * batches, and landing the imported files.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { canSee } from "../privacy";
import { type Clearance } from "../clearance";
import { type FileStore } from "./store";
import { FileOpError, notFound } from "./errors";
import { requirePath } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { assertWritablePath } from "./writing";
import { KEYED_REFUSAL } from "../noteIds/keyedStore";

/**
 * Clearing a bucket for a vault replacement. Refused in every workspace, before
 * anything is listed or deleted: clearing deletes by key, and every workspace
 * keeps its notes under their ids (2026-10-22), so the tree's rows would still
 * name every note just deleted and the import would land at paths no row
 * adopts. A replacement has to be rebuilt on rows before it can come back.
 */
export async function clearVaultBatch(
  _store: FileStore,
  _countOnly: boolean,
): Promise<{ mode: "counted" | "deleted"; objects: number; complete: boolean }> {
  throw new FileOpError("KEYED_WORKSPACE", KEYED_REFUSAL);
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
