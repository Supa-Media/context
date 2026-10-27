/**
 * The privacy mirror: `privacy.md`'s rules as the tree keeps them
 * (`nodePrivacy`, `table.ts`).
 *
 * The tree holds the rules the readers judge by. Nothing here reads the bucket:
 * a mirror is written from the rows and the rules, never from a listing.
 *
 * Only the rules are kept. The prose around the managed block is the
 * customer's text, and CLAUDE.md keeps note content out of the control plane.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { PRE_PARSED_RULES } from "../../../../mcp/src/privacy/engine.js";
import { renderPrivacyRulesBlock, type PrivacyRule, type Visibility } from "../privacy";
import type { PrivacyMirror } from "./table";

/** The workspace's privacy mirror as a store renders it, or `null` when the tree holds none. */
export async function readMirror(db: QueryCtx["db"], workspaceId: Id<"workspaces">): Promise<PrivacyMirror | null> {
  const row = await db
    .query("nodePrivacy")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .unique();
  if (row === null) return null;
  return {
    ...(row.etag === undefined ? {} : { etag: row.etag }),
    invalid: row.invalid,
    folders: row.folders,
    notes: row.notes,
  };
}


/** A `privacy.md` that will not parse. Rendering an invalid mirror as this makes the rendered file parse invalid too. */
const UNPARSEABLE = "privacy.md is not parseable\n";

/**
 * A `privacy.md` whose managed block parses back to the mirror's rules and
 * exceptions. `null` when the mirror has no etag, which is the same as no file.
 *
 * Only the block is rendered, not the prose around it: the mirror never had
 * the prose, and `loadPrivacyState` reads the rules from the block alone.
 */
export function renderMirror(mirror: PrivacyMirror): string | null {
  if (mirror.etag === undefined) return null;
  if (mirror.invalid) return UNPARSEABLE;
  const rules: PrivacyRule[] = mirror.folders.map((folder) => ({
    prefix: folder.prefix,
    vis: folder.visibility as Visibility,
  }));
  const overrides = new Map<string, Visibility>(
    mirror.notes.map((note): [string, Visibility] => [note.path, note.visibility as Visibility]),
  );
  return renderPrivacyRulesBlock(rules, overrides);
}

/**
 * The mirror as the object a bucket `get("privacy.md")` returns, or `null`
 * where the mirror holds no file. Every store that answers listings from the
 * tree answers `privacy.md` with this, so none of them falls through to the
 * bucket's file and checks the tree against itself.
 */
export function mirrorFile(mirror: PrivacyMirror | null): MirrorObject | null {
  if (mirror !== null && mirror.rows === true && mirror.etag !== undefined && !mirror.invalid) return rowsFile(mirror);
  const text = mirror === null ? null : renderMirror(mirror);
  if (mirror === null || mirror.etag === undefined || text === null) return null;
  const bytes = new TextEncoder().encode(text);
  return {
    etag: mirror.etag,
    text: async () => text,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

/** A `privacy.md` as a store hands it out. A rows view also carries its rules, already parsed. */
export type MirrorObject = {
  etag: string;
  text: () => Promise<string>;
  arrayBuffer: () => Promise<ArrayBuffer>;
  [PRE_PARSED_RULES]?: { rules: PrivacyRule[]; overrides: Map<string, Visibility> };
};

/**
 * A rows view as the object a store returns for `privacy.md`. The text is the rules rendered, for anything
 * that only wants bytes; the rules are the rows' own, handed over parsed, because a row token is not valid
 * in file text (`loadPrivacyState` takes them from `PRE_PARSED_RULES`).
 */
function rowsFile(mirror: PrivacyMirror): MirrorObject {
  const rules: PrivacyRule[] = mirror.folders.map((folder) => ({ prefix: folder.prefix, vis: folder.visibility as Visibility }));
  const overrides = new Map<string, Visibility>(mirror.notes.map((note): [string, Visibility] => [note.path, note.visibility as Visibility]));
  const text = renderPrivacyRulesBlock(rules, overrides);
  const bytes = new TextEncoder().encode(text);
  return {
    etag: mirror.etag!,
    text: async () => text,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    [PRE_PARSED_RULES]: { rules, overrides },
  };
}

/**
 * Whether two mirrors hold the same rules: the same folder defaults and the
 * same exceptions, whatever order they were read in, and the same validity.
 *
 * Order-insensitive because a file's rule order is the customer's to change,
 * and a reordered file is not a different policy. The etag is not compared:
 * it names a version of the file, and two versions can say the same thing.
 */
export function sameRules(a: PrivacyMirror, b: PrivacyMirror): boolean {
  if (a.invalid !== b.invalid) return false;
  return (
    sameSet(
      a.folders.map((folder) => JSON.stringify([folder.prefix, folder.visibility])),
      b.folders.map((folder) => JSON.stringify([folder.prefix, folder.visibility])),
    ) &&
    sameSet(
      a.notes.map((note) => JSON.stringify([note.path, note.visibility])),
      b.notes.map((note) => JSON.stringify([note.path, note.visibility])),
    )
  );
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((value, index) => value === y[index]);
}
