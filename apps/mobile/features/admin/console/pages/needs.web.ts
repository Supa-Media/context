/**
 * Home's "Needs you" (the artifact's `needsList`): every line also counts on the sidebar row of the page it opens, so
 * the shell asks for it on every page. The words and order are `homeData.ts` `needsList`.
 *
 * Reads (review of #3291): credentials and open reports are small lists and stay live; the waitlist, untold let-ins,
 * search indexes, backup encryption and open mail inboxes come from one counts-only query (`consoleHome.needs`), and
 * the turns report from the window's `agentReport`, and the open Tex reports from the bugs desk (`texDashboard.triage`).
 * Those three are read once and shared (`sharedReads.web.ts`), so Home, which shows the same turns, and the sidebar
 * never read them twice.
 */
import { useMemo } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@context/convex/_generated/api";
import { unsetKnownSecrets } from "../../report";
import { esc } from "../kit";
import { S } from "../state";
import type { Need } from "../types";
import { needsList, type NeedLine, type NeedsSources } from "./homeData";
import { useSharedReport } from "./sharedReads.web";

type LightNeeds = FunctionReturnType<typeof api.functions.consoleHome.needs>;
type Turns = FunctionReturnType<typeof api.functions.admin.agentReport>;
type Triage = FunctionReturnType<typeof api.functions.texDashboard.triage>;

/**
 * A Tex report's statuses that are no longer open, as the Reports page reads them (`reports/model.ts`): "3 open
 * reports, 2 texted to Tex" counts the same reports that page lists as open.
 */
const TEX_CLOSED = new Set(["triage", "triaged", "fixing", "fixed", "retired"]);

/** Open Tex reports on the bugs desk; null when the desk is not pinned or this staff member is not on it. */
export function openTexReports(triage: Triage | undefined): number | null | undefined {
  if (triage === undefined) return undefined;
  if (!triage.available) return null;
  return triage.bugs.filter((bug) => !TEX_CLOSED.has(bug.status.toLowerCase())).length;
}

/** A `homeData` line as the shell draws it. */
export function toNeed(line: NeedLine): Need {
  const { page, subs, x, f } = line.target;
  return {
    tone: line.tone,
    html: `<b>${esc(line.bold)}</b>${esc(line.rest)}`,
    label: line.where,
    to: { p: page, ...(subs ? { subs } : {}), ...(x ? { x } : {}), ...(f ? { f } : {}) },
  };
}

/** What each read answered, as `needsList` takes it. A read still loading is `undefined` and adds no line. */
export function needsSourcesOf(raw: {
  secrets: readonly { name: string }[] | undefined;
  reports: readonly unknown[] | undefined;
  /**
   * Open Tex reports (`openTexReports`): undefined while the desk loads, null when it cannot be read (no pinned desk, or
   * not a member), so only content reports count.
   */
  texReports: number | null | undefined;
  turns: Pick<Turns, "current"> | undefined;
  light: LightNeeds | undefined;
}): NeedsSources {
  const { secrets, reports, texReports, turns, light } = raw;
  return {
    secretsUnset: secrets === undefined ? undefined : unsetKnownSecrets(secrets).length,
    openReports:
      reports === undefined || texReports === undefined
        ? undefined
        : { count: reports.length + (texReports ?? 0), viaTex: texReports ?? null },
    unfinished: turns === undefined ? undefined : { exhausted: turns.current.exhausted, failed: turns.current.failed },
    waiting: light?.waiting,
    untold: light?.untold,
    failedIndexes: light?.failedIndexes,
    failedBackups: light?.failedBackups,
    mailOpen: light?.openMail,
  };
}

/** The window's text turns, read once and shared by Needs you and Home. */
export function useTurns(): Turns | undefined {
  return useSharedReport(api.functions.admin.agentReport, { days: Number(S.d) || 30, client: "texts" }).value;
}

/** The list, and whether a source is still loading (Home then says so rather than "Nothing needs you"). */
export function useNeedsState(): { needs: Need[]; loading: boolean } {
  const secrets = useQuery(api.functions.admin.listSecrets, {});
  const reports = useQuery(api.functions.contentReports.listReports, { show: "open" });
  // Read once and shared, like the counts: the Tex desk is a whole folder of notes.
  const triage = useSharedReport(api.functions.texDashboard.triage, {}).value;
  const light = useSharedReport(api.functions.consoleHome.needs, {}).value;
  const turns = useTurns();
  return useMemo(() => {
    const texReports = openTexReports(triage);
    const needs = needsList(needsSourcesOf({ secrets, reports, texReports, turns, light })).map(toNeed);
    const loading = [secrets, reports, texReports, turns, light].some((v) => v === undefined);
    return { needs, loading };
  }, [secrets, reports, triage, turns, light]);
}

export function useNeeds(): Need[] {
  return useNeedsState().needs;
}
