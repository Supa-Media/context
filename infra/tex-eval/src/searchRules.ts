/**
 * The Search Test's rules, with no storage: what a search case must hold, the counts people may see, and the
 * verdict. The caps and the day are the Test Set's own (rules.ts), so a search run spends the same budget shape.
 * A search case asks: given a query, as a person in a context, do the expected notes come back first? Its words
 * (the query, the notes) are read by people in the Lab only; a run hands them to main's workflow and returns a
 * pass or fail and counts, never a word.
 */
import { ID } from "./rules";

/** A note's address as the gateway names it: `@context/path.md`. */
export const SEARCH_ADDRESS = /^@[a-z0-9][a-z0-9-]*\/.+\.md$/;
/** A context's name, as `in` names it. */
const CONTEXT = /^@[a-z0-9][a-z0-9-]*$/;
/** The largest search case kept, in bytes of its JSON. */
export const MAX_SEARCH_BYTES = 200_000;
const MAX_QUERY = 300;
const MAX_EXPECT = 5;

export interface SearchCase {
  id: string;
  set: "test";
  query: string;
  /** Who searches, as a person in the context: the handle the search runs as. */
  as: string;
  /** The context searched; null or left out means the searcher's own. */
  in?: string | null;
  /** The notes that must come back first, each by its address. */
  expect: string[];
  /** Notes that must never come back for this search. */
  forbid?: string[];
  /** A short slug the counts group by; never words. */
  kind?: string;
  /** The notes the case sees, keyed by their address. */
  notes: Record<string, string>;
  [k: string]: unknown;
}

const isAddress = (a: unknown): a is string => typeof a === "string" && SEARCH_ADDRESS.test(a);

/** What the service keeps of a search case: its shape checked, nothing changed. A sentence when it can't. */
export function searchProblemWith(c: unknown): string | null {
  if (!c || typeof c !== "object") return "not a search case";
  const s = c as Partial<SearchCase> & Record<string, unknown>;
  if (!ID.test(String(s.id ?? ""))) return "its id must be lowercase letters, digits and dashes";
  if (s.set !== "test") return 'only Test search cases live here: set must be "test"';
  if (typeof s.query !== "string" || s.query.length < 1 || s.query.length > MAX_QUERY) return `its query must be 1 to ${MAX_QUERY} characters`;
  if (typeof s.as !== "string" || s.as.length < 1 || s.as.length > 80) return "it must name who searches (as)";
  if (s.in !== undefined && s.in !== null && !(typeof s.in === "string" && CONTEXT.test(s.in))) return "in must name a context as @name, or be left out";
  if (!Array.isArray(s.expect) || s.expect.length < 1 || s.expect.length > MAX_EXPECT) return `it must expect 1 to ${MAX_EXPECT} notes`;
  if (!s.expect.every(isAddress)) return "each expected note must be an address as @context/path.md";
  if (s.forbid !== undefined && (!Array.isArray(s.forbid) || !s.forbid.every(isAddress))) return "forbid must list notes as @context/path.md";
  if (s.kind !== undefined && !(typeof s.kind === "string" && ID.test(s.kind))) return "kind must be a short slug of lowercase letters, digits and dashes";
  if (!s.notes || typeof s.notes !== "object" || Array.isArray(s.notes)) return "it has no notes";
  for (const [address, body] of Object.entries(s.notes)) {
    if (!isAddress(address)) return "each note is keyed as @context/path.md";
    if (typeof body !== "string") return "each note is text";
  }
  if (new TextEncoder().encode(JSON.stringify(c)).length > MAX_SEARCH_BYTES) return `it is over ${MAX_SEARCH_BYTES} bytes`;
  return null;
}

/** Counts with no words: how many cases, and how many of each kind (kind is a slug, never a query). */
export function searchCounts(cases: SearchCase[]) {
  const byKind: Record<string, number> = {};
  for (const c of cases) {
    const kind = c.kind ?? "none";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
  }
  return { cases: cases.length, byKind };
}

/** One answer: where the expected note ranked in a search, 1 first; null when it did not come back at all. */
export interface SearchResult {
  id: string;
  rank: number | null;
}
export interface SearchVerdict {
  pass: boolean;
  total: number;
  /** Handed cases whose expected note ranked first on the change. */
  first: number;
  /** The same on main. */
  mainFirst: number;
  /** Handed cases whose expected note ranked 1 to 5 on the change. */
  top5: number;
  mainTop5: number;
}

/**
 * The gate: every case the run was handed, scored on the change and on main. A case with no answer is a miss.
 * It passes when the change puts the expected note first at least as often as main does (Dev2: "can't merge if
 * right-note-first drops"); an empty set passes, and says so by its total.
 */
export function searchVerdict(ids: string[], branch: SearchResult[], main: SearchResult[]): SearchVerdict {
  const ranks = (rows: SearchResult[]) => {
    const byId = new Map<string, number | null>();
    for (const r of rows) if (r && typeof r.id === "string" && !byId.has(r.id)) byId.set(r.id, r.rank);
    return byId;
  };
  const count = (side: Map<string, number | null>, inTop: (rank: number) => boolean) =>
    ids.filter((id) => {
      const rank = side.get(id);
      return typeof rank === "number" && inTop(rank);
    }).length;
  const b = ranks(branch);
  const m = ranks(main);
  const isFirst = (rank: number) => rank === 1;
  const isTop5 = (rank: number) => Number.isInteger(rank) && rank >= 1 && rank <= 5;
  const first = count(b, isFirst);
  const mainFirst = count(m, isFirst);
  return { pass: first >= mainFirst, total: ids.length, first, mainFirst, top5: count(b, isTop5), mainTop5: count(m, isTop5) };
}
