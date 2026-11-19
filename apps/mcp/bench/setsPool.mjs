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
