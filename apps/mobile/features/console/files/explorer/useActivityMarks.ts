import { useMemo } from "react";
import type { FileBrowser } from "../browser";
import { loadedCounts } from "../contextFoot";
import { agentMarkRows, agentsLine, type AgentActivityView } from "../../agents/agentActivity";
import { footLabel, markedRows, type ActivityView } from "../../activity/activity";
import { AGENTS_LINE_HEIGHT } from "./styles";

/**
 * The foot line's words, the tree's dots and the agents line. Called from
 * `useExplorer` at the point these hooks always ran.
 */
export function useActivityMarks({
  files,
  activity,
  agents,
  activityOpen,
}: {
  files: FileBrowser;
  activity: ActivityView | undefined;
  agents: AgentActivityView | undefined;
  activityOpen: number | null;
}) {
  const counts = loadedCounts(files.listings);
  /*
    The foot line's words and the tree's dots, from one view of one file.

    `now` is the moment the list was opened where there is one, and the
    component's own clock otherwise: the line and the rows it opens must agree
    about "4 min", and two `Date.now()` calls in one render do not.
  */
  const activityLabel =
    activity === undefined
      ? counts
      : footLabel({
          unseen: activity.unseen,
          since: activity.seenAt,
          counts,
          now: activityOpen ?? Date.now(),
        });
  const markedPaths = useMemo(
    () =>
      activity === undefined
        ? undefined
        : markedRows(activity.unseenPaths, files.expanded),
    [activity, files.expanded],
  );
  const agentMarks = useMemo(
    () => (agents === undefined ? undefined : agentMarkRows(agents.marks, files.expanded)),
    [agents, files.expanded],
  );
  const agentsLabel = agentsLine(agents);
  /*
    The popovers sit above the foot, and the foot is one line taller while
    agents are active. Without this the list would cover the line that opened
    it.
  */
  const sheetLift = agentsLabel === null ? null : { bottom: 76 + AGENTS_LINE_HEIGHT };

  return { counts, activityLabel, markedPaths, agentMarks, agentsLabel, sheetLift };
}
