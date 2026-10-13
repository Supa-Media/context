/**
 * What a queued folder move does to `privacy.md` (phase 4 of
 * `docs/decisions/app-and-console/convex-tree.md`).
 *
 * `privacy.md` is still the authority until phase 3, and the bucket keeps
 * objects at their old names until the move's worker reaches them. So the
 * rules are carried in two halves, and neither half can widen anything:
 *
 *  - **At the start** (`carryPrivacy`), before the tree draws the move, the
 *    folder's rules and exceptions are copied to the new name, and the new
 *    name is narrowed to what the folder was visible as, exactly as
 *    `remapPrivacy` does for a move made in one go. The old name keeps its
 *    rules, so an object still sitting there is judged as it always was.
 *  - **At the end** (`releasePrivacy`), once the last object has moved, the
 *    old name's rules go. An undone move instead takes back what the start
 *    added, and the old name never lost anything.
 *
 * A rule a stale entry left under the new name (a folder that once lived
 * there) is narrowed to what the moved folder had at that place, never kept
 * wider: copying a private folder over a stale `team` subfolder rule would
 * otherwise publish that subfolder.
 */

import { mutateManifest } from "../fileOps/privacyRewrite";
import { loadPrivacyState } from "../fileOps/privacyState";
import type { FileStore } from "../fileOps/store";
import { oneRulePerPrefix } from "../fileOps/moveRules";
import {
  type PrivacyRule,
  type Visibility,
  effectiveVisibility,
  narrowerVisibility,
  nextOverrides,
  visibilityOf,
} from "../privacy";

/** What the start wrote at the new name: the exact entries an Undo takes back. */
export interface AddedRules {
  /** `was` is what the entry said before, where it said anything: an Undo puts that back. */
  folders: { prefix: string; visibility: string; was?: string }[];
  notes: { path: string; visibility: string; was?: string }[];
}

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

/** `path` under `from`, renamed to sit under `to`. */
function rebase(path: string, from: string, to: string): string {
  return `${to}${path.slice(from.length)}`;
}

/**
 * The manifest with folder `from`'s rules carried to `to`, the old ones kept.
 * Pure, so the no-widening property is tested without a bucket.
 */
export function carriedRules(
  current: { rules: readonly PrivacyRule[]; overrides: ReadonlyMap<string, Visibility> },
  from: string,
  to: string,
): { rules: PrivacyRule[]; overrides: Map<string, Visibility>; added: AddedRules } {
  const rules: PrivacyRule[] = [...current.rules];
  for (const rule of current.rules) {
    if (within(rule.prefix, from)) rules.push({ prefix: rebase(rule.prefix, from, to), vis: rule.vis });
  }
  // Whatever already sits under the new name narrows to what the folder had there.
  for (const rule of current.rules) {
    if (!within(rule.prefix, to)) continue;
    const had = visibilityOf(rebase(rule.prefix, to, from), current.rules);
    rules.push({ prefix: rule.prefix, vis: narrowerVisibility(rule.vis, had) ?? "private" });
  }
  // The folder as a whole keeps what it was visible as, never what the new parent gives.
  const was = visibilityOf(from, current.rules);
  const there = visibilityOf(to, rules);
  const carry = narrowerVisibility(was, there) ?? "private";
  if (carry !== there) rules.push({ prefix: to, vis: carry });
  const settled = oneRulePerPrefix(rules);

  let overrides = new Map(current.overrides);
  for (const [path, visibility] of current.overrides) {
    if (!path.startsWith(`${from}/`)) continue;
    const destination = rebase(path, from, to);
    overrides = nextOverrides(destination, narrowerVisibility(visibility, overrides.get(destination)) ?? "private", settled, overrides);
  }
  for (const [path, visibility] of current.overrides) {
    if (!path.startsWith(`${to}/`)) continue;
    const had = effectiveVisibility(rebase(path, to, from), current.rules, current.overrides);
    overrides = nextOverrides(path, narrowerVisibility(visibility, had) ?? "private", settled, overrides);
  }

  const before = new Map(current.rules.map((rule) => [rule.prefix, rule.vis]));
  const added: AddedRules = {
    folders: settled
      .filter((rule) => within(rule.prefix, to) && before.get(rule.prefix) !== rule.vis)
      .map((rule) => {
        const was = before.get(rule.prefix);
        return { prefix: rule.prefix, visibility: rule.vis, ...(was === undefined ? {} : { was }) };
      }),
    notes: [...overrides]
      .filter(([path, visibility]) => path.startsWith(`${to}/`) && current.overrides.get(path) !== visibility)
      .map(([path, visibility]) => {
        const was = current.overrides.get(path);
        return { path, visibility, ...(was === undefined ? {} : { was }) };
      }),
  };
  return { rules: settled, overrides, added };
}

/**
 * Carry the rules before the move is drawn. Answers the manifest's etag after
 * the write, which the tree's copy of the rules must match before the move is
 * drawn, and what was added.
 *
 * A bucket with no `privacy.md` keeps everything private at every name, so
 * there is nothing to carry. One whose rules block does not parse is refused:
 * the caller moves the old way, which says so.
 */
export async function carryPrivacy(
  store: FileStore,
  from: string,
  to: string,
): Promise<{ etag: string | null; added: AddedRules } | null> {
  const state = await loadPrivacyState(store);
  if (state.invalid) return null;
  if (state.text === null) return { etag: state.etag, added: { folders: [], notes: [] } };
  let added: AddedRules = { folders: [], notes: [] };
  await mutateManifest(store, (current) => {
    const next = carriedRules(current, from, to);
    added = next.added;
    return { rules: next.rules, overrides: next.overrides };
  });
  return { etag: (await loadPrivacyState(store)).etag, added };
}

/**
 * Settle the rules once the last object has moved.
 *
 * - A move that finished drops every rule and exception under its old name:
 *   nothing lives there now, and old names stay reserved until this point.
 * - An undone move takes back what its start added, entry by entry, and only
 *   where the entry still says what the start wrote. Anything an owner
 *   changed since is theirs and stays.
 */
export async function releasePrivacy(
  store: FileStore,
  move: { from: string; undone: boolean; added: AddedRules },
): Promise<void> {
  const state = await loadPrivacyState(store);
  if (state.text === null || state.invalid) return;
  const added = move.added;
  await mutateManifest(store, (current) => {
    if (!move.undone) {
      const overrides = new Map(current.overrides);
      for (const path of current.overrides.keys()) if (within(path, move.from)) overrides.delete(path);
      return { rules: current.rules.filter((rule) => !within(rule.prefix, move.from)), overrides };
    }
    const folders = new Map(added.folders.map((rule) => [rule.prefix, rule]));
    const rules: PrivacyRule[] = [];
    for (const rule of current.rules) {
      const entry = folders.get(rule.prefix);
      if (entry === undefined || entry.visibility !== rule.vis) rules.push(rule);
      else if (entry.was !== undefined) rules.push({ prefix: rule.prefix, vis: entry.was as Visibility });
    }
    const overrides = new Map(current.overrides);
    for (const note of added.notes) {
      if (overrides.get(note.path) !== note.visibility) continue;
      if (note.was === undefined) overrides.delete(note.path);
      else overrides.set(note.path, note.was as Visibility);
    }
    return { rules, overrides };
  });
}
