/**
 * The Front door's scheduler (`setsFd.mjs` `runFd`): one shared pool of lanes over every test of every conversation, so
 * a lane never waits on a conversation's slice of `parallel` while another has tests ready. Each test is its own run
 * and judge process in its conversation's folder, so the tests of one chat may go at once too.
 */

/**
 * Runs `worker(item, index)` over `items` with at most `lanes` going at once, starting them in the items' order. The
 * worker must not throw: a failure is its own to record. Resolves when every item is done.
 */
export async function runPool(items, lanes, worker) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const k = next;
      next += 1;
      await worker(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(Number(lanes) || 1, items.length)) }, lane));
}

/**
 * The order the pool starts the tests in, given each conversation's tests (`convos`, one array a conversation). The
 * conversations with the most tests go first, and their tests are dealt out round-robin: every conversation starts its
 * first test before any starts a second, so the biggest chat's tests begin early and every chat progresses. Longest
 * first, so the last test to start is a short one, not a long chat's last. Ties keep the input's order.
 */
export function scheduleOrder(convos) {
  const sorted = convos.map((tests, k) => ({ tests, k })).sort((a, b) => b.tests.length - a.tests.length || a.k - b.k);
  const longest = sorted[0]?.tests.length ?? 0;
  const out = [];
  for (let round = 0; round < longest; round += 1) {
    for (const { tests } of sorted) if (round < tests.length) out.push(tests[round]);
  }
  return out;
}

/** A failure that names credit: the bench's keys are spent, so no later test can run either. */
export const CREDIT = /credit/i;

/**
 * `work` for the pool, stopped by the first test that fails on credit: every unstarted test takes its error as its own
 * and is never sent (gw Lab runs, 2026-11-18: every Claude call failed, one test after another). `work` keeps a test's
 * failure on `t.error`.
 */
export function untilOutOfCredit(work) {
  let spent = null;
  return async (t) => {
    if (spent) return void (t.error = spent);
    await work(t);
    if (t.error && CREDIT.test(String(t.error?.message ?? t.error))) spent ??= t.error;
  };
}

/** `work` that keeps how long each test took on `t.ms`, so a run can say where its time went. */
export function timed(work, now = Date.now) {
  return async (t) => {
    const began = now();
    try {
      await work(t);
    } finally {
      t.ms = now() - began;
    }
  };
}

/**
 * One line on where a pool's time went: how many tests, how many lanes, the wall time, the sum, and the slowest few
 * with their conversation and how many cases each ran. Ids and times only, never a label or a text, so a Dev run may print it.
 */
export function timesLine(tests, { lanes, wallMs, slowest = 5 }) {
  const ran = tests.filter((t) => typeof t.ms === "number");
  const s = (ms) => `${Math.round(ms / 1000)} s`;
  const sum = ran.reduce((total, t) => total + t.ms, 0);
  const of = (key) => ran.reduce((total, t) => total + (Number(t.split?.[key]) || 0), 0);
  // Where a test's time went (`coreArea.mjs` splitOf), when its run said: the answer and judge processes, the turns'
  // own seconds, and the background jobs it ran.
  const split = (t) => (t.split && typeof t.split.answerMs === "number" ? ` (answer ${s(t.split.answerMs)}, turns ${Math.round(t.split.turnS ?? 0)} s, judge ${s(t.split.judgeMs ?? 0)}, ${t.split.jobs ?? 0} job(s) ${t.split.parts ?? 0} part(s))` : "");
  const top = [...ran].sort((a, b) => b.ms - a.ms).slice(0, slowest).map((t) => `${t.id ?? "?"}/${t.name} ${t.cases ?? 1} case(s) ${s(t.ms)}${split(t)}`);
  const totals = ran.some((t) => t.split?.answerMs !== undefined) ? `; answer ${s(of("answerMs"))}, judge ${s(of("judgeMs"))}, ${of("jobs")} job(s) in ${ran.filter((t) => t.split?.jobs > 0).length} test(s)` : "";
  return `fd tests: ${ran.length} in ${lanes} lanes, wall ${s(wallMs)}, sum ${s(sum)}, mean ${s(ran.length ? sum / ran.length : 0)}${totals}; slowest: ${top.join(", ")}`;
}
