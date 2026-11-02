/**
 * A workspace's tree rows as its workspace object holds them, and the checks
 * that the two copies agree (decided by the owner, 2026-11-01;
 * `docs/decisions/storage-and-credentials/workspace-objects.md`).
 *
 * The object's row and digest shapes are its own (`apps/mcp/src/workspaceStore/rows.js`):
 * the digest here must be byte-for-byte the object's, or every comparison
 * reports a difference. `rows.test.ts` pins the two against each other.
 *
 * Who-can-see is compared from two derivations: Convex's own reader rules
 * (`nodesPrivacy.readerRules`, derived from the rows and grants) on the
 * Convex side, the object's held rules on the other, both run through the
 * same `canSee`. Answers only counts.
 */

import { canSee, PrivacyOverrides } from "../../../../mcp/src/privacy/engine.js";

/** One row as the object takes it (`workspaceStore/api.js`). */
export interface ObjectRow {
  id: string;
  noteId: string | null;
  path: string;
  kind: "file" | "folder";
  storageKey: string | null;
  etag: string | null;
  size: number | null;
  collaborates: boolean;
  uploaded: number | null;
  role: string | null;
  order: number | null;
  archiveOf: string | null;
  at: number;
}

/** The fields the object's digest covers, in its order. */
const DIGEST_FIELDS = ["id", "noteId", "path", "kind", "storageKey", "etag", "size", "collaborates", "uploaded", "role", "order", "archiveOf"] as const;

export interface ConvexRowLike {
  _id: string;
  path: string;
  kind: "file" | "folder";
  noteId?: string;
  storageKey?: string;
  etag?: string;
  size?: number;
  goneAt?: number;
  collaborates?: boolean;
  uploaded?: number;
  role?: string;
  order?: number;
  archiveOf?: string;
}

const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** A live Convex row as the object row, stamped with `at` (the copy's clock); `null` for a gone row. */
export function objectRowOf(row: ConvexRowLike, at: number): ObjectRow | null {
  if (row.goneAt !== undefined) return null;
  return {
    id: String(row._id),
    noteId: row.noteId ?? null,
    path: row.path,
    kind: row.kind,
    storageKey: row.storageKey ?? null,
    etag: row.etag ?? null,
    size: finite(row.size),
    collaborates: row.collaborates === true,
    uploaded: finite(row.uploaded),
    role: row.role ?? null,
    order: finite(row.order),
    archiveOf: row.archiveOf ?? null,
    at,
  };
}

/** The object's digest over `rows`: their count, and a SHA-256 of each row's digest fields in id order. */
export async function rowsDigest(rows: ObjectRow[]): Promise<{ rows: number; sha256: string }> {
  // SQLite's `ORDER BY id` on TEXT is a byte order; ids are ASCII, so code-unit order is the same.
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const canonical = sorted.map((row) => JSON.stringify(DIGEST_FIELDS.map((field) => row[field] ?? null))).join("\n");
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return { rows: sorted.length, sha256: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("") };
}

/** Reader rules as `nodesPrivacy.readerRules` returns them. */
export interface ReaderRules {
  rules: Array<{ prefix: string; vis: string }>;
  overrides: Array<{ path: string; vis: string }>;
}

/** A reader to ask about: an owner (`private`), a member (`team`), or a member holding one row token. */
export interface SamplePrincipal {
  scope: "private" | "team";
  groups: string[];
}

/** The most row tokens sampled, one principal each. */
export const MAX_SAMPLED_TOKENS = 20;

/** Owner, member, and a member holding each row token the rules name (up to `MAX_SAMPLED_TOKENS`). */
export function samplePrincipals(rules: ReaderRules): SamplePrincipal[] {
  const tokens = new Set<string>();
  for (const value of [...rules.rules.map((rule) => rule.vis), ...rules.overrides.map((override) => override.vis)]) {
    if (value !== "team" && value !== "private" && tokens.size < MAX_SAMPLED_TOKENS) tokens.add(value);
  }
  return [{ scope: "private", groups: [] }, { scope: "team", groups: [] }, ...[...tokens].sort().map((token) => ({ scope: "team" as const, groups: [token] }))];
}

/** What Convex's rules say `principal` may see, for each of `rows` (live files with a note id). */
export function convexVisible(rows: ObjectRow[], rules: ReaderRules, principal: SamplePrincipal): boolean[] {
  const overrides = new PrivacyOverrides();
  for (const override of rules.overrides) overrides.set(override.path, override.vis);
  const parsed = rules.rules.map((rule) => ({ prefix: rule.prefix, vis: rule.vis }));
  const tokens = new Set(principal.groups);
  return rows.map((row) => canSee(row.path, principal.scope, parsed, overrides, tokens) === true);
}

/** The live file rows a visibility check asks about: those with a note id, one per id (the latest). */
export function noteRows(rows: ObjectRow[]): ObjectRow[] {
  const byNote = new Map<string, ObjectRow>();
  for (const row of rows) {
    if (row.kind !== "file" || row.noteId === null) continue;
    const held = byNote.get(row.noteId);
    if (held === undefined || held.at <= row.at) byNote.set(row.noteId, row);
  }
  return [...byNote.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}
