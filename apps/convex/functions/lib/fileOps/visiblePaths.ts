/**
 * Which of these paths this caller may see, decided now through the live
 * `privacy.md` — for a record the control plane holds about paths it cannot
 * judge on its own.
 *
 * The map's "notes moving between your workspaces" reads moves out of our own
 * tables (`contextMoves`, `auditEvents`), and a query there cannot know
 * whether `2-areas/acquisition.md` is private: `privacy.md` is in the
 * customer's bucket, behind the credential barrier. So the action that serves
 * those moves asks each bucket this, once, with every path it is about to
 * reveal, and drops what does not come back.
 *
 * A note is judged by `canSee`; anything else is a folder (a console move
 * carries a folder and everything under it) and is judged by
 * `folderVisibleAtScope`, the rule the file tree draws folders by. A path that
 * no longer exists is still a *location* with a visibility, which is exactly
 * the question for a move that has already happened.
 */

import { canSee, isPlumbing } from "../privacy";
import type { Clearance } from "../clearance";
import type { FileStore } from "./store";
import { loadPrivacyState } from "./privacyState";
import { folderVisibleAtScope } from "./listing";

/**
 * More than one map's worth of moves names. A path past it is not judged and
 * so is not returned — which fails closed: the move it belongs to is dropped.
 */
export const VISIBLE_PATHS_CAP = 1_000;

export async function visiblePathsOf(
  store: FileStore,
  clearance: Clearance,
  paths: readonly string[],
): Promise<string[]> {
  const asked = [...new Set(paths)].slice(0, VISIBLE_PATHS_CAP);
  const state = await loadPrivacyState(store);
  return asked.filter((path) => {
    if (typeof path !== "string" || path === "" || isPlumbing(path)) return false;
    if (path.endsWith(".md")) {
      return canSee(path, clearance.scope, state.rules, state.overrides, clearance.names);
    }
    return folderVisibleAtScope(path.replace(/\/+$/, ""), clearance, state.rules, state.overrides);
  });
}
