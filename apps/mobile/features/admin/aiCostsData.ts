/**
 * The AI costs tab's data, as hooks the section calls.
 *
 * The report and an account's drawer are live queries; Cloudflare's own count
 * is an action (it asks Cloudflare), fetched once per window and kept until the
 * window changes. The shapes are in
 * `apps/convex/functions/lib/adminFns/aiCostsShape.ts`.
 */

import { useEffect, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type {
  AiCostsAccount,
  AiCostsCloudflare,
  AiCostsReport,
} from "@context/convex/functions/lib/adminFns/aiCostsShape";

/** The window's report and Cloudflare's own count. Both `undefined` until they land. */
export function useAiCostsData(days: number): {
  report: AiCostsReport | undefined;
  cloudflare: AiCostsCloudflare | undefined;
} {
  const report = useQuery(api.functions.admin.aiCostsReport, { days });
  const check = useAction(api.functions.admin.aiCostsCloudflare);
  const [cloudflare, setCloudflare] = useState<{ days: number; value: AiCostsCloudflare } | null>(null);
  useEffect(() => {
    let live = true;
    check({ days })
      .then((value) => {
        if (live) setCloudflare({ days, value });
      })
      .catch(() => {
        // Our words, never the error's: the strip says the count could not be read.
        if (live) setCloudflare({ days, value: { configured: true, error: "Cloudflare could not be asked", billedUsd: 0, workersAi: [], gateway: [] } });
      });
    return () => {
      live = false;
    };
  }, [check, days]);
  return { report, cloudflare: cloudflare?.days === days ? cloudflare.value : undefined };
}

/**
 * One account's drill-down. `undefined` while loading or when nothing is
 * open (`userId` null); `null` when the account cannot be found.
 */
export function useAiCostsAccount(userId: string | null, days: number): AiCostsAccount | undefined {
  return useQuery(api.functions.admin.aiCostsAccount, userId === null ? "skip" : { userId, days });
}
