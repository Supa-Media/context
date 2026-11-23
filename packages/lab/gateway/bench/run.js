/**
 * A kept bench plan asked again on the standing bench objects, by the gateway alone (`plans.js`): main's search
 * config next to a Lab draft's, every copy's share at once through its own runner object, scored as a Search run is
 * scored (right note first, top 5, found, MRR). Seconds, not a GitHub job: the world is already loaded and built.
 */

import { benchCall } from "./setup.js";
import { RUN_PATH } from "./plans.js";
import { benchWorkspaceId } from "./world.js";

/**
 * The note paths in a `search_notes` answer, in the order shown, each as `@workspace/path`: a hit from another
 * workspace already carries its name; one from the workspace searched gets `home` in front.
 */
export function hitsOf(text, home) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!/^\S.*\.md$/.test(line)) continue;
    out.push(line.startsWith("@") ? line : `${home}/${line}`);
  }
  return out;
}

/** Where the first expected note placed (1-based), or null when none was shown. */
export function rankOf(hits, expected) {
  const wanted = new Set(expected);
  const index = hits.findIndex((hit) => wanted.has(hit));
  return index === -1 ? null : index + 1;
}

/** Most cases one runner object asks (each on main's config and the draft's). */
export const RUNNER_CASES = 6;

const pct = (n, of) => (of === 0 ? 0 : Math.round((1000 * n) / of) / 10);

/** One config's scores over its ranks and times. */
export function summaryOf(rows) {
  const scored = rows.filter((row) => row.expect.length > 0);
  const first = scored.filter((row) => row.rank === 1).length;
  const top5 = scored.filter((row) => row.rank !== null && row.rank <= 5).length;
  const found = scored.filter((row) => row.rank !== null).length;
  const mrr = scored.length === 0 ? 0 : scored.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / scored.length;
  const times = rows.map((row) => row.ms).sort((a, b) => a - b);
  return {
    n: scored.length,
    first,
    top5,
    found,
    firstPct: pct(first, scored.length),
    top5Pct: pct(top5, scored.length),
    mrr: Math.round(mrr * 1000) / 1000,
    p50Ms: times.length ? times[Math.floor(times.length / 2)] : 0,
    errors: rows.filter((row) => row.error).length,
  };
}

/**
 * Ask `plan`'s cases on main's config and, when `draft` is a search config, on the draft's too. `bench` is the bench
 * environment. Answers `{ms, main, draft, changed}`: `changed` every case whose rank moved, worst loss first.
 */
export async function runPlan(bench, plan, { draft = null, call = benchCall } = {}) {
  const drafts = draft === null ? [null] : [null, JSON.stringify(draft)];
  const started = Date.now();
  const shares = [];
  for (const w of plan.worlds) {
    for (let copy = 0; copy < w.copies; copy += 1) {
      const cases = w.cases.filter((_, i) => i % w.copies === copy);
      // A few cases per runner object: each search spends subrequests, and one request has a ceiling on them.
      for (let at = 0; at < cases.length; at += RUNNER_CASES) shares.push({ world: w.world, copy, part: at / RUNNER_CASES, cases: cases.slice(at, at + RUNNER_CASES) });
    }
  }
  const answers = new Map();
  await Promise.all(
    shares.map(async (share) => {
      const asked = share.cases.map((c) => ({ id: c.id, query: c.query, personal: benchWorkspaceId(share.world, share.copy, c.own), context: c.in ?? null }));
      const got = await call(bench, `bench-runner-${share.world.slice(0, 8)}-${share.copy}-${share.part}`, RUN_PATH, { cases: asked, drafts }).catch((error) => ({ answers: asked.flatMap((c) => drafts.map((_, variant) => ({ id: c.id, variant, ok: false, text: String(error?.message ?? error).slice(0, 200), ms: 0 }))) }));
      for (const answer of got.answers ?? []) answers.set(`${answer.variant}\u0000${answer.id}`, answer);
    }),
  );
  const rowsFor = (variant) =>
    plan.worlds.flatMap((w) =>
      w.cases.map((c) => {
        const answer = answers.get(`${variant}\u0000${c.id}`) ?? { ok: false, text: "no answer", ms: 0 };
        const hits = answer.ok ? hitsOf(answer.text, c.in ?? `@${c.own}`) : [];
        return { id: c.id, query: c.query, kind: c.kind ?? null, expect: c.expect ?? [], rank: (c.expect ?? []).length ? rankOf(hits, c.expect) : null, top: hits.slice(0, 3), ms: answer.ms, error: answer.ok ? null : String(answer.text).slice(0, 200) };
      }),
    );
  const main = rowsFor(0);
  const drafted = draft === null ? null : rowsFor(1);
  const place = (rank) => (rank === null ? 99 : rank);
  const changed =
    drafted === null
      ? []
      : main
          .map((row, i) => ({ id: row.id, query: row.query, main: row.rank, draft: drafted[i].rank, draftTop: drafted[i].top }))
          .filter((row) => row.main !== row.draft)
          .sort((a, b) => place(b.draft) - place(b.main) - (place(a.draft) - place(a.main))); // worst loss first
  return {
    ms: Date.now() - started,
    main: summaryOf(main),
    draft: drafted === null ? null : summaryOf(drafted),
    changed,
    misses: (drafted ?? main).filter((row) => row.rank !== 1 && row.expect.length > 0).map((row) => ({ id: row.id, query: row.query, rank: row.rank, top: row.top, error: row.error })),
  };
}

/** A plan from a GitHub run, checked: `{worlds: [{world, copies, cases: [{id, query, own, in?, expect, kind?}]}]}`. */
export function planProblem(plan, { worldKey, maxCopies, maxCases, maxQuery }) {
  if (!plan || !Array.isArray(plan.worlds) || plan.worlds.length === 0 || plan.worlds.length > 100) return "a plan is { worlds: [...] }";
  let total = 0;
  for (const w of plan.worlds) {
    if (!worldKey.test(String(w?.world ?? "")) || !Number.isSafeInteger(w.copies) || w.copies < 1 || w.copies > maxCopies || !Array.isArray(w.cases)) return "each world is { world, copies, cases }";
    total += w.cases.length;
    for (const c of w.cases) {
      const good = typeof c?.id === "string" && c.id.length <= 200 && typeof c.query === "string" && c.query.trim() !== "" && c.query.length <= maxQuery && typeof c.own === "string" && c.own.length <= 64 && (c.in === null || c.in === undefined || /^@[A-Za-z0-9_-]{1,64}$/.test(c.in)) && Array.isArray(c.expect) && c.expect.length <= 50 && c.expect.every((e) => typeof e === "string" && e.length <= 1_000);
      if (!good) return "each case is { id, query, own, in?, expect, kind? }";
    }
  }
  return total > maxCases ? `a plan keeps at most ${maxCases} cases` : null;
}
