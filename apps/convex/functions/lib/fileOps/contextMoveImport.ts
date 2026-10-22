/**
 * Moving between two contexts: landing a batch, and retiring the source.
 *
 * Split out of `lib/fileOps.ts`, which re-exports it; that file's header holds
 * the rules every operation keeps.
 */

import {
  canSee,
  clearedOverrides,
  effectiveVisibility,
  hasOverride,
  narrowerVisibility,
  nextOverrides,
  visibilityOf,
} from "../privacy";
import { type Clearance } from "../clearance";
import type { FileStore } from "./store";
import { type FileErrorCode, FileOpError, notFound } from "./errors";
import { requirePath } from "./paths";
import { loadPrivacyState } from "./privacyState";
import { folderVisibleAtScope } from "./listing";
import { assertWritablePath } from "./writing";
import { isFolder } from "./walk";
import { trashKeyedRows } from "./deleting";
import { assertDestinationsVisible } from "./moveRules";
import {
  type ContextMoveObject,
  landingVisibility,
  assertDestinationCanLand,
} from "./contextMoveExport";
import { mutateManifest } from "./privacyRewrite";

export interface ContextMoveImport {
  /** What actually exists at the destination now, with the etag it was given. */
  landed: { source: string; destination: string; etag: string }[];
  /**
   * Why the batch stopped, if it did.
   *
   * A partial batch is reported rather than thrown, because the sources for
   * everything in `landed` must still be deleted: throwing would leave copies
   * in both buckets with nothing recording that they are copies.
   */
  failure: { destination: string; code: FileErrorCode; message: string } | null;
}

/**
 * Everything `importContextMoveBatch` decides before it writes a file: the
 * destination root's collision check, the mover's own clearance there, and the
 * narrowing exceptions, written first in one manifest write. The gateway's
 * mover lands the files themselves afterwards
 * (`apps/mcp/src/moves/contextMovePage.js`), so they never pass through this
 * deployment; the order (narrow, then land) is the same either way.
 */
export async function prepareContextMoveLanding<T extends { destination: string; sourceVisibility: "private" | "team" }>(
  store: FileStore,
  options: { objects: readonly T[]; clearance: Clearance; root?: string },
): Promise<{ object: T; destination: string; visibility: "private" | "team" }[]> {
  assertDestinationCanLand(store);

  const state = await loadPrivacyState(store);
  if (state.invalid) {
    throw new FileOpError(
      "PRIVACY_MANIFEST_INVALID",
      "privacy.md could not be read in the context this is moving into. Nothing was moved.",
    );
  }

  if (options.root !== undefined) {
    const root = requirePath(options.root);
    assertWritablePath(root);
    if (await isFolder(store, root)) {
      // Refused whether or not they can see it, and `notFound` when they
      // cannot: "that folder already exists" about a folder somebody cannot
      // list is the disclosure, not the merge. Same shape as `movePath`'s.
      if (!folderVisibleAtScope(root, options.clearance, state.rules, state.overrides)) {
        throw notFound();
      }
      throw new FileOpError(
        "DESTINATION_EXISTS",
        `${root} already exists there. Moving one folder onto another would merge them.`,
      );
    }
    if ((await store.get(root)) !== null) {
      if (!canSee(root, options.clearance.scope, state.rules, state.overrides, options.clearance.names)) {
        throw notFound();
      }
      throw new FileOpError("DESTINATION_EXISTS", `Something already exists at ${root}.`);
    }
  }

  const planned = options.objects.map((object) => {
    const destination = requirePath(object.destination);
    assertWritablePath(destination);
    return {
      object,
      destination,
      visibility: landingVisibility(object.sourceVisibility, visibilityOf(destination, state.rules)),
    };
  });

  /*
    THE MOVER'S OWN CLEARANCE IN THE DESTINATION, ASKED BEFORE ANYTHING IS
    WRITTEN.

    Starting a move needs `editor` there, and an editor reads at `team` — so
    the same rule every other write in this file obeys applies here: they may
    land something in a folder they can see, and a `private` folder of somebody
    else's context is not one. Without this, "move into @theirs" would be a way
    to write into a folder the mover cannot list, and to learn from the result
    that it is there.

    The identical guard `movePath` uses, deliberately: this is the one place a
    write arrives in a context from outside it, and a second implementation of
    "may they write here" is a second one to get wrong. An owner
    (`scope: "private"`) passes it unconditionally, which is the arm every move
    started by the destination's own owner takes.
  */
  assertDestinationsVisible(
    planned.map((entry) => entry.destination),
    options.clearance,
    state.rules,
    state.overrides,
  );

  /*
    ASKED OF WHAT THE DESTINATION WILL RESOLVE THIS PATH TO, NOT OF WHAT ITS
    FOLDER PUBLISHES.

    This read `visibilityOf` — the folder default — so a landing tier that
    matched it was dropped as a redundant write, and an exact `team` exception
    already sitting at the destination path then decided what landed. Those
    exist by design: `clearExactVisibilityIfAbsent` is a deliberate no-op, so
    deleting a shared note leaves its exception behind rather than open the
    race that removing it safely would need, and the folder it sat in is gone
    from the listing long before the rule is. A private note moved into a
    private folder of another context landed on one and was readable by the
    people named there — exactly what `landingVisibility` promises cannot
    happen, and the reason this operation asks for no confirmation.

    `narrowerVisibility` rather than the landing tier alone, so this can only
    ever narrow. A stale exception tighter than what the move computed is left
    where it is instead of being lifted, and a stale group name is kept for the
    same reason: it reaches fewer people than `team` and, unlike one carried
    from the source, it resolves in this context's own control plane.
  */
  const landing = planned.map((entry) => {
    const standing = effectiveVisibility(entry.destination, state.rules, state.overrides);
    return { entry, standing, target: narrowerVisibility(entry.visibility, standing) ?? entry.visibility };
  });
  const narrowed = landing.filter(({ standing, target }) => target !== standing);
  // In rows mode the rows are the truth and the rules file is not read: each arrival is born private on its row
  // instead (`lib/nodes/arrivalAccess.ts`). A landing the target is wider than (a stale tighter rule) is left be.
  const onRows = (store as { narrowArrivals?: (paths: string[]) => Promise<void> }).narrowArrivals;
  if (narrowed.length > 0 && onRows !== undefined) {
    const closing = narrowed.filter(({ target }) => target === "private").map(({ entry }) => entry.destination);
    if (closing.length > 0) await onRows(closing);
  } else if (narrowed.length > 0) {
    await mutateManifest(store, (current) => {
      let overrides = current.overrides;
      for (const { entry, target } of narrowed) {
        overrides = nextOverrides(entry.destination, target, current.rules, overrides);
      }
      return { rules: current.rules, overrides };
    });
  }

  return planned;
}

/**
 * Land a batch in the destination context, narrowing before it writes.
 *
 * The exceptions go in **first**, in one manifest write for the whole batch,
 * and the objects follow. The order is the whole point: a private note put
 * into a team-default folder and then narrowed is a note that was readable by
 * the destination's team for as long as the second write took. The gateway's
 * cross-context move makes the same choice, one note at a time
 * (`persistExactVisibility` before the `put`).
 */
export async function importContextMoveBatch(
  store: FileStore,
  options: {
    objects: readonly ContextMoveObject[];
    clearance: Clearance;
    /**
     * The move's destination root, on the first batch only.
     *
     * Checked once rather than per object, and only when nothing has landed
     * yet — by the second batch this move's own objects are under it, so the
     * same check would then refuse the move on the strength of its own work.
     *
     * It is what stops a folder move **merging** into a folder that is already
     * there. The per-object `get` below cannot see that: for a folder move
     * every destination is `to` plus a suffix, so two trees interleave key by
     * key with no key ever colliding, and `movePath` records what the result
     * is — the source folder's rule carried onto a destination that already
     * had notes in it, one of which went from hidden to readable. A file
     * already sitting at `to` is the other half of the same question, and is
     * invisible to a per-object check for the same reason.
     */
    root?: string;
  },
): Promise<ContextMoveImport> {
  const planned = await prepareContextMoveLanding(store, {
    objects: options.objects,
    clearance: options.clearance,
    ...(options.root === undefined ? {} : { root: options.root }),
  });

  const landed: ContextMoveImport["landed"] = [];
  for (const entry of planned) {
    try {
      if ((await store.get(entry.destination)) !== null) {
        return {
          landed,
          failure: {
            destination: entry.destination,
            code: "DESTINATION_EXISTS",
            message: `Something already exists at ${entry.destination}.`,
          },
        };
      }
      // Unconditionally conditional: `assertDestinationCanLand` has already
      // refused a store that cannot do this, so there is no fallback arm to
      // get wrong — and the fallback that used to be here was a read-compare,
      // which is exactly the window this operation must not have.
      const created = await store.put(entry.destination, entry.object.bytes, {
        onlyIf: { absent: true },
      });
      if (created === null) {
        return {
          landed,
          failure: {
            destination: entry.destination,
            code: "DESTINATION_EXISTS",
            message: `Something already exists at ${entry.destination}.`,
          },
        };
      }
      landed.push({
        source: entry.object.source,
        destination: entry.destination,
        etag: created.etag,
      });
    } catch (error) {
      return {
        landed,
        failure: {
          destination: entry.destination,
          code: "STORAGE_UNSAFE",
          message: error instanceof Error ? error.message : "The destination bucket refused a write.",
        },
      };
    }
  }
  return { landed, failure: null };
}

/**
 * Take the copied objects out of the source, and only those, as their rows.
 *
 * A KEYED NOTE LEAVES BY THE TRASH, NEVER BY A DELETE. Its bytes are at its key
 * and a delete of it is refused (only emptying the trash retires a key). So the
 * note's row goes to this workspace's trash, only if its key still holds the
 * version that was copied: an edit made since is a conflict, and the caller
 * removes the stale copy it made and stops (see `contextMoves.ts`). The note
 * stays restorable here, and its rules travel with the row, so there is nothing
 * to forget.
 *
 * The version is asked of the key, never the row. A row's etag is what the tree
 * last heard, and a key can be rewritten with nobody telling it (the managed
 * encryption walk seals keys in the bare bucket): checked against the row, such
 * a note read as edited on every move, and never moved. An edit landing after
 * this read and before the trash goes into the trash with the note, where
 * Restore still has it.
 */
export async function deleteMovedSources(
  store: FileStore,
  options: { sources: readonly { path: string; etag: string }[]; clearance?: Clearance },
): Promise<{ deleted: string[]; conflicts: string[] }> {
  const deleted: string[] = [];
  const conflicts: string[] = [];
  const clearance = options.clearance;
  if (clearance === undefined) throw new FileOpError("KEYED_WORKSPACE", "A keyed note is moved out by the trash, which needs the caller's clearance.");
  for (const source of options.sources) {
    const current = typeof store.head === "function" ? await store.head(source.path) : await store.get(source.path);
    if (current === null || current.etag !== source.etag) {
      conflicts.push(source.path);
      continue;
    }
    try {
      await trashKeyedRows(store, { path: source.path, clearance, now: Date.now() });
      deleted.push(source.path);
    } catch (error) {
      if (!(error instanceof FileOpError)) throw error;
      console.warn("contextMove.keyed_trash_refused", { code: error.code });
      conflicts.push(source.path);
    }
  }
  return { deleted, conflicts };
}

/**
 * Forget what the source manifest still says about a subtree nothing is left in.
 *
 * Run once, after the last batch. A folder rule whose folder is gone is not
 * inert: the name comes back the day anybody recreates that path — an
 * ingestion alias filing into `1-projects/acme`, a new note saved to the same
 * place — and it comes back carrying a visibility nobody chose for it. Rules
 * covering something that stayed behind are kept, which is why this takes the
 * survivors rather than assuming there are none.
 */
export async function clearMovedSourceRules(
  store: FileStore,
  options: { from: string; survivors?: readonly string[]; clearance?: Clearance },
): Promise<void> {
  const from = requirePath(options.from);
  const survivors = options.survivors ?? [];
  // Rules are on the rows and went to the trash with each note. What is left of a moved folder is its empty
  // folders: they follow it into the trash, unless something stayed behind in it.
  if (survivors.length === 0 && options.clearance !== undefined) {
    // A moved note is already in the trash, and a folder's row may be too: neither is left to take.
    await trashKeyedRows(store, { path: from, clearance: options.clearance, now: Date.now() }).catch((error) => {
      if (!(error instanceof FileOpError) || error.code !== "FILE_NOT_FOUND") throw error;
    });
  }
}
