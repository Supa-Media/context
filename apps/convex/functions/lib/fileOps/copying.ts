/**
 * Copying and duplicating a note or a folder.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { isEncryptedNote } from "../noteEncryption";
import { canSee } from "../privacy";
import { type Clearance } from "../clearance";
import {
  eligible as collaborationEligible,
  readDocument as readCollaborationDocument,
  supported as collaborationSupported,
} from "@context/collaboration";
import type { FileStore } from "./store";
import { FileOpError, notFound } from "./errors";
import { requirePath, parentOf, baseName, joinPath } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { assertWritablePath } from "./writing";
import { namesInUse, duplicateName } from "./folders";
import { keysUnder, isFolder } from "./walk";
import { assertDestinationsVisible } from "./moveRules";
import type { MoveResult } from "./moving";
import { copyPrivacy } from "./privacyRewrite";

/**
 * Copy a file or folder to an explicit destination — the "paste" half of
 * copy/paste.
 *
 * The exception travels with the copy: two files with identical content should
 * not have different visibility because one of them was pasted.
 */
export async function copyPath(
  store: FileStore,
  options: { from: string; to: string; clearance: Clearance },
): Promise<MoveResult> {
  const from = requirePath(options.from);
  const to = requirePath(options.to);
  // Both ends, which `movePath` has always done and this had not. `privacy.md`
  // is the access map for the whole context, and it is readable at owner scope
  // — so an owner could copy it into a shared folder and hand every member the
  // complete list of their private folders by name. Measured before this line:
  // 935 bytes of `folder_defaults` readable at team scope. The manifest is
  // `isPlumbing`, so this is the same refusal every other reserved path gets.
  assertWritablePath(from);
  assertWritablePath(to);
  if (to === from || to.startsWith(`${from}/`)) {
    throw new FileOpError("PATH_INVALID", "A folder cannot be copied inside itself.");
  }

  const state = await loadPrivacyState(store);
  if (!canSee(from, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();

  const sourceIsFolder = await isFolder(store, from);
  // `copyPrivacy` only ever writes a per-note exception, never a folder rule,
  // so a partial copy has nothing to get wrong and `filtered` is not needed.
  const sources = sourceIsFolder
    ? (await keysUnder(store, from, options.clearance, state.rules, state.overrides)).keys
    : [from];
  if (sources.length === 0) throw notFound();

  const pairs = sources.map((key) => ({
    source: key,
    destination: sourceIsFolder ? `${to}${key.slice(from.length)}` : to,
  }));

  assertDestinationsVisible(
    pairs.map((pair) => pair.destination),
    options.clearance,
    state.rules,
    state.overrides,
  );

  for (const pair of pairs) {
    if ((await store.get(pair.destination)) !== null) {
      // This message names the path back, which is safe only because the guard
      // above has established that the caller can see both the key and the
      // folder holding it. An earlier version of this comment claimed the guard
      // read "the same rules this loop reads" and that the line was therefore
      // unreachable with a hidden path. That was wrong, and instrumenting it is
      // what showed it: the guard seeds a carried exception into its override
      // map, so a note the owner had shared out of a private folder made any
      // destination pass, and this line then answered from the real manifest.
      // The folder check above is what actually closes it.
      //
      // "No test reaches it" was the evidence for the old claim, and it was the
      // wrong kind of evidence — the suite had no team-scope coverage of this
      // line at all. There is one now.
      throw new FileOpError(
        "DESTINATION_EXISTS",
        `Something already exists at ${pair.destination}.`,
      );
    }
  }

  for (const pair of pairs) {
    const object = await store.get(pair.source);
    if (object === null) throw notFound();
    const sourceText = await object.text();
    let body = sourceText;
    if (collaborationSupported(store) && !isEncryptedNote(sourceText) && collaborationEligible(pair.source, sourceText)) {
      try {
        body = (await readCollaborationDocument(store, pair.source)).text;
      } catch {
        throw new FileOpError("STORAGE_UNSAFE", "This note cannot be copied safely for collaborative editing.");
      }
    }
    await store.put(pair.destination, body);
  }

  await copyPrivacy(
    store,
    pairs.map((pair) => ({ from: pair.source, to: pair.destination })),
    sourceIsFolder ? { from, to } : null,
  );

  return { from, to, paths: pairs.map((pair) => pair.destination) };
}

/** Copy beside itself under a free "… copy" name. */
export async function duplicatePath(
  store: FileStore,
  options: { path: string; clearance: Clearance },
): Promise<MoveResult> {
  const path = requirePath(options.path);
  const parent = parentOf(path);

  // Before the listing, not after it — and in `copyPath`'s order, which is
  // `assertWritablePath` and then `canSee`. Both of those run on this same path
  // a few lines below, so no input is accepted or refused that was not already,
  // and keeping the order keeps every refusal byte-identical too: dropping
  // `assertWritablePath` here made Duplicate the only operation in this file
  // that answered `FILE_NOT_FOUND` for a dot-prefixed path where `writeFile`,
  // `movePath`, `copyPath` and `deletePath` all answer `PATH_INVALID`.
  //
  // What changes is only what happens *before* a refusal. A caller who cannot
  // see `path` no longer causes a full walk of its parent on the strength of a
  // name they typed — and no longer reads that folder's *size* off the answer:
  // `namesInUse` refuses a walk it could not finish, so a parent too large to
  // list came back `FOLDER_TOO_LARGE` while a small one came back
  // `FILE_NOT_FOUND`, for two notes the caller could see neither of.
  assertWritablePath(path);
  const state = await loadPrivacyState(store);
  if (!canSee(path, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();

  // Every name in use, not every name this caller can see.
  //
  // Picking from the visible siblings alone chooses a name a hidden note may
  // already hold, and `copyPath`'s guard then refuses it — so Duplicate
  // answered "that file does not exist" if and only if a private note occupied
  // the "… copy" name, and the caller could aim it by writing the name they
  // wanted to test first.
  //
  // The names read here never leave this function. What does leave is the one
  // it picks, and that still carries a bit: `x copy 2.md` where `x copy.md` was
  // free says something holds `x copy.md`. That is the residual
  // `assertDestinationsVisible` documents and `writeFile` has had all along —
  // the same caller learns as much in one write — so this removes a hard
  // refusal rather than an inference. Saying it discloses nothing would be the
  // overclaim this file has already made once.
  const taken = await namesInUse(store, parent);
  const destination = joinPath(parent, duplicateName(baseName(path), taken));
  return await copyPath(store, { from: path, to: destination, clearance: options.clearance });
}
