import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { pendingCount } from "../../approvals/copy";
import type { ApprovalsView } from "../../approvals/useApprovals";
import { Dot } from "../../design/components/Dot";
import { Text } from "../../design/components/Text";
import { radii, space } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useMeetingsSnapshot } from "../../meetings/useMeetings";
import { MeetingsTab } from "./MeetingsTab";
import type { PastWorkspace } from "../../meetings/usePastMeetings";
import { TexChatTab } from "../../tex/chat/TexChatTab";
import { useMapSide } from "./mapSide";
import { AsideStrip } from "./AsideStrip";
import { useFrame } from "../../app/AppFrame";
import { Icon } from "../../design/components/Icon";
import type { CalendarEvent } from "../../meetings/protocol";
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
 * A recording of what is being said, and the chat with Tex, where the requests
 * waiting on a person's yes are answered inline. `tabs.ts` carries the rules,
 * including the one that matters most: **a meeting starting does not take the
 * tab.** It gets a dot instead, because a panel that swaps out from under
 * somebody is a panel they stop trusting.
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
  onJoin = null,
  tex = null,
  pastFrom = null,
}: {
  /** The workspaces whose meeting notes the Meetings tab lists under Past; `null` where there is no control plane. */
  pastFrom?: readonly PastWorkspace[] | null;
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
   * What is waiting for this person's yes (an email, a calendar change, a handle, a key), from `useApprovals`.
   *
   * It feeds the Tex chat, which answers each one inline as a card. Its count
   * rides on the Tex tab's label, so a person on the Meetings tab still sees
   * that something is waiting. Optional: absent means no count, and the Tex
   * chat shows nothing to answer.
   */
  approvals?: ApprovalsView;
  /** Join and take notes, for today's meetings in the Meetings tab. `null` where there is no calendar. */
  onJoin?: ((meeting: CalendarEvent) => void) | null;
  /**
   * The chat with Tex, for the owner of the personal workspace this console has open: that
   * workspace's id and the MCP endpoint the console shows. `null` elsewhere, and then there is no
   * Tex tab. The tab mounts only while it is showing, so the chat polls only then.
   */
  tex?: { workspaceId: string; endpoint: string } | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const [chosen, setChosen] = useState<AsideTab>(DEFAULT_ASIDE_TAB);
  const waiting = approvals?.items.length ?? 0;
  // The tab somebody chose, if this console still shows it; else Meetings, which every console shows.
  const wanted = asideTabFor(chosen);
  const map = useMapSide();
  const tabs = visibleAsideTabs({
    map: map !== null,
    note: map?.noteKey != null,
    tex: tex !== null,
  });
  // A chosen tab that has gone (the note closed, the map left) falls back to the map's Activity, else Meetings.
  const showing: AsideTab = tabs.includes(wanted) ? wanted : tabs.includes("activity") ? "activity" : "meetings";

  /* Somebody asked for Meetings, from the + menu or the title bar. See `started`. */
  useEffect(() => {
    if (started === null) return;
    setChosen("meetings");
  }, [started]);

  /*
    The map opening brings its Activity forward, and a note clicked on it
    brings Note forward. These are the person's own presses on the map, so
    they move the tab where a meeting starting does not. After `started`'s
    effect, so a panel opened on the map shows the map's tab even when a
    meeting was asked for earlier; a new ask still takes the tab.
  */
  const mapOpen = map !== null;
  const noteKey = map?.noteKey ?? null;
  useEffect(() => {
    if (mapOpen) setChosen("activity");
  }, [mapOpen]);
  useEffect(() => {
    if (noteKey !== null) setChosen("note");
  }, [noteKey]);

  const single = tabs.length === 1;
  const live = useMeetingsSnapshot().live;
  const meetingLive = live !== null;
  const colors = useColors();
  const frame = useFrame();
  const setFolded = frame.setAsideFolded;
  const toggleAside = frame.toggleAside;

  // Folded, or shut where the frame keeps a column for it (`regionsFor`), the
  // panel is its strip: a tab opens it whole. Drawn outside a frame it is whole.
  const strip = frame.state.asideFolded || (!frame.state.asideOpen && frame.regions?.aside === "column");
  if (strip) {
    return (
      <AsideStrip
        tabs={tabs}
        showing={showing}
        recording={meetingLive}
        onUnfold={(tab) => {
          if (tab !== null) setChosen(tab);
          if (frame.state.asideOpen) setFolded(false);
          else toggleAside();
        }}
      />
    );
  }

  return (
    <View style={styles.panel} testID="aside-panel">
      {/*
        One tab is a title, not a choice (owner, 2026-11-19: "Dont love the
        meeting header"): with Meetings alone the strip and its rule go, and
        the fold arrow is all that is left of it.
      */}
      <View style={single ? styles.bare : styles.tabs} accessibilityRole={single ? undefined : "tablist"}>
        {single ? null : ASIDE_TABS.filter((tab) => tabs.includes(tab.key)).map((tab) => {
          const current = tab.key === showing;
          // What is waiting for a yes rides on the Tex tab, where those are answered.
          const count = tab.key === "tex" ? pendingCount(waiting) : "";
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
                <Text variant="meta" style={styles.count} testID="aside-tab-tex-count">
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
        <View style={styles.tabsGap} />
        <Pressable
          onPress={() => setFolded(true)}
          accessibilityRole="button"
          accessibilityLabel="Fold the panel"
          style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.fold, hovered && styles.tabCurrent]}
          testID="aside-fold"
        >
          <Icon name="chevronRight" size={14} color={colors.muted} />
        </Pressable>
      </View>

      {showing === "activity" && map !== null ? (
        <View style={styles.body} testID="aside-map-activity">
          {map.activity}
        </View>
      ) : showing === "note" && map !== null ? (
        <View style={styles.body} testID="aside-map-note">
          {map.note}
        </View>
      ) : showing === "tex" && tex !== null ? (
        <View style={styles.body} testID="aside-tex">
          <TexChatTab workspaceId={tex.workspaceId} endpoint={tex.endpoint} approvals={approvals} />
        </View>
      ) : (
        <MeetingsTab onOpenNote={onOpenNote} onJoin={onJoin} pastFrom={pastFrom} />
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    panel: { flex: 1, minWidth: 0 },
    /*
      A slim switcher rather than a header bar (owner, 2026-11-19: "Dont love
      the meeting header", then "no way to quickly switch between meetings and
      tex"): small pills with no rule under them, the current one filled.
    */
    tabs: {
      flexDirection: "row",
      alignItems: "center",
      gap: 2,
      paddingHorizontal: space.x3,
      paddingTop: space.x3,
      paddingBottom: space.x1,
    },
    tab: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      minHeight: 28,
      paddingHorizontal: 10,
      borderRadius: radii.pill,
    },
    tabCurrent: { backgroundColor: colors.surface3 },
    tabsGap: { flex: 1 },
    bare: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.x2, paddingTop: space.x2 },
    fold: { width: 28, height: 28, borderRadius: radii.md, alignItems: "center", justifyContent: "center" },
    tabLabel: { color: colors.muted },
    count: { color: colors.muted },
    tabLabelCurrent: { color: colors.text, fontWeight: "600" },
    body: { flex: 1, minHeight: 0 },
  });
