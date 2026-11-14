/**
 * Home: the artifact's `P.home`. Five tiles for the window on top, then "Needs you" (Dev2, 2026-11-14: "metric tiles
 * on top, Needs you under them"). The figures are `homeData.ts`'s; the needs are `needs.web.ts`'s, the same list the
 * sidebar badges count.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@context/convex/_generated/api";
import { esc, ic, kpi, panel, spark } from "../kit";
import { S } from "../state";
import type { ConsolePage, Need } from "../types";
import { homeTiles, knownPerText, statsWindows, type ConsoleWindow, type TexStatsLike } from "./homeData";
import { useNeedsState, useTurns } from "./needs.web";
import { useSharedReport } from "./sharedReads.web";

type TexStats = FunctionReturnType<typeof api.functions.texStats.report>;

/**
 * `texStats.report` for `[from, to)`, asked again when the window changes; null when it failed or is not set up. The
 * last answer stays on screen while the next window loads, so the tiles never blank out.
 */
export function useTexStats(span: { from: number; to: number } | null): TexStatsLike | null | undefined {
  const ask = useRef(useAction(api.functions.texStats.report));
  const key = span === null ? "none" : `${span.from}:${span.to}`;
  const [answer, setAnswer] = useState<{ key: string; stats: TexStatsLike | null } | null>(null);
  useEffect(() => {
    if (span === null) return;
    let live = true;
    ask.current({ from: span.from, to: span.to })
      .then((stats: TexStats) => live && setAnswer({ key, stats: stats.configured ? stats : null }))
      .catch(() => live && setAnswer({ key, stats: null }));
    return () => {
      live = false;
    };
    // The key stands for the window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (span === null) return null;
  return answer?.stats;
}

export type HomeData = {
  d: ConsoleWindow;
  stats: TexStatsLike | null | undefined;
  prior: TexStatsLike | null | undefined;
  partial: boolean;
  accounts: number | null;
  answered: number | null;
  needs: Need[];
  /** A needs source is still loading: the list says so rather than "Nothing needs you". */
  needsLoading: boolean;
};

function useHomeData(): HomeData {
  const d = (["1", "7", "30", "90"].includes(S.d) ? S.d : "30") as ConsoleWindow;
  // The window is fixed when the page opens or the window changes, never per render (review of #3291).
  const windows = useMemo(() => statsWindows(d, Date.now()), [d]);
  const stats = useTexStats(windows);
  const prior = useTexStats(windows.prior);
  const census = useSharedReport(api.functions.admin.censusReport, { days: 30 }).value;
  const turns = useTurns();
  const { needs, loading: needsLoading } = useNeedsState();
  return {
    d,
    stats,
    prior,
    partial: windows.partial,
    accounts: census === undefined ? null : census.accounts.total.count,
    answered: turns === undefined ? null : turns.current.answered,
    needs,
    needsLoading,
  };
}

export function renderHome(data: HomeData | undefined): string {
  const tiles = homeTiles({
    d: data?.d ?? "30",
    stats: data?.stats ?? null,
    costs: null,
    accounts: data?.accounts ?? null,
    answered: data?.answered ?? null,
    priorPerText: knownPerText(data?.prior),
    partial: data?.partial ?? false,
  });
  const needs = data?.needs ?? [];
  const row = (tile: (typeof tiles)[number]) => {
    const change = tile.delta ? `<span class="${tile.delta.good ? "up" : "dn"}">${esc(tile.delta.text)}</span>` : "";
    const line = change + esc(tile.detail);
    return kpi(tile.label, esc(tile.value), line, `data-act="go" data-p="${tile.go}"`, tile.spark.length > 1 ? spark(tile.spark, tile.color) : "");
  };
  const list = needs
    .map(
      (n, i) =>
        `<button class="need" data-act="need" data-i="${i}"><span class="dt" style="background:var(--${n.tone})"></span><span class="tx">${n.html}</span><span class="where hp">${esc(n.label)}</span>${ic("next")}</button>`,
    )
    .join("");
  const loading = data === undefined || (data.needsLoading && needs.length === 0);
  const empty = loading ? '<div class="empty">Loading…</div>' : '<div class="empty">Nothing needs you.</div>';
  return `<div class="kpis">${tiles.map(row).join("")}</div>` + panel("home-needs", "Needs you", loading ? "" : String(needs.length), `<div class="needs">${list || empty}</div>`);
}

export const homePage: ConsolePage<HomeData> = {
  key: "home",
  filters: {},
  windowed: true,
  useData: useHomeData,
  render: renderHome,
};
