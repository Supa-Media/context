/**
 * Everything the Jobs page draws from, for the place the URL holds: the
 * catalog and every scores note, and, on a job, its test lists, and on a
 * compare, both prompts and the round's replies.
 */

import { useMemo, useState } from "react";
import type { Id } from "@context/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { jobPage, type Candidate, type JobPage } from "../../../aiModel";
import type { RepliesCase } from "../../../aiCompareModel";
import { useConsoleGrant } from "../../../../agent/useConsoleGrant";
import { S } from "../../state";
import { LAB_JOB } from "./jobsModel";
import { useJobsData, useJobWrites, useReplies, useTexts, type JobsData, type JobWrites } from "./useJobsData";

export interface JobsPageData extends JobsData {
  now: number;
  /** The open job, when the URL names one. */
  page: JobPage | null;
  /** Test list texts by path, for the open job. */
  texts: ReadonlyMap<string, string | null>;
  /** The setup open in Compare. */
  candidate: Candidate | null;
  liveText: string | null;
  candidateText: string | null;
  replies: ReadonlyMap<number, RepliesCase> | null;
  writes: JobWrites;
  /** Re-read the open job's test lists. */
  rereadTests: () => void;
  mint: ReturnType<typeof useConsoleGrant>;
  /** The caller's own workspace: Try it reads their notes, never anyone else's. */
  ownWorkspace: Id<"workspaces"> | null;
}

export function useJobsPage(): JobsPageData {
  const data = useJobsData();
  const [round, setRound] = useState(0);
  const jobKey = S.subs[0] && S.subs[0] !== "activity" && S.subs[0] !== LAB_JOB ? S.subs[0] : null;
  const compareName = S.subs[1] === "compare" ? (S.subs[2] ?? null) : null;
  const page = useMemo(() => (data.catalog && jobKey ? jobPage(data.catalog, jobKey, data.reads) : null), [data.catalog, data.reads, jobKey]);
  const texts = useTexts(data.workspaceId, page?.row.tests.map((test) => test.path) ?? [], round + data.reloads);
  const candidate = useMemo(() => {
    if (!page || S.subs[1] !== "compare") return null;
    const open = page.candidates.filter((item) => item.status !== "live" && item.status !== "retired");
    return open.find((item) => item.name === compareName) ?? open[0] ?? null;
  }, [page, compareName]);
  const prompts = useTexts(data.workspaceId, candidate && page?.row.setup ? [page.row.setup.path, candidate.row.path] : [], data.reloads);
  const replies = useReplies(data.workspaceId, candidate);
  const writes = useJobWrites(data.workspaceId, data.me);
  const mint = useConsoleGrant();
  const workspaces = useQuery(api.functions.workspaces.listMyWorkspaces, {});
  const own = workspaces?.find((workspace) => (workspace as { kind?: string }).kind === "personal");
  const ownWorkspace = (own?.workspaceId as Id<"workspaces"> | undefined) ?? null;
  const liveText = page?.row.setup ? (prompts.get(page.row.setup.path) ?? null) : null;
  const candidateText = candidate ? (prompts.get(candidate.row.path) ?? null) : null;
  // A minute is fine enough for "2d ago", and keeps the object steady between clicks.
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  return useMemo(
    () => ({ ...data, now, page, texts, candidate, liveText, candidateText, replies, writes, rereadTests: () => setRound((was) => was + 1), mint, ownWorkspace }),
    [data, now, page, texts, candidate, liveText, candidateText, replies, writes, mint, ownWorkspace],
  );
}
