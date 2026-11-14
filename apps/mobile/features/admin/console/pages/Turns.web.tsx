/**
 * Turns: the artifact's `P.turns` and `P.turns.props`, with real data. The HTML is `turnsView.ts`;
 * this module fetches. The turns come from `consoleAi.turns`, read once per visit (`useReportOnce`)
 * and held to the minute the page opened on, and the texts received from `texStats.report` (an
 * action, so it is called here and kept in state). Both cover the same span: the turns are kept
 * 30 days, so the texts are counted over the same clamped span.
 */
import { useEffect, useMemo, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { useReportOnce } from "../../useReportOnce";
import { setF, S } from "../state";
import type { ConsolePage } from "../types";
import { turnsProps, turnsRender, type TurnsData } from "./turnsView";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** The turns are kept this long, so the texts are counted over no more than this. */
export const TURNS_KEPT_DAYS = 30;

/** `now` floored to the minute: the one `to` a page visit reads with. */
export const floorToMinute = (now: number): number => Math.floor(now / MINUTE_MS) * MINUTE_MS;

/** The span the texts are counted over: the window, clamped to the days the turns are kept. */
export function textWindow(days: number, to: number): { from: number; to: number } {
  return { from: to - Math.min(days, TURNS_KEPT_DAYS) * DAY_MS, to };
}

/** The texts received for the span; null until it answers, on error, or when the counts are not configured. */
function useTexts(days: string, to: number) {
  const report = useAction(api.functions.texStats.report);
  // Kept with the window it answers, so a slow answer for another window is never shown.
  const [got, setGot] = useState<{ key: string; texts: Awaited<ReturnType<typeof report>> | null } | null>(null);
  const key = `${days}:${to}`;
  useEffect(() => {
    let live = true;
    report(textWindow(Number(days), to)).then(
      (r) => {
        if (live) setGot({ key, texts: r });
      },
      () => {
        if (live) setGot({ key, texts: null });
      },
    );
    return () => {
      live = false;
    };
  }, [key, days, to, report]);
  return got?.key === key ? got.texts : null;
}

export const turnsPage: ConsolePage<TurnsData> = {
  key: "turns",
  filters: { end: "all" },
  windowed: true,
  useData: () => {
    const days = S.d;
    const end: "all" | "trouble" = S.f.end === "trouble" ? "trouble" : "all";
    const q = S.q;
    // Computed once per days/end/q change: the read's `to` is the minute the page was asked for.
    const to = useMemo(() => floorToMinute(Date.now()), [days, end, q]);
    const turns = useReportOnce(api.functions.consoleAi.turns, { days: +days, end, q, to });
    const texts = useTexts(days, to);
    // Stable while nothing changes: the shell redraws on every new data object.
    return useMemo(() => ({ turns, texts }), [turns, texts]);
  },
  render: (d) => turnsRender(d),
  props: (d, x) => turnsProps(d, x),
  acts: {
    end: (el) => setF("end", el.dataset.v ?? "all"),
  },
};
