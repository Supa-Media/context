/**
 * THE FILE EDITOR'S OPERATIONS.
 *
 * Every one of them, against an in-memory bucket, including the failure paths.
 * `lib/fileOps.ts` takes a `ContextStore` and nothing else, which is what lets
 * these run with no credential, no workspace and no session — and what keeps
 * the one function that *does* hold a credential
 * (`functions/files.runFileOperation`) small enough to audit by reading it.
 *
 * The assertions that matter most, and why:
 *
 *  - **A stale etag is a conflict, never an overwrite.** Two people editing the
 *    same note is not exotic; it is the normal case for a context that is also
 *    open in Obsidian and being written by an AI client. A last-writer-wins
 *    save loses work silently.
 *  - **A `team` caller cannot read, list, or infer a `private` note.** The
 *    error for "not yours" is compared byte-for-byte with the error for "never
 *    existed", in the style of `isolation.test.ts`. "Both fail" is not enough.
 *  - **Archive is recoverable and delete is not.** Both are asserted as
 *    behaviour, because "permanently delete" quietly keeping a copy would be a
 *    lie told by the one product whose whole claim is that you know where your
 *    data is.
 */

import { clearanceOf } from "../../functions/lib/clearance";
import { memoryStore, type MemoryStore } from "../storeStub.helpers";
import {
  FileOpError,
  type FileStore,
  type FolderListing,
  setFolderVisibility,
  setVisibility,
} from "../../functions/lib/fileOps";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { renderPrivacyManifest } from "../../functions/lib/scaffold";

export const NOW = 1_800_000_000_000;

/**
 * A bucket that looks like a real one: the PARA scaffold's own `privacy.md`,
 * a shared folder, a private folder, and one exception in each direction.
 */
export function bucket(options: { ignoreIfMatch?: boolean; conditional?: boolean } = {}): MemoryStore & FileStore {
  const store = memoryStore(options) as MemoryStore & FileStore;
  store.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  store.seed("index.md", "# Context\n");
  store.seed("0-inbox/README.md", "# Inbox\n");
  store.seed("1-projects/README.md", "# Projects\n");
  store.seed("1-projects/context-lc.md", "# Context.LC\n\nnotes\n");
  store.seed("1-projects/pay.md", "# Pay\n\nsalaries\n");
  store.seed("2-areas/README.md", "# Areas\n");
  store.seed("2-areas/health.md", "# Health\n");
  store.seed("4-archive/README.md", "# Archive\n");
  store.seed(".history/1-projects/context-lc.md.old.md", "# older\n");
  // A bucket connected before snapshots stopped being written. Nothing creates
  // these any more, but every bucket that predates that change is full of them
  // and `deletePath` still has to purge them — a fixture without these lets the
  // delete tests pass by having nothing to find, which is exactly how the copy
  // on the console's delete dialog came to be false the first time.
  store.seed(".history/1-projects/pay.md.2026-07-01T09-00-00-000Z.md", "# Pay\n\nsalaries\n");
  store.seed(
    ".history/1-projects/pay.md.2026-07-02T09-00-00-000Z.move.md",
    "# Pay\n\nsalaries\n",
  );
  store.seed(".history/2-areas/health.md.2026-07-01T09-00-00-000Z.md", "# Health\n\nolder\n");
  return store;
}

/** Every `.history/` key still in the bucket. */
export function historyKeys(store: MemoryStore): string[] {
  return Object.keys(store.snapshot()).filter((key) => key.startsWith(".history/"));
}

/** Make `1-projects` team-visible, with one note held back as an exception. */
export async function shareProjects(store: FileStore): Promise<void> {
  await setFolderVisibility(store, {
    path: "1-projects",
    visibility: "team",
    clearance: clearanceOf("private"),
  });
  await setVisibility(store, {
    path: "1-projects/pay.md",
    visibility: "private",
    clearance: clearanceOf("private"),
  });
}

export async function capture(fn: () => Promise<unknown>): Promise<FileOpError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof FileOpError) return error;
    throw error;
  }
  throw new Error("Expected the operation to throw, but it resolved.");
}

/** Serialize a failure so two of them can be compared exactly. */
export function errorShape(error: FileOpError): string {
  return JSON.stringify({
    code: error.code,
    message: error.message,
    currentEtag: error.currentEtag ?? null,
  });
}

/**
 * A listing's answer, minus the path the caller supplied.
 *
 * `path` echoes the request, so it is the one field that may differ between a
 * withheld folder and an absent one without disclosing which is which. Every
 * other field has to match, and that is what these comparisons assert.
 */
export function listingShape(listing: FolderListing): string {
  const { path: _echoed, ...rest } = listing;
  return JSON.stringify(rest);
}

export function names(entries: { name: string }[]): string[] {
  return entries.map((entry) => entry.name);
}
