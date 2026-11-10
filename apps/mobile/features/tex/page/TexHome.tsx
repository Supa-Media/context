import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Circle, G, Path, Rect, Svg } from "react-native-svg";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import {
  Figure,
  More,
  SectionHead,
  T,
  useNow,
  useWide,
} from "./TexPageParts";
import { TexSelect } from "./TexSelect";
import { TexHistoryLines } from "../history/TexHistoryLines";
import { ConversationsPeek } from "../conversations/ConversationsPage";
import { PagesPeek } from "../pages/PagesPeek";
import type { ViewProps } from "./TexPageBody";
import { MachineAskCard } from "./TexMachineAsk";
import { EarlierRow, MinionPool } from "./TexMinionPool";
import { MinionFigure } from "./TexMinionFigure";
import { activityOf } from "./minionProps";
import {
  advisorLine,
  busyLine,
  minionMood,
  endedLine,
  heading,
  mailcheckLine,
  slotLine,
  statusLine,
  tileLines,
} from "./texPageFormat";
import type { Overview, Slot } from "./texPageTypes";

/** The Tex page's first screen, the mock's `template#page` and `#page-g`. */
export function TexHome({
  source,
  chat,
  go,
  page,
  group,
  overview,
  pickChat,
  openNote,
}: ViewProps & { overview: Overview; pickChat: (chatKey: string) => void }) {
  const wide = useWide();
  const now = useNow();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const lines = tileLines(overview.tiles, group !== null, new Date(now));
  const titleSize = wide ? 34 : 26;


  // A tile's line is drawn once it is known; until then a quiet bar, and after `TILES_WAIT_MS` the title alone.
  const known = (view: TileView) => (view === "computer" ? page.tiles.computer : page.tiles.lines);
  const strip = tilesFor(group !== null).map(({ view, title }) => (
    <Pressable
      key={view}
      accessibilityRole="button"
      accessibilityLabel={known(view) ? `${title}, ${lines[view]}` : title}
      onPress={() => go({ view })}
      testID={`tex-tile-${view}`}
      style={[styles.tile, wide ? styles.tileWide : styles.tilePhone]}
    >
      <View style={styles.icon}>
        <Svg width={15} height={15} viewBox="0 0 24 24">
          <G fill="none" stroke={colors.accent} strokeWidth={1.8} strokeLinecap="round">
            {ICONS[view]}
          </G>
        </Svg>
      </View>
      <T size={14} weight="500" numberOfLines={1}>
        {title}
      </T>
      <View style={styles.tileLine}>
        {known(view) ? (
          <T size={12} tone="muted" numberOfLines={1}>
            {lines[view]}
          </T>
        ) : page.tiles.waiting ? (
          <View testID={`tex-tile-${view}-wait`} style={styles.tileWait} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
        ) : null}
      </View>
    </Pressable>
  ));

  return (
    <>
      <View style={styles.top}>
        <Figure mood="calm" size={wide ? 72 : 56} />
        <View style={styles.heading}>
          <T size={titleSize} serif line={1.15} style={{ letterSpacing: titleSize * -0.01 }}>
            {heading(overview.chat)}
          </T>
          <T size={14} tone="muted" style={{ marginTop: 4 }}>
            {statusLine(overview)}
          </T>
        </View>
        <TexSelect
          look="pick"
          label="Which chat"
          testID="tex-chat-picker"
          selected={overview.chat.key}
          options={overview.chats.map((c) => ({ key: c.key, label: c.name }))}
          onPick={pickChat}
        />
      </View>

      {(overview.asks ?? []).map((ask) => (
        <MachineAskCard key={ask.job} ask={ask} page={page} />
      ))}

      {wide ? (
        <View style={styles.stripWide}>{strip}</View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.stripPhone}
          contentContainerStyle={styles.stripPhoneContent}
          testID="tex-strip"
        >
          {strip}
        </ScrollView>
      )}

      <ConversationsPeek source={source} chat={chat} go={go} />

      <PagesPeek source={source} chat={chat} openNote={openNote} />

      <View>
        <SectionHead>History</SectionHead>
        <TexHistoryLines
          source={source}
          chat={chat}
          group={group !== null}
          mini={{ openFull: (history) => go({ view: "history", history }) }}
        />
      </View>

      {overview.places ? (
        <MinionPool overview={overview} now={now} wide={wide} go={go} />
      ) : (
        <View style={styles.column}>
          <View style={styles.busy}>
            <SectionHead>{busyLine(overview.minions)}</SectionHead>
          </View>
          <View style={wide ? styles.rowGap : styles.columnGap}>
            {overview.minions.map((slot) => (
              <Minion key={slot.slot} slot={slot} now={now} wide={wide} go={go} />
            ))}
          </View>
        </View>
      )}

      <View>
        <SectionHead>Earlier today</SectionHead>
        {overview.earlier.length === 0 ? (
          <T size={13} tone="muted">
            Nothing finished today.
          </T>
        ) : (
          overview.earlier.map((job) => (
            <EarlierRow
              key={job.id}
              title={job.title}
              ranOn={job.ranOn}
              right={endedLine(job, now)}
              onPress={() => go({ job: job.id })}
              testID={`tex-earlier-${job.id}`}
            />
          ))
        )}
        {overview.earlierWeek > overview.earlier.length ? (
          <More onPress={() => go({ view: "jobs" })} testID="tex-more-jobs">
            {`Show all ${overview.earlierWeek} from this week`}
          </More>
        ) : null}
      </View>

      <View>
        <SectionHead>Behind the scenes</SectionHead>
        <View style={wide ? styles.rowGap : styles.columnGap}>
          <BehindCard
            testID="tex-behind-advisor"
            title="Advisor"
            line={advisorLine(overview.behind.advisor)}
            wide={wide}
            onPress={() => go({ view: "advisor" })}
          />
          <BehindCard
            testID="tex-behind-mailcheck"
            title="Email check"
            line={mailcheckLine(overview.behind.mailcheck)}
            wide={wide}
            onPress={() => go({ view: "mailcheck" })}
          />
          <BehindCard
            testID="tex-behind-sees"
            title="What Tex sees"
            line="The chat as Tex reads it on the next text"
            wide={wide}
            onPress={() => go({ view: "sees" })}
          />
        </View>
      </View>
    </>
  );
}

type TileView = "routines" | "checkins" | "about" | "computer" | "settings";

const tilesFor = (group: boolean): { view: TileView; title: string }[] => [
  { view: "routines", title: "Routines" },
  { view: "checkins", title: "Check-ins" },
  { view: "about", title: group ? "About the group" : "About you" },
  { view: "computer", title: "Tex's computer" },
  { view: "settings", title: group ? "Group settings" : "Settings" },
];

/** The mock's stroke icons, path for path. */
const ICONS: Record<TileView, ReactNode> = {
  routines: (
    <>
      <Path d="M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3" />
      <Path d="M18 3v4h-4M6 21v-4h4" />
    </>
  ),
  checkins: (
    <>
      <Circle cx={12} cy={13} r={8} />
      <Path d="M12 9v4l2.5 2M9 2h6" />
    </>
  ),
  about: (
    <>
      <Circle cx={12} cy={8} r={4} />
      <Path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" />
    </>
  ),
  computer: (
    <>
      <Rect x={3} y={4} width={18} height={12} rx={2} />
      <Path d="M8 20h8M12 16v4" />
    </>
  ),
  settings: (
    <>
      <Path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <Circle cx={16} cy={7} r={2} />
      <Circle cx={10} cy={17} r={2} />
    </>
  ),
};

export function Minion({ slot, now, wide, go }: { slot: Slot; now: number; wide: boolean; go: ViewProps["go"] }) {
  const styles = useThemedStyles(makeStyles);
  const { job } = slot;
  const s = job ? slotLine(job, now) : null;
  const body = (
    <>
      {job ? (
        <MinionFigure activity={activityOf(job)} trouble={job.failedSteps > 0} size={wide ? 64 : 52} testID={`tex-minion-figure-${slot.place ?? "cloud"}-${slot.slot}`} />
      ) : (
        <Figure mood={minionMood(job)} size={wide ? 64 : 52} testID={`tex-minion-figure-${slot.place ?? "cloud"}-${slot.slot}`} />
      )}
      <View style={styles.minionText}>
        <T size={11} weight="600" tone="muted" upper>
          {`Minion ${slot.slot}`}
        </T>
        {/* Muted, as the mock draws it: the slot's words are quiet, its figure says how it is going. */}
        <T size={15} weight="600" tone="muted">
          {job ? job.title : "Free"}
        </T>
        {s ? (
          <T size={13} tone={s.warn ? "warn" : "muted"}>
            {s.text}
            {s.failed ? (
              <>
                {" · "}
                <T size={13} tone="crit">
                  {s.failed}
                </T>
              </>
            ) : null}
          </T>
        ) : (
          <T size={13} tone="muted">
            Ready for the next job
          </T>
        )}
      </View>
    </>
  );
  const frame = [styles.slot, wide ? styles.slotWide : styles.slotPhone];
  if (job === null) {
    return (
      <View style={[...frame, styles.free]} testID={`tex-slot-${slot.slot}`}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Minion ${slot.slot}: ${job.title}. ${s ? s.text.replace(/\u00a0/g, " ") : ""}${s?.failed ? `. ${s.failed}` : ""}`}
      onPress={() => go({ job: job.id })}
      style={frame}
      testID={`tex-slot-${slot.slot}`}
    >
      {body}
    </Pressable>
  );
}

function BehindCard({
  title,
  line,
  wide,
  onPress,
  testID,
}: {
  title: string;
  line: string;
  wide: boolean;
  onPress: () => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      testID={testID}
      style={[styles.bt, wide ? styles.btWide : null]}
    >
      <Figure mood="calm" size={40} />
      <View style={styles.minionText}>
        <T size={14} weight="600">
          {title}
        </T>
        <T size={13} tone="muted">
          {line}
        </T>
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    top: { flexDirection: "row", alignItems: "center", gap: 14 },
    heading: { flex: 1, minWidth: 0 },
    stripWide: { flexDirection: "row", gap: 8, marginTop: -8 },
    stripPhone: { marginHorizontal: -18, marginTop: -6, flexGrow: 0 },
    stripPhoneContent: { flexDirection: "row", gap: 8, paddingHorizontal: 18, paddingBottom: 2 },
    tile: {
      flexDirection: "column",
      gap: 2,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 12,
      backgroundColor: colors.surface,
    },
    // Wide enough for most lines, so a line landing after the page rarely widens its tile.
    tilePhone: { minWidth: 128, flexShrink: 0 },
    // One 12px line's height whether it holds the line, the bar or nothing: nothing below moves when it lands.
    tileLine: { height: 18, justifyContent: "center" },
    tileWait: { width: 56, height: 8, borderRadius: 4, backgroundColor: colors.surface3 },
    tileWide: { flex: 1, minWidth: 0 },
    icon: {
      width: 26,
      height: 26,
      borderRadius: 7,
      backgroundColor: colors.accentDim,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 4,
    },
    column: { gap: 10 },
    busy: { marginBottom: -4 },
    columnGap: { gap: 10 },
    rowGap: { flexDirection: "row", gap: 10 },
    slot: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 12,
      backgroundColor: colors.surface,
      minWidth: 0,
    },
    slotPhone: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, paddingHorizontal: 14 },
    slotWide: { flex: 1, flexDirection: "column", alignItems: "flex-start", gap: 12, padding: 16 },
    free: { borderStyle: "dashed", backgroundColor: "transparent" },
    minionText: { gap: 2, minWidth: 0, flexShrink: 1 },
    bt: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 12,
      backgroundColor: colors.surface2,
      minWidth: 0,
    },
    btWide: { flex: 1 },
  });
