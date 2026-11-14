/**
 * Home: the artifact's `P.home`. Five tiles for the window on top, then "Needs you" (Dev2, 2026-11-14: "metric tiles
 * on top, Needs you under them"). The figures are `homeData.ts`'s; the needs are `needs.web.ts`'s, the same list the
 * sidebar badges count.
 */
import { useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@context/convex/_generated/api";
import { useReportOnce } from "../../useReportOnce";
import { esc, ic, kpi, panel, spark } from "../kit";
import { S } from "../state";
import type { ConsolePage, Need } from "../types";
import { DAY_MS, homeTiles, type ConsoleWindow, type TexStatsLike } from "./homeData";
import { useNeeds } from "./needs.web";

type TexStats = FunctionReturnType<typeof api.functions.texStats.report>;

/** Windows are keyed to the minute, so a render never asks again on its own. */
const MINUTE = 60_000;

/** `texStats.report` for `[from, to)`, asked again when the window changes; null when it failed or is not set up. */
export function useTexStats(from: number, to: number): TexStatsLike | null | undefined {
  const ask = useRef(useAction(api.functions.texStats.report));
  const key = `${from}:${to}`;
  const [answer, setAnswer] = useState<{ key: string; stats: TexStatsLike | null } | null>(null);
  useEffect(() => {
    let live = true;
    ask.current({ from, to })
      .then((stats: TexStats) => live && setAnswer({ key, stats: stats.configured ? stats : null }))
      .catch(() => live && setAnswer({ key, stats: null }));
    return () => {
      live = false;
    };
    // The key stands for the window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return answer !== null && answer.key === key ? answer.stats : undefined;
}

export type HomeData = {
  d: ConsoleWindow;
  stats: TexStatsLike | null | undefined;
  prior: TexStatsLike | null | undefined;
  accounts: number | null;
  answered: number | null;
  needs: Need[];
};

function useHomeData(): HomeData {
  const d = (["1", "7", "30", "90"].includes(S.d) ? S.d : "30") as ConsoleWindow;
  const to = Math.floor(Date.now() / MINUTE) * MINUTE;
  const span = Number(d) * DAY_MS;
  const stats = useTexStats(to - span, to);
  // The window before, for the change in cost per text. Older than the gateway keeps, it reads as no change.
  const prior = useTexStats(to - 2 * span, to - span);
  const census = useReportOnce(api.functions.admin.censusReport, { days: 30 });
  const turns = useReportOnce(api.functions.admin.agentReport, { days: Number(d), client: "texts" });
  const needs = useNeeds();
  return {
    d,
    stats,
    prior,
    accounts: census === undefined ? null : census.accounts.total.count,
    answered: turns === undefined ? null : turns.current.answered,
    needs,
  };
}

export function renderHome(data: HomeData | undefined): string {
  const tiles = homeTiles({
    d: data?.d ?? "30",
    stats: data?.stats ?? null,
    costs: null,
    accounts: data?.accounts ?? null,
    answered: data?.answered ?? null,
    priorPerText: data?.prior?.costPerTextUsd ?? null,
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
  return `<div class="kpis">${tiles.map(row).join("")}</div>` + panel("home-needs", "Needs you", String(needs.length), `<div class="needs">${list || '<div class="empty">Nothing needs you.</div>'}</div>`);
}

export const homePage: ConsolePage<HomeData> = {
  key: "home",
  filters: {},
  windowed: true,
  useData: useHomeData,
  render: renderHome,
};
