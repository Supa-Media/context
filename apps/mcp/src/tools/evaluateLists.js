/** Server-side Folder list evaluation at this MCP connection's exact scope. */

import { MAX_EVALUATED_LIST_BLOCKS, parseListBlocks, selectListRows } from "../lists.js";
import { canSee } from "../privacy/engine.js";
import { openStoredNote } from "../notes/sealing.js";
import { listVisibleNoteKeys } from "../notes/visibleKeys.js";
import { getWithLegacyFallback } from "../storageLayout.js";
import { normalizePath } from "../notes/paths.js";
import { probeWithLegacyFallback } from "../notes/storage.js";
import { factProps } from "../tree/facts.js";
import { toolError, toolText } from "./results.js";

const MAX_LIST_CANDIDATES = 500;

/** The note whose List blocks are evaluated: opened, because its blocks are in its body. */
async function sourceText(store, scope, rules, overrides, path) {
  if (!canSee(path, scope, rules, overrides)) return null;
  if (!(await probeWithLegacyFallback(store, path))) return null;
  const object = await getWithLegacyFallback(store, path);
  if (!object) return null;
  const opened = await openStoredNote(store, await object.text());
  return opened.ok ? opened.text : null;
}

function instantOf(value) {
  const instant = value instanceof Date ? value.valueOf() : NaN;
  return Number.isFinite(instant) ? instant : null;
}

/**
 * Every List block in one note, evaluated over the notes its `from:` folder
 * holds. The source note is opened; the candidates are not (owner,
 * 2026-10-13: only opening a note reads storage). Each candidate's front
 * matter, inline tags and first heading are the Convex tree's props of it,
 * and its date is the tree's. A sealed candidate is left out, as it always
 * was; one the tree has not read yet is left out too, and the block says
 * `pending` so a client does not take a short List for the whole folder.
 */
export async function toolEvaluateLists(store, scope, rules, overrides, pathArg) {
  const path = normalizePath(pathArg);
  if (!path || !path.endsWith(".md")) return toolError("invalid path");
  const source = await sourceText(store, scope, rules, overrides, path);
  if (source === null) return toolError("not found");

  const blocks = parseListBlocks(source).slice(0, MAX_EVALUATED_LIST_BLOCKS);
  const lists = [];
  for (const block of blocks) {
    if (block.error) {
      lists.push({ line: block.line, error: block.error });
      continue;
    }
    const visible = await listVisibleNoteKeys(store, scope, rules, overrides, block.config.from);
    if (visible.length > MAX_LIST_CANDIDATES) {
      lists.push({ line: block.line, error: "this list is too large to evaluate safely" });
      continue;
    }
    const facts = (await factProps(store, visible.map(({ key }) => key))) ?? new Map();
    const notes = [];
    let pending = false;
    for (const { key, uploaded } of visible) {
      const fact = facts.get(key);
      if (!fact) {
        pending = true;
        continue;
      }
      if (fact.sealed) continue;
      notes.push({
        path: key,
        updatedAt: instantOf(uploaded),
        properties: fact.props.properties,
        inlineTags: fact.props.inlineTags,
        heading: fact.props.heading,
      });
    }
    const selection = selectListRows(block.config, notes, { selfPath: path });
    lists.push({
      line: block.line,
      rows: selection.rows,
      truncated: selection.truncated,
      ...(pending ? { pending: true } : {}),
      // `total` is intentionally absent: the returned notes are visible, but
      // preserving the no-count contract keeps this result safe to reuse.
    });
  }
  return toolText(JSON.stringify({ path, lists }));
}
