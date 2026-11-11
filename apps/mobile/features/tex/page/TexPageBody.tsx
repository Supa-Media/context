import { useState, type ReactElement } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useThemedStyles, type Colors } from "../../design/theme";
import type { TexComputerState } from "../useTexComputer";
import { Back, NowContext, T, WIDE_PX, WideContext } from "./TexPageParts";
import { TexHome } from "./TexHome";
import { TexJobPage } from "./TexJobPage";
import { AdvisorPage, JobsPage, MailcheckPage, ThinkingPage } from "./TexLists";
import { AboutPage, CheckinsPage, RoutinesPage } from "./TexEditPages";
import { HistoryPage, SeesPage } from "./TexHistoryPage";
import { ConversationsPage } from "../conversations/ConversationsPage";
import { ComputerPage, GroupSettingsPage, SettingsPage } from "./TexSettingsPages";
import { MachinesPage } from "./TexMachinesPage";
import { MachinePage } from "./TexMachinePage";
import { ConnectPage } from "./TexConnectPage";
import type { TexPageSource } from "./texPageSource";
import type { TexPageState } from "./useTexPage";
import type { SubView } from "./texPageTypes";
import type { HistoryChoice } from "../history/historyChoice";

/** Where on the page the person is: the chat, and a sub-page or a job, or neither for the first screen. */
export interface Place {
  chat: string;
  view?: SubView;
  job?: string;
  /** Tex's computer full screen, to watch or take over. */
  full?: boolean;
  /** Which machine, on `view: "machine"`. */
  machine?: string;
  /** The day and kinds the History page opens with, on `view: "history"` (`historyChoice.ts`). */
  history?: HistoryChoice;
}

/** What every view below the first screen is given. */
export interface ViewProps {
  source: TexPageSource;
  page: TexPageState;
  chat: string;
  /** A group's name, or null in the person's own chat. */
  group: string | null;
  /** Somewhere in this chat; naming `chat` moves to another (a machine's settings live in each chat). */
  go: (to: Omit<Place, "chat"> & { chat?: string }) => void;
  /** Which machine, on the machine page. */
  machine?: string;
  /** The day and kinds the History page opens with. */
  history?: HistoryChoice;
  /** A note opened in the app, as a page Tex made is; omitted where there is no app to open it in. */
  openNote?: (context: string, path: string) => void;
}

/**
 * The Tex page, drawable without a session: the screen hands it the real
 * gateway, the visual fixture an in-memory one. Paper, one calm column at
 * most 720 wide, the mock's `.pg`.
 */
export function TexPageBody({
  source,
  page,
  place,
  go,
  computer,
  openComputer,
  exit,
  openNote,
  now,
  wide: forceWide,
}: {
  source: TexPageSource;
  page: TexPageState;
  place: Place;
  go: (to: Place) => void;
  computer: TexComputerState | null;
  /** The full-screen computer, to watch or take over. */
  openComputer: () => void;
  /**
   * Out of Tex, back to the notes: "‹ Notes" above the first screen, which
   * otherwise has no way out inside the app (Dev2, 2026-11-06). Omitted, no link.
   */
  exit?: () => void;
  openNote?: (context: string, path: string) => void;
  now?: () => number;
  /** Overrides the measured width (the screenshot pass, where jsdom never lays out). */
  wide?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const [width, setWidth] = useState(0);
  const wide = forceWide ?? width >= WIDE_PX;
  const overview = page.overview;
  const group = overview && overview.chat.key !== "me" ? overview.chat.name : null;
  const props: ViewProps = {
    source,
    page,
    chat: place.chat,
    group,
    go: (to) => go({ chat: place.chat, ...to }),
    ...(place.machine ? { machine: place.machine } : {}),
    ...(place.history ? { history: place.history } : {}),
    ...(openNote ? { openNote } : {}),
  };
  const home = () => go({ chat: place.chat });

  let body: ReactElement;
  if (page.phase === "notYours") {
    body = <Notice title="This chat isn't one of yours" line="Pick another chat, or open your own page." />;
  } else if (page.phase === "failed" && overview === null) {
    body = <Notice title="Tex's page can't be reached right now" line="Try again in a moment." />;
  } else if (overview === null) {
    body = (
      <View style={styles.wait}>
        <ActivityIndicator size="small" />
      </View>
    );
  } else if (place.job) {
    body = (
      <>
        <Back onPress={home} />
        <TexJobPage {...props} id={place.job} computer={computer} openComputer={openComputer} />
      </>
    );
  } else if (place.view) {
    // One machine and connecting one sit under Your machines, and go back there.
    const underMachines = place.view === "machine" || place.view === "connect";
    body = (
      <>
        {underMachines ? (
          <Back onPress={() => go({ chat: place.chat, view: "machines" })} label="‹ Your machines" />
        ) : (
          <Back onPress={home} />
        )}
        <SubViewPage view={place.view} props={props} computer={computer} openComputer={openComputer} />
      </>
    );
  } else {
    body = <TexHome {...props} overview={overview} pickChat={(chat: string) => go({ chat })} />;
  }

  // The first screen, loading or not, gets the way out; a sub-page's "‹ Tex" leads back to it.
  if (exit && !place.job && !place.view) {
    body = (
      <>
        <Back onPress={exit} label="‹ Notes" testID="tex-exit" />
        {body}
      </>
    );
  }

  // History owns its scroller, so its filters stay put and it opens on the newest line (`HistoryPage`): the page around it holds still.
  const ownsScroll = overview !== null && page.phase !== "notYours" && !place.job && place.view === "history";
  const column = (
    <View style={[styles.pg, wide ? styles.pgWide : null, ownsScroll ? styles.pgFill : null]} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {body}
    </View>
  );

  return (
    <NowContext.Provider value={now ?? Date.now}>
      <WideContext.Provider value={wide}>
        {ownsScroll ? (
          <View style={styles.ground} testID="tex-page">
            {column}
          </View>
        ) : (
          <ScrollView style={styles.ground} contentContainerStyle={styles.scroll} testID="tex-page">
            {column}
          </ScrollView>
        )}
      </WideContext.Provider>
    </NowContext.Provider>
  );
}

function SubViewPage({
  view,
  props,
  computer,
  openComputer,
}: {
  view: SubView;
  props: ViewProps;
  computer: TexComputerState | null;
  openComputer: () => void;
}) {
  switch (view) {
    case "routines":
      return <RoutinesPage {...props} />;
    case "checkins":
      return <CheckinsPage {...props} />;
    case "about":
      return <AboutPage {...props} />;
    case "computer":
      return <ComputerPage {...props} computer={computer} openComputer={openComputer} />;
    case "settings":
      return props.group ? <GroupSettingsPage {...props} /> : <SettingsPage {...props} />;
    case "thinking":
      return <ThinkingPage {...props} />;
    case "jobs":
      return <JobsPage {...props} />;
    case "advisor":
      return <AdvisorPage {...props} />;
    case "mailcheck":
      return <MailcheckPage {...props} />;
    case "history":
      return <HistoryPage {...props} />;
    case "sees":
      return <SeesPage {...props} />;
    case "conversations":
      return <ConversationsPage {...props} />;
    case "machines":
      return <MachinesPage {...props} />;
    case "machine":
      return <MachinePage {...props} />;
    case "connect":
      return <ConnectPage {...props} />;
  }
}

function Notice({ title, line }: { title: string; line: string }) {
  return (
    <View style={{ gap: 8, paddingVertical: 40 }} testID="tex-page-notice">
      <T size={22} serif line={1.25}>
        {title}
      </T>
      <T size={14} tone="muted">
        {line}
      </T>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.pageSurface },
    scroll: { flexGrow: 1 },
    pg: { width: "100%", maxWidth: 720, alignSelf: "center", paddingTop: 18, paddingHorizontal: 18, paddingBottom: 30, gap: 22 },
    pgWide: { paddingTop: 30, paddingHorizontal: 32, paddingBottom: 40 },
    pgFill: { flex: 1, minHeight: 0, gap: 12, paddingBottom: 12 },
    wait: { paddingVertical: 60, alignItems: "center" },
  });
