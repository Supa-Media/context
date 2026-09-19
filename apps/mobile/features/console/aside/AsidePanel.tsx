import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { AgentConversation } from "../../agent/AgentConversation";
import type { AgentEngine } from "../../agent/engine";
import type { AgentPage } from "../../agent/page";
import { Dot } from "../../design/components/Dot";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { clock } from "../../meetings/format";
import { recordElapsedMs } from "../../meetings/controller";
import { useMeetingsSnapshot, useTick } from "../../meetings/useMeetings";
import {
  ASIDE_TABS,
  CHAT_INTRO,
  NO_MEETING,
  asideTabFor,
  meetingNeedsAttention,
  type AsideTab,
} from "./tabs";

/**
 * What is inside the console's right panel.
 *
 * The frame decides *where* this is — a column at `wide`, an overlay over the
 * note at `medium`, absent on a phone — and this decides what is in it. That
 * split is the reason `AppFrame` takes an `aside` slot rather than knowing
 * about chat: geometry is the frame's and content is the console's, and the
 * panel changing shape under a resize must not be something this file has an
 * opinion about.
 *
 * ## The two things that happen beside a note
 *
 * A conversation about what is written, and a recording of what is being said.
 * Both used to float, and both floated for the same reason — neither had
 * anywhere to live. `tabs.ts` carries the rules, including the one that matters
 * most: **a meeting starting does not take the tab.** It gets a dot instead,
 * because a panel that swaps out from under a composer loses the question
 * somebody was halfway through typing.
 *
 * ## No close button, and that is the toggle's job
 *
 * The control that opens this is a labelled button in the top bar, in the same
 * place whether the panel is open or shut, and the scrim closes the overlay at
 * `medium`. A third way out inside the panel would be a control whose only
 * distinction is being nearer — and the header would have to find room for it
 * beside the tab strip, which is the row a reader scans to choose.
 */
export function AsidePanel({
  engine,
  place,
  onOpenMeeting,
}: {
  engine: AgentEngine;
  /** Where the person is, rebuilt by the console on every render. */
  place: AgentPage;
  /** Open the running meeting's own screen. `null` where there is nowhere to go. */
  onOpenMeeting: ((id: string) => void) | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const [chosen, setChosen] = useState<AsideTab>("chat");
  const showing = asideTabFor(chosen);

  const live = useMeetingsSnapshot().live;
  const meetingLive = live !== null;

  return (
    <View style={styles.panel} testID="aside-panel">
      <View style={styles.tabs} accessibilityRole="tablist">
        {ASIDE_TABS.map((tab) => {
          const current = tab.key === showing;
          return (
            <Pressable
              key={tab.key}
              onPress={() => setChosen(tab.key)}
              role="tab"
              accessibilityState={{ selected: current }}
              /*
                The dot is in the *name* as well as beside it. A mark a screen
                reader cannot see is a mark that only exists for people who can
                look at the screen, and this one is what makes "a meeting does
                not take the tab" a safe trade rather than a way to miss a
                recording.
              */
              accessibilityLabel={
                meetingNeedsAttention(showing, meetingLive) && tab.key === "meetings"
                  ? `${tab.label}, recording`
                  : tab.label
              }
              style={[styles.tab, current && styles.tabCurrent]}
              testID={`aside-tab-${tab.key}`}
            >
              <Text variant="rowSub" style={[styles.tabLabel, current && styles.tabLabelCurrent]}>
                {tab.label}
              </Text>
              {meetingNeedsAttention(showing, meetingLive) && tab.key === "meetings" ? (
                /*
                  Wrapped, because `Dot` takes no `testID` — it is a 6pt mark
                  and giving it one would be a prop on the design system for
                  one caller's test. The wrapper is what a test asks about, and
                  the mark inside it is unchanged.
                */
                <View testID="aside-tab-meetings-dot">
                  <Dot tone="crit" />
                </View>
              ) : null}
            </Pressable>
          );
        })}
      </View>

      {showing === "chat" ? (
        <View style={styles.body} testID="aside-chat">
          <Text variant="foot" style={styles.intro}>
            {CHAT_INTRO}
          </Text>
          {/*
            No `style` prop, so the transcript fills. The modal caps its own —
            see `AgentPanel` — and this is the host the cap was made a prop for.
          */}
          <AgentConversation engine={engine} place={place} />
        </View>
      ) : (
        <MeetingsTab live={live} onOpenMeeting={onOpenMeeting} />
      )}
    </View>
  );
}

/**
 * The Meetings tab.
 *
 * What it shows while something is running is the same three facts the
 * floating bar shows — which meeting, how long, and a way into it — derived
 * the same way, from `recordElapsedMs` against a tick rather than from a timer
 * this component accumulates. That is what makes the number right after a
 * navigation, a backgrounding or a cold start into a running meeting, and it
 * is `useMeetings.ts`'s rule rather than a new one.
 *
 * **The transport is not here.** Start, pause and end live on the bar and on
 * the meeting's own screen, and a fourth place to press End is a fourth place
 * to get the "did that work?" question wrong. This is a window onto a
 * recording, and the way in is a press.
 */
function MeetingsTab({
  live,
  onOpenMeeting,
}: {
  live: ReturnType<typeof useMeetingsSnapshot>["live"];
  onOpenMeeting: ((id: string) => void) | null;
}) {
  const styles = useThemedStyles(makeStyles);
  // `0` and no timer at all when nothing is running — see `useTick`.
  const now = useTick(live !== null);

  if (live === null) {
    return (
      <ScrollView contentContainerStyle={styles.body} testID="aside-meetings">
        <Text variant="rowSub" style={styles.empty} testID="aside-no-meeting">
          {NO_MEETING}
        </Text>
      </ScrollView>
    );
  }

  const elapsed = clock(recordElapsedMs(live, now === 0 ? Date.now() : now));
  const paused = live.session.state === "paused";

  return (
    <ScrollView contentContainerStyle={styles.body} testID="aside-meetings">
      <Pressable
        onPress={onOpenMeeting === null ? undefined : () => onOpenMeeting(live.session.id)}
        role={onOpenMeeting === null ? undefined : "button"}
        accessibilityLabel={
          onOpenMeeting === null ? undefined : `Open ${live.session.title}, ${elapsed}`
        }
        style={styles.liveCard}
        testID="aside-live-meeting"
      >
        <View style={styles.liveHead}>
          <Dot tone={paused ? "warn" : "crit"} />
          <Text variant="rowTitle" style={styles.liveTitle}>
            {live.session.title}
          </Text>
        </View>
        <Text variant="mono" style={styles.liveClock} testID="aside-live-clock">
          {elapsed}
        </Text>
        <Text variant="foot" style={styles.liveFoot}>
          {paused
            ? "Paused. Nothing is being recorded right now."
            : "Recording. The note lands wherever you sent it when you started."}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    panel: { flex: 1, minWidth: 0 },
    tabs: {
      flexDirection: "row",
      gap: space.x1,
      paddingHorizontal: space.x2,
      paddingTop: space.x2,
      paddingBottom: space.x1,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    tab: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      minHeight: layout.minTouchTarget,
      paddingHorizontal: space.x3,
      borderRadius: radii.control,
    },
    tabCurrent: { backgroundColor: colors.chrome },
    tabLabel: { color: colors.muted },
    tabLabelCurrent: { color: colors.text },
    body: { flex: 1, minHeight: 0 },
    intro: { color: colors.muted, paddingHorizontal: space.x4, paddingTop: space.x3 },
    empty: { color: colors.muted, padding: space.x4 },
    liveCard: {
      margin: space.x3,
      padding: space.x4,
      gap: space.x2,
      borderRadius: radii.card,
      backgroundColor: colors.chrome,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
    },
    liveHead: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    liveTitle: { flexShrink: 1 },
    liveClock: { color: colors.text, fontVariant: ["tabular-nums"] },
    liveFoot: { color: colors.muted },
  });
