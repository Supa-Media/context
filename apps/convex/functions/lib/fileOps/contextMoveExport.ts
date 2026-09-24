/**
 * Moving between two contexts: the source's half, which lists and exports.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { isEncryptedNote } from "../noteEncryption";
import { type Visibility, canSee, effectiveVisibility, isPlumbing } from "../privacy";
import { type Clearance } from "../clearance";
import {
  eligible as collaborationEligible,
  readDocument as readCollaborationDocument,
  supported as collaborationSupported,
} from "@context/collaboration";
import { LIST_PAGE_CAP, type FileStore } from "./store";
import { FileOpError, notFound } from "./errors";
import { requirePath } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { folderVisibleAtScope } from "./listing";
import { assertWritablePath } from "./writing";
import { isFolder } from "./walk";

/* -------------------------------------------------------------------------- */
/*                       moving between two contexts                          */
/* -------------------------------------------------------------------------- */

/**
 * ONE MOVE, TWO BUCKETS, AND NEITHER FUNCTION HOLDS BOTH.
 *
 * `movePath` above is the whole operation in one call because it has one
 * store. A move into *another* context has two, in two different customers'
 * accounts under two different credentials, and there is no portable
 * server-side copy between them — the adapter has `get`/`put`/`delete`/`list`
 * and nothing else. So the bytes have to travel through the caller, and the
 * caller is the control plane.
 *
 * That is why this is three exported functions rather than one. Each takes a
 * single store, so each runs behind its own credential barrier
 * (`runFileOperation`), and the orchestrator that calls all three in turn
 * — `functions/contextMoves.ts` — never holds a bucket key at all. A single
 * `moveAcrossStores(source, destination, …)` would have been shorter and would
 * have required a second credential barrier to exist, holding two customers'
 * plaintext secrets in one scope. The enumeration in
 * `__tests__/structure.test.ts` says what that costs; this is the shape that
 * does not pay it.
 *
 * The order is copy, verify, delete, per batch, which is the discipline the
 * gateway's `materialize_move` already uses: nothing is removed from the
 * source until the destination has answered with an etag for it. A batch that
 * dies halfway leaves objects in both places, which is recoverable by running
 * the move again — the copied ones are gone from the source by then, so the
 * next pass simply does not see them. The opposite order is not recoverable.
 *
 * ## What a cross-context move deliberately does not do
 *
 *  - **It does not rewrite links.** `movePath` rewrites every reference it can
 *    see, because the notes that point at the moved one are in the same
 *    bucket. Across a boundary they are not, and a rewrite would have to reach
 *    into a context the mover may only be an editor of. The gateway's
 *    cross-context `move_note` says the same thing in its own output —
 *    "references: not rewritten across workspace boundaries".
 *  - **It does not carry attachments.** Images live under `IMAGE_PREFIX`,
 *    which `isPlumbing` refuses, and they are addressed by leaf name for the
 *    whole context rather than per folder. Carrying them would mean parsing
 *    every body to find which leaves a subtree depends on.
 *  - **It does not widen anything, ever.** See `landingVisibility`.
 */

/** Objects one batch may carry. Bounded by the Convex argument limit, not the store. */
export const CONTEXT_MOVE_BATCH_OBJECTS = 40;

/**
 * Bytes one batch may carry.
 *
 * Convex caps a function's arguments and return value at 16 MiB, and one batch
 * crosses that boundary twice — out of the export barrier and into the import
 * one — so the real ceiling is well under half of it. Eight megabytes leaves
 * room for the paths and etags travelling beside the bodies, and a single
 * object larger than this is still carried: the check is made *before* each
 * read rather than after, so a batch always carries at least one object and a
 * move can never wedge on a note it refuses to pick up.
 */
export const CONTEXT_MOVE_BATCH_BYTES = 8 * 1024 * 1024;

/**
 * Objects a move may leave behind before it stops asking.
 *
 * Something left behind is skipped by every later batch, so the skip list is
 * the one part of a move's state that grows. It is small in practice — a note
 * encrypted to the source context's key is the only thing that lands on it —
 * and a folder with a hundred of them is a different problem from the one this
 * operation solves.
 */
export const CONTEXT_MOVE_SKIP_CAP = 100;

export interface ContextMoveObject {
  /** Key in the source bucket. */
  source: string;
  /** Key in the destination bucket. */
  destination: string;
  bytes: ArrayBuffer;
  /** What the source held when it was read. The delete is conditional on it. */
  etag: string;
  /** Exact collaboration revision to tombstone after the other context lands it. */
  collaborationEtag?: string;
  /**
   * The source's effective visibility, collapsed to the two tiers.
   *
   * A group rule reads `private` here, and that is the gateway's decision made
   * again rather than a lossy cast: `@supa-leads` names a group in the SOURCE
   * workspace, and the destination resolves names in its own. Carrying the
   * string would write a rule the destination cannot resolve — reaching nobody
   * today, and reaching the wrong people the day that name is minted there.
   */
  sourceVisibility: "private" | "team";
}

/** A key this move will not carry, and the reason it can be shown. */
export interface ContextMoveSkip {
  path: string;
  reason: "encrypted";
}

export interface ContextMoveExport {
  objects: ContextMoveObject[];
  skipped: ContextMoveSkip[];
  /** Whether anything under the source is still waiting after these. */
  remaining: boolean;
}

/**
 * What the destination should land an object at, which is never wider than
 * either end.
 *
 * Two questions, and the answer is the narrower of the two: what the object
 * could be seen as where it came from, and what the folder it is landing in
 * already publishes. A `team` note into a private-default folder lands
 * private — the destination's own default wins. A `private` note into a
 * team-default folder lands private too, with an exception written for it —
 * the source's tier wins.
 *
 * **So a cross-context move never publishes anything to anybody who could not
 * already read it, on either side, and it needs no confirmation step to say
 * so.** The gateway's `move_note` refuses that second case instead, behind
 * `confirm_team_publish`; refusing is the right answer for a tool call, where
 * an agent picked the destination and the person may not have seen it, and the
 * wrong one for a folder of mixed notes that somebody dragged somewhere on
 * purpose — one checkbox cannot express per-note intent, and the safe reading
 * of it is the one this function already takes.
 */
export function landingVisibility(
  sourceVisibility: "private" | "team",
  destinationFolderDefault: Visibility,
): "private" | "team" {
  return sourceVisibility === "team" && destinationFolderDefault === "team" ? "team" : "private";
}

/**
 * Folders this caller can see, everywhere in the context, in one call.
 *
 * For the destination picker: "move this into @work" needs @work's folders,
 * and the console's tree only ever holds the folders of the context it is
 * standing in. Asking for them one `listFiles` at a time would be one Convex
 * action — and one bucket credential — per folder, so the walk happens here,
 * inside the single call that already has the store open.
 *
 * Bounded twice over, because the bucket is a customer's and somebody is
 * waiting on this: `FOLDER_PATH_CAP` folders and `FOLDER_PATH_LISTINGS`
 * listings. Past either it reports `truncated` and returns what it has, which
 * is the honest shape for a picker — a short list somebody can still use beats
 * a refusal, and the destination they wanted can always be typed into a
 * subfolder of one that is here. It is the same choice `listFolder` makes one
 * folder down, and the opposite of `keysUnder`'s, for the reason that function
 * gives: a partial *walk* cannot be operated on, and a partial *list* can be
 * read.
 */
export const FOLDER_PATH_CAP = 500;
const FOLDER_PATH_LISTINGS = 200;

export async function listFolderPaths(
  store: FileStore,
  options: { clearance: Clearance },
): Promise<{ folders: string[]; truncated: boolean }> {
  const state = await loadPrivacyState(store);
  if (state.invalid) {
    // Fail closed, exactly as every read does: an unreadable manifest is not a
    // reason to show somebody every folder in the bucket.
    throw new FileOpError(
      "PRIVACY_MANIFEST_INVALID",
      "privacy.md could not be read, so this context's folders cannot be listed.",
    );
  }

  const folders: string[] = [];
  const queue: string[] = [""];
  let listings = 0;
  let truncated = false;

  while (queue.length > 0) {
    const folder = queue.shift()!;
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
      if (listings >= FOLDER_PATH_LISTINGS) return { folders, truncated: true };
      listings += 1;
      const listing = await store.list({
        prefix: folder === "" ? "" : `${folder}/`,
        delimiter: "/",
        limit: 1_000,
        cursor,
      });
      for (const raw of listing.delimitedPrefixes ?? []) {
        const child = raw.replace(/\/+$/, "");
        if (!child || isPlumbing(child)) continue;
        if (!folderVisibleAtScope(child, options.clearance, state.rules, state.overrides)) continue;
        if (folders.length >= FOLDER_PATH_CAP) {
          truncated = true;
          continue;
        }
        folders.push(child);
        queue.push(child);
      }
      if (!listing.truncated) break;
      if (!listing.cursor || seen.has(listing.cursor)) {
        truncated = true;
        break;
      }
      seen.add(listing.cursor);
      cursor = listing.cursor;
      if (page === LIST_PAGE_CAP - 1) truncated = true;
    }
  }

  folders.sort();
  return { folders, truncated };
}

/**
 * Read the next bounded piece of what is moving out of this context.
 *
 * **It lists from the beginning of the subtree every time, and that is the
 * property that makes a move of any size finish.** A persisted continuation
 * cursor over a listing whose keys are being deleted underneath it can skip
 * objects on S3-compatible providers — `clearVaultBatch` says the same thing
 * above, for the same reason — and it would also make every retry a guess
 * about how far the last attempt got. Listing from the start costs nothing
 * extra because the previous batch's objects are *gone* by the time this runs:
 * the first page is already the next thing to move. Only what was deliberately
 * left behind is paged over again, which is what `skip` is for and why it is
 * capped.
 *
 * So this has no cap on the size of the folder. `keysUnder` refuses past
 * `FOLDER_OPERATION_CAP` because a single-store move rewrites the manifest as
 * though the whole walk happened and a partial walk cannot be operated on
 * safely. Here the unit that must be all-or-nothing is one *object* — copied,
 * verified, then deleted — so a pass that sees only the first forty of nine
 * thousand is an ordinary pass rather than a half-done move.
 */
export async function exportContextMoveBatch(
  store: FileStore,
  options: {
    from: string;
    to: string;
    clearance: Clearance;
    /** Keys an earlier pass could not carry. Never re-offered. */
    skip?: readonly string[];
    limit?: number;
    maxBytes?: number;
  },
): Promise<ContextMoveExport> {
  const from = requirePath(options.from);
  const to = requirePath(options.to);
  assertWritablePath(from);
  assertWritablePath(to);
  // Before the first read, not after the first copy: a move that discovered
  // this on the way to retiring a source would already have written the
  // destination, and the only way out of that is a duplicate.
  assertSourceCanRetire(store);

  const state = await loadPrivacyState(store);
  if (state.invalid) {
    throw new FileOpError(
      "PRIVACY_MANIFEST_INVALID",
      "privacy.md could not be read in the context this is moving out of. Nothing was moved.",
    );
  }
  if (!canSee(from, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) {
    throw notFound();
  }

  const limit = options.limit ?? CONTEXT_MOVE_BATCH_OBJECTS;
  const maxBytes = options.maxBytes ?? CONTEXT_MOVE_BATCH_BYTES;
  const skip = new Set(options.skip ?? []);

  const sourceIsFolder = await isFolder(store, from);
  const candidates: string[] = [];
  let remaining = false;

  if (!sourceIsFolder) {
    if (!skip.has(from)) candidates.push(from);
  } else {
    const prefix = `${from}/`;
    const seen = new Set<string>();
    let cursor: string | undefined;
    pages: for (let page = 0; page < LIST_PAGE_CAP; page += 1) {
      const listing = await store.list({ prefix, cursor, limit: 1_000 });
      for (const object of listing.objects ?? []) {
        const key = object.key;
        if (isPlumbing(key)) continue;
        if (skip.has(key)) continue;
        if (!canSee(key, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) {
          // Only reachable if this ever runs at `team`, which it does not:
          // starting a move out of a context requires owning it, and an owner
          // reads at `private`. Kept because "the caller sees everything" is an
          // argument about a caller, and this function takes a clearance.
          continue;
        }
        if (candidates.length >= limit) {
          remaining = true;
          break pages;
        }
        candidates.push(key);
      }
      if (!listing.truncated) break;
      if (!listing.cursor || seen.has(listing.cursor)) {
        // A store that will not page is not a store this can finish against,
        // and saying so beats moving an arbitrary prefix of a folder.
        throw new FileOpError(
          "LISTING_INCOMPLETE",
          "That folder could not be listed to the end, so nothing more was moved. Try again.",
        );
      }
      seen.add(listing.cursor);
      cursor = listing.cursor;
    }
  }

  const objects: ContextMoveObject[] = [];
  const skipped: ContextMoveSkip[] = [];
  let carried = 0;
  let looked = 0;
  for (const key of candidates) {
    // Checked before the read, so one object over the ceiling is still carried
    // rather than refused forever. The pass after this one starts behind it.
    if (carried > 0 && carried >= maxBytes) break;
    looked += 1;
    const object = await store.get(key);
    if (object === null) continue; // deleted underneath us; nothing to carry
    let bytes = await object.arrayBuffer();
    const sourceText = key.endsWith(".md") ? new TextDecoder().decode(bytes) : null;
    if (sourceText !== null && isEncryptedNote(sourceText)) {
      /*
        AN ENCRYPTED NOTE IS ENCRYPTED TO *THIS* CONTEXT'S KEY.

        Its ciphertext would arrive in the destination as a note nobody there
        can ever open, including the person who moved it — the data key is held
        per workspace (`functions/encryptionKeys.ts`) and does not travel.
        Carrying it would be a silent, permanent loss dressed up as a
        successful move, so it stays where it can still be read and the move
        reports it by name.
      */
      skipped.push({ path: key, reason: "encrypted" });
      continue;
    }
    let collaborationEtag: string | undefined;
    if (sourceText !== null && collaborationSupported(store) &&
        collaborationEligible(key, sourceText)) {
      if (store.capabilities?.conditionalDelete !== true) {
        throw new FileOpError(
          "STORAGE_UNSAFE",
          "This storage cannot safely retire a collaboratively edited note. Nothing from this batch was removed.",
        );
      }
      try {
        const base = await readCollaborationDocument(store, key);
        bytes = new TextEncoder().encode(base.text).buffer;
        collaborationEtag = base.etag;
      } catch {
        throw new FileOpError(
          "CONFLICT",
          "A note changed while this context move was reading it. Nothing from this batch was removed.",
        );
      }
    }
    carried += bytes.byteLength;
    objects.push({
      source: key,
      destination: sourceIsFolder ? `${to}${key.slice(from.length)}` : to,
      bytes,
      etag: object.etag,
      ...(collaborationEtag === undefined ? {} : { collaborationEtag }),
      sourceVisibility:
        effectiveVisibility(key, state.rules, state.overrides) === "team" ? "team" : "private",
    });
  }

  // Anything this pass listed but did not reach is still waiting. Folded in
  // here rather than set at each `break` above, because the two ceilings and
  // the skip both leave work behind and only one of them is a loop exit.
  return { objects, skipped, remaining: remaining || looked < candidates.length };
}

/**
 * What each end of a cross-context move needs of its own store.
 *
 * The gateway's `moveSafetyRefusal`, split in two because the two stores are
 * opened by two different calls through the credential barrier and nothing in
 * this process ever holds both. Each half is asked **before its own side does
 * anything**, and refused by name rather than silently degraded: the
 * degradation is "your edit was destroyed instead of refused", which is the
 * one outcome this operation may never have.
 *
 * Either conditional satisfies the source, for the reason `retireMovedSource`
 * gives at length. B2 and Wasabi have neither and are refused, which is what
 * every other conflict-safe path in this file already does to them.
 */
function assertSourceCanRetire(store: FileStore): void {
  if (
    store.capabilities?.conditionalDelete !== true &&
    store.capabilities?.conditionalWrite !== true
  ) {
    throw new FileOpError(
      "STORAGE_UNSAFE",
      "This context is on storage that cannot make a conflict-safe write, so a note edited while it moved would be lost rather than refused. Nothing was moved.",
    );
  }
}

export function assertDestinationCanLand(store: FileStore): void {
  if (store.capabilities?.conditionalCreate !== true) {
    throw new FileOpError(
      "STORAGE_UNSAFE",
      "The context you are moving into is on storage that cannot write a file only if it is absent, so a move there could overwrite something. Nothing was moved.",
    );
  }
}
