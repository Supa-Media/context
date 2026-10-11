import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { ApprovalsPanel } from "../../approvals/ApprovalsPanel";
import { pendingCount } from "../../approvals/copy";
import type { ApprovalsView } from "../../approvals/useApprovals";
import { Dot } from "../../design/components/Dot";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { useMeetingsSnapshot } from "../../meetings/useMeetings";
import { MeetingsTab } from "./MeetingsTab";
import {
  ASIDE_TABS,
  DEFAULT_ASIDE_TAB,
  asideTabFor,
  meetingNeedsAttention,
  visibleAsideTabs,
  type AsideTab,
} from "./tabs";

/**
 * What is inside the console's right panel.
 *
 * The frame decides *where* this is — a column at `wide`, an overlay over the
 * note at `medium`, absent on a phone — and this decides what is in it. That
 * split is the reason `AppFrame` takes an `aside` slot rather than knowing
 * about meetings: geometry is the frame's and content is the console's, and the
 * panel changing shape under a resize must not be something this file has an
 * opinion about.
 *
 * ## What happens beside a note
 *
 * A recording of what is being said, and the requests waiting on a person's
 * yes. `tabs.ts` carries the rules, including the one that matters most: **a
 * meeting starting does not take the tab.** It gets a dot instead, because a
 * panel that swaps out from under somebody is a panel they stop trusting.
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
  started,
  onOpenNote,
  approvals,
}: {
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
  /** Open a finished meeting's note in the console, by href and path. `null` on the demo console. */
  onOpenNote: ((href: string, path: string) => void) | null;
  /**
   * What the egress gate is holding for this person, from `useApprovals`.
   *
   * Optional, and absent means no Approvals tab: a host that cannot answer
   * approvals (the homepage, a test that does not mount the hook) draws the
   * Meetings tab alone. The tab's count is read here, so it is visible from
   * the Meetings tab without opening it.
   */
  approvals?: ApprovalsView;
}) {
  const styles = useThemedStyles(makeStyles);
  const [chosen, setChosen] = useState<AsideTab>(DEFAULT_ASIDE_TAB);
  const approvalsAvailable = approvals?.available === true;
  const tabs = visibleAsideTabs({ approvals: approvalsAvailable });
  // The tab somebody chose, if this console still shows it; else Meetings, which every console shows.
  const wanted = asideTabFor(chosen);
  const showing: AsideTab = tabs.includes(wanted) ? wanted : "meetings";
  const waiting = approvals?.items.length ?? 0;

  /* Somebody asked for Meetings, from the + menu or the title bar. See `started`. */
  useEffect(() => {
    if (started === null) return;
    setChosen("meetings");
  }, [started]);

  const live = useMeetingsSnapshot().live;
  const meetingLive = live !== null;

  return (
    <View style={styles.panel} testID="aside-panel">
      <View style={styles.tabs} accessibilityRole="tablist">
        {ASIDE_TABS.filter((tab) => tabs.includes(tab.key)).map((tab) => {
          const current = tab.key === showing;
          const count = tab.key === "approvals" ? pendingCount(waiting) : "";
          return (
            <Pressable
              key={tab.key}
              onPress={() => {
                setChosen(tab.key);
                // Looking at the list is asking for the newest one: a request
                // raised since the console opened should be here when it is.
                if (tab.key === "approvals") approvals?.refresh();
              }}
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
                  : count !== ""
                    ? `${tab.label}, ${count} waiting`
                    : tab.label
              }
              style={[styles.tab, current && styles.tabCurrent]}
              testID={`aside-tab-${tab.key}`}
            >
              <Text variant="rowSub" style={[styles.tabLabel, current && styles.tabLabelCurrent]}>
                {tab.label}
              </Text>
              {count !== "" ? (
                <Text variant="meta" style={styles.count} testID="aside-tab-approvals-count">
                  {count}
                </Text>
              ) : null}
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

      {showing === "approvals" && approvals !== undefined ? (
        <View style={styles.body} testID="aside-approvals">
          <ApprovalsPanel view={approvals} />
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
    count: { color: colors.muted },
    tabLabelCurrent: { color: colors.text },
    body: { flex: 1, minHeight: 0 },
  });
