/**
 * Home's "Needs you" (the artifact's `needsList`): every line also counts on the sidebar row of the page it opens, so
 * the shell asks for it on every page. Each line is read from the query its own page already uses; only the open mail
 * inboxes have a query of their own (`functions/consoleHome.ts`). The words and order are `homeData.ts` `needsList`.
 *
 * The light lists are live; the turns report reads a whole window of turns, so it is read once per window
 * (`useReportOnce`), like every heavy report on the console.
 */
import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { unsetKnownSecrets } from "../../report";
import { useReportOnce } from "../../useReportOnce";
import { esc } from "../kit";
import { S } from "../state";
import type { Need } from "../types";
import { needsList, type NeedLine, type NeedsSources } from "./homeData";

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

export function useNeeds(): Need[] {
  const days = Number(S.d) || 30;
  const secrets = useQuery(api.functions.admin.listSecrets, {});
  const reports = useQuery(api.functions.contentReports.listReports, { show: "open" });
  const waiting = useQuery(api.functions.admin.listWaitlist, { status: "waiting" });
  const untold = useQuery(api.functions.admin.untoldPhoneWaitlist, {});
  const indexes = useQuery(api.functions.meaningAdmin.meaningIndexReport, {});
  const backups = useQuery(api.functions.managedEncryption.rolloutStatus, {});
  const mail = useQuery(api.functions.consoleHome.openMail, {});
  const turns = useReportOnce(api.functions.admin.agentReport, { days, client: "texts" });
  return useMemo(() => {
    const sources: NeedsSources = {
      secretsUnset: secrets === undefined ? undefined : unsetKnownSecrets(secrets).length,
      openReports: reports === undefined ? undefined : { count: reports.length, viaTex: null },
      unfinished: turns === undefined ? undefined : { exhausted: turns.current.exhausted, failed: turns.current.failed },
      waiting: waiting?.counts.waiting,
      untold,
      failedIndexes: indexes === undefined ? undefined : indexes.rows.filter((row) => row.status === "failed").length,
      failedBackups: backups === undefined ? undefined : backups.workspaces.filter((w) => w.state === "failed").map((w) => w.slug),
      mailOpen: mail,
    };
    return needsList(sources).map(toNeed);
  }, [secrets, reports, waiting, untold, indexes, backups, mail, turns]);
}
