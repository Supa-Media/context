/**
 * What one turn spent, from the meter reports it made (`controlPlane.builtinReports` from index `from`): one per model
 * it ran on, the answering model last (`src/agent/modelPlan.js` `meterParts`). `usage` is the sum, `usageByModel` the
 * split, `model` the answering one. Moved out of `world.mjs` unchanged, so a carried cross-chat ask
 * (`crossWorld.mjs`) is priced the same way.
 */
export function spentSince(reportsAll, from) {
  const reports = reportsAll.slice(from);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const usageByModel = {};
  for (const report of reports) {
    const spent = { input: report.inputTokens ?? 0, output: report.outputTokens ?? 0, cacheRead: report.cacheReadTokens ?? 0, cacheWrite: report.cacheWriteTokens ?? 0 };
    for (const key of Object.keys(usage)) usage[key] += spent[key];
    if (typeof report.model !== "string") continue;
    const into = (usageByModel[report.model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    for (const key of Object.keys(into)) into[key] += spent[key];
  }
  return { usage, usageByModel, model: reports.at(-1)?.model ?? null };
}
