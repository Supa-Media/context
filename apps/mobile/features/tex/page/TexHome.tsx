import { Fragment, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Circle, G, Path, Rect, Svg } from "react-native-svg";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import {
  Figure,
  LinkWord,
  More,
  SectionHead,
  T,
  ThinkBlock,
  useNow,
  useWide,
} from "./TexPageParts";
import { TexSelect } from "./TexSelect";
import type { ViewProps } from "./TexPageBody";
import { MachineAskCard } from "./TexMachineAsk";
import { EarlierRow, MinionPool } from "./TexMinionPool";
import {
  actionPieces,
  advisorLine,
  busyLine,
  endedLine,
  heading,
  mailcheckLine,
  moodOf,
  slotLine,
  statusLine,
  tileLines,
  turnHead,
  turnTail,
} from "./texPageFormat";
import type { Overview, Slot, Turn, TurnAction } from "./texPageTypes";

/** The Tex page's first screen, the mock's `template#page` and `#page-g`. */
export function TexHome({
  go,
  page,
  group,
  overview,
  pickChat,
}: ViewProps & { overview: Overview; pickChat: (chatKey: string) => void }) {
  const wide = useWide();
  const now = useNow();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const lines = tileLines(overview.tiles, group !== null, new Date(now));
  const titleSize = wide ? 34 : 26;

  const open = (action: TurnAction) => {
    if (action.kind === "advisor") go({ view: "advisor" });
    else if (action.kind === "mailcheck") go({ view: "mailcheck" });
    else if (action.kind === "job" && action.ref) go({ job: action.ref });
  };

  const strip = tilesFor(group !== null).map(({ view, title }) => (
    <Pressable
      key={view}
      accessibilityRole="button"
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
      <T size={12} tone="muted" numberOfLines={1}>
        {lines[view]}
      </T>
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

      <View>
        <SectionHead>{"Tex's thinking"}</SectionHead>
        {overview.thinking.length === 0 ? (
          <T size={13} tone="muted">
            Nothing yet today.
          </T>
        ) : (
          overview.thinking.map((turn, i) => (
            <ThinkBlock key={`${turn.at}:${i}`} testID={`tex-think-${i}`}>
              <T size={13} tone="muted">
                {turnHead(turn, new Date(now))}
              </T>
              <T size={15} serif line={1.55}>
                {turn.thought}
              </T>
              <T size={13} tone="muted">
                {thoughtLine(turn, open)}
              </T>
            </ThinkBlock>
          ))
        )}
        {overview.thinkingToday > overview.thinking.length ? (
          <More onPress={() => go({ view: "thinking" })} testID="tex-more-thinking">
            {`Show all ${overview.thinkingToday} from today`}
          </More>
        ) : null}
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
            testID="tex-behind-history"
            title="History"
            line="Everything said and done here"
            wide={wide}
            onPress={() => go({ view: "history" })}
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

/** `Asked the Advisor › · replied “…” · 3.8 s`: each action, then the tail, separated by " · ". */
function thoughtLine(turn: Turn, open: (action: TurnAction) => void): ReactNode {
  const items: ReactNode[] = [
    ...turn.did.map((action, j) => {
      const p = actionPieces(action);
      return (
        <Fragment key={`a${j}`}>
          {p.before}
          {p.link ? <LinkWord onPress={() => open(action)}>{`${p.link} ›`}</LinkWord> : null}
          {p.after}
        </Fragment>
      );
    }),
    ...turnTail(turn).map((text, k) => <Fragment key={`t${k}`}>{text}</Fragment>),
  ];
  return items.map((item, k) => (
    <Fragment key={k}>
      {k > 0 ? " · " : null}
      {item}
    </Fragment>
  ));
}

export function Minion({ slot, now, wide, go }: { slot: Slot; now: number; wide: boolean; go: ViewProps["go"] }) {
  const styles = useThemedStyles(makeStyles);
  const { job } = slot;
  const s = job ? slotLine(job, now) : null;
  const body = (
    <>
      <Figure mood={moodOf(job)} size={wide ? 64 : 52} />
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
    tilePhone: { minWidth: 112, flexShrink: 0 },
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
