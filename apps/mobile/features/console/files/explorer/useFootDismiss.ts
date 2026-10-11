import type { Dispatch, SetStateAction } from "react";
import { useDismissOnOutside } from "../../../design/useDismissOnOutside";
import type { ActivityView } from "../../activity/activity";

/**
 * The foot's three popovers (what changed, who is active, suggestions) close
 * on a press anywhere else and on Escape, the way any popover does.
 *
 * They are one rule rather than three because they are one kind of thing: a
 * list over the tree, opened by a line at its foot, only one open at a time.
 * Closing what changed marks it seen, as closing it from its own line does.
 */
const INSIDE = [
  "explorer-activity",
  "explorer-activity-list",
  "explorer-agents",
  "explorer-agents-list",
  "explorer-suggestions",
  "explorer-suggestions-list",
] as const;

export function useFootDismiss({
  activity,
  activityOpen,
  setActivityOpen,
  agentsOpen,
  setAgentsOpen,
}: {
  activity: ActivityView | undefined;
  activityOpen: number | null;
  setActivityOpen: Dispatch<SetStateAction<number | null>>;
  agentsOpen: number | null;
  setAgentsOpen: Dispatch<SetStateAction<number | null>>;
}): void {
  useDismissOnOutside(activityOpen !== null || agentsOpen !== null, INSIDE, () => {
    if (activityOpen !== null) {
      setActivityOpen(null);
      activity?.markSeen();
    }
    setAgentsOpen(null);
  });
}
