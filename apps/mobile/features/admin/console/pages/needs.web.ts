/**
 * Home's "Needs you" (the artifact's `needsList`): every line also counts on the sidebar row of the page it opens, so
 * the shell asks for it on every page. The words and order are `homeData.ts` `needsList`.
 *
 * Reads (review of #3291): credentials and open reports are small lists and stay live; the waitlist, untold let-ins,
 * search indexes, backup encryption and open mail inboxes come from one counts-only query (`consoleHome.needs`), and
 * the turns report from the window's `agentReport`. Those two are read once and shared (`sharedReads.web.ts`), so Home,
 * which shows the same turns, and the sidebar never read them twice.
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
  turns: Pick<Turns, "current"> | undefined;
  light: LightNeeds | undefined;
}): NeedsSources {
  const { secrets, reports, turns, light } = raw;
  return {
    secretsUnset: secrets === undefined ? undefined : unsetKnownSecrets(secrets).length,
    openReports: reports === undefined ? undefined : { count: reports.length, viaTex: null },
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

export function useNeeds(): Need[] {
  const secrets = useQuery(api.functions.admin.listSecrets, {});
  const reports = useQuery(api.functions.contentReports.listReports, { show: "open" });
  const light = useSharedReport(api.functions.consoleHome.needs, {}).value;
  const turns = useTurns();
  return useMemo(() => needsList(needsSourcesOf({ secrets, reports, turns, light })).map(toNeed), [secrets, reports, turns, light]);
}
