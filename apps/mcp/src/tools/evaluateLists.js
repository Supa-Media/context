/** Server-side Folder list evaluation at this MCP connection's exact scope. */

import {
  MAX_EVALUATED_LIST_BLOCKS,
  noteProperties,
  parseListBlocks,
  selectListRows,
} from "../lists.js";
import { canSee } from "../privacy/engine.js";
import { openStoredNote } from "../notes/sealing.js";
import {
  getVisibleMovedNote,
  listVisibleNoteKeysWithMoves,
} from "../notes/visibleKeys.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { normalizePath } from "../notes/paths.js";
import { probeWithLegacyFallback } from "../notes/storage.js";
import { toolError, toolText } from "./results.js";

const MAX_LIST_CANDIDATES = 500;

async function visibleText(store, scope, rules, overrides, path) {
  if (!canSee(path, scope, rules, overrides)) return null;
  const found = await getVisibleMovedNote(
    store,
    scope,
    rules,
    overrides,
    path,
    probeWithLegacyFallback,
  );
  if (!found.object) return null;
  const object = await getWithLegacyFallback(store, found.physicalPath);
  if (!object) return null;
  const opened = await openStoredNote(store, await object.text());
  if (!opened.ok) return null;
  return {
    text: opened.text,
    updatedAt:
      object.uploaded instanceof Date &&
      Number.isFinite(object.uploaded.valueOf())
        ? object.uploaded.valueOf()
        : null,
  };
}

export async function toolEvaluateLists(
  store,
  scope,
  rules,
  overrides,
  pathArg,
) {
  const path = normalizePath(pathArg);
  if (!path || !path.endsWith(".md")) return toolError("invalid path");
  const source = await visibleText(store, scope, rules, overrides, path);
  if (source === null) return toolError("not found");

  const blocks = parseListBlocks(source.text).slice(
    0,
    MAX_EVALUATED_LIST_BLOCKS,
  );
  const noteCache = new Map();
  const lists = [];
  for (const block of blocks) {
    if (block.error) {
      lists.push({ line: block.line, error: block.error });
      continue;
    }
    const visible = await listVisibleNoteKeysWithMoves(
      store,
      scope,
      rules,
      overrides,
      block.config.from,
    );
    if (visible.length > MAX_LIST_CANDIDATES) {
      lists.push({
        line: block.line,
        error: "this list is too large to evaluate safely",
      });
      continue;
    }
    const notes = [];
    for (const { key } of visible) {
      if (!noteCache.has(key)) {
        noteCache.set(
          key,
          await visibleText(store, scope, rules, overrides, key),
        );
      }
      const note = noteCache.get(key);
      if (note === null) continue;
      notes.push({
        path: key,
        updatedAt: note.updatedAt,
        properties: noteProperties(note.text),
      });
    }
    const selection = selectListRows(block.config, notes, { selfPath: path });
    lists.push({
      line: block.line,
      rows: selection.rows,
      truncated: selection.truncated,
      // `total` is intentionally absent: the returned notes are visible, but
      // preserving the no-count contract keeps this result safe to reuse.
    });
  }
  return toolText(JSON.stringify({ path, lists }));
}
