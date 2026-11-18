/**
 * What the background jobs a test's turns handed off added (`jobDelivery.mjs`), summed for a Lab run's row
 * (`coreArea.mjs`): no imports, so the core runner reads it without loading the job runner.
 */

/** What every delivered job of `delivered` added: jobs run, parts, the job advisor's calls and spend. */
export function handoffTotals(delivered) {
  const ran = (Array.isArray(delivered) ? delivered : []).filter((d) => d && d.state !== "not run");
  const usd = ran.reduce((sum, d) => sum + (Number(d.usd) || 0), 0);
  return { jobs: ran.length, parts: ran.reduce((n, d) => n + (Number(d.parts) || 0), 0), advisorCalls: ran.reduce((n, d) => n + (Number(d.advisorCalls) || 0), 0), usd: Math.round(usd * 10_000) / 10_000 };
}
