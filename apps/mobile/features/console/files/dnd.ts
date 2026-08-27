/**
 * The rules behind dragging rows in the file tree.
 *
 * A pure table rather than logic inside a drag handler, because there are two
 * handlers and only one set of rules: an HTML5 drag on web (pointer events,
 * `dataTransfer`, ⌥ for copy) and a long-press-then-drag on touch (a gesture,
 * a "Copy here" choice in the drop menu). A refusal that only exists in one of
 * them is a bug nobody can see — the web build keeps working while the phone
 * quietly moves a folder into itself, or the phone refuses something the
 * desktop allows and the two disagree about what the same product does.
 * Putting the whole verdict in one function that neither platform can bypass
 * is the only way the two stay the same product. The console's Jest suite runs
 * in plain node with no renderer (see `jest.config.js`), so a module with no
 * DOM, React or react-native import is also the only version of these rules a
 * test can hold.
 *
 * The server validates all of this again — `apps/convex/functions/files.ts`
 * refuses a bad move whatever the client sent, and `moveEntry` still answers
 * `DESTINATION_EXISTS` for a collision this layer never saw. This layer exists
 * so a person finds out before they wait for a round trip, not instead of the
 * check that matters.
 *
 * ## Nothing here reimplements path arithmetic
 *
 * `describeMoveProblem` in `./paths` already encodes "a folder cannot be moved
 * inside itself", "it is already there" and "a move never overwrites", and
 * `planPaste` in `./clipboard` already encodes the copy-versus-move asymmetry.
 * A drag is a paste you performed with your finger, so it delegates to both. A
 * second copy of those rules that drifted by one case would be a drag that
 * allows what the toolbar refuses.
 */

import { planPaste, put } from "./clipboard";
import { contextSegment } from "../nav";
import {
  baseName,
  describeMoveProblem,
  describeNameProblem,
  isMarkdown,
  moveTargetFor,
} from "./paths";
import { namesIn } from "./tree";
import type { FolderListing } from "./types";

/**
 * How long a drag has to hover a collapsed folder before it opens.
 *
 * Named here rather than left as a number in a component for the same reason
 * the rest of this module exists: the web drag and the touch drag both need
 * it, and two components disagreeing about it would be two different products.
 * 600ms is long enough that dragging *across* a folder on the way somewhere
 * else does not fling the tree open under the pointer, and short enough that
 * deliberately hovering does not feel broken.
 */
export const AUTO_EXPAND_MS = 600;

/** ⌥/alt held on web; a "Copy here" choice in the touch drop menu. */
export type DragModifier = "copy";

export interface DragSource {
  /** One or more rows being dragged. Multi-select drags are one gesture. */
  paths: readonly string[];
  /** True if **any** dragged row is read-only — `privacy.md` is generated. */
  readOnly: boolean;
}

export type DropTarget =
  | { kind: "folder"; path: string }
  | { kind: "root" }
  /** Another context in the rail. */
  | { kind: "context"; slug: string }
  /** Out of the app entirely — onto Slack, a terminal, a text field. */
  | { kind: "external" };

export type DropVerdict =
  | { ok: true; action: "move" | "copy"; moves: readonly { from: string; to: string }[] }
  | { ok: false; reason: string };

type Listings = Readonly<Record<string, FolderListing | undefined>>;

/**
 * What dropping the rail's row for `slug` means.
 *
 * Dropping onto the context you are already in is not a cross-context write at
 * all — it is a drop on that context's root, which is an ordinary move. Only a
 * *different* context is the refusal below. The two are decided here so both
 * drag handlers ask the same question instead of each deciding for itself what
 * "the current context" was at the moment the finger came down.
 */
export function contextDropTarget(slug: string, currentSlug: string | null): DropTarget {
  return slug === currentSlug ? { kind: "root" } : { kind: "context", slug };
}

/**
 * Whether this drop can happen, and exactly what it would do.
 *
 * All-or-nothing across `source.paths`. A multi-select drag where one path
 * collides refuses the **whole** drop and names the offending path, rather
 * than moving the four that fit and leaving the fifth behind: a partially
 * applied move is the thing somebody spends an afternoon undoing, and it is
 * indistinguishable afterwards from a move they made on purpose.
 */
export function canDrop(
  source: DragSource,
  target: DropTarget,
  modifiers: readonly DragModifier[],
  listings: Listings,
): DropVerdict {
  if (source.paths.length === 0) return { ok: false, reason: "Nothing is being dragged." };

  /**
   * Checked before the target, because it is true of every target. `privacy.md`
   * is not a file somebody wrote; it is rendered from their visibility
   * settings, so moving, copying or exporting it would produce a second copy
   * that stops tracking the thing it describes.
   */
  if (source.readOnly) {
    return {
      ok: false,
      reason:
        "privacy.md is generated from your visibility settings and cannot be moved. Change a note or folder's visibility instead.",
    };
  }

  if (target.kind === "external") {
    /**
     * Dragging out of the app hands the OS the addresses from
     * `externalDragPayload`; nothing in the bucket changes. Reported as a
     * refusal rather than as `action: "move"` with an empty list, because the
     * tree must not draw a drop line or animate a row away for a gesture that
     * moves nothing.
     */
    return {
      ok: false,
      reason: "Dragging out of Context copies the address, not the file. Nothing here moves.",
    };
  }

  if (target.kind === "context") {
    /**
     * Cross-context writes and mounts are "deliberately not yet" — see the
     * root `CLAUDE.md`. A context is its own bucket, its own privacy manifest
     * and its own audit trail, so this is not a move within a file system; it
     * is a write into somebody else's storage binding. Refused **out loud**:
     * a drag that just snaps back teaches nothing, and the person is entitled
     * to know the feature is missing rather than assume their drop missed.
     */
    return {
      ok: false,
      reason: `${contextSegment(target.slug)} is a separate context with its own bucket. Moving notes between contexts is not supported yet — open it and create the note there.`,
    };
  }

  const destination = target.kind === "root" ? "" : target.path;
  const copying = modifiers.includes("copy");

  /**
   * Names already in the destination, grown as the plan is built. Two dragged
   * rows called `notes.md` land in the same folder: the second copy has to see
   * the first one's chosen name or both would be planned as `notes copy.md`,
   * and the second move has to be refused rather than silently overwrite.
   *
   * An unloaded destination (a collapsed folder nobody has expanded) yields an
   * empty set, so a collision there is invisible to this layer and the server
   * answers `DESTINATION_EXISTS`. That is the honest degradation: refusing
   * every drop onto a folder that has not been fetched would be worse, and
   * pretending the set is complete would be a lie.
   */
  const taken = new Set(namesIn(listings, destination));
  const moves: { from: string; to: string }[] = [];

  for (const from of source.paths) {
    if (copying) {
      /**
       * The copy branch is `planPaste`'s copy branch, verbatim: a copy onto a
       * taken name takes the next free `duplicateName`, including a copy back
       * into its own folder, which is a duplicate and perfectly legal.
       */
      const plan = planPaste(put("copy", from), destination, taken);
      if (!plan.ok) return { ok: false, reason: `${from}: ${plan.reason}` };
      taken.add(baseName(plan.to));
      moves.push({ from: plan.from, to: plan.to });
      continue;
    }

    /**
     * The move branch is `describeMoveProblem`, which is the same asymmetry
     * `planPaste`'s cut branch encodes and must stay consistent with it: a
     * **copy** onto a collision renames itself, a **move** onto a collision is
     * refused. A move that quietly renamed itself out of a collision did
     * something other than what was asked, and the original is already gone.
     */
    const problem = describeMoveProblem(from, destination, taken);
    if (problem !== null) return { ok: false, reason: `${from}: ${problem}` };
    const to = moveTargetFor(from, destination);
    taken.add(baseName(to));
    moves.push({ from, to });
  }

  return { ok: true, action: copying ? "copy" : "move", moves };
}

/**
 * What the OS drag carries, so dropping a note into Slack or a terminal
 * pastes something that means anything.
 *
 * The product's addressable form: `@seyi/1-projects/foo.md`, newline-joined
 * for several. Not a URL and not a bare path — a bare path is ambiguous once
 * somebody can reach more than one context, and `@name/path` is exactly what
 * the MCP tools already take, so a pasted address is something another agent
 * can act on rather than a screenshot in text form.
 */
export function externalDragPayload(paths: readonly string[], contextSlug: string): string {
  const prefix = contextSegment(contextSlug);
  return paths.map((path) => `${prefix}/${path}`).join("\n");
}

export interface ExternalDropPlan {
  accepted: readonly string[];
  refused: readonly { name: string; reason: string }[];
}

/**
 * Which files dragged in from the OS a drop will accept, and why the rest are
 * refused.
 *
 * Deliberately **not** all-or-nothing, unlike `canDrop`. Nothing here is being
 * taken away from anywhere: dropping a folder of twelve files where one is a
 * screenshot should add the eleven notes and say plainly what happened to the
 * twelfth, rather than refuse the lot. The asymmetry is the point — a move can
 * destroy the arrangement somebody already had, an add cannot.
 */
export function planExternalDrop(
  fileNames: readonly string[],
  destinationFolder: string,
  listings: Listings,
): ExternalDropPlan {
  const taken = new Set(namesIn(listings, destinationFolder));
  const accepted: string[] = [];
  const refused: { name: string; reason: string }[] = [];

  for (const name of fileNames) {
    // The name rules first, so `privacy.md` and dot-files get the sentence that
    // explains them rather than the generic one about attachments.
    const problem = describeNameProblem(name);
    if (problem !== null) {
      refused.push({ name, reason: problem });
      continue;
    }
    if (!isMarkdown(name)) {
      refused.push({
        name,
        reason: "Only Markdown files can be dropped in. Attachments are not supported yet.",
      });
      continue;
    }
    if (taken.has(name)) {
      refused.push({
        name,
        reason: `${destinationFolder === "" ? "The root" : destinationFolder} already has something called ${name}.`,
      });
      continue;
    }
    taken.add(name);
    accepted.push(name);
  }

  return { accepted, refused };
}
