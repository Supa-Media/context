import type { Dispatch, SetStateAction } from "react";
import { StyleSheet, View } from "react-native";
import { PressRow } from "../../../design/components/Button";
import { Icon } from "../../../design/components/Icon";
import { Text } from "../../../design/components/Text";
import { radii } from "../../../design/tokens";
import { useColors, useThemedStyles } from "../../../design/theme";
import { AgentStack } from "../../agents/AgentList";
import type { AgentActivityView } from "../../agents/agentActivity";
import type { ActivityView } from "../../activity/activity";
import { makeStyles } from "./styles";
import { useOrganizerView } from "../../../organizer/OrganizerContext";
import { SuggestionsLine } from "../../../organizer/Review";
import { footCount } from "../../../organizer/rules";

/**
 * The foot of the column: the agents line when there are any, and the one
 * line that is either the counts or what changed. The state is `Explorer`'s;
 * this draws it.
 */
export function ExplorerFoot({
  activity,
  activityLabel,
  activityOpen,
  setActivityOpen,
  agents,
  agentsLabel,
  agentsOpen,
  setAgentsOpen,
  counts,
}: {
  activity: ActivityView | undefined;
  activityLabel: string;
  activityOpen: number | null;
  setActivityOpen: Dispatch<SetStateAction<number | null>>;
  agents: AgentActivityView | undefined;
  agentsLabel: string | null;
  agentsOpen: number | null;
  setAgentsOpen: Dispatch<SetStateAction<number | null>>;
  counts: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  /*
    Auto-organize's line: "11 suggestions", the activity line's twin, opening
    the review list the way that one opens what changed. Only one of the
    three popovers is open at a time.
  */
  const organizer = useOrganizerView();
  const suggestions = footCount(organizer?.status ?? null);
  const closeReview = organizer?.closeReview;
  return (
    <>
      {/*
        The foot: one muted line saying how much of this tree has been read.

        **It used to be three lines and one block — Obsidian's vault switcher —
        and the two lines above this one are gone with the density that had
        them.** The reference (`docs/design/obsidian-parity`, the file-explorer
        shot) ends the sidebar with a row of icon actions, then the vault's name
        with a chevron and a gear, then the count line; a phone drew all three
        because the tree was the whole sheet and its foot was the only place a
        fact about the *context* could sit beside the context's own name.

        A phone has no file tree at all now (`features/app/frame.ts`), so this
        component is a pointer-layout column and nothing else, and the `vault`
        and `vaultDetail` slots had no supplier left. The three facts they
        carried did not go with them: the binding and the tier are the top bar's
        chips here, how much is indexed is the status strip's segment, and on a
        phone all three are the foot of the context's own page — see
        `files/contextFoot.ts` and `FolderView`.

        `loadedCounts` is shared with that page rather than computed here, so
        "how much of this context have I got" has one answer.
      */}
      {/*
        ONE LINE, TWO THINGS TO SAY, AND NEVER BOTH.

        The counts line — "12 notes, 8 folders" — is what this row has always
        said. When something has changed since this person last looked it says
        that instead, and pressing it opens the list.

        Instead, rather than beside: the meeting that asked for this asked for
        "a number of updates at the bottom … in a nice sleek way, it doesn't
        have to be in your face", and a second row at the foot of a column
        whose rail was folded away to give its width to the note is exactly the
        furniture that request was refusing. The counts come back the moment
        the list is read, which is also what makes "caught up" visible without
        a word for it.
      */}
      {/*
        AGENTS, WHEN THERE ARE ANY, AND NOT A LINE OTHERWISE.

        One line however many agents are working, so a workspace with a
        hundred of them has the same sidebar as one with two. Who they are is
        one press away; the tree's squares say where. Above the counts line
        because it is the more current of the two: minutes rather than since
        you last looked.
      */}
      {agents !== undefined && agentsLabel !== null ? (
        <PressRow
          accessibilityLabel={`${agentsLabel}. Show which`}
          onPress={() => {
            setActivityOpen(null);
            closeReview?.();
            setAgentsOpen((open) => (open === null ? Date.now() : null));
          }}
          ariaExpanded={agentsOpen !== null}
          ariaHasPopup="menu"
          radius={radii.sm}
          style={StyleSheet.flatten([styles.foot, styles.footPress])}
          hoverStyle={styles.matchHover}
          testID="explorer-agents"
        >
          <AgentStack agents={agents.agents} />
          <Text variant="treeMeta" numberOfLines={1} style={styles.footGrow}>
            {agentsLabel}
          </Text>
          <Icon
            name={agentsOpen === null ? "chevronUp" : "chevronDown"}
            size={11}
            color={colors.chromeMuted}
          />
        </PressRow>
      ) : null}

      {organizer !== undefined && suggestions !== null ? (
        <SuggestionsLine
          count={suggestions}
          open={organizer.reviewOpen}
          onToggle={() => {
            setActivityOpen(null);
            setAgentsOpen(null);
            if (organizer.reviewOpen) organizer.closeReview();
            else organizer.openReview();
          }}
        />
      ) : null}

      {activity !== undefined && activity.unseen > 0 ? (
        <PressRow
          accessibilityLabel={`${activityLabel}. Show what changed`}
          onPress={() => {
            const opening = activityOpen === null;
            setAgentsOpen(null);
            closeReview?.();
            setActivityOpen(opening ? Date.now() : null);
            // Re-read on the way in. The entries arrived when this console
            // did, and everything that has happened since — including this
            // person's own last hour of work — is in the file rather than in
            // state. One small read, on a press, is the cheapest honest
            // answer; the alternative is a subscription over a file.
            if (opening) activity.refresh();
            // Marked on close rather than on open: a list that clears its own
            // marker the instant it appears is one you cannot look away from
            // and come back to.
            else activity.markSeen();
          }}
          ariaExpanded={activityOpen !== null}
          ariaHasPopup="menu"
          radius={radii.sm}
          style={StyleSheet.flatten([styles.foot, styles.footPress])}
          hoverStyle={styles.matchHover}
          testID="explorer-activity"
        >
          <View style={styles.activityDot} aria-hidden />
          <Text variant="treeMeta" numberOfLines={1} style={styles.footGrow}>
            {activityLabel}
          </Text>
          <Icon
            name={activityOpen === null ? "chevronUp" : "chevronDown"}
            size={11}
            color={colors.chromeMuted}
          />
        </PressRow>
      ) : (
        <View style={styles.foot}>
          <Text variant="treeMeta" numberOfLines={1} testID="explorer-counts">
            {counts}
          </Text>
        </View>
      )}
    </>
  );
}
