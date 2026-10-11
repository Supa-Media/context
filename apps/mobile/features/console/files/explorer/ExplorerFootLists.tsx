import type { Dispatch, SetStateAction } from "react";
import { ScrollView, View } from "react-native";
import { PressRow } from "../../../design/components/Button";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { radii } from "../../../design/tokens";
import { useColors, useThemedStyles } from "../../../design/theme";
import type { FileBrowser } from "../browser";
import { ActivityList } from "../../activity/ActivityList";
import { AgentList } from "../../agents/AgentList";
import { PeopleList } from "../../agents/ActiveBar";
import type { AgentActivityView } from "../../agents/agentActivity";
import { ACTIVITY_PATH, emptyLine, type ActivityView } from "../../activity/activity";
import type { ExplorerProps } from "./props";
import { ACTIVITY_LIFT, AGENTS_LINE_HEIGHT, makeStyles } from "./styles";
import { useOrganizerUndoFor, useOrganizerView } from "../../../organizer/OrganizerContext";
import { changesCount } from "../../../organizer/rules";
import type { ExplorerState } from "./useExplorer";
import { useChaosView } from "../../../chaos/ChaosContext";
import { ChaosFootPopover } from "../../../chaos/ChaosPopover";
import { scoreShown } from "../../../chaos/chaosModel";

/**
 * The two popovers the foot's lines open: what changed, and which agents are
 * working. The state is `Explorer`'s; this draws it.
 */
export function ExplorerFootLists({
  files,
  access,
  activity,
  activityOpen,
  setActivityOpen,
  agents,
  agentsLabel,
  agentsOpen,
  setAgentsOpen,
  sheetLift,
}: {
  files: FileBrowser;
  access: ExplorerProps["access"];
  activity: ActivityView | undefined;
  activityOpen: number | null;
  setActivityOpen: Dispatch<SetStateAction<number | null>>;
  agents: AgentActivityView | undefined;
  agentsLabel: string | null;
  agentsOpen: number | null;
  setAgentsOpen: Dispatch<SetStateAction<number | null>>;
  sheetLift: ExplorerState["sheetLift"];
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const organizer = useOrganizerView();
  const undoFor = useOrganizerUndoFor();
  /*
    The popovers sit above the foot's lines, and auto-organize's "What
    changed" is one more of them — so every popover rises by it, or the list
    covers the line.
  */
  const organizerLine = changesCount(organizer?.status ?? null) !== null;
  // The chaos line is one more (`features/chaos`).
  const chaos = useChaosView();
  const lines = (organizerLine ? 1 : 0) + (chaos !== undefined && scoreShown(chaos.result) ? 1 : 0);
  const lift = lines > 0 ? { bottom: (sheetLift?.bottom ?? ACTIVITY_LIFT) + lines * AGENTS_LINE_HEIGHT } : sheetLift;
  return (
    <>
      {/*
        The list, over the tree rather than beside it.

        A popover anchored to the line that opened it, inside this column,
        because what it lists is what happened in the tree behind it — and
        because the alternatives are a pane (a navigation destination for a
        glance) or a panel (the right-hand one, which holds the two things that
        happen beside a *note*). Pressing a row opens that note in the editor
        this column already drives, and closes.
      */}
      {activity !== undefined && activityOpen !== null ? (
        <View style={[styles.activitySheet, lift]} testID="explorer-activity-list">
          <ScrollView style={styles.activityScroll}>
            <ActivityList
              entries={activity.entries}
              seenAt={activity.seenAt}
              now={activityOpen}
              empty={emptyLine(access !== undefined)}
              undoFor={undoFor}
              onOpen={(path) => {
                setActivityOpen(null);
                activity.markSeen();
                files.select(path);
              }}
            />
          </ScrollView>
          <PressRow
            accessibilityLabel="Open the whole history as a note"
            onPress={() => {
              setActivityOpen(null);
              activity.markSeen();
              files.select(ACTIVITY_PATH);
            }}
            radius={radii.sm}
            style={styles.activityFoot}
            hoverStyle={styles.matchHover}
          >
            <Text variant="treeMeta" style={styles.footGrow}>
              Open the whole history
            </Text>
            <Icon name="chevronRight" size={11} color={colors.chromeMuted} />
          </PressRow>
        </View>
      ) : null}

      {agents !== undefined && agentsOpen !== null && agentsLabel !== null ? (
        <View style={[styles.activitySheet, lift]} testID="explorer-agents-list">
          <ScrollView style={styles.activityScroll}>
            <PeopleList view={agents} />
            <AgentList
              agents={agents.agents}
              now={agentsOpen}
              onOpen={(path) => {
                setAgentsOpen(null);
                files.select(path);
              }}
            />
          </ScrollView>
        </View>
      ) : null}

      <ChaosFootPopover lift={lift ?? undefined} />
    </>
  );
}
