import type { Id } from "@context/convex/_generated/dataModel";
import { useAction } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { graphFromAnswer, type GraphAnswer } from "../convert";
import { workspaceGraphRef } from "../mapData";
import type { WorkspaceGraph } from "../types";

/** A workspace the map can show: the console's own row for it. */
export type MapWorkspace = { id: string; slug: string; displayName: string; kind: string };

/** How often a shown graph is read again. Live events move notes in between. */
const REFRESH_MS = 2 * 60_000;

export type MapGraphs = {
  graphs: WorkspaceGraph[];
  /** Still waiting on the first answer for at least one workspace. */
  loading: boolean;
  /** A workspace whose search index is behind, missing, or cut at the size limit: the map says so. */
  partial: { behind: boolean; indexMissing: boolean; truncated: boolean };
};

/**
 * Every visible note and link of each workspace on the map, from
 * `files.workspaceGraph` (one call per workspace; the control plane filters
 * each through the caller's own access). Read on the way in and every two
 * minutes after, while `enabled`.
 */
export function useMapGraphs(workspaces: readonly MapWorkspace[], enabled: boolean): MapGraphs {
  const read = useAction(workspaceGraphRef);
  const readRef = useRef(read);
  readRef.current = read;
  const [answers, setAnswers] = useState<ReadonlyMap<string, GraphAnswer | "failed">>(() => new Map());
  const key = workspaces.map((w) => w.id).join("|");

  useEffect(() => {
    if (!enabled || workspaces.length === 0) return;
    let stopped = false;
    const load = () => {
      for (const ws of workspaces) {
        void readRef
          .current({ workspaceId: ws.id as Id<"workspaces"> })
          .then((answer) => {
            if (!stopped) setAnswers((prev) => new Map(prev).set(ws.id, answer));
          })
          .catch(() => {
            if (!stopped) setAnswers((prev) => (prev.has(ws.id) ? prev : new Map(prev).set(ws.id, "failed")));
          });
      }
    };
    load();
    const timer = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") load();
    }, REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return useMemo(() => {
    const graphs: WorkspaceGraph[] = [];
    const partial = { behind: false, indexMissing: false, truncated: false };
    let loading = false;
    for (const ws of workspaces) {
      const answer = answers.get(ws.id);
      if (answer === undefined) {
        loading = true;
        continue;
      }
      if (answer === "failed") continue;
      partial.behind ||= answer.behind === true;
      partial.indexMissing ||= answer.indexMissing === true;
      partial.truncated ||= answer.truncated === true;
      graphs.push(graphFromAnswer(answer, { id: ws.id, slug: ws.slug, name: ws.displayName, kind: ws.kind }));
    }
    return { graphs, loading, partial };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, key]);
}
