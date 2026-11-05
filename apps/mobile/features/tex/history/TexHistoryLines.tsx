import { useRef, type ReactNode } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";
import { useThemedStyles, type Colors } from "../../design/theme";
import { More, T, useWide } from "../page/TexPageParts";
import type { TexPageSource } from "../page/texPageSource";
import { HistoryDayLines } from "./HistoryDayLines";
import { HistoryFilters } from "./HistoryFilters";
import type { HistoryChoice } from "./historyChoice";
import { useHistoryRead, type HistoryRead } from "./useHistoryRead";
import { useSeesTurnTiming } from "./useSeesTurnTiming";

/** The hub's history box at most as tall as the approved artboard draws it, shorter on a quiet day: it scrolls inside, the page around it stays put. */
const MINI_HEIGHT = { phone: 320, wide: 360 };

/**
 * A chat's history, one line a message: time, who, words, left-aligned and
 * grouped by day and turn (decided by the owner, 2026-11-02, from the
 * artboard he approved: "go back to the ltr, 1 line slack style"). One row of
 * filters: which day, and Texts, Tool calls, Thinking and Background, thinking off
 * until asked for. A line opens to its entry exactly as kept. Read from the
 * gateway each time, a page at a time; nothing here keeps a copy.
 *
 * Drawn on a job's page, newest day first. The Tex page's History and the
 * history file (`tex/history.ledger.json`, or a group home's) opened in the
 * app read as a chat does, live and newest at the bottom (`HistoryFileLines`).
 *
 * `mini` is the same history on the hub's first screen (Dev, 2026-11-04: "use
 * the same history component ... like a mini view but it can still scroll,
 * still have the filter, still a button to go to the full page"): the lines in
 * a box of their own that scrolls, oldest at the top and opened on the newest,
 * live as the chat goes on, the kinds sliding sideways rather than wrapping,
 * and a button to the History page carrying the filters.
 */
export function TexHistoryLines({
  source,
  chat,
  group,
  job,
  initial,
  mini,
}: {
  source: TexPageSource;
  chat: string;
  group: boolean;
  /** One job's work only: its page. */
  job?: string;
  /** The day and kinds to open with (`historyChoice.ts`). */
  initial?: HistoryChoice;
  /** The hub's box; `openFull` goes to the History page with these filters. */
  mini?: { openFull: (choice: HistoryChoice) => void };
}) {
  const history = useHistoryRead({ source, chat, group, job, live: mini !== undefined, initial, timing: useSeesTurnTiming() });
  if (mini) return <MiniLines history={history} openFull={mini.openFull} />;
  return (
    <View style={{ gap: 12 }} testID="tex-history-lines">
      <HistoryFilters history={history} />
      <HistoryState history={history}>{history.days.map((d) => <HistoryDayLines key={d.key} day={d} job={job} />)}</HistoryState>
      {history.hasOlder ? (
        <More onPress={() => void history.more()} testID="tex-history-more">
          {history.loadingMore ? "Reading…" : "Show older"}
        </More>
      ) : null}
    </View>
  );
}

function MiniLines({ history, openFull }: { history: HistoryRead; openFull: (choice: HistoryChoice) => void }) {
  const styles = useThemedStyles(makeStyles);
  const wide = useWide();
  const box = useRef<ScrollView>(null);
  // Follows the newest line while the person is at the bottom; once they scroll up to read, it stays where they are.
  const atEnd = useRef(true);
  const { day, picked, shown } = history;
  return (
    <View style={{ gap: 8 }} testID="tex-history-mini">
      <HistoryFilters history={history} slide />
      <ScrollView
        ref={box}
        nestedScrollEnabled
        style={[styles.box, { maxHeight: wide ? MINI_HEIGHT.wide : MINI_HEIGHT.phone }]}
        contentContainerStyle={styles.boxContent}
        scrollEventThrottle={100}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          atEnd.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 24;
        }}
        onContentSizeChange={() => {
          if (atEnd.current) box.current?.scrollToEnd({ animated: false });
        }}
        testID="tex-history-mini-box"
      >
        {history.hasOlder ? (
          <More onPress={() => void history.more()} testID="tex-history-more">
            {history.loadingMore ? "Reading…" : "Show older"}
          </More>
        ) : null}
        <HistoryState history={history}>
          {[...history.days].reverse().map((d) => (
            <HistoryDayLines key={d.key} day={d} />
          ))}
        </HistoryState>
      </ScrollView>
      <More onPress={() => openFull({ day, picked, shown })} style={styles.open} testID="tex-history-open-full">
        Open full history ›
      </More>
    </View>
  );
}

/** The lines, or what stands where they would: nothing asked, reading, a failed read, an empty day. */
export function HistoryState({ history, children }: { history: HistoryRead; children: ReactNode }) {
  const { waiting, read, days } = history;
  if (waiting) return null;
  if (read === null) return <ActivityIndicator size="small" />;
  if (read.kind !== "ok")
    return (
      <T size={13} tone="muted" testID="tex-history-failed">
        The history can't be read right now. Try again in a moment.
      </T>
    );
  if (days.length === 0)
    return (
      <T size={13} tone="muted" testID="tex-history-empty">
        Nothing here for that day.
      </T>
    );
  return <>{children}</>;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    box: { borderWidth: 1, borderColor: colors.line, borderRadius: 12 },
    boxContent: { paddingHorizontal: 12, paddingBottom: 8 },
    // A button the width of the box, as the artboard draws it; 44 tall to tap.
    open: { alignSelf: "stretch", alignItems: "center", justifyContent: "center", minHeight: 44, paddingTop: 0, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 10 },
  });
