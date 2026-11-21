import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { pendingCount } from "../../approvals/copy";
import type { ApprovalsView } from "../../approvals/useApprovals";
import { space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { useMeetingsSnapshot } from "../../meetings/useMeetings";
import { MeetingsTab } from "./MeetingsTab";
import type { PastWorkspace } from "../../meetings/usePastMeetings";
import { TexChatTab } from "../../tex/chat/TexChatTab";
import type { SeenBody } from "../../tex/chat/appChatSeen";
import { useMapSide } from "./mapSide";
import { AsideStrip } from "./AsideStrip";
import { changedSinceSeen, useAsideChoice } from "./asideChoice";
import { useFrame } from "../../app/AppFrame";
import type { CalendarEvent } from "../../meetings/protocol";
import { asideTabFor, visibleAsideTabs, type AsideTab } from "./tabs";

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
 * ## The rail is the panel's only chrome
 *
 * A thin column of one icon per tab sits on the right edge whether the panel
 * is open or folded (Dev2, 2026-11-20: "the meeting and tex icon just live
 * forever in a thin right column"). It switches tabs, folds the panel (its
 * chevron, or the open tab's own icon) and carries the marks a tab row used
 * to: a meeting recording, and what waits for a yes on Tex. So there is no tab
 * row inside the panel, and nothing to scan twice.
 */
export function AsidePanel({
  started,
  onOpenNote,
  approvals,
  onJoin = null,
  tex = null,
  pastFrom = null,
  onSearch = null,
  texSeen = null,
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
  /** Open the search palette, from the rail's magnifier. `null` hides it. */
  onSearch?: (() => void) | null;
  /** What the person has open in the console, for the Tex chat's sends. Absent or `null` sends none. */
  texSeen?: (() => SeenBody | null) | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const [chosen, setChosen] = useAsideChoice();
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
  // Each takes the tab once, when it changes; a remount of the panel (folded strip to overlay) does not replay it.
  useEffect(() => {
    if (changedSinceSeen("started", started) && started !== null) setChosen("meetings");
  }, [started, setChosen]);

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
    if (changedSinceSeen("mapOpen", mapOpen) && mapOpen) setChosen("activity");
  }, [mapOpen, setChosen]);
  useEffect(() => {
    if (changedSinceSeen("noteKey", noteKey) && noteKey !== null) setChosen("note");
  }, [noteKey, setChosen]);

  const live = useMeetingsSnapshot().live;
  const meetingLive = live !== null;
  const frame = useFrame();
  const setFolded = frame.setAsideFolded;
  const toggleAside = frame.toggleAside;

  /*
    The rail is always drawn, open or folded (Dev2, 2026-11-20: "the meeting
    and tex icon just live forever in a thin right column"), so the panel has
    no tab row: the rail is the one place to switch tabs and to fold.
  */
  const unfold = (tab: AsideTab | null) => {
    if (tab !== null) setChosen(tab);
    if (frame.state.asideOpen) setFolded(false);
    else toggleAside();
  };
  const rail = (open: boolean) => (
    <AsideStrip
      tabs={tabs}
      showing={showing}
      recording={meetingLive}
      open={open}
      waiting={tex !== null ? pendingCount(waiting) : ""}
      onUnfold={unfold}
      onFold={() => setFolded(true)}
      onSearch={onSearch}
    />
  );

  // Folded, or shut where the frame keeps a column for it (`regionsFor`), the
  // panel is its rail alone. Drawn outside a frame it is whole.
  const strip = frame.state.asideFolded || (!frame.state.asideOpen && frame.regions?.aside === "column");
  if (strip) return <View style={styles.folded}>{rail(false)}</View>;

  return (
    <View style={styles.row}>
      <View style={styles.panel} testID="aside-panel">
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
            <TexChatTab
              workspaceId={tex.workspaceId}
              endpoint={tex.endpoint}
              approvals={approvals}
              onOpenNote={onOpenNote}
              seen={texSeen ?? undefined}
            />
          </View>
        ) : (
          <MeetingsTab onOpenNote={onOpenNote} onJoin={onJoin} pastFrom={pastFrom} />
        )}
      </View>
      {rail(true)}
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    row: { flex: 1, minWidth: 0, flexDirection: "row" },
    folded: { flex: 1, alignItems: "flex-end" },
    panel: { flex: 1, minWidth: 0, paddingTop: space.x2 },
    body: { flex: 1, minHeight: 0 },
  });
