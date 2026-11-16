/**
 * The Test Set's rules, with no storage: the run caps, the unit tests a conversation holds, and the verdict.
 * Dev2, 2026-11-15: the Test Set is "the actual thing that the CI/CD gates on"; runs are capped so an agent cannot
 * tune against it by trying again; a run returns pass or fail and counts by node, never a word.
 */

/** 1 run a commit, 3 a pull request, 20 a day (UTC), across every pull request. */
export const CAPS = { commit: 1, pr: 3, day: 20 } as const;
/** The largest conversation kept, in bytes of its JSON. */
export const MAX_CHAT_BYTES = 200_000;
export const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

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
}

/** Every unit test in a conversation: one starred label, one person's message by one node (texSets.cjs `unitTests`). */
export function unitTests(c: Conversation): Test[] {
  const out: Test[] = [];
  for (const m of c.msgs ?? []) {
    if (!m || m.tex) continue;
    for (const [node, l] of Object.entries(m.labels ?? {})) if (l && l.star === true) out.push({ chat: c.id, msg: m.id, node });
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
  pr: number;
  day: number;
  /** Extra runs people gave this pull request, not yet used. */
  allowed: number;
}

/** Whether a run may start, and whether it spends one of the pull request's extra runs. */
export function mayRun(u: Usage): { ok: true; spendsAllowance: boolean } | { ok: false; why: string } {
  const over = u.commit >= CAPS.commit ? `this commit already had its ${CAPS.commit} Test Set run` : u.pr >= CAPS.pr ? `this pull request already had its ${CAPS.pr} Test Set runs` : u.day >= CAPS.day ? `the Test Set already ran ${CAPS.day} times today (UTC)` : null;
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
}
export interface Verdict {
  pass: boolean;
  total: number;
  right: number;
  main: number;
  byNode: Record<string, NodeScore>;
}

/**
 * The gate: every unit test the run was handed, scored on the change and on main. A test with no answer is wrong.
 * It passes when no node gets fewer right on the change than on main (Dev2: "no worse than main"); an empty Test
 * Set passes, and says so by its total.
 */
export function verdict(tests: Test[], branch: Result[], main: Result[]): Verdict {
  const rightIn = (rows: Result[]) => new Set(rows.filter((r) => r && r.right === true).map((r) => keyOf(r)));
  const b = rightIn(branch);
  const m = rightIn(main);
  const byNode: Record<string, NodeScore> = {};
  for (const t of tests) {
    const s = (byNode[t.node] ??= { total: 0, right: 0, main: 0 });
    s.total += 1;
    if (b.has(keyOf(t))) s.right += 1;
    if (m.has(keyOf(t))) s.main += 1;
  }
  const scores = Object.values(byNode);
  const sum = (f: (s: NodeScore) => number) => scores.reduce((a, s) => a + f(s), 0);
  return { pass: scores.every((s) => s.right >= s.main), total: tests.length, right: sum((s) => s.right), main: sum((s) => s.main), byNode };
}

/** The UTC day a time falls on, as the day cap counts. */
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
