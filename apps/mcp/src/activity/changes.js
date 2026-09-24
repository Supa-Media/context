/**
 * The change feed: which recorded actions change a file tree, the hint an
 * open tree is sent, and the `list_changes` tool. Moved verbatim out of
 * `src/index.js`; recording a change, which decides audiences through the
 * privacy engine, stays beside it.
 */

import { AUDIT_PREFIX } from "../../../../packages/shared/src/storageLayout.cjs";
import { getWithLegacyFallback } from "../storageLayout.js";
import { listAllKeysWithLegacy } from "../notes/storage.js";
import { toolError, toolText } from "../tools/results.js";

/**
 * The changes that alter a context's file tree — something created, moved,
 * removed or re-scoped. A save to a note that already exists is not one: it
 * changes words, not the tree, and every keystroke of a live edit must not
 * send every console viewing the context to re-list it.
 */
export const TREE_ACTIONS = new Set([
  "create_note",
  "meeting_note",
  "save_context",
  "inbox_capture",
  // An approved proposal is a new note where there was none: the proposal
  // itself waited under `.context/`, outside every tree.
  "approve_proposal",
  "archive_note",
  "move_note",
  "move_notes",
  "move_folder",
  "materialize_move",
  "set_visibility",
  "set_folder_visibility",
]);

/**
 * The paths a tree change should be judged by, and any visibility it had
 * before that the paths alone no longer show.
 *
 * Judged after the change, so a move's SOURCE is left out unless the change
 * recorded what it was: after the move the source reads as its folder's
 * default, which for a note held back from a shared folder is `team` — and
 * telling the team would date a private note's move. What the destination
 * shows, the tool's own `source_visibility`, and a visibility change's
 * `from`/`to` are exact. A source's readers the change does not name learn of
 * it at their console's next periodic walk: late, never leaked.
 */
export function treeHintOf(action, paths, details) {
  const known = [];
  const add = (value) => {
    if (typeof value === "string") known.push(value);
  };
  if (details && typeof details === "object") {
    add(details.source_visibility);
    if (action === "set_visibility" || action === "set_folder_visibility") {
      add(details.from);
      add(details.to);
    }
  }
  switch (action) {
    case "move_note":
    case "archive_note":
    case "move_folder":
    case "materialize_move":
      return { paths: paths.length === 2 ? [paths[1]] : paths, known };
    case "move_notes": {
      const moved = typeof details?.moved === "number" ? details.moved : paths.length / 2;
      const pairs = paths.slice(0, moved * 2).filter((_, index) => index % 2 === 1);
      return { paths: [...pairs, ...paths.slice(moved * 2)], known };
    }
    default:
      return { paths, known };
  }
}

export async function toolListChanges(store, scope, rules, overrides, limitArg) {
  const parsedLimit = Number.isInteger(limitArg) ? limitArg : 20;
  if (parsedLimit < 1 || parsedLimit > 100) return toolError("limit must be between 1 and 100");
  const keys = (await listAllKeysWithLegacy(store, AUDIT_PREFIX)).sort((a, b) => b.key.localeCompare(a.key));
  const visible = [];
  // Recent privacy migrations can create long runs of team-hidden records.
  // Read small audit batches concurrently while preserving newest-first order.
  for (let start = 0; start < keys.length && visible.length < parsedLimit; start += 50) {
    const batch = keys.slice(start, start + 50);
    const entries = await Promise.all(
      batch.map(async ({ key }) => {
        const obj = await getWithLegacyFallback(store, key);
        if (!obj) return null;
        try {
          return JSON.parse(await obj.text());
        } catch {
          return null;
        }
      })
    );
    for (const entry of entries) {
      if (!entry) continue;
      if (scope !== "private") {
        // Only an immutable event-time decision may expose audit paths to a
        // team connection. Legacy records without the flag fail closed.
        if (entry.details?.team_visible !== true) continue;
      }
      visible.push(entry);
      if (visible.length >= parsedLimit) break;
    }
  }
  if (!visible.length) return toolText("(no visible changes)");
  return toolText(
    visible
      .map((entry) => {
        const pathText = entry.paths.join(" → ");
        const count = entry.details?.count ? ` (${entry.details.count} objects)` : "";
        return `${entry.at} — ${entry.action}${count} — ${pathText}`;
      })
      .join("\n")
  );
}
