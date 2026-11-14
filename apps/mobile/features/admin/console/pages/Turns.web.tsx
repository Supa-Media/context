/**
 * Turns: the artifact's `P.turns` and `P.turns.props`, with real data. The HTML is `turnsView.ts`;
 * this module fetches. The turns come from `consoleAi.turns` for the open window and search, and
 * the texts received from `texStats.report` (an action, so it is called here and kept in state).
 */
import { useEffect, useMemo, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { setF, S } from "../state";
import type { ConsolePage } from "../types";
import { turnsProps, turnsRender, type TurnsData } from "./turnsView";

const DAY_MS = 86_400_000;

/** The texts received for the open window; null until it answers, on error, or when the counts are not configured. */
function useTexts() {
  const report = useAction(api.functions.texStats.report);
  // Kept with the window it answers, so a slow answer for another window is never shown.
  const [got, setGot] = useState<{ days: string; texts: Awaited<ReturnType<typeof report>> | null } | null>(null);
  const days = S.d;
  useEffect(() => {
    let live = true;
    const to = Date.now();
    report({ from: to - Number(days) * DAY_MS, to }).then(
      (r) => {
        if (live) setGot({ days, texts: r });
      },
      () => {
        if (live) setGot({ days, texts: null });
      },
    );
    return () => {
      live = false;
    };
  }, [days, report]);
  return got?.days === days ? got.texts : null;
}

export const turnsPage: ConsolePage<TurnsData> = {
  key: "turns",
  filters: { end: "all" },
  windowed: true,
  useData: () => {
    const turns = useQuery(api.functions.consoleAi.turns, { days: +S.d, end: S.f.end === "trouble" ? "trouble" : "all", q: S.q });
    const texts = useTexts();
    // Stable while nothing changes: the shell redraws on every new data object.
    return useMemo(() => ({ turns, texts }), [turns, texts]);
  },
  render: (d) => turnsRender(d),
  props: (d, x) => turnsProps(d, x),
  acts: {
    end: (el) => setF("end", el.dataset.v ?? "all"),
  },
};
