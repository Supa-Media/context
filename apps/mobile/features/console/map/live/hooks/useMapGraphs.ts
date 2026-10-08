import type { Id } from "@context/convex/_generated/dataModel";
import { useAction } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { currentEpoch } from "../../../../offline/epoch";
import { expandAnswer, graphFromAnswer, type GraphAnswer } from "../convert";
import { cachedGraph, holdGraph } from "../graphCache";
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
  partial: GraphGaps;
};

export type GraphGaps = {
  behind: boolean;
  indexMissing: boolean;
  truncated: boolean;
  /** Across workspaces cut at the note limit: notes drawn, and notes there are. */
  drawn: number;
  total: number;
  /** Some links between drawn notes were left out at the link limit. */
  linksCut: boolean;
};

/**
 * Every visible note and link of each workspace on the map, from
 * `files.workspaceGraph` (one call per workspace; the control plane filters
 * each through the caller's own access), in its compact form, which carries
 * every note rather than the first 5,000. Read on the way in and every two
 * minutes after, while `enabled`; a workspace read earlier this session is
 * drawn from memory at once while its fresh answer comes (`graphCache.ts`).
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
    // What this tab already read is drawn now; the reads below replace it.
    setAnswers((prev) => {
      let next: Map<string, GraphAnswer | "failed"> | null = null;
      for (const ws of workspaces) {
        const cached = prev.has(ws.id) ? undefined : cachedGraph(ws.id);
        if (cached !== undefined) (next ??= new Map(prev)).set(ws.id, cached);
      }
      return next ?? prev;
    });
    const load = () => {
      for (const ws of workspaces) {
        const epoch = currentEpoch();
        void readRef
          .current({ workspaceId: ws.id as Id<"workspaces">, compact: true })
          .then((raw) => {
            const answer = expandAnswer(raw);
            holdGraph(ws.id, answer, epoch);
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
    const partial: GraphGaps = { behind: false, indexMissing: false, truncated: false, drawn: 0, total: 0, linksCut: false };
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
      partial.linksCut ||= answer.linksCut === true;
      if (typeof answer.noteCount === "number" && answer.noteCount > answer.nodes.length) {
        partial.drawn += answer.nodes.length;
        partial.total += answer.noteCount;
      }
      graphs.push(graphFromAnswer(answer, { id: ws.id, slug: ws.slug, name: ws.displayName, kind: ws.kind }));
    }
    return { graphs, loading, partial };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, key]);
}
