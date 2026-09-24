/**
 * What a change does to the file tree, and who may be told about it.
 *
 * Split out of `functions/files.ts` so the answer lives beside
 * `treeAudiences`, which decides the same question one path at a time.
 */

import type { PrivacyState } from "./fileOps";
import { treeAudiences } from "./treeAudiences";

/**
 * What a file operation does to the tree: the paths it creates, moves or
 * removes, and whether it can take something away from a reader who could see
 * it (a move, a delete, a visibility change) — for which the audiences are
 * read before the operation as well as after. `every` is an operation that
 * can change anything (clearing or resetting the whole context). `null` for
 * everything that leaves the tree as it was: reads, and a save to a note that
 * already exists, which changes its words and not the tree.
 */
export interface TreeChange {
  paths: string[];
  narrows: boolean;
  every?: boolean;
  /**
   * The paths this operation takes away, which the manifest AFTER it can no
   * longer judge.
   *
   * A permanent delete runs `forgetPrivacy` and a move runs `movedOverrides`,
   * so the exact-note exception that held a note back is gone from the source
   * path by the time `announceTreeChange` re-reads the manifest. Asking
   * `effectiveVisibility` about that path then answers with the FOLDER's
   * default — which for a note held back inside a shared folder is `team`, an
   * audience that never saw it. The path existed only under `before`, so only
   * `before` may speak for it.
   */
  gone?: string[];
}

/**
 * Who to tell that the tree changed, from the manifest either side of it.
 *
 * Pure: the caller loads both states and runs the mutation. Kept here beside
 * `treeAudiences` because the decision of WHICH manifest may speak for which
 * path is the same decision `treeAudiences` documents, and splitting the two
 * across files is how the `gone` case came to be missed in the first place.
 */
export function audiencesForChange(options: {
  change: TreeChange;
  /** `change.paths`, plus where a move actually landed. */
  paths: readonly string[];
  /** Paths this operation took away, including a `moved` result's source. */
  gone: ReadonlySet<string>;
  before: PrivacyState | null;
  after: PrivacyState;
}): string[] {
  const { change, paths, gone, before, after } = options;
  const audiences = new Set<string>();
  for (const state of before === null ? [after] : [before, after]) {
    /*
      A path this operation took away is judged by `before` alone. See
      `TreeChange.gone`: the after-manifest has forgotten the exception that
      held it back, so asking it would widen a deleted private note to its
      folder's audience and date its deletion for readers who never saw it.
      Only when `before` is unreadable does the after-manifest speak for
      everything, which under-reports rather than over-reports — the
      direction `treeAudiences` documents as the safe one.
    */
    const visible = before !== null && state === after
      ? paths.filter((path) => !gone.has(trimTrailingSlashes(path)))
      : paths;
    const reach = change.every
      ? ["", ...state.rules.map((rule) => rule.prefix), ...state.overrides.keys()]
      : visible;
    for (const audience of treeAudiences(reach, state.rules, state.overrides)) {
      audiences.add(audience);
    }
    if (change.every) audiences.add("private");
  }
  return [...audiences];
}

/** `treeAudiences` folds a folder's trailing slash away; `gone` must match. */
export function trimTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, "");
}
