/**
 * ⌘K over every workspace: the pure half.
 *
 * Dev2 asked (2026-10-09) for ⌘K to search every workspace by default, to put
 * names, words and meaning in one ranked list, to say why each note matched,
 * and to show how long the search took. The search itself is the search page's
 * (`files.searchContexts`, through `useBlendedSearch`), so ⌘K and the page
 * answer alike and both answer like an AI client's `search_notes`
 * (`apps/convex/__tests__/searchParity.test.ts`). What is left for ⌘K is this
 * file: turning the page's rows into palette rows, and the arithmetic behind
 * the timing pill. Narrowing by typing (`in:`) is `searchFilters.ts`.
 *
 * No React here, for the reason `files/palette.ts` gives: these are rules that
 * are trivial to pin in a test and impossible to check by clicking around.
 */

import { displayPath, parentPath } from "../files/paths";
import { WHY_LABEL, paletteKey, type PaletteItem } from "../files/palette";
import type { BlendedAnswer, BlendedResult, PageState } from "../search/results";

/** Why a note is in the list, drawn as a tag on its row. */
export type WhyMatched = "name" | "words" | "meaning";

/** The tag's words; "Same topic, different words" is the owner's pick (2026-10-07). */
export { WHY_LABEL };

/**
 * Found by meaning alone; else every word typed is in its title; else its
 * words matched inside the note. Words are compared without case, and a word
 * of one or two letters is not held against the title — "a plan for rent"
 * should still count as in the name of "Rent plan".
 */
export function whyMatched(query: string, title: string, meaningOnly: boolean | undefined): WhyMatched {
  if (meaningOnly) return "meaning";
  const words = queryWords(query);
  const name = title.toLowerCase();
  return words.length > 0 && words.every((word) => name.includes(word)) ? "name" : "words";
}

/** The words a reason counts: lowercase, and none of one or two letters. */
export function queryWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 2))];
}

/**
 * The row's reason in words, which is the ranking made visible: a note with
 * every word typed ranks above one with some of them, so the row says which
 * ("Has all 3 words", "Has 2 of 3 words"). A strict hit has every word by
 * definition; a `loose` one is counted in its title and snippet, never as
 * none and never as all, since the index already said it was some.
 */
export function reasonFor(
  query: string,
  row: { title: string; snippet?: string; meaningOnly?: boolean; loose?: boolean },
): string {
  const why = whyMatched(query, row.title, row.meaningOnly);
  if (why !== "words") return WHY_LABEL[why];
  const words = queryWords(query);
  if (words.length === 0) return WHY_LABEL.words;
  if (words.length === 1) return "Has your word";
  if (!row.loose) return `Has all ${words.length} words`;
  const text = `${row.title} ${row.snippet ?? ""}`.toLowerCase();
  const found = words.filter((word) => text.includes(word)).length;
  return `Has ${Math.min(words.length - 1, Math.max(1, found))} of ${words.length} words`;
}

/**
 * The page's rows as palette rows, in the server's order.
 *
 * A note in the workspace somebody is standing in keeps its bare path as its
 * id, so it is the same row as the loaded name match for it (`mergeRanked`);
 * one in another workspace carries the workspace, which is how choosing it
 * leaves for that workspace instead of looking for the path here.
 */
export function itemsFromBlended(
  results: readonly BlendedResult[],
  query: string,
  currentSlug: string | null,
): PaletteItem[] {
  return results.map((row) => {
    const folder = displayPath(parentPath(row.path));
    const current = row.slug === currentSlug;
    return {
      id: row.path,
      label: row.title || displayPath(row.path),
      detail: folder === "" ? `@${row.slug}` : `@${row.slug} · ${folder}`,
      ...(row.snippet ? { snippet: row.snippet } : {}),
      ...(row.meaningOnly ? { meaningOnly: true } : {}),
      ...(row.edited === undefined ? {} : { edited: row.edited }),
      workspace: { slug: row.slug, current, id: row.workspaceId },
      why: whyMatched(query, row.title, row.meaningOnly),
      reason: reasonFor(query, row),
      kind: "note" as const,
    };
  });
}

/**
 * The tree's name matches as palette rows (`functions/nameSearch.ts`), keyed
 * the way `itemsFromBlended` keys a search row so the two are one row when
 * the search finds the same note.
 */
export function itemsFromNames(
  rows: readonly { workspaceId: string; slug: string; path: string; title: string }[],
  currentSlug: string | null,
): PaletteItem[] {
  return rows.map((row) => {
    const folder = displayPath(parentPath(row.path));
    return {
      id: row.path,
      label: row.title || displayPath(row.path),
      detail: folder === "" ? `@${row.slug}` : `@${row.slug} · ${folder}`,
      workspace: { slug: row.slug, current: row.slug === currentSlug, id: row.workspaceId },
      why: "name" as const,
      reason: WHY_LABEL.name,
      kind: "note" as const,
    };
  });
}

/**
 * Loaded names and the tree's names as one list for the palette to rank: a
 * note in both is the loaded row, which already opens in place.
 */
export function withTreeNames(loaded: readonly PaletteItem[], tree: readonly PaletteItem[]): PaletteItem[] {
  const have = new Set(loaded.map((item) => paletteKey(item)));
  return [...loaded, ...tree.filter((item) => !have.has(paletteKey(item)))];
}

/**
 * The loaded rows ⌘K may rank by name. They are the workspace being browsed,
 * so narrowed to another workspace they are out of scope and only the
 * commands stay — "in: @other" then "rent" must not offer this workspace's Rent note.
 */
export function loadedInScope<T extends { kind: string }>(
  items: T[],
  narrowed: string | null,
  currentSlug: string | null,
): T[] {
  if (narrowed === null || narrowed === currentSlug) return items;
  return items.filter((item) => item.kind !== "note");
}

/** The palette's states, from the page's. */
export function paletteStateOf(
  state: PageState,
  answer: BlendedAnswer | null,
): "idle" | "searching" | "ready" | "indexing" | "failed" {
  switch (state) {
    case "searching":
      return "searching";
    case "failed":
      return "failed";
    case "ready":
    case "partial":
    case "empty":
    case "filtered":
      return answer !== null &&
        answer.results.length === 0 &&
        answer.sources.some((source) => source.state === "indexing")
        ? "indexing"
        : "ready";
    default:
      return "idle";
  }
}

/**
 * The sentence above the list when part of the answer cannot be complete:
 * a workspace still being indexed, or one that did not answer in time. Never
 * "no matches" for either — see `useContextSearch`.
 */
export function sourcesNotice(answer: BlendedAnswer | null): string | null {
  if (answer === null) return null;
  const indexing = answer.sources.filter((source) => source.state === "indexing").map((s) => `@${s.slug}`);
  const failed = answer.sources.filter((source) => source.state === "failed").map((s) => `@${s.slug}`);
  const parts: string[] = [];
  if (indexing.length > 0) {
    parts.push(`${listed(indexing)} ${indexing.length === 1 ? "is" : "are"} still being indexed, so some notes there may be missing.`);
  }
  if (failed.length > 0) parts.push(`${listed(failed)} did not answer in time.`);
  return parts.length === 0 ? null : parts.join(" ");
}

function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** One workspace's line in "where the time went". */
export interface WorkspaceTime {
  slug: string;
  ms: number;
  slowest: boolean;
}

/** What the timing pill opens: the whole time, and where it went. */
export interface TimingBreakdown {
  /** From sending the search to its answer arriving, as this device measured it. */
  total: number;
  /** The slowest workspace's word search, or `null` when no workspace said. */
  words: number | null;
  /** The slowest workspace's meaning lookup, or `null` where meaning search is off everywhere. */
  meaning: number | null;
  /** The total, less the slowest workspace: getting there and back, and the fan-out around it. */
  travel: number;
  workspaces: WorkspaceTime[];
}

/** Over this, the pill turns amber and says which workspace was slow. */
export const SLOW_MS = 1000;

/**
 * The pill's arithmetic. `took` is measured on the device — the honest number,
 * since it is what the person waited — and the per-workspace times are the
 * server's, so the difference is the trip and nothing is double-counted.
 */
export function timingBreakdown(answer: BlendedAnswer | null, took: number | null): TimingBreakdown | null {
  if (answer === null || took === null) return null;
  const timed = answer.sources.filter((source): source is typeof source & { ms: number } => typeof source.ms === "number");
  const slowest = timed.reduce((most, source) => Math.max(most, source.ms), 0);
  const most = (field: "words" | "meaning") => {
    const values = answer.sources.flatMap((source) => (typeof source[field] === "number" ? [source[field] as number] : []));
    return values.length === 0 ? null : Math.max(...values);
  };
  return {
    total: took,
    words: most("words"),
    meaning: most("meaning"),
    travel: Math.max(0, took - slowest),
    workspaces: [...timed]
      .sort((a, b) => b.ms - a.ms)
      .map((source, index) => ({ slug: source.slug, ms: source.ms, slowest: index === 0 && timed.length > 1 })),
  };
}

/** "0.34 s": seconds with two decimals, the unit Dev2 asked to read. */
export function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(2)} s`;
}
