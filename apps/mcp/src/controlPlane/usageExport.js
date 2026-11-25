/**
 * The Context usage run's read (`data/sync/runUsage.js`, `apps/convex/functions/lib/gatewayRoutes/usageExport.ts`):
 * person-days, account ids that texted or signed up, and call and reply timings since `since`, and the bug reports people sent since `bugsSince` (or `since`). It is a read the sync
 * object's alarm makes, never a report behind a response, so it lives apart from `reporting.js`, whose every route
 * the Tex speed budgets leave out of a turn's count. Its failure is the run's: the run says so and writes nothing.
 */
export function createUsageExportMethods({ post }) {
  return {
    async usageExport(since, bugsSince) {
      return await post("/gateway/usage/export", Number.isFinite(bugsSince) ? { since, bugsSince } : { since }, { timeoutMs: 30_000, maxBytes: 16 * 1024 * 1024 });
    },
  };
}
