import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { AgentConversation } from "../../agent/AgentConversation";
import type { AgentEngine } from "../../agent/engine";
import type { AgentPage } from "../../agent/page";
import { Dot } from "../../design/components/Dot";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { useMeetingsSnapshot } from "../../meetings/useMeetings";
import { MeetingsTab } from "./MeetingsTab";
import {
  ASIDE_TABS,
  CHAT_INTRO,
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
  asked,
  started,
  newChat,
  onOpenNote,
}: {
  engine: AgentEngine;
  /** Where the person is, rebuilt by the console on every render. */
  place: AgentPage;
  /**
   * A question handed over from ⌘K, and the moment it was handed over.
   *
   * **A counter rides with the text, and it is not decoration.** Asking the
   * same thing twice is an ordinary thing to do — the first answer was wrong,
   * or the note changed — and a bare string would look unchanged the second
   * time and send nothing. The counter is what makes "ask this again" a
   * different event from "the panel re-rendered".
   */
  asked: { text: string; at: number } | null;
  /**
   * When somebody last asked for a meeting, from the console's + menu.
   *
   * A counter, for `asked`'s reason: recording twice in one session is
   * ordinary and a boolean looks unchanged the second time.
   *
   * **This takes the tab, where a meeting merely *starting* does not**, and the
   * two are not in tension — `tabs.ts` refuses the meeting because nobody asked
   * for it, and this is somebody asking, in the menu's own words. A meeting
   * that begins any other way (a second machine, the phone in a pocket) still
   * only gets the dot.
   */
  started: number | null;
  /**
   * When somebody last asked for a **new** conversation, from the + menu.
   *
   * A counter again, and it is a `key` rather than a command: the transcript
   * and the draft live inside `AgentConversation`, so the honest way to start a
   * fresh one is to mount a fresh one. A "clear" method on the conversation
   * would be a second way to reach the same state, and the one thing this panel
   * must never do is drop a turn that is in flight into a transcript somebody
   * has already replaced.
   */
  newChat: number | null;
  /** Open a finished meeting's note in the console. `null` on the demo console. */
  onOpenNote: ((href: string) => void) | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const [chosen, setChosen] = useState<AsideTab>("chat");
  const showing = asideTabFor(chosen);

  /*
    A question arriving takes the tab, where a meeting does not — and the two
    are not in tension. `tabs.ts` refuses the meeting because nobody asked for
    it; this *is* somebody asking, in the composer's own words, and landing
    them on a tab they did not choose to see the answer they did would be the
    same surprise pointed the other way.
  */
  const askedAt = asked?.at ?? null;
  useEffect(() => {
    if (askedAt === null) return;
    setChosen("chat");
  }, [askedAt]);

  /* The same trade pointed the other way. See `started`. */
  useEffect(() => {
    if (started === null) return;
    setChosen("meetings");
  }, [started]);

  /* And a new conversation is a question about to be typed. See `asked`. */
  useEffect(() => {
    if (newChat === null) return;
    setChosen("chat");
  }, [newChat]);

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
          <AgentConversation
            key={newChat ?? "first"}
            engine={engine}
            place={place}
            asked={asked}
          />
        </View>
      ) : (
        <MeetingsTab onOpenNote={onOpenNote} />
      )}
    </View>
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
  });
