/**
 * Reports: the artifact's `P.reports` and `P.reports.props`. One list of two sources: reports made
 * in the app (`contentReports`, "In the app") and bug reports people filed by texting Tex (the
 * triage desk, "Texted to Tex"). The model and the markup are in `reports/` (pure); this module
 * wires them to Convex, and to the Tex desk's rules the old console used (`features/tex/dashboard`).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { useTriageDesk } from "../../../tex/dashboard/useTriageDesk";
import { S, setF, toast } from "../state";
import type { ConsolePage } from "../types";
import { mergeReports, parseTexNote, texIds, type Notes, type Report, type TexBug } from "./reports/model";
import { renderProps, renderReports } from "./reports/render";

export type ReportsData = {
  /** The merged list, newest first; undefined while the content reports load. */
  reports: Report[] | undefined;
  /** The artifact's banner when the Tex desk is not open to this person. */
  banner: string | null;
  /** Actions on the two sources, stable across renders. */
  call: {
    handled: (reportId: string, handled: boolean) => Promise<void>;
    note: (path: string, action: "comment" | "triage" | "retire" | "reopen", comment?: string) => Promise<void>;
    reload: (path: string) => void;
  };
};

const NO_TEX: readonly TexBug[] = [];
const NO_BUGS_BANNER = "No bugs workspace is pinned for Tex reports.";
const NOT_A_MEMBER_BANNER = "Tex reports need the pinned bugs workspace; you are not a member.";
const SAVE_FAILED = "That did not save. Try again.";
const failed = (): void => toast(SAVE_FAILED);
/** An undo: the same failure toast as the page's writes, when it fails. */
const undoable = (fn: () => Promise<unknown>) => (): Promise<void> => fn().then(() => undefined, failed);

function useReportsData(): ReportsData {
  const content = useQuery(api.functions.contentReports.listReports, { show: "all" });
  const desk = useTriageDesk(true);
  const setHandledMutation = useMutation(api.functions.contentReports.setReportHandled);
  const readNote = useAction(api.functions.texDashboard.readNote);
  const actNote = useAction(api.functions.texDashboard.act);
  const [notes, setNotes] = useState<Notes>({});

  // Refreshed each render, so the stable `call` below always reaches the current functions.
  const fns = useRef({ setHandledMutation, readNote, actNote });
  fns.current = { setHandledMutation, readNote, actNote };

  // A constant for "none yet", so the memos below keep their identity between renders.
  const texBugs = desk?.available === true ? desk.bugs : NO_TEX;
  const selectedPath = useMemo(() => {
    if (!S.x) return undefined;
    for (const [path, id] of texIds(texBugs.map((bug) => bug.path))) if (id === S.x) return path;
    return undefined;
  }, [texBugs, S.x]);
  const loaded = selectedPath !== undefined && notes[selectedPath] !== undefined;

  // The selected Tex note is read once, at the staff member's clearance, and kept by path.
  useEffect(() => {
    if (selectedPath === undefined || loaded) return;
    const path = selectedPath;
    setNotes((n) => ({ ...n, [path]: { state: "loading" } }));
    fns.current.readNote({ path }).then(
      (note) => setNotes((n) => ({ ...n, [path]: { state: "ready", ...parseTexNote(note.text) } })),
      () => setNotes((n) => ({ ...n, [path]: { state: "error" } })),
    );
  }, [selectedPath, loaded]);

  const call = useMemo<ReportsData["call"]>(
    () => ({
      handled: async (reportId, handled) => {
        await fns.current.setHandledMutation({ reportId: reportId as Id<"contentReports">, handled });
      },
      note: async (path, action, comment) => {
        await fns.current.actNote({ path, action, comment });
      },
      reload: (path) =>
        setNotes((n) => {
          const next = { ...n };
          delete next[path];
          return next;
        }),
    }),
    [],
  );

  const reports = useMemo(
    () => (content === undefined ? undefined : mergeReports({ content, tex: texBugs, notes, now: Date.now() })),
    [content, texBugs, notes],
  );
  const banner = desk === undefined || desk.available ? null : desk.reason === "no_pinned_context" ? NO_BUGS_BANNER : NOT_A_MEMBER_BANNER;
  return useMemo(() => ({ reports, banner, call }), [reports, banner, call]);
}

/** The comment the staff member wrote in the side panel, if any. */
function commentOf(el: HTMLElement): string {
  const box = (el.closest("#props") ?? document).querySelector<HTMLTextAreaElement>("#cm");
  return box?.value ?? "";
}

function reportOf(d: ReportsData | undefined, id: string | undefined): Report | undefined {
  return d?.reports?.find((r) => r.id === id);
}

export const reportsPage: ConsolePage<ReportsData> = {
  key: "reports",
  filters: { src: "all", st: "open" },
  windowed: false,
  useData: useReportsData,
  render: (d) => renderReports({ reports: d?.reports, f: { src: S.f.src, st: S.f.st }, x: S.x, banner: d?.banner ?? null }),
  props: (d, x) => renderProps(d?.reports?.find((r) => r.id === x)),
  acts: {
    repopen: (el) => setF("st", el.dataset.v!),
    repsrc: (el) => setF("src", el.dataset.v!),
    // Mark handled (a content report) or Retire (a Tex one), each with Undo, as the artifact does.
    handle: async (el, d) => {
      const r = reportOf(d, el.dataset.id);
      if (!r || !d) return;
      try {
        if (r.src === "content") {
          await d.call.handled(r.id, true);
          toast("Marked handled", undoable(() => d.call.handled(r.id, false)));
        } else {
          await d.call.note(r.path!, "retire", commentOf(el));
          d.call.reload(r.path!);
          toast(
            "Retired",
            undoable(async () => {
              await d.call.note(r.path!, "reopen");
              d.call.reload(r.path!);
            }),
          );
        }
      } catch {
        failed();
      }
    },
    triage: async (el, d) => {
      const r = reportOf(d, el.dataset.id);
      if (!r || !d || r.src !== "tex") return;
      try {
        await d.call.note(r.path!, "triage", commentOf(el));
        d.call.reload(r.path!);
        toast("Sent to triage with your comment");
      } catch {
        failed();
      }
    },
    reopen: async (el, d) => {
      const r = reportOf(d, el.dataset.id);
      if (!r || !d) return;
      try {
        if (r.src === "content") await d.call.handled(r.id, false);
        else {
          await d.call.note(r.path!, "reopen");
          d.call.reload(r.path!);
        }
        toast("Reopened");
      } catch {
        failed();
      }
    },
  },
};

