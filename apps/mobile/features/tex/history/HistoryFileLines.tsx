import { useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { useThemedStyles, type Colors } from "../../design/theme";
import { T } from "../page/TexPageParts";
import type { TexPageSource } from "../page/texPageSource";
import { HistoryDayLines } from "./HistoryDayLines";
import { HistoryFilters } from "./HistoryFilters";
import { HistoryState } from "./TexHistoryLines";
import { useHistoryRead } from "./useHistoryRead";
import { useSeesTurnTiming } from "./useSeesTurnTiming";

/** How near the end still counts as at the newest line, in points. */
const AT_END = 48;
/** How near the top reads the earlier days, in points. */
const NEAR_TOP = 80;

/**
 * The history file's lines, read as a chat is: oldest at the top, newest at
 * the bottom, opened scrolled to the newest line, with the title and the
 * filters held above the scroller so they stay as the lines move (Dev,
 * 2026-11-03: "can we start scrolled all the way to the bottom of the page,
 * this might mean that we have to keep the filters sticky", from the
 * artboard he approved). "Show older" is at the top and keeps the line in
 * view where it was; scrolled up, a "Latest" button goes back down.
 */
export function HistoryFileLines({
  source,
  chat,
  group,
  head,
  pad,
  phone = false,
}: {
  source: TexPageSource;
  chat: string;
  group: boolean;
  /** The title row, held with the filters. */
  head: ReactNode;
  /** Room for a phone's floating chrome: above the header and below the last line. */
  pad: { top: number; bottom: number; side: number };
  /** A phone: the title above the filters, and each line's name and time above its words (the phone artboard). */
  phone?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const history = useHistoryRead({ source, chat, group, live: true, timing: useSeesTurnTiming() });
  const scroller = useRef<ScrollView>(null);
  // At the newest line until the reader scrolls up: then new lines and a filter's answer leave them where they are.
  const atEnd = useRef(true);
  const [away, setAway] = useState(false);
  const at = useRef({ y: 0, height: 0, view: 0 });
  // A page of older lines arriving above: the height before, so the line in view stays in view.
  const holding = useRef<number | null>(null);

  const toEnd = (animated: boolean) => {
    atEnd.current = true;
    setAway(false);
    scroller.current?.scrollToEnd({ animated });
  };
  const older = async () => {
    holding.current = at.current.height;
    await history.more();
    // The page has drawn by now, or there was none to draw: either way the hold is over.
    setTimeout(() => {
      holding.current = null;
    }, 300);
  };
  // A new filter's answer opens at its newest line, as the file does.
  if (history.read === null) atEnd.current = true;
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    at.current = { y: contentOffset.y, height: contentSize.height, view: layoutMeasurement.height };
    const end = contentSize.height - (contentOffset.y + layoutMeasurement.height) < AT_END;
    atEnd.current = end;
    // Near the top, the earlier days come in on their own ("Scroll up for earlier days").
    if (contentOffset.y < NEAR_TOP && history.hasOlder && !history.loadingMore && holding.current === null) void older();
    setAway((was) => (was === !end ? was : !end));
  };
  const onSize = (_w: number, height: number) => {
    const before = holding.current;
    const grew = height - at.current.height;
    at.current = { ...at.current, height };
    if (before !== null && !history.loadingMore && height !== before) {
      holding.current = null;
      scroller.current?.scrollTo({ y: at.current.y + grew, animated: false });
      return;
    }
    if (atEnd.current) scroller.current?.scrollToEnd({ animated: false });
  };

  // Oldest day first, each in the order it happened: a chat, read down to now.
  const days = [...history.days].reverse();

  return (
    <View style={styles.fill} testID="history-file-lines">
      <View style={[styles.head, phone ? null : styles.headRow, { paddingTop: pad.top, paddingHorizontal: pad.side }]} testID="history-file-head">
        {head}
        {phone ? null : <View style={styles.divider} />}
        <View style={phone ? null : styles.fill}>
          <HistoryFilters history={history} slide />
        </View>
      </View>
      <ScrollView
        ref={scroller}
        style={styles.fill}
        contentContainerStyle={[styles.content, { paddingHorizontal: pad.side, paddingBottom: pad.bottom + 16 }]}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onContentSizeChange={onSize}
        testID="history-file-scroll"
      >
        {history.hasOlder ? (
          <Pressable accessibilityRole="button" onPress={() => void older()} style={styles.older} testID="tex-history-more">
            <T size={12} tone="muted">
              {history.loadingMore ? "Reading earlier days…" : "Scroll up for earlier days"}
            </T>
          </Pressable>
        ) : null}
        <HistoryState history={history}>{days.map((d) => <HistoryDayLines key={d.key} day={d} look={phone ? "phone" : "file"} />)}</HistoryState>
        {history.read?.kind === "ok" && !history.waiting ? (
          <View style={styles.upToDate} testID="history-file-up-to-date">
            <View style={styles.dot} />
            <T size={12} tone="muted">
              Up to date · new lines appear here
            </T>
          </View>
        ) : null}
      </ScrollView>
      {away ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Go to the latest" onPress={() => toEnd(true)} style={[styles.latest, { bottom: pad.bottom + 16, right: pad.side }]} testID="history-file-latest">
          <T size={14} weight="500">
            ↓ Latest
          </T>
        </Pressable>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    fill: { flex: 1, minHeight: 0 },
    head: { gap: 4, paddingBottom: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, zIndex: 2 },
    content: { flexGrow: 1, justifyContent: "flex-end" },
    headRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingBottom: 0 },
    divider: { width: StyleSheet.hairlineWidth, height: 20, marginHorizontal: 6, backgroundColor: colors.line },
    older: { alignSelf: "center", paddingTop: 6, paddingBottom: 10 },
    upToDate: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 10 },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
    latest: {
      position: "absolute",
      height: 40,
      paddingHorizontal: 16,
      borderRadius: 20,
      justifyContent: "center",
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      shadowColor: "#000",
      shadowOpacity: 0.2,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      elevation: 3,
    },
  });
