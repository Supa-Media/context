/**
 * AI costs: the artifact's `P.costs` (thread "Build console Turns and AI costs" ports it). The
 * page's HTML is in `costsView.ts`; this module fetches the data and holds the two acts.
 *
 * The costs action asks Cloudflare, so its answer is kept with the window it was asked for and
 * never shown for another window. The account report and a picked account are live queries.
 */
import { useEffect, useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { go, render, S, store } from "../state";
import type { ConsolePage } from "../types";
import { shut } from "../kit";
import { accountPropsHtml, costsPageHtml, type CostsData, type CostsResult } from "./costsView";

/** The open window's AI costs (`consoleAi.costs`), shared with Home's "Spent on AI" tile so both read one answer. Undefined while it loads. */
export function useCosts(): CostsResult | undefined {
  const key = S.d;
  const costs = useAction(api.functions.consoleAi.costs);
  const [got, setGot] = useState<{ key: string; result: CostsResult } | null>(null);
  useEffect(() => {
    let live = true;
    costs({ days: +key }).then(
      (result) => {
        if (live) setGot({ key, result });
      },
      () => {
        if (live) setGot({ key, result: { error: "Couldn't load costs" } });
      },
    );
    return () => {
      live = false;
    };
  }, [costs, key]);
  return got?.key === key ? got.result : undefined;
}

// The registry takes every page as `ConsolePage` (unknown data), so the data is narrowed here.
const data = (d: unknown) => d as CostsData | undefined;

export const costsPage: ConsolePage = {
  key: "costs",
  windowed: true,
  useData: () => {
    const costs = useCosts();
    const days = Math.max(7, +S.d);
    const report = useQuery(api.functions.admin.aiCostsReport, { days });
    const account = useQuery(api.functions.admin.aiCostsAccount, S.x ? { userId: S.x, days } : "skip");
    return useMemo(() => ({ costs, report, account }), [costs, report, account]);
  },
  render: (d) => costsPageHtml(data(d)?.costs, data(d)?.report),
  props: (d, x) => accountPropsHtml(data(d)?.account, x, data(d)?.report),
  acts: {
    // The artifact's `totex`: open the step table if it is folded, then bring it into view.
    totex: () => {
      if (shut.has("c-tex")) {
        shut.delete("c-tex");
        store.set("shut", [...shut]);
        render();
      }
      setTimeout(() => document.querySelector("[data-k=c-tex]")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
    },
    person: (el) => go("people", [], el.dataset.id ?? null),
  },
};
