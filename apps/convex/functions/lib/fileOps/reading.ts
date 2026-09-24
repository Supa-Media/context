/**
 * Reading one note, or a batch of them, at the caller's clearance.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { isEncryptedNote } from "../noteEncryption";
import { type Visibility, canSee } from "../privacy";
import { type Clearance } from "../clearance";
import { forwardPath, readForwarding } from "../../../../mcp/src/forwarding.js";
import {
  eligible as collaborationEligible,
  readDocument as readCollaborationDocument,
  supported as collaborationSupported,
} from "@context/collaboration";
import { MAX_NOTE_BYTES, type FileStore } from "./store";
import { type FileErrorCode, FileOpError, notFound } from "./errors";
import { requirePath } from "./paths";
import { type PrivacyState, loadPrivacyState } from "./privacyState";
import { describeFile } from "./listing";
import { byteLength } from "./writing";

/* -------------------------------------------------------------------------- */
/*                                   reading                                  */
/* -------------------------------------------------------------------------- */

export interface FileContents {
  path: string;
  text: string;
  etag: string;
  /** Provider object version, retained for mirror freshness checks. */
  rawEtag?: string;
  visibility: Visibility;
  inherited: Visibility;
  exception: boolean;
  /** `privacy.md`. The console shows it with an explanation instead of a textarea. */
  readOnly: boolean;
  /**
   * The note is stored encrypted, and this response is its ciphertext.
   *
   * The console shows a locked note rather than an editor. `readOnly` is forced
   * true beside it, which is what makes the *existing* console behave correctly
   * on a build that has never heard of this field — the same treatment
   * `privacy.md` already gets, and the reason the flag is additive rather than a
   * new mode.
   *
   * The control plane holds no key, so there is nothing here to decrypt with.
   * See `functions/lib/noteEncryption.ts` for why that is deliberate.
   */
  encrypted: boolean;
  /** Stable collaboration generation and complete Yjs base for supported notes. */
  documentId?: string;
  update?: string;
}

export async function readFile(
  store: FileStore,
  options: { path: string; clearance: Clearance; forward?: "never" | "onMiss" },
): Promise<FileContents> {
  const path = requirePath(options.path);
  const state = await loadPrivacyState(store);
  if (options.forward !== "onMiss") {
    return await readVisibleFile(store, state, path, options.clearance);
  }

  /*
    A STALE ADDRESS IS FORWARDED, AFTER IT HAS MISSED AND NEVER BEFORE.

    A path means what it says *today*: if a note lives where the address
    points, that note is the answer, even when something else once lived there.
    Only an address that resolves to nothing has anything to gain from the
    forwarding ledger — which also keeps the extra GET off every successful
    read.

    A share is the one caller that needs the opposite order, because its grant
    was minted on a *note* rather than on a string. It resolves through the
    `forward` operation before it reads, for the reasons in `shares.ts`; the
    two orders are deliberately not one rule.

    The destination still goes through `readVisibleFile`, so `canSee` is
    re-asked there and a forward can never widen what a caller reaches.
  */
  try {
    return await readVisibleFile(store, state, path, options.clearance);
  } catch (error) {
    if (!(error instanceof FileOpError) || error.code !== "FILE_NOT_FOUND") throw error;
    const forwarded = forwardPath(await readForwarding(store), path);
    if (forwarded === path) throw error;
    return await readVisibleFile(store, state, forwarded, options.clearance);
  }
}

/**
 * The body of `readFile`, against a manifest already loaded — so `readFiles`
 * reads a batch through exactly this, and a single read and a batched one
 * cannot come to disagree about who may see a note.
 */
async function readVisibleFile(
  store: FileStore,
  state: PrivacyState,
  path: string,
  clearance: Clearance,
): Promise<FileContents> {
  if (!canSee(path, clearance.scope, state.rules, state.overrides, clearance.names)) throw notFound();

  const object = await store.get(path);
  if (object === null) throw notFound();

  const described = describeFile(path, state.rules, state.overrides);
  const text = await object.text();
  // The ciphertext is returned rather than withheld: it is what is in the
  // bucket, the caller has already passed `canSee`, and the file says in its own
  // plain frontmatter what it is. What changes is that it is never editable —
  // `readOnly` is forced, so an older console that ignores `encrypted` still
  // refuses to put it in a textarea.
  const encrypted = isEncryptedNote(text);
  let collaboration: { documentId: string; update: string; text: string; etag: string; rawEtag: string } | null = null;
  if (!encrypted && collaborationSupported(store) && collaborationEligible(path, text)) {
    try {
      collaboration = await readCollaborationDocument(store, path);
    } catch {
      throw new FileOpError(
        "STORAGE_UNSAFE",
        "This note cannot be opened safely for collaborative editing right now.",
      );
    }
  }
  return {
    path,
    text: collaboration?.text ?? text,
    etag: collaboration?.etag ?? object.etag,
    ...(collaboration ? { rawEtag: collaboration.rawEtag } : {}),
    visibility: described.visibility,
    inherited: described.inherited,
    exception: described.exception,
    readOnly: described.readOnly || encrypted,
    encrypted,
    ...(collaboration
      ? { documentId: collaboration.documentId, update: collaboration.update }
      : {}),
  };
}

/** Paths one `readFiles` call may name. */
export const READ_BATCH_PATHS = 50;
/**
 * Note bytes one `readFiles` call may return: two of the largest note the
 * console will write. Past it the rest are deferred rather than read, so a
 * batch of big notes cannot make a response nothing can carry.
 */
export const READ_BATCH_BYTES = 2 * MAX_NOTE_BYTES;

/**
 * One path's answer in a batch.
 *
 * `read` carries exactly what `readFile` returns. `error` carries a refusal's
 * code and message — `FILE_NOT_FOUND` for a note that is missing *and* for one
 * the caller may not see, identically, because both came from `readFile`'s own
 * `notFound()`. `deferred` means the byte budget was spent before this path was
 * looked at: ask again, nothing is implied about the path.
 */
export type BatchRead =
  | { path: string; outcome: "read"; note: FileContents }
  | { path: string; outcome: "error"; code: FileErrorCode; message: string }
  | { path: string; outcome: "deferred" };

/**
 * Read several notes at once, for the offline mirror to fill itself.
 *
 * Every path goes through `readVisibleFile`, the body of `readFile`, against
 * one load of `privacy.md` — so the batch is N single reads sharing a manifest,
 * not a second privacy path. A refusal is per path and does not fail the batch:
 * one note deleted since the manifest was taken must not stop the other
 * forty-nine arriving.
 *
 * `path` on each answer echoes what was asked, so a caller can match answers
 * to requests even for a path that did not normalise. Answers come back in
 * request order.
 *
 * The budget is spent only by notes that were read, which only a visible note
 * is, and once it is spent nothing further is looked at. So whether a path is
 * `deferred` turns on the sizes of notes the caller can read and never on
 * whether a hidden one exists. The first note always reads, whatever its size,
 * so every batch makes progress.
 */
export async function readFiles(
  store: FileStore,
  options: { paths: readonly string[]; clearance: Clearance },
): Promise<BatchRead[]> {
  if (options.paths.length > READ_BATCH_PATHS) {
    throw new FileOpError(
      "BATCH_TOO_LARGE",
      `Read at most ${READ_BATCH_PATHS} notes at a time.`,
    );
  }
  if (options.paths.length === 0) return [];

  const state = await loadPrivacyState(store);
  const results: BatchRead[] = [];
  let bytes = 0;
  let spent = false;
  for (const requested of options.paths) {
    if (spent) {
      results.push({ path: requested, outcome: "deferred" });
      continue;
    }
    try {
      const note = await readVisibleFile(store, state, requirePath(requested), options.clearance);
      const size = byteLength(note.text);
      if (bytes > 0 && bytes + size > READ_BATCH_BYTES) {
        spent = true;
        results.push({ path: requested, outcome: "deferred" });
        continue;
      }
      bytes += size;
      results.push({ path: requested, outcome: "read", note });
    } catch (error) {
      // A refusal is this path's answer. Anything else is the bucket failing,
      // which is the whole batch's problem and goes up as one.
      if (!(error instanceof FileOpError)) throw error;
      results.push({ path: requested, outcome: "error", code: error.code, message: error.message });
    }
  }
  return results;
}
