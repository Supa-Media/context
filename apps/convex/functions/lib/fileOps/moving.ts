/**
 * Moving or renaming a note or a folder inside one context.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import { isEncryptedNote } from "../noteEncryption";
import {
  type Visibility,
  canSee,
  effectiveVisibility,
  narrowerVisibility,
  nextOverrides,
  visibilityOf,
} from "../privacy";
import { type Clearance } from "../clearance";
import { recordForwarding } from "../../../../mcp/src/forwarding.js";
import { pruneEmptyFolders } from "../../../../mcp/src/store/index.js";
import {
  eligible as collaborationEligible,
  moveDocument as moveCollaborationDocument,
  supported as collaborationSupported,
} from "@context/collaboration";
import type { FileStore } from "./store";
import { FileOpError, notFound } from "./errors";
import { requirePath } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { folderVisibleAtScope } from "./listing";
import { assertWritablePath } from "./writing";
import { keysUnder, isFolder } from "./walk";
import { assertMoveDestinationsVisible } from "./moveRules";
import { type ReferenceRewrite, rewriteReferences } from "./references";
import { mutateManifest, remapPrivacy } from "./privacyRewrite";

export interface MoveResult {
  from: string;
  to: string;
  /** Every key that moved. Paths, which are metadata — never content. */
  paths: string[];
  /** What the link rewrite did. See `rewriteReferences`. */
  references?: ReferenceRewrite;
  /**
   * The moved note's etag at its new path — a single note only, and only where
   * the bucket answered the write with one. See `movePath`.
   */
  etag?: string;
}

/**
 * Move or rename. A rename is a move whose parent does not change, so there is
 * one implementation rather than two that can disagree.
 *
 * Works on a file or a whole folder. The destination must not exist: this
 * never merges and never overwrites.
 *
 * The privacy manifest moves with it. That is the part it would be easy to
 * skip and expensive to get wrong — without it, dragging a private note into a
 * `team` folder silently shares it, because the exception that kept it private
 * still names a path that no longer exists.
 */
export async function movePath(
  store: FileStore,
  options: {
    from: string;
    to: string;
    clearance: Clearance;
    now: number;
    /**
     * The version of the note this move was asked about. Given, the move is
     * refused with `CONFLICT` and the current etag when the note is anywhere
     * else — the same answer a queued edit gets, for the same reason: a rename
     * typed offline is a decision about the note as it was then. Absent is an
     * online press made while looking at the listing, exactly as before.
     *
     * A note only: a folder has no version to name.
     */
    expectedEtag?: string;
    /**
     * Refuse, rather than read-compare, where the bucket cannot make the check
     * atomic. The plugin runtime asks for this — a plugin renames as part of a
     * transaction it cannot see the end of. A person's queued rename does not:
     * it gets the check an online save gets on the same bucket.
     */
    requireAtomic?: boolean;
  },
): Promise<MoveResult> {
  const from = requirePath(options.from);
  const to = requirePath(options.to);
  assertWritablePath(from);
  assertWritablePath(to);
  if (from === to) return { from, to, paths: [] };
  if (to.startsWith(`${from}/`)) {
    throw new FileOpError("PATH_INVALID", "A folder cannot be moved inside itself.");
  }
  // ...nor onto one of its own ancestors, which is a rename that flattens a
  // folder into a parent it is already inside. It also breaks the one thing
  // that makes the manifest repair below sound: a renamed rule normally lands
  // under the destination, where it cannot outrank a rule kept under the
  // source. When the destination IS an ancestor the two trees overlap, and a
  // renamed `.../b/b/hr/deep: team` came out longer than the `.../b/hr: private`
  // put back for a survivor, which published it.
  if (from.startsWith(`${to}/`)) {
    throw new FileOpError(
      "PATH_INVALID",
      "A folder cannot be moved onto a folder it is already inside.",
    );
  }

  const state = await loadPrivacyState(store);
  if (!canSee(from, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();

  const sourceIsFolder = await isFolder(store, from);
  if (options.expectedEtag !== undefined && sourceIsFolder) {
    throw new FileOpError(
      "PATH_INVALID",
      options.requireAtomic === true
        ? "Plugins may only rename files, not folders."
        : "A folder has no version, so it cannot be moved against one.",
    );
  }
  /*
    Atomic where the bucket can do both halves conditionally — the copy
    `onlyIf: { absent }` and the delete `onlyIf: { etagMatches }` — and a
    read-compare where it cannot: the source's etag is compared just before it
    is copied, which is what an online save on such a bucket gets too. Only the
    plugin runtime refuses the second kind.
  */
  const atomic =
    options.expectedEtag !== undefined &&
    store.capabilities?.conditionalCreate === true &&
    store.capabilities?.conditionalDelete === true;
  if (options.expectedEtag !== undefined && options.requireAtomic === true && !atomic) {
    throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely rename plugin files.");
  }
  const changedElsewhere =
    options.requireAtomic === true
      ? "That file changed somewhere else while the plugin was using it."
      : "That note changed somewhere else after this was asked for.";

  // The header of this function says "the destination must not exist: this
  // never merges and never overwrites". That was true of files, which the
  // collision loop below checks key by key, and never true of folders — moving
  // `src` onto an existing `dst` merged them, and the rename carried `src`'s
  // folder rule onto `dst`, where it reached notes that were already there.
  // Measured: an owner's `dst/secret.md` went from hidden to readable for the
  // team caller who moved their own folder next to it.
  //
  // Refused with `notFound()` when the caller cannot see the folder, which is
  // the shape `createFolder`'s collision check already uses and the reason it
  // uses it: "that folder already exists" about a folder they cannot list is
  // the disclosure, not the merge.
  // "The destination must not exist" is about a destination of either kind. The
  // collision loop below checks key against key, so a file onto a file was
  // always caught; a folder onto a folder merged, and the two crossed pairs
  // left a file key shadowing a folder prefix — a shape a Dropbox binding
  // cannot even represent.
  if (await isFolder(store, to)) {
    if (!folderVisibleAtScope(to, options.clearance, state.rules, state.overrides)) throw notFound();
    throw new FileOpError(
      "DESTINATION_EXISTS",
      sourceIsFolder
        ? "That folder already exists. Moving one folder onto another would merge them."
        : "A folder already exists at that path.",
    );
  }
  if (sourceIsFolder && (await store.get(to)) !== null) {
    if (!canSee(to, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) throw notFound();
    throw new FileOpError("DESTINATION_EXISTS", `Something already exists at ${to}.`);
  }

  const walk = sourceIsFolder
    ? await keysUnder(store, from, options.clearance, state.rules, state.overrides)
    : { keys: [from], withheld: [] };
  const sources = walk.keys;
  if (!sourceIsFolder && (await store.get(from)) === null) throw notFound();
  if (sources.length === 0) throw notFound();

  const folderMove = sourceIsFolder ? { from, to } : null;

  const pairs = sources.map((key) => ({
    source: key,
    destination: sourceIsFolder ? `${to}${key.slice(from.length)}` : to,
  }));

  assertMoveDestinationsVisible(pairs, options.clearance, state);

  // A plaintext Markdown note on a supported bucket is owned by the
  // collaboration head once it is opened. Preserve that identity through a
  // rename instead of copying its materialization and leaving the head at the
  // old path. Folders and ineligible files continue through the structural
  // legacy path because the engine intentionally only names individual notes.
  if (!sourceIsFolder && collaborationSupported(store)) {
    const sourceObject = await store.get(from);
    if (sourceObject !== null) {
      const sourceText = await sourceObject.text();
      if (!isEncryptedNote(sourceText) && collaborationEligible(from, sourceText)) {
        if (store.capabilities?.conditionalDelete !== true) {
          throw new FileOpError(
            "STORAGE_UNSAFE",
            "This storage cannot safely move a collaboratively edited note.",
          );
        }
        if ((await store.get(to)) !== null) {
          throw new FileOpError("DESTINATION_EXISTS", `Something already exists at ${to}.`);
        }
        const destinationVisibility = narrowerVisibility(
          effectiveVisibility(from, state.rules, state.overrides),
          visibilityOf(to, state.rules),
        );
        // Install any narrowing before moveDocument materializes bytes at the
        // destination. The source rule remains in place until remapPrivacy
        // runs after success; on failure a stale narrowing is safe to leave.
        if (destinationVisibility !== "team") {
          await mutateManifest(store, (current) => ({
            rules: current.rules,
            overrides: nextOverrides(
              to,
              narrowerVisibility(
                destinationVisibility,
                effectiveVisibility(to, current.rules, current.overrides),
              ) ?? "private",
              current.rules,
              current.overrides,
            ),
          }));
        }
        let moved;
        try {
          moved = await moveCollaborationDocument(store, from, to, {
            ...(options.expectedEtag === undefined ? {} : { expectedEtag: options.expectedEtag }),
          });
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error
            ? String((error as { code?: unknown }).code)
            : "";
          if (code === "CONFLICT" || code === "BASE_MISSING" || code === "GENERATION_MISMATCH") {
            throw new FileOpError("CONFLICT", changedElsewhere, sourceObject.etag);
          }
          if (code === "DESTINATION_EXISTS") throw new FileOpError("DESTINATION_EXISTS", `Something already exists at ${to}.`);
          if (code === "UNSUPPORTED_STORAGE") {
            throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely move a collaboratively edited note.");
          }
          throw error;
        }
        const movedPairs = [{ source: from, destination: to }];
        await remapPrivacy(store, {
          moves: [{ from, to }],
          folderMove: null,
          survivors: [],
        });
        await recordForwarding(store, [{ from, to, kind: "note" as const }], { now: options.now });
        let finalEtag = moved.etag;
        const references = await rewriteReferences(store, {
          clearance: options.clearance,
          state,
          renames: new Map(movedPairs.map((pair) => [pair.source, pair.destination])),
          onRewritten: (key, etag) => {
            if (key === to) finalEtag = etag;
          },
        });
        return {
          from,
          to,
          paths: [to],
          references,
          etag: finalEtag,
        };
      }
    }
  }

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

  /*
    The etag the note has at its new path, for a single note. A queue that
    renamed a note and then deletes it offline sends the delete against *this*
    version — the one its own rename produced — and without it would have to
    either guess or drop the check.
  */
  let movedEtag: string | undefined;
  // Folder moves carry individual note heads. Move those notes through the
  // lifecycle first, and only use the byte-copy path for ineligible files.
  // Preflight the capability before the first pair so a provider without
  // conditional delete cannot leave a half-moved folder.
  const collaborativePairs = new Set<string>();
  if (sourceIsFolder && collaborationSupported(store)) {
    const candidates: Array<{
      pair: (typeof pairs)[number];
      visibility: Visibility;
    }> = [];
    for (const pair of pairs) {
      const object = await store.get(pair.source);
      if (object === null) continue;
      const text = await object.text();
      if (!isEncryptedNote(text) && collaborationEligible(pair.source, text)) {
        candidates.push({
          pair,
          visibility: narrowerVisibility(
            effectiveVisibility(pair.source, state.rules, state.overrides),
            visibilityOf(pair.destination, state.rules),
          ) ?? "private",
        });
      }
    }
    if (candidates.length > 0 && store.capabilities?.conditionalDelete !== true) {
      throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely move collaboratively edited notes.");
    }
    if (candidates.length > 0) {
      await mutateManifest(store, (current) => {
        let next = current.overrides;
        for (const candidate of candidates) {
          if (candidate.visibility === "team") continue;
          next = nextOverrides(
            candidate.pair.destination,
            narrowerVisibility(
              candidate.visibility,
              effectiveVisibility(
                candidate.pair.destination,
                current.rules,
                next,
              ),
            ) ?? "private",
            current.rules,
            next,
          );
        }
        return { rules: current.rules, overrides: next };
      });
    }
    for (const candidate of candidates) {
      try {
        await moveCollaborationDocument(store, candidate.pair.source, candidate.pair.destination);
        collaborativePairs.add(candidate.pair.source);
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : "";
        if (code === "CONFLICT" || code === "BASE_MISSING" || code === "GENERATION_MISMATCH") {
          throw new FileOpError("CONFLICT", "A note changed somewhere else while this folder was moving.");
        }
        if (code === "DESTINATION_EXISTS") throw new FileOpError("DESTINATION_EXISTS", "A destination changed while this folder was moving.");
        if (code === "UNSUPPORTED_STORAGE") throw new FileOpError("STORAGE_UNSAFE", "This storage cannot safely move collaboratively edited notes.");
        throw error;
      }
    }
  }

  for (const pair of pairs) {
    if (collaborativePairs.has(pair.source)) continue;
    const object = await store.get(pair.source);
    if (object === null) {
      // Vanished mid-move. Nothing to carry — unless this move was asked
      // against a version, and then the version it named is not there.
      if (options.expectedEtag !== undefined) throw new FileOpError("CONFLICT", changedElsewhere);
      continue;
    }
    if (options.expectedEtag !== undefined && object.etag !== options.expectedEtag) {
      throw new FileOpError("CONFLICT", changedElsewhere, object.etag);
    }
    const body = await object.text();
    const created = atomic
      ? await store.put(pair.destination, body, { onlyIf: { absent: true } })
      : await store.put(pair.destination, body);
    if (created === null) throw new FileOpError("DESTINATION_EXISTS", `Something already exists at ${pair.destination}.`);
    const removed = atomic
      ? await store.delete(pair.source, { onlyIf: { etagMatches: options.expectedEtag! } })
      : await store.delete(pair.source);
    if (removed === null) {
      if (created?.etag) await store.delete(pair.destination, { onlyIf: { etagMatches: created.etag } });
      throw new FileOpError("CONFLICT", changedElsewhere);
    }
    if (!sourceIsFolder && created?.etag) movedEtag = created.etag;
  }

  if (folderMove !== null) {
    /*
      The folder itself, on a backend that has one.

      `createFolder` writes down the assumption the rest of this file is built
      on — object storage has no folders, only shared key prefixes — and it is
      true of R2 and S3 and false of Dropbox. There the files move and the
      directory stays, `list` keeps reporting it as a prefix, and the console
      goes on drawing the folder somebody just moved. The notes at the new name
      and the old folder still beside them is a move that reads as a copy, and
      it read that way on exactly one backend.

      `keep` is the destination: moving a folder next to itself must not tidy
      away the tree the move just built. `walk.withheld` is why the adapter's
      own emptiness check is the authority rather than this list — a note this
      caller could not see is still in that folder, and the folder has to stay.
    */
    await pruneEmptyFolders(
      store,
      pairs.map((pair) => pair.source),
      { roots: [folderMove.from], keep: [folderMove.to] },
    );
  }

  await remapPrivacy(store, {
    moves: pairs.map((pair) => ({ from: pair.source, to: pair.destination })),
    folderMove,
    survivors: walk.withheld,
  });

  /*
    A FORWARDING ADDRESS, FOR THE REFERENCES A REWRITE CANNOT REACH.

    `rewriteReferences` below fixes every link inside the bucket. It cannot
    touch the ones held elsewhere — a share link already sent, a deep link in
    somebody's chat log — so the move also records where things went. See
    `apps/mcp/src/forwarding.js` for why this is a trail between paths rather
    than an index of who points at what.

    **A folder move is one entry**, not one per file it carried: a nine
    thousand note rename must not write nine thousand rows, and a prefix rule
    forwards the whole subtree. It is the same engine the gateway records with,
    imported rather than ported, so a rename through the console and the same
    rename through an MCP client leave the same trail.
  */
  await recordForwarding(
    store,
    folderMove
      ? [{ from, to, kind: "folder" as const }]
      : pairs.map((pair) => ({ from: pair.source, to: pair.destination, kind: "note" as const })),
    { now: options.now },
  );

  const references = await rewriteReferences(store, {
    clearance: options.clearance,
    state,
    renames: new Map(pairs.map((pair) => [pair.source, pair.destination])),
    /*
      A note that links to itself is rewritten here too, which moves its etag
      past the one the copy produced — and the queue would then send its next
      step against a version its own rename had already superseded.
    */
    onRewritten: (key, etag) => {
      if (!sourceIsFolder && key === to) movedEtag = etag;
    },
  });

  return {
    from,
    to,
    paths: pairs.map((pair) => pair.destination),
    references,
    ...(movedEtag === undefined ? {} : { etag: movedEtag }),
  };
}
