/**
 * The agent tools' listing of a workspace (`tree/served.js`), answered by its object from its own rows and rules:
 * the same answer `/gateway/tree/manifest` gives from the Convex tree
 * (`apps/convex/functions/lib/nodes/gatewayManifest.ts`), without the control plane.
 *
 * Every live file row under the folder that the reader may see, judged by the same check every other answer here
 * goes through (`serve.js` `judgeFor`: the reader's audience's rules, `canSee`, failing closed), in UTF-8 byte order
 * (the order a bucket lists in, and the tree's walk), a page at a time. The cursor is the last path handed out, never
 * anything about a row the reader was not given.
 *
 * The refusals are the tree's:
 * - no rules held: `{ served: false }`, and the gateway asks the control plane, as it does today;
 * - a folder the reader cannot see answers as an empty one: no entries, no cursor;
 * - plumbing (`.context/`, any dot folder) reaches nobody: `canSee` refuses it.
 *
 * A Tex guest chat, a guest and a member are judged as their reads are, so a listing never names a note the same
 * reader could not open, and never leaves out one it could.
 */

import { compareKeys } from "../tree/served.js";
import { folderPathOf, folderVisibleAtScope } from "./listing.js";

/** Entries one answer carries: the tree's own page (`GATEWAY_PAGE_ENTRIES`). */
export const MANIFEST_PAGE_ENTRIES = 10_000;

/** A cursor is one path the reader was given. */
function cursorOf(raw) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string" || raw.length > 1024 || raw.includes("\0")) return { ok: false };
  return { ok: true, value: raw };
}

/**
 * One page of the keys the reader may see under `fields.folder`.
 *
 * @param {ReturnType<import("./rows.js").workspaceRows>} rows
 * @param {{folder?: string, cursor?: string, limit?: number}} fields
 * @param {{clearance: {scope: "private"|"team", names: ReadonlySet<string>}|null, parsed: {rules: object[], overrides: Map<string, string>}|null, sees: (row: object|null) => boolean}} judge
 */
export function manifestPage(rows, fields, judge) {
  const folder = folderPathOf(fields?.folder ?? "");
  const cursor = cursorOf(fields?.cursor);
  if (folder === null || !cursor.ok || judge.clearance === null || judge.parsed === null) return { served: false };
  const { rules, overrides } = judge.parsed;
  const prefix = folder === "" ? "" : `${folder}/`;
  const limit = Math.max(1, Math.min(MANIFEST_PAGE_ENTRIES, Number.isFinite(fields?.limit) ? Math.floor(fields.limit) : MANIFEST_PAGE_ENTRIES));
  // Read whether or not the folder may be seen, so a hidden folder costs what a visible one does.
  const under = rows.filesUnder(prefix, cursor.value);
  if (folder !== "" && !folderVisibleAtScope(folder, judge.clearance, rules, overrides)) return { served: true, entries: [], cursor: null };
  const visible = under
    .filter((row) => (cursor.value === null || compareKeys(row.path, cursor.value) > 0) && judge.sees(row))
    .sort((a, b) => compareKeys(a.path, b.path));
  const page = visible.slice(0, limit);
  return {
    served: true,
    entries: page.map((row) => ({
      path: row.path,
      ...(typeof row.etag === "string" && row.etag !== "" ? { etag: row.etag } : {}),
      ...(Number.isFinite(row.size) ? { size: row.size } : {}),
      ...(Number.isFinite(row.uploaded) ? { updatedAt: row.uploaded } : {}),
      ...(typeof row.noteId === "string" && row.noteId !== "" ? { noteId: row.noteId } : {}),
    })),
    cursor: visible.length > limit ? page[page.length - 1].path : null,
  };
}
