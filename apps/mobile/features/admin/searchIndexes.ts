/**
 * The Search tab's Indexes view (`./IndexesView`) as data: three
 * per-workspace indexes (the file tree, fast search and search by meaning)
 * joined into one row per workspace, each reduced to a health the eye can scan.
 *
 * Asked for by the owner, 2026-10-08 ("the search page literally has a bunch
 * of different things like tree index, search by meaning etc … not the best
 * UI"): three stacked tables became one, opening on what needs attention.
 *
 * The file tree column is the Convex copy, which the sidebar, folder pages,
 * Home and agents read (the owner approved the board, 2026-10-13). Its detail
 * adds the copy's facts:
 * the links and front matter Lists, Boards, the map and the chaos score read,
 * which lived in each workspace's own D1 tables until phase 7 of the tree
 * migration. Pure, so the rules are pinned by `adminSearchIndexes.test.ts`.
 */

import type { FunctionReturnType } from "convex/server";
import type { api } from "@context/convex/_generated/api";
import type { DotTone } from "../design";
import { meaningFailureLine, meaningStatePill, type MeaningIndexRow } from "./meaningIndexes";

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

export type IndexKey = "files" | "fast" | "meaning";

export const INDEXES: readonly { key: IndexKey; label: string; what: string }[] = [
  {
    key: "files",
    label: "File tree",
    what: "What the sidebar, folder pages, Home and AI clients list notes from. Keeps itself current; Check compares it with the bucket. Rules from Convex makes the privacy rules held there decide who sees what, with each privacy.md written from them.",
  },
  { key: "fast", label: "Fast search", what: "Word search, in the app and for AI clients." },
  { key: "meaning", label: "Search by meaning", what: "Finds notes on the same topic in different words." },
];

export type WorkspaceIndexes = {
  workspaceId: string;
  slug: string | null;
  /** The file tree column: the Convex copy. */
  files: IndexCell;
  fast: IndexCell;
  meaning: IndexCell;
  /** The Convex copy alone, for the row's detail. */
  convex: IndexCell;
  /** The copy's facts behind Lists, Boards, the map and the chaos score, for the row's detail. */
  details: IndexCell;
  /** Only archived accounts hold it: nothing runs on it, and it never needs attention. */
  archived: boolean;
  /** Newest change we know of across them, for the Changed column. */
  changedAt: number | null;
  /** The raw rows, for the buttons that act on them. */
  meaningRow: MeaningIndexRow | null;
  migrationRow: MigrationRow | null;
  /** Notes no reader of the bucket can read, and why; null when there are none. */
  unreadable: Unreadable | null;
};

/** The dot colour for a health. */
export function healthTone(health: IndexHealth): DotTone {
  return health === "ok" ? "ok" : health === "working" ? "warn" : health === "stuck" ? "crit" : "neutral";
}

const NONE: IndexCell = { health: "none", label: "—", figure: null, progress: null, problem: null, tiers: null };

/**
 * A workspace only archived accounts hold (admin › People › Archive): no round
 * or Start all touches it, so each of its indexes reads Archived, not Stuck
 * (the owner, 2026-10-14).
 */
const ARCHIVED: IndexCell = { health: "off", label: "Archived", figure: null, progress: null, problem: null, tiers: null };

const format = (n: number) => n.toLocaleString("en-US");

function progressOf(indexed: number | null, pending: number | null) {
  if (indexed === null) return { figure: null, progress: null };
  if (pending === null || pending === 0) return { figure: format(indexed), progress: null };
  return { figure: `${format(indexed)} of ${format(indexed + pending)}`, progress: { done: indexed, total: indexed + pending } };
}

/** Passes in a row a passing kind of failure gets before it reads as stuck rather than a hiccup. */
export const UNREADABLE_AFTER_PASSES = 3;

/** Why the notes do not read, after "1 note" / "2 notes", in words (`apps/mcp/src/store/readFailure.js`). */
const UNREADABLE_WORDS: Record<string, readonly [one: string, many: string]> = {
  unsealed: [
    "was saved unsealed after this workspace was sealed, so it can't be opened. Seal again walks the bucket and seals it.",
    "were saved unsealed after this workspace was sealed, so they can't be opened. Seal again walks the bucket and seals them.",
  ],
  sealed: ["is sealed but doesn't open with this workspace's key.", "are sealed but don't open with this workspace's key."],
  name: ["has a name storage can't address.", "have names storage can't address."],
  storage: ["was refused by the storage.", "were refused by the storage."],
  other: ["keeps failing to read.", "keep failing to read."],
};
const LASTING = new Set(["unsealed", "sealed", "name"]);

export type Unreadable = { count: number; kind: string; problem: string };

/**
 * Notes the facts fill cannot read, once it is clear they will not read on
 * their own: at once for a lasting kind (a note saved unsealed into a sealed
 * bucket never opens however often it is tried), after a few passes for the
 * rest. Every reader of the bucket meets the same notes, so this is also why
 * search sits short of the end (@segunawe, 2026-10-14).
 */
export function unreadableOf(row: MigrationRow | null): Unreadable | null {
  const facts = row?.facts ?? null;
  if (facts === null || facts.retrying === 0 || facts.retryKind === null) return null;
  if (!LASTING.has(facts.retryKind) && facts.retryPasses < UNREADABLE_AFTER_PASSES) return null;
  const count = facts.retrying;
  const notes = `${format(count)} ${count === 1 ? "note" : "notes"}`;
  const [one, many] = UNREADABLE_WORDS[facts.retryKind] ?? UNREADABLE_WORDS.other!;
  return { count, kind: facts.retryKind, problem: `${notes} ${count === 1 ? one : many}` };
}

/**
 * The copy's facts (`lib/nodes/facts.ts` in the control plane): `Ready` once
 * the fill has read every note. A failed read is retried by the next pass, and
 * the 15-minute round starts a fill that is due; one that will not read on its
 * own is stuck and says why (`unreadableOf`). Paused with the copy, since the
 * round starts nothing while it is.
 */
export function factsCell(row: MigrationRow | null, paused = false): IndexCell {
  if (row === null) return NONE;
  const base = { figure: null, progress: null, problem: null, tiers: null };
  const facts = row.facts;
  if (facts !== null && facts.ready && facts.retrying === 0) return { ...base, health: "ok", label: "Ready" };
  const unreadable = unreadableOf(row);
  if (unreadable !== null) {
    return { ...base, health: "stuck", label: "Can't read", figure: `${format(unreadable.count)} ${unreadable.count === 1 ? "note" : "notes"}`, problem: unreadable.problem };
  }
  if (paused) return { ...base, health: "off", label: "Paused" };
  if (facts === null) return { ...base, health: "working", label: "Not started" };
  if (!facts.ready) return { ...base, health: "working", label: "Filling" };
  return { ...base, health: "working", label: "Retrying", figure: `${format(facts.retrying)} to read again` };
}

/**
 * A search index still short of the end by no more notes than the bucket
 * cannot read is not indexing: it is waiting on those notes, and says so
 * rather than sitting on "Indexing 4 of 6".
 */
export function waitingOnUnreadable(cell: IndexCell, unreadable: Unreadable | null): IndexCell {
  if (unreadable === null || cell.health !== "working" || cell.progress === null) return cell;
  const left = cell.progress.total - cell.progress.done;
  if (left <= 0 || left > unreadable.count) return cell;
  return { ...cell, health: "stuck", label: "Waiting", problem: `Waiting on ${format(left)} ${left === 1 ? "note" : "notes"} that can't be read. See File tree.` };
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
      return { ...base, health: "off", label: "Skipped", problem: "This storage can't be listed in order" };
    case "keyed":
      return { ...base, health: "ok", label: "Notes by id" };
  }
}

const RANK: Record<IndexHealth, number> = { stuck: 0, working: 1, ok: 2, off: 3, none: 3 };

/** The worst of a row's three, which decides its order and whether it needs attention. */
export function worstHealth(row: Pick<WorkspaceIndexes, IndexKey>): IndexHealth {
  return [row.files.health, row.fast.health, row.meaning.health].reduce((worst, each) =>
    RANK[each] < RANK[worst] ? each : worst,
  );
}

export function needsAttention(row: Pick<WorkspaceIndexes, IndexKey>): boolean {
  const worst = worstHealth(row);
  return worst === "stuck" || worst === "working";
}

/**
 * One row per workspace that has any of them. `migration` is null while its
 * report loads; `paused` is the whole copy's switch.
 */
export function joinIndexes(
  meaning: readonly MeaningIndexRow[],
  migration: readonly MigrationRow[] | null = null,
  paused = false,
): WorkspaceIndexes[] {
  const byId = new Map<string, { slug: string | null; meaning: MeaningIndexRow | null }>();
  for (const row of meaning) byId.set(row.workspaceId, { slug: row.slug, meaning: row });
  for (const row of migration ?? []) {
    if (!byId.has(row.workspaceId)) byId.set(row.workspaceId, { slug: row.slug, meaning: null });
  }
  const copies = new Map<string, MigrationRow>((migration ?? []).map((row) => [row.workspaceId, row] as const));
  const rows = [...byId.entries()].map(([workspaceId, entry]): WorkspaceIndexes => {
    const copy = copies.get(workspaceId) ?? null;
    const changed = [entry.meaning?.updatedAt ?? null, copy?.sweptAt ?? null].filter(
      (n): n is number => n !== null,
    );
    const archived = entry.meaning?.archived === true || copy?.archived === true;
    const convex = archived ? ARCHIVED : convexCell(copy, paused);
    const unreadable = unreadableOf(copy);
    return {
      workspaceId,
      slug: entry.slug,
      files: convex,
      fast: archived ? ARCHIVED : waitingOnUnreadable(fastCell(entry.meaning?.fastSearch ?? null), unreadable),
      meaning: archived ? ARCHIVED : waitingOnUnreadable(meaningCell(entry.meaning), unreadable),
      convex,
      details: archived ? ARCHIVED : factsCell(copy, paused),
      archived,
      changedAt: changed.length === 0 ? null : Math.max(...changed),
      meaningRow: entry.meaning,
      migrationRow: copy,
      unreadable: archived ? null : unreadable,
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
    files: { ok: "ready", working: "copying", stuck: "stuck or differ", off: "paused, skipped or archived" },
    fast: { ok: "ready", working: "indexing", stuck: "failed", off: "off or archived" },
    meaning: { ok: "ready", working: "indexing", stuck: "failed", off: "off or archived" },
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
