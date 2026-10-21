/**
 * The Usage tab's data: an action (it asks PostHog), fetched once per window
 * and kept until the window changes or staff refresh it.
 * The shape is `apps/convex/functions/lib/adminFns/usageAnalyticsShape.ts`.
 */

import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { UsageAnalytics } from "@context/convex/functions/lib/adminFns/usageAnalyticsShape";

/** `undefined` until PostHog's answer for this window lands. */
export function useUsageData(days: number, refresh = 0): UsageAnalytics | undefined {
  const report = useAction(api.functions.usageAnalytics.report);
  const [answer, setAnswer] = useState<{ days: number; refresh: number; value: UsageAnalytics } | null>(null);
  useEffect(() => {
    let live = true;
    report({ days })
      .then((value) => {
        if (live) setAnswer({ days, refresh, value });
      })
      .catch(() => {
        // Our words, never the error's.
        if (live) setAnswer({ days, refresh, value: { connected: true, error: "PostHog could not be asked" } });
      });
    return () => {
      live = false;
    };
  }, [report, days, refresh]);
  return answer?.days === days && answer.refresh === refresh ? answer.value : undefined;
}
