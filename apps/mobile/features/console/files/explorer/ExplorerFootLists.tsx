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
import type { AgentActivityView } from "../../agents/agentActivity";
import { ACTIVITY_PATH, emptyLine, type ActivityView } from "../../activity/activity";
import type { ExplorerProps } from "./props";
import { makeStyles } from "./styles";
import type { ExplorerState } from "./useExplorer";

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
        <View style={[styles.activitySheet, sheetLift]} testID="explorer-activity-list">
          <ScrollView style={styles.activityScroll}>
            <ActivityList
              entries={activity.entries}
              seenAt={activity.seenAt}
              now={activityOpen}
              empty={emptyLine(access !== undefined)}
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
        <View style={[styles.activitySheet, sheetLift]} testID="explorer-agents-list">
          <ScrollView style={styles.activityScroll}>
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
    </>
  );
}
