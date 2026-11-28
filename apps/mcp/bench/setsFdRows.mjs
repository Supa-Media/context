/**
 * A Front door batch's rows (`setsFd.mjs` runFd), moved out of `setsFd.mjs` on 2026-11-19 to keep it under the size
 * bar: each unit's judged case from its test's run, a miss in short, a row the bench failed, and the simulated
 * world's misses per test (`simFixtures.mjs`).
 */
import { couldNotRunRow } from "./rowAccounting.mjs";
import { runMisses, testWorld } from "./simFixtures.mjs";

/**
 * A failed Front door test as its run row says it, short (the Lab keeps 200 characters): the first line that failed
 * and what Tex said. The judge's whole reasons and Tex's whole texts stay in the row's `misses` and `said`.
 */
export function missedLine(r) {
  const miss = (r.misses ?? [])[0];
  const said = (r.said ?? []).join(" / ").replace(/\s+/g, " ");
  const line = miss ? `${miss.kind === "must not" ? "never" : "must"}: ${miss.line}` : "a must or never line failed";
  return `${line.slice(0, 90)} | Tex: ${said.slice(0, 100) || "(said nothing)"}`;
}

/**
 * A row the bench failed, not Tex: a stand-in of the bench's had no answer for a call the turn made (`benchGaps.mjs`),
 * so a miss there is a harness error, shown as a row that could not run with what the bench lacked. A test that held
 * anyway is a pass: the gap was not in its way.
 */
export function benchFailed(r) {
  const gaps = Array.isArray(r?.bench) ? r.bench : [];
  return !r?.right && gaps.length > 0 ? `the bench failed, not Tex: ${gaps.join("; ")}`.slice(0, 280) : null;
}

/**
 * One prepared conversation's rows, once its tests ran: each unit's judged case from its test's run, the conversation's
 * cost split evenly over its units. A test that threw marks only its own units. Units with no test are already in `rows`.
 */
export function collectConvo(p) {
  const rows = [...p.rows];
  const missed = p.runDir ? runMisses(p.runDir) : [];
  const units = p.tests.reduce((n, t) => n + t.group.length, 0);
  const usd = p.tests.reduce((sum, t) => sum + (t.got?.usd ?? 0), 0);
  const each = units === 0 ? 0 : usd / units;
  for (const t of p.tests) {
    const world = testWorld(missed, t.name); // the simulated calls no fixture answered, for the run's summary
    t.group.forEach((u, k) => {
      const share = Math.round(each * 10_000) / 10_000;
      if (t.error) return void rows.push(couldNotRunRow(u.row, t.error, { usd: share, world }));
      const r = t.got?.rows.find((x) => x.id === `${t.name}/q${k + 1}`);
      const story = r ? { misses: r.misses ?? [], held: r.held ?? [], said: r.said ?? [], ...(r.handoff ? { handoff: r.handoff } : {}), ...(r.rounds ? { rounds: r.rounds } : {}), ...(r.routes ? { routes: r.routes } : {}), ...(r.fallbacks ? { fallbacks: r.fallbacks } : {}), ...(r.steps ? { steps: r.steps } : {}), ...(r.toolErrors?.length ? { toolErrors: r.toolErrors } : {}) } : {};
      const bench = benchFailed(r);
      if (!r) rows.push({ ...u.row, right: false, ran: false, usd: share, world, why: "the bench gave no judged answer" });
      else if (bench !== null) rows.push({ ...u.row, right: false, ran: false, usd: share, world, why: bench, ...story });
      else rows.push({ ...u.row, right: Boolean(r.right), ran: true, usd: share, world, got: r.right ? "every line held" : missedLine(r), want: "every must and never line", ...story });
    });
  }
  return rows;
}
