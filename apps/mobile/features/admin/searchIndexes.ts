/**
 * The Search tab's Indexes view (`./IndexesView`) as data: the four
 * per-workspace indexes (the sidebar's tree, fast search, search by meaning,
 * and the Convex copy of the migration) joined into one row per workspace,
 * each reduced to a health the eye can scan.
 *
 * Asked for by the owner, 2026-10-08 ("the search page literally has a bunch
 * of different things like tree index, search by meaning etc … not the best
 * UI"): three stacked tables became one, opening on what needs attention.
 * Pure, so the rules are pinned by `adminSearchIndexes.test.ts`.
 */

import type { FunctionReturnType } from "convex/server";
import type { api } from "@context/convex/_generated/api";
import { meaningFailureLine, meaningStatePill, type MeaningIndexRow } from "./meaningIndexes";

export type TreeIndexRow = FunctionReturnType<typeof api.functions.treeAdmin.treeIndexes>["rows"][number];
export type MigrationRow = FunctionReturnType<typeof api.functions.nodesMigration.report>["rows"][number];
type Priorities = MeaningIndexRow["priorities"];

/** `ok` is done, `working` is on its way, `stuck` wants a person, `off` is meant, `none` has nothing. */
export type IndexHealth = "ok" | "working" | "stuck" | "off" | "none";

export type IndexCell = {
  health: IndexHealth;
  /** One or two words: `Ready`, `Indexing`, `Not filled`. */
  label: string;
  /** The figure beside it: `9,412` or `340 of 1,204`; null when there is none. */
  figure: string | null;
  /** Done of total for a bar, only while there is something left. */
  progress: { done: number; total: number } | null;
  /** Why it is stuck, in words; null when it is not. */
  problem: string | null;
  /** The T0/T1/T2 split, when a pass reported one. */
  tiers: Priorities;
};

export type IndexKey = "tree" | "fast" | "meaning" | "convex";

export const INDEXES: readonly { key: IndexKey; label: string; what: string }[] = [
  { key: "tree", label: "Sidebar tree", what: "What the sidebar is drawn from. Without it the sidebar still works, just slower." },
  { key: "fast", label: "Fast search", what: "Word search, in the app and for AI clients." },
  { key: "meaning", label: "Search by meaning", what: "Finds notes on the same topic in different words." },
  {
    key: "convex",
    label: "Convex copy",
    what: "The backend migration: each workspace's file tree copied into Convex and checked against its bucket. Once a check matches, the app's sidebar and folder pages read it live. Pause sends everyone back to the bucket.",
  },
];

export type WorkspaceIndexes = {
  workspaceId: string;
  slug: string | null;
  tree: IndexCell;
  fast: IndexCell;
  meaning: IndexCell;
  convex: IndexCell;
  /** Newest change we know of across the four, for the Changed column. */
  changedAt: number | null;
  /** The raw rows, for the buttons that act on them. */
  treeRow: TreeIndexRow | null;
  meaningRow: MeaningIndexRow | null;
  migrationRow: MigrationRow | null;
};

const NONE: IndexCell = { health: "none", label: "—", figure: null, progress: null, problem: null, tiers: null };

const format = (n: number) => n.toLocaleString("en-US");

function progressOf(indexed: number | null, pending: number | null) {
  if (indexed === null) return { figure: null, progress: null };
  if (pending === null || pending === 0) return { figure: format(indexed), progress: null };
  return { figure: `${format(indexed)} of ${format(indexed + pending)}`, progress: { done: indexed, total: indexed + pending } };
}

export function treeCell(row: TreeIndexRow | null): IndexCell {
  if (row === null) return NONE;
  const figure = row.rows === null ? null : format(row.rows);
  const base = { figure, progress: null, problem: null, tiers: null };
  if (row.status === "unreachable") return { ...base, health: "stuck", label: "Can't reach", problem: row.error };
  if (row.error !== null) return { ...base, health: "stuck", label: "Stuck", problem: `Last pass failed: ${row.error}` };
  switch (row.status) {
    case "ready":
      return row.dirty ? { ...base, health: "working", label: "Catching up" } : { ...base, health: "ok", label: "Ready" };
    case "filling":
      return { ...base, health: "working", label: "Filling" };
    case "empty":
      return { ...base, health: "stuck", label: "Not filled" };
    case "unsupported":
      return { ...base, health: "off", label: "Can't fill" };
  }
}

export function fastCell(fast: MeaningIndexRow["fastSearch"] | null): IndexCell {
  if (fast === null) return NONE;
  const { figure, progress } = progressOf(fast.notesIndexed, fast.notesPending);
  const base = { figure, progress, problem: null, tiers: fast.priorities };
  switch (fast.status) {
    case "ready":
      return progress ? { ...base, health: "working", label: "Catching up" } : { ...base, health: "ok", label: "Ready" };
    case "backfilling":
      return { ...base, health: "working", label: "Indexing" };
    case "provisioning":
      return { ...base, health: "working", label: "Setting up" };
    case "failed":
      return { ...base, health: "stuck", label: "Failed" };
    case "releasing":
      return { ...base, health: "off", label: "Deleting" };
    case "off":
      return { ...base, health: "off", label: "Off" };
    default:
      return { ...base, health: "working", label: fast.status };
  }
}

export function meaningCell(row: MeaningIndexRow | null): IndexCell {
  if (row === null) return NONE;
  const { figure, progress } = progressOf(row.notesIndexed, row.notesPending);
  const base = { figure, progress, problem: meaningFailureLine(row), tiers: row.priorities };
  const label = meaningStatePill(row).label;
  if (!row.enabled) return { ...base, health: "off", label: "Off by owner", progress: null };
  switch (row.status) {
    case "ready":
      return { ...base, health: progress ? "working" : "ok", label: progress ? "Catching up" : label };
    case "backfilling":
    case "provisioning":
      return { ...base, health: "working", label };
    case "failed":
      return { ...base, health: "stuck", label };
    case "releasing":
    case "off":
      return { ...base, health: "off", label, progress: null };
  }
}

/** Where the Convex copy's differences are, in words: `3 files differ from the bucket; privacy rules differ`. */
export function parityWords(parity: MigrationRow["parity"]): string {
  if (parity === null) return "Not checked against the bucket yet";
  const parts: string[] = [];
  if (parity.mismatches > 0) {
    parts.push(`${format(parity.mismatches)} ${parity.mismatches === 1 ? "file differs" : "files differ"} from the bucket`);
  }
  if (!parity.privacyMatches) parts.push("privacy rules differ");
  if (parts.length === 0) return "Matches the bucket";
  const said = parts.join("; ");
  return said.charAt(0).toUpperCase() + said.slice(1);
}

/**
 * The Convex copy (the backend migration). While the whole migration is
 * paused, a copy that has not finished reads as paused, not as stuck: the
 * owner paused it on purpose.
 */
export function convexCell(row: MigrationRow | null, paused = false): IndexCell {
  if (row === null) return NONE;
  const base = { figure: row.files > 0 ? format(row.files) : null, progress: null, problem: null, tiers: null };
  switch (row.stage) {
    case "matches":
      return { ...base, health: "ok", label: "Matches" };
    case "copied":
      return { ...base, health: "ok", label: "Copied" };
    case "copying":
      return paused ? { ...base, health: "off", label: "Paused" } : { ...base, health: "working", label: "Copying" };
    case "waiting":
      return paused ? { ...base, health: "off", label: "Paused" } : { ...base, health: "working", label: "Not started" };
    case "stuck":
      return { ...base, health: "stuck", label: "Stuck", problem: row.error ?? "The last pass failed" };
    case "differs":
      return { ...base, health: "stuck", label: "Differs", problem: parityWords(row.parity) };
    case "skipped":
      return { ...base, health: "off", label: "Skipped", problem: "This storage can't be listed in order (Dropbox)" };
  }
}

const RANK: Record<IndexHealth, number> = { stuck: 0, working: 1, ok: 2, off: 3, none: 3 };

/** The worst of a row's three, which decides its order and whether it needs attention. */
export function worstHealth(row: Pick<WorkspaceIndexes, IndexKey>): IndexHealth {
  return [row.tree.health, row.fast.health, row.meaning.health, row.convex.health].reduce((worst, each) =>
    RANK[each] < RANK[worst] ? each : worst,
  );
}

export function needsAttention(row: Pick<WorkspaceIndexes, IndexKey>): boolean {
  const worst = worstHealth(row);
  return worst === "stuck" || worst === "working";
}

/**
 * One row per workspace that has any of the four. `tree` is null until the
 * tree read lands (it is an action, read on open), and the rows show without
 * it rather than wait. `migration` is null while its report loads; `paused`
 * is the whole migration's switch.
 */
export function joinIndexes(
  tree: readonly TreeIndexRow[] | null,
  meaning: readonly MeaningIndexRow[],
  migration: readonly MigrationRow[] | null = null,
  paused = false,
): WorkspaceIndexes[] {
  const byId = new Map<string, { slug: string | null; tree: TreeIndexRow | null; meaning: MeaningIndexRow | null }>();
  for (const row of meaning) byId.set(row.workspaceId, { slug: row.slug, tree: null, meaning: row });
  for (const row of tree ?? []) {
    const found = byId.get(row.workspaceId);
    if (found) found.tree = row;
    else byId.set(row.workspaceId, { slug: row.slug, tree: row, meaning: null });
  }
  for (const row of migration ?? []) {
    if (!byId.has(row.workspaceId)) byId.set(row.workspaceId, { slug: row.slug, tree: null, meaning: null });
  }
  const copies = new Map<string, MigrationRow>((migration ?? []).map((row) => [row.workspaceId, row] as const));
  const rows = [...byId.entries()].map(([workspaceId, entry]): WorkspaceIndexes => {
    const copy = copies.get(workspaceId) ?? null;
    const changed = [entry.meaning?.updatedAt ?? null, entry.tree?.sweptAt ?? null, copy?.sweptAt ?? null].filter(
      (n): n is number => n !== null,
    );
    return {
      workspaceId,
      slug: entry.slug ?? entry.tree?.slug ?? null,
      tree: treeCell(entry.tree),
      fast: fastCell(entry.meaning?.fastSearch ?? null),
      meaning: meaningCell(entry.meaning),
      convex: convexCell(copy, paused),
      changedAt: changed.length === 0 ? null : Math.max(...changed),
      treeRow: entry.tree,
      meaningRow: entry.meaning,
      migrationRow: copy,
    };
  });
  return rows.sort(
    (a, b) => RANK[worstHealth(a)] - RANK[worstHealth(b)] || (a.slug ?? "￿").localeCompare(b.slug ?? "￿"),
  );
}

/** How many workspaces each index has in each health, for the summary cards. */
export function healthCounts(rows: readonly WorkspaceIndexes[], key: IndexKey): Record<IndexHealth, number> {
  const counts: Record<IndexHealth, number> = { ok: 0, working: 0, stuck: 0, off: 0, none: 0 };
  for (const row of rows) counts[row[key].health] += 1;
  return counts;
}

/** `ready`, `indexing` and so on for a summary card, in the index's own words; only the non-zero ones. */
export function countParts(key: IndexKey, counts: Record<IndexHealth, number>): { health: IndexHealth; text: string }[] {
  const words: Record<IndexKey, Record<"ok" | "working" | "stuck" | "off", string>> = {
    tree: { ok: "ready", working: "filling", stuck: "stuck or not filled", off: "can't fill" },
    fast: { ok: "ready", working: "indexing", stuck: "failed", off: "off" },
    meaning: { ok: "ready", working: "indexing", stuck: "failed", off: "off" },
    convex: { ok: "match or copied", working: "copying or not started", stuck: "stuck or differ", off: "paused or skipped" },
  };
  return (["ok", "working", "stuck", "off"] as const)
    .filter((health) => counts[health] > 0)
    .map((health) => ({ health, text: `${format(counts[health])} ${words[key][health]}` }));
}

/** A typed `@maya` or `maya` matches by slug, anywhere in it. */
export function matchesFind(row: Pick<WorkspaceIndexes, "slug">, find: string): boolean {
  const asked = find.trim().replace(/^@/, "").toLowerCase();
  return asked === "" || (row.slug ?? "").toLowerCase().includes(asked);
}

/** Tier names for the detail bars (T0 is priority 1; the owner, 2026-10-08). */
export function tierLabel(priority: number): string {
  const name = priority === 1 ? "Main" : priority === 2 ? "Inbox" : priority === 3 ? "Archive" : "";
  return `T${priority - 1} ${name}`.trim();
}
