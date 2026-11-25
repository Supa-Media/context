/**
 * A right-now metric kept every hour (`apps/mcp/src/data/sync/snap.js`): whether the sync keeps it, how its last
 * reading went, and Keep every hour, which makes the kept sheet beside the note (`<slug>.csv`, its two columns) when
 * there is none and arms the sync, which takes the first reading at once.
 *
 * Absent where it can't be asked: no workspace or slug, a demo, or no gateway address. Then the metric says only
 * its value right now and offers nothing.
 */

import { useCallback, useEffect, useState } from "react";
import type { Id } from "@context/convex/_generated/dataModel";
import { withoutTextExtension } from "@context/shared/src/fileKinds.cjs";
import { useConsoleGrant } from "../../../agent/useConsoleGrant";
import { useOptionalConsoleData } from "../../ConsoleDataContext";
import { selectedContext } from "../../types";
import { MCP_ENDPOINT } from "../../placeholderData";
import { useWriteNote } from "../useWriteNote";
import { callDataSync, dataSyncUrl, syncStateOf, type DataSyncBody, type SourceSync } from "./dataSync";
import type { SyncState } from "./words";

/** The kept sheet's first line, as the sync writes it (`KEPT_COLUMNS` in `snap.js`). */
export const KEPT_HEADER = "hour:date,value:number\n";

/** `data/metrics/open-incidents.md` → `data/metrics/open-incidents.csv`. */
export function keptSheetPath(notePath: string): string {
  return `${withoutTextExtension(notePath)}.csv`;
}

export interface MetricKeep {
  /** The sync's word on this metric, once it answered. */
  readonly state: SyncState | undefined;
  readonly armed: boolean;
  /** Keep every hour: null once armed, or the sentence saying why not. Absent for who may not. */
  readonly keep?: (keptExists: boolean) => Promise<string | null>;
}

export function useMetricKeep(notePath: string, rightNow: boolean): MetricKeep {
  const data = useOptionalConsoleData();
  const current = data === null ? null : selectedContext(data);
  const mint = useConsoleGrant();
  const writeNote = useWriteNote();
  const url = current === null || data?.demo === true ? null : dataSyncUrl(MCP_ENDPOINT, current.slug);
  const mayArm = url !== null && (current?.role === "owner" || current?.role === "editor");
  const workspaceId = current?.id ?? null;
  const [held, setHeld] = useState<SourceSync | undefined>(undefined);

  const ask = useCallback(
    async (body: DataSyncBody) => {
      if (url === null || workspaceId === null) return { ok: false as const, said: "This workspace can't keep metrics here." };
      return await callDataSync({ url, workspaceId, body, token: async (refresh) => (await mint({ workspaceId: workspaceId as Id<"workspaces"> }, refresh)).accessToken });
    },
    [url, workspaceId, mint],
  );

  useEffect(() => {
    if (!rightNow || url === null) return;
    let live = true;
    void ask({ op: "status", metric: [notePath] }).then((answer) => {
      if (!live || !answer.ok) return;
      setHeld(answer.sources.find((one) => one.about === notePath) ?? { about: notePath, armed: false, last: null });
    });
    return () => {
      live = false;
    };
  }, [notePath, rightNow, url, ask]);

  const keep = useCallback(
    async (keptExists: boolean): Promise<string | null> => {
      if (workspaceId === null) return "This workspace can't keep metrics here.";
      if (!keptExists) {
        // With no version given, the save only makes a new file: a kept sheet this page could not read is never
        // written over. If it is there after all, the arm below keeps adding to it; if it is not, its run says so.
        try {
          await writeNote({ workspaceId: workspaceId as Id<"workspaces">, path: keptSheetPath(notePath), text: KEPT_HEADER });
        } catch {
          // Said by the run, which finds the sheet or names it missing.
        }
      }
      const answer = await ask({ op: "arm", metric: notePath });
      if (!answer.ok) return answer.said;
      const one = answer.sources[0];
      if (one !== undefined) setHeld(one);
      return null;
    },
    [ask, notePath, workspaceId, writeNote],
  );

  return { state: held === undefined ? undefined : syncStateOf(held), armed: held?.armed === true, ...(mayArm && rightNow ? { keep } : {}) };
}
