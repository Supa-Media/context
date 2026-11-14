/**
 * Search: the artifact's `P.search` (both views, "Speed and quality" and "Indexes") and
 * `P.search.props` (an index's side panel). Quality reads `admin.searchReport`'s `quality`; Indexes
 * reads the search-by-meaning report and the facts report, joined in `searchIndexesView.web.ts`.
 */
import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { seg } from "../kit";
import { FDEF, S, go, render, setF, toast } from "../state";
import type { ConsolePage } from "../types";
import { qualityHtml, qualityOf } from "./searchQuality.web";
import {
  failingCount,
  indexProps,
  indexRowsOf,
  indexesHtml,
  rowKey,
} from "./searchIndexesView.web";

const errorWords = (err: unknown) =>
  err instanceof Error ? err.message : "That didn't work. Try again.";

/** The queries and mutations behind the page. The Indexes data is read on both views (the tab's badge needs it). */
function useSearchData() {
  const indexesView = S.subs[0] === "indexes";
  const report = useQuery(
    api.functions.admin.searchReport,
    indexesView ? "skip" : { days: Math.min(+S.d, 30) },
  );
  const meaning = useQuery(api.functions.meaningAdmin.meaningIndexReport, {});
  const migration = useQuery(api.functions.nodesMigration.report, {});
  const restartFast = useMutation(api.functions.meaningAdmin.restartFastSearch);
  const restartMeaning = useMutation(
    api.functions.meaningAdmin.restartMeaningIndexing,
  );
  const setPaused = useMutation(api.functions.nodesMigration.setPaused);
  // A new object each render would make the shell redraw forever; these only change when the data does.
  return useMemo(
    () => ({
      report,
      meaning,
      migration,
      restartFast,
      restartMeaning,
      setPaused,
    }),
    [report, meaning, migration, restartFast, restartMeaning, setPaused],
  );
}

type Data = ReturnType<typeof useSearchData>;
// The registry types every page as `ConsolePage`, so the shell's data arrives as `unknown` and is read as `Data` here.
type Maybe = Data | undefined;

const rowsOf = (d: Maybe) => indexRowsOf(d?.meaning, d?.migration);
const findRow = (d: Maybe, id: string | undefined) =>
  rowsOf(d).find((row) => rowKey(row) === id);

function drawSearch(d: Maybe): string {
  const view = S.subs[0] === "indexes" ? "indexes" : "quality";
  const rows = rowsOf(d);
  const tabs = seg(
    "View",
    [
      ["quality", "Speed and quality"],
      ["indexes", "Indexes", failingCount(rows)],
    ],
    view,
    "srch",
  );
  if (view === "indexes")
    return indexesHtml(
      tabs,
      rows,
      d === undefined || d.meaning === undefined || d.migration === undefined,
    );
  return qualityHtml(
    tabs,
    d?.report ? qualityOf(d.report) : null,
    d === undefined || d.report === undefined,
  );
}

export const searchPage: ConsolePage = {
  key: "search",
  filters: { idx: "attention", from: "all" },
  windowed: () => S.subs[0] !== "indexes",
  useData: useSearchData,
  render: (d) => drawSearch(d as Maybe),
  props: (d, x) => {
    const row = findRow(d as Maybe, x);
    return row ? indexProps(row) : null;
  },
  acts: {
    srch(e) {
      go("search", e.dataset.v === "quality" ? [] : [e.dataset.v ?? ""]);
    },
    goidx(e) {
      go("search", ["indexes"], e.dataset.id ?? null, {
        f: { ...FDEF, idx: "all" },
      });
    },
    idxf(e) {
      setF("idx", e.dataset.v ?? "attention");
    },
    from(e) {
      setF("from", e.dataset.v ?? "all");
    },
    // Pause or resume the facts (the file tree's whole-copy switch), or restart fast search or search by meaning for one workspace.
    async restart(e, data) {
      const d = data as Maybe;
      const row = findRow(d, e.dataset.id);
      if (!d || !row) return;
      const label = (e.textContent ?? "").trim();
      const workspaceId = row.workspaceId as Id<"workspaces">;
      try {
        if (e.dataset.i === "1")
          await d.setPaused({ paused: !(d.migration?.paused ?? false) });
        else if (e.dataset.i === "2") await d.restartFast({ workspaceId });
        else await d.restartMeaning({ workspaceId });
        toast(`${label} for @${row.slug ?? row.workspaceId}`);
      } catch (err) {
        toast(errorWords(err));
      }
      render();
    },
    async restartall(_e, data) {
      const d = data as Maybe;
      if (!d) return;
      try {
        const result = await d.restartMeaning({});
        toast(`Restarted ${result.restarted}`);
      } catch (err) {
        toast(errorWords(err));
      }
      render();
    },
  },
};
