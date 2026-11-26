/**
 * The Test Set's rules, with no storage: the run caps, the unit tests a conversation holds, and the verdict.
 * Dev2, 2026-11-15: the Test Set is "the actual thing that the CI/CD gates on"; runs are capped so an agent cannot
 * tune against it by trying again; a run returns pass or fail and counts by node, never a word.
 */

/**
 * 1 run a commit, 10 changes a pull request, 1000 a day (UTC), across every pull request. Raised from 3 a pull
 * request by Dev2, 2026-11-17 ("increase the caps if they keep getting hit"): merging a moving main made every
 * pull request spend its runs on the same change. The pull request cap counts distinct changes (the patch-id of
 * the pull request's diff from main), so a commit that only merges main re-runs without spending one.
 */
export const CAPS = { commit: 1, pr: 10, day: 1000 } as const;
/** The largest conversation kept, in bytes of its JSON. */
export const MAX_CHAT_BYTES = 200_000;
export const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
/** A commit in full: 40 lowercase hex digits. */
export const SHA = /^[0-9a-f]{40}$/;

export interface Msg {
  id: string;
  tex?: boolean;
  labels?: Record<string, { star?: boolean } & Record<string, unknown>>;
  [k: string]: unknown;
}
export interface Conversation {
  id: string;
  title?: string;
  set: string;
  kind?: string;
  members?: string[];
  msgs: Msg[];
  [k: string]: unknown;
}
export interface Test {
  chat: string;
  msg: string;
  node: string;
  /** The conversation's kind, "one" (a 1:1 text) or "group": only for the verdict's counts by kind. */
  kind?: "one" | "group";
}

/** Every unit test in a conversation: one starred label, one person's message by one node (texSets.cjs `unitTests`). */
export function unitTests(c: Conversation): Test[] {
  const out: Test[] = [];
  const kind = c.kind === "group" ? "group" : "one";
  for (const m of c.msgs ?? []) {
    if (!m || m.tex) continue;
    for (const [node, l] of Object.entries(m.labels ?? {})) if (l && l.star === true) out.push({ chat: c.id, msg: m.id, node, kind });
  }
  return out;
}

export const keyOf = (t: Test) => `${t.chat}\u0000${t.msg}\u0000${t.node}`;

/**
 * Counts with no words: chats, unit tests, unit tests by node, and each chat as the Lab's hidden list shows it
 * ("Hidden chat 2 · ★ 3 · 1:1 · 6 messages"), by position, without its id (an id is often its words).
 */
export function counts(chats: Conversation[]) {
  const byNode: Record<string, number> = {};
  let stars = 0;
  const perChat = chats.map((c) => {
    const tests = unitTests(c);
    for (const t of tests) byNode[t.node] = (byNode[t.node] ?? 0) + 1;
    stars += tests.length;
    return { stars: tests.length, kind: c.kind === "group" ? "group" : "one", msgs: Array.isArray(c.msgs) ? c.msgs.length : 0 };
  });
  return { chats: chats.length, stars, byNode, perChat };
}

/** What the service keeps of a conversation: its shape checked, nothing changed. A sentence when it can't. */
export function problemWith(c: unknown): string | null {
  if (!c || typeof c !== "object") return "not a conversation";
  const conv = c as Conversation;
  if (!ID.test(String(conv.id ?? ""))) return "its id must be lowercase letters, digits and dashes";
  if (conv.set !== "test") return 'only Test conversations live here: set must be "test"';
  if (!Array.isArray(conv.msgs)) return "it has no messages";
  if (JSON.stringify(conv).length > MAX_CHAT_BYTES) return `it is over ${MAX_CHAT_BYTES} bytes`;
  return null;
}

export interface Usage {
  commit: number;
  /** Distinct changes this pull request already ran. */
  pr: number;
  /** This change (the same diff from main) already ran on this pull request: only main moved, so it spends no pull request run. */
  sameChange?: boolean;
  day: number;
  /** Extra runs people gave this pull request, not yet used. */
  allowed: number;
}

/** Whether a run may start, and whether it spends one of the pull request's extra runs. */
export function mayRun(u: Usage): { ok: true; spendsAllowance: boolean } | { ok: false; why: string } {
  const over = u.commit >= CAPS.commit ? `this commit already had its ${CAPS.commit} Test Set run` : !u.sameChange && u.pr >= CAPS.pr ? `this pull request already ran ${CAPS.pr} different changes on the Test Set` : u.day >= CAPS.day ? `the Test Set already ran ${CAPS.day} times today (UTC)` : null;
  if (!over) return { ok: true, spendsAllowance: false };
  if (u.allowed > 0) return { ok: true, spendsAllowance: true };
  return { ok: false, why: `${over}; a person can allow one more in the Lab` };
}

export interface Result {
  chat: string;
  msg: string;
  node: string;
  right: boolean;
}
export interface NodeScore {
  total: number;
  right: number;
  main: number;
  /** Set on byNode entries: true when this node counts as fewer right than main under the noise rule (see verdict). */
  worse?: boolean;
}
export interface Verdict {
  pass: boolean;
  total: number;
  right: number;
  main: number;
  /** How many times each tree answered: 1 is the original rule; up to MAX_ATTEMPTS, the same on both sides. */
  attempts: number;
  byNode: Record<string, NodeScore>;
  /**
   * The same counts by conversation kind ("one" or "group"), for the Group chats area's metric
   * (`docs/decisions/data-and-metrics.md`, "CI sends its own numbers"). Counts only, and never part of the gate.
   * A test stored before kinds were kept counts as "one".
   */
  byKind: Record<string, NodeScore>;
}

/** The most attempts a run may send for each side. */
export const MAX_ATTEMPTS = 5;
/** One tree's answers (one attempt), or several attempts, each a tree's answers. */
export type Attempts = Result[] | Result[][];
export const ATTEMPTS_MISMATCH = "send the same number of attempts, at most 5, for the change and main";

const objectsOnly = (rows: unknown[]): Result[] => rows.filter((r): r is Result => !!r && typeof r === "object");

/**
 * The attempts a run sent, normalised to one list of answers per attempt. A plain list is one attempt; an empty
 * list is one attempt with no answers; a list of lists is that many attempts. Anything mixed, or more than
 * MAX_ATTEMPTS lists, is null.
 */
export function attemptsOf(x: unknown): Result[][] | null {
  if (!Array.isArray(x) || x.length === 0) return [[]];
  const lists = x.filter((e) => Array.isArray(e));
  if (lists.length === x.length) return lists.length > MAX_ATTEMPTS ? null : lists.map(objectsOnly);
  if (lists.length > 0) return null;
  return [objectsOnly(x)];
}

/**
 * The gate: every unit test the run was handed, scored on the change and on main. A test with no answer is wrong.
 *
 * With one attempt it passes when no node gets fewer right on the change than on main (Dev2: "no worse than main").
 * With several attempts (the same count on both sides, at most MAX_ATTEMPTS), each test's rights are summed over the
 * attempts, and a node is worse when main's sum beats the change's by at least the attempt count, that is by one
 * whole test in every attempt. Why: main's own reviewer score swung 5/8 vs 6/8 between runs on the same harness;
 * 15 of 38 gate runs failed on that one test. A single coin flip no longer decides the gate, a steady loss still does.
 *
 * Reported counts are per attempt (the sums divided by the attempt count, rounded). An empty Test Set passes, and
 * says so by its total. Throws when the attempt counts differ or are not a valid shape; the caller checks first.
 */
export function verdict(tests: Test[], branch: Attempts, main: Attempts): Verdict {
  const b = attemptsOf(branch);
  const m = attemptsOf(main);
  if (!b || !m || b.length !== m.length) throw new Error(ATTEMPTS_MISMATCH);
  const k = b.length;
  const rightIn = (rows: Result[]) => new Set(rows.filter((r) => r.right === true).map((r) => keyOf(r)));
  const bSets = b.map(rightIn);
  const mSets = m.map(rightIn);
  const nodes: Record<string, Tally> = {};
  const kinds: Record<string, Tally> = {};
  for (const t of tests) {
    const kind = t.kind === "group" ? "group" : "one";
    const key = keyOf(t);
    const rightSum = bSets.filter((s) => s.has(key)).length;
    const mainSum = mSets.filter((s) => s.has(key)).length;
    for (const s of [(nodes[t.node] ??= tally()), (kinds[kind] ??= tally())]) {
      s.total += 1;
      s.rightSum += rightSum;
      s.mainSum += mainSum;
    }
  }
  const isWorse = (s: Tally) => (k === 1 ? s.rightSum < s.mainSum : s.mainSum - s.rightSum >= k);
  const perAttempt = (sum: number) => Math.round(sum / k);
  const byNode: Record<string, NodeScore> = {};
  for (const [node, s] of Object.entries(nodes)) byNode[node] = { total: s.total, right: perAttempt(s.rightSum), main: perAttempt(s.mainSum), worse: isWorse(s) };
  const byKind: Record<string, NodeScore> = {};
  for (const [kind, s] of Object.entries(kinds)) byKind[kind] = { total: s.total, right: perAttempt(s.rightSum), main: perAttempt(s.mainSum) };
  const all = Object.values(nodes);
  const sum = (f: (s: Tally) => number) => all.reduce((a, s) => a + f(s), 0);
  return {
    pass: !Object.values(byNode).some((s) => s.worse),
    total: tests.length,
    right: perAttempt(sum((s) => s.rightSum)),
    main: perAttempt(sum((s) => s.mainSum)),
    attempts: k,
    byNode,
    byKind,
  };
}

/** A node's sums over the attempts (one attempt: its count). */
interface Tally {
  total: number;
  rightSum: number;
  mainSum: number;
}
const tally = (): Tally => ({ total: 0, rightSum: 0, mainSum: 0 });

/** The UTC day a time falls on, as the day cap counts. */
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
