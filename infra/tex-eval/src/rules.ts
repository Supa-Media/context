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
  /** Which repeat this row is, when the node ran more than once. Absent on a node that ran once. */
  rep?: number;
}
export interface NodeScore {
  total: number;
  right: number;
  main: number;
  /**
   * Set when the node ran more than once. Tests the change got wrong on every trial and main got right on every
   * trial. The gate reads this instead of `right < main`: one sample of the reviewer is noise.
   */
  steady?: number;
  /** The most trials any test of this node ran, when that is more than one. */
  repeats?: number;
}
export interface Verdict {
  pass: boolean;
  total: number;
  right: number;
  main: number;
  byNode: Record<string, NodeScore>;
  /**
   * The same counts by conversation kind ("one" or "group"), for the Group chats area's metric
   * (`docs/decisions/data-and-metrics.md`, "CI sends its own numbers"). Counts only, and never part of the gate.
   * A test stored before kinds were kept counts as "one".
   */
  byKind: Record<string, NodeScore>;
}

/** One test's trials on one side, in repeat order. A row with no `rep` is its own trial. A repeat sent twice counts once. */
function trialsOf(rows: Result[], t: Test): boolean[] {
  const seen = new Set<string>();
  const out: boolean[] = [];
  for (const r of rows) {
    if (!r || r.chat !== t.chat || r.msg !== t.msg || r.node !== t.node || typeof r.right !== "boolean") continue;
    const rep = Number.isInteger(r.rep) && (r.rep as number) >= 0 ? String(r.rep) : `row-${out.length}`;
    if (seen.has(rep)) continue;
    seen.add(rep);
    out.push(r.right === true);
  }
  return out;
}

/** A side got the test right: a strict majority of its trials. No trial is wrong, the same as a missing answer. */
const majority = (trials: boolean[]) => trials.filter(Boolean).length * 2 > trials.length;
/** Wrong on every trial, and a missing answer is wrong on every trial. */
const neverRight = (trials: boolean[]) => trials.length === 0 || trials.every((ok) => !ok);
/** Right on every trial. An empty side is not this: main has to have answered. */
const alwaysRight = (trials: boolean[]) => trials.length > 0 && trials.every(Boolean);

/**
 * Whether a node's score fails the gate. One run: fewer right than main. Several runs: a steady regression, a test
 * wrong on every trial of the change and right on every trial of main. A lower sample with no such test is noise.
 */
export function nodeWorse(s: NodeScore): boolean {
  return (s.repeats ?? 1) > 1 ? (s.steady ?? 0) > 0 : s.right < s.main;
}

/**
 * The gate: every unit test the run was handed, scored on the change and on main. A test with no answer is wrong.
 * A node that ran once passes when it gets at least as many right as main (Dev2: "no worse than main"). A node that
 * ran more than once passes unless a test is a steady regression (the replay gate's rule): one sample of the reply
 * reviewer is 5/8 or 6/8 on unchanged code, and that must not fail a pull request. The counts stay the majority of
 * the trials, so the sample still shows. An empty Test Set passes, and says so by its total.
 */
export function verdict(tests: Test[], branch: Result[], main: Result[]): Verdict {
  const byNode: Record<string, NodeScore> = {};
  const byKind: Record<string, NodeScore> = {};
  const mostTrials: Record<string, number> = {};
  const steady: Record<string, number> = {};
  for (const t of tests) {
    const b = trialsOf(branch, t);
    const m = trialsOf(main, t);
    const repeats = Math.max(b.length, m.length);
    const kind = t.kind === "group" ? "group" : "one";
    for (const s of [(byNode[t.node] ??= { total: 0, right: 0, main: 0 }), (byKind[kind] ??= { total: 0, right: 0, main: 0 })]) {
      s.total += 1;
      if (majority(b)) s.right += 1;
      if (majority(m)) s.main += 1;
    }
    mostTrials[t.node] = Math.max(mostTrials[t.node] ?? 0, repeats);
    if (repeats > 1 && neverRight(b) && alwaysRight(m)) steady[t.node] = (steady[t.node] ?? 0) + 1;
  }
  for (const [node, n] of Object.entries(mostTrials)) {
    if (n > 1) {
      byNode[node].repeats = n;
      byNode[node].steady = steady[node] ?? 0;
    }
  }
  const scores = Object.values(byNode);
  const sum = (f: (s: NodeScore) => number) => scores.reduce((a, s) => a + f(s), 0);
  return { pass: scores.every((s) => !nodeWorse(s)), total: tests.length, right: sum((s) => s.right), main: sum((s) => s.main), byNode, byKind };
}

/** The UTC day a time falls on, as the day cap counts. */
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
