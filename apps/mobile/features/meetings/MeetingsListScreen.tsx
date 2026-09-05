import { useCallback, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { ScreenScroll } from "../app/Screen";
import { layout, radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { MeetingRow, RowDivider } from "./components/MeetingRow";
import { meetings } from "./controller";
import { groupMeetings, startsIn, type MeetingListSection } from "./format";
import type { CalendarEvent } from "./protocol";
import { useMeetingsSnapshot, useTick } from "./useMeetings";

/**
 * `Meetings` — everything this device has recorded, and what is about to
 * happen.
 *
 * Three bands, in the mockup's order: **Coming up** from the calendar,
 * **Earlier today**, then a heading per previous day. `groupMeetings` decides
 * them, in local time, with the reasoning in `format.ts`.
 *
 * ## The record button is the screen's one job
 *
 * It is a filled circle at the bottom, thumb-height, and it starts a meeting
 * with no dialog in front of it: the reference experience is that you open the
 * app and hit record. A title can be typed later — the live screen's heading is
 * editable — and asking for one first is a modal between somebody and a meeting
 * that has already started.
 *
 * ## The calendar is not wired, and the screen says nothing rather than lying
 *
 * "Coming up" renders only when there are real events. There is no calendar
 * integration in this app yet — reading the device calendar is a native
 * permission and a decision about what leaves the phone — so the section is
 * simply absent, rather than showing a plausible-looking placeholder. That is
 * `placeholderData.ts`'s rule, and it is the one this repo has already been
 * burned by twice: "an invented value may never reach a signed-in person as a
 * fact about their own data".
 */
/**
 * The empty calendar, as one frozen value.
 *
 * A `[]` default parameter is a fresh array on every render, so it changes the
 * identity of the `useMemo` below every time and re-groups the whole list for
 * nothing. One constant, and the memo holds.
 */
const NO_EVENTS: readonly CalendarEvent[] = Object.freeze([]);

export function MeetingsListScreen({
  /**
   * Calendar events, when something can supply them.
   *
   * A prop rather than a hook so the screen is complete and testable now, and
   * so whoever wires a calendar has one place to plug into. Empty means the
   * section is not drawn at all.
   */
  upcoming = NO_EVENTS,
  locale,
}: {
  upcoming?: readonly CalendarEvent[];
  locale?: string;
}) {
  const snapshot = useMeetingsSnapshot();
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const now = useTick(upcoming.length > 0, 30_000);

  const sections = useMemo(
    () =>
      groupMeetings({
        meetings: snapshot.records.map((record) => record.session),
        upcoming,
        now: now === 0 ? Date.now() : now,
        locale,
      }),
    [snapshot.records, upcoming, now, locale],
  );

  const start = useCallback(
    async (title: string) => {
      const id = await meetings.start({ title });
      router.push(`/meetings/${id}`);
    },
    [router],
  );

  return (
    <>
      <ScreenScroll
        // The floating record button lies over the list, so the last row can be
        // scrolled out from under it rather than being stranded behind it.
        chrome={{ bottom: layout.bottomBarHeight + layout.floatingInset }}
        contentContainerStyle={styles.content}
      >
        <Text variant="paneTitle" style={styles.title}>
          Meetings
        </Text>

        {snapshot.status !== "ready" ? (
          // Loading is not "no meetings". Drawing the empty state here would
          // tell somebody with fifty recordings that they have none, for as
          // long as the store takes to answer — the distinction
          // `emptyConsoleStats.test.ts` exists to keep.
          <View style={styles.quiet} testID="meetings-loading" />
        ) : sections.length === 0 ? (
          <Empty onStart={() => void start("New meeting")} />
        ) : (
          sections.map((section) => (
            <Section
              key={section.id}
              section={section}
              locale={locale}
              now={now === 0 ? Date.now() : now}
              onOpen={(id) => router.push(`/meetings/${id}`)}
              onRecord={(title) => void start(title)}
            />
          ))
        )}

        {snapshot.unreadable > 0 ? (
          <Text variant="meta" style={styles.unreadable}>
            {snapshot.unreadable === 1
              ? "1 meeting on this device was written by a newer version of the app and cannot be shown here."
              : `${snapshot.unreadable} meetings on this device were written by a newer version of the app and cannot be shown here.`}
          </Text>
        ) : null}

        {snapshot.durabilityReason !== null ? (
          <Text variant="meta" style={styles.unreadable}>
            {snapshot.durabilityReason}
          </Text>
        ) : null}
      </ScreenScroll>

      {snapshot.live === null ? <RecordButton onPress={() => void start("New meeting")} /> : null}
    </>
  );
}

function Section({
  section,
  locale,
  now,
  onOpen,
  onRecord,
}: {
  section: MeetingListSection;
  locale?: string;
  now: number;
  onOpen: (id: string) => void;
  onRecord: (title: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.section}>
      <Text variant="railHead">{section.heading}</Text>

      {section.upcoming.map((event) => (
        <UpcomingRow
          key={event.id}
          event={event}
          now={now}
          onRecord={() => onRecord(event.title)}
        />
      ))}

      {section.meetings.length > 0 ? (
        <View style={styles.card}>
          {section.meetings.map((meeting, index) => (
            <View key={meeting.id}>
              {index > 0 ? <RowDivider /> : null}
              <MeetingRow
                meeting={meeting}
                locale={locale}
                onPress={() => onOpen(meeting.id)}
              />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * A calendar event that has not happened.
 *
 * Drawn in the accent wash rather than as a list row, because it is not one:
 * there is nothing to open, and the only thing to do with it is start
 * recording. The Record button carries the event's title straight through, so
 * the meeting is named before it begins without anybody typing.
 */
function UpcomingRow({
  event,
  now,
  onRecord,
}: {
  event: CalendarEvent;
  now: number;
  onRecord: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const people = event.attendees.length;
  const detail = [
    startsIn(event.startsAt, now),
    people > 0 ? `${people} ${people === 1 ? "person" : "people"}` : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");

  return (
    <View style={styles.upcoming} testID={`meeting-upcoming-${event.id}`}>
      <View style={styles.upcomingMark} aria-hidden>
        <Icon name="constellation" size={18} color={colors.accent} />
      </View>
      <View style={styles.grow}>
        <Text variant="rowTitle" numberOfLines={1}>
          {event.title}
        </Text>
        <Text variant="rowSub" numberOfLines={1}>
          {detail}
        </Text>
      </View>
      <Pressable
        onPress={onRecord}
        accessibilityRole="button"
        accessibilityLabel={`Record ${event.title}`}
        style={({ pressed }) => [styles.recordChip, pressed && styles.chipPressed]}
      >
        <Text variant="mini" style={styles.recordChipLabel}>
          Record
        </Text>
      </Pressable>
    </View>
  );
}

function Empty({ onStart }: { onStart: () => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.empty} testID="meetings-empty">
      <Text variant="noteTitle">Nothing recorded on this device yet.</Text>
      <Text variant="rowSub" style={styles.emptyBody}>
        Start a meeting and type as it happens. Your notes and the transcript
        become one Markdown note in your own bucket — nobody else holds a copy.
      </Text>
      <Pressable
        onPress={onStart}
        accessibilityRole="button"
        accessibilityLabel="Start recording a meeting"
        style={({ pressed }) => [styles.emptyCta, pressed && styles.chipPressed]}
      >
        <Text variant="mini" style={styles.recordChipLabel}>
          Start a meeting
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * The one control on the screen, in the floating chrome's own geometry.
 *
 * A red disc rather than a labelled button: it is the mockup's, it is what
 * every recorder on a phone looks like, and it is the one target on this screen
 * a thumb has to hit without looking. `chromeButton` is exactly
 * `minTouchTarget` — the visible circle *is* the target here, with no padding
 * around it to make up a shortfall.
 */
function RecordButton({ onPress }: { onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.recordSlot}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="Start recording a meeting"
        style={({ pressed }) => [styles.record, pressed && styles.recordPressed]}
        testID="meetings-record"
      >
        <View style={styles.recordDot} aria-hidden />
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  content: {
    paddingHorizontal: layout.readingMargin,
    gap: 22,
  },
  title: { fontSize: 30, letterSpacing: -0.9, marginBottom: -6 },
  section: { gap: 10 },
  card: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.sheet,
    backgroundColor: colors.surface2,
    overflow: "hidden",
  },
  grow: { flex: 1, minWidth: 0, gap: 3 },
  upcoming: {
    flexDirection: "row",
    alignItems: "center",
    gap: 13,
    borderWidth: 1,
    borderColor: colors.hintBorder,
    backgroundColor: colors.hintWash,
    borderRadius: radii.sheet,
    padding: 15,
  },
  upcomingMark: {
    width: 38,
    height: 38,
    borderRadius: radii.card,
    backgroundColor: colors.accentDim,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  recordChip: {
    height: 32,
    paddingHorizontal: 14,
    borderRadius: radii.pill,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  recordChipLabel: { color: colors.ink, fontSize: 13 },
  chipPressed: { opacity: 0.8 },
  quiet: { height: 120 },
  empty: { gap: 12, paddingVertical: 24, alignItems: "flex-start" },
  emptyBody: { maxWidth: 420 },
  emptyCta: {
    height: 44,
    paddingHorizontal: 20,
    borderRadius: radii.pill,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  unreadable: { paddingTop: 4 },
  recordSlot: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: layout.floatingGap,
    alignItems: "center",
    /*
      The slot spans the width of the screen so the button is centred, but only
      the button may take a press — the rest of that strip is the last line of
      somebody's list. `box-none` in the *style* rather than as the `pointerEvents`
      prop, which React Native deprecated and which warns on every render.
    */
    pointerEvents: "box-none",
  },
  record: {
    width: layout.bottomBarHeight,
    height: layout.bottomBarHeight,
    borderRadius: radii.pill,
    backgroundColor: colors.chrome,
    alignItems: "center",
    justifyContent: "center",
  },
  recordPressed: { backgroundColor: colors.chromePressed },
  recordDot: {
    width: 26,
    height: 26,
    borderRadius: radii.pill,
    backgroundColor: colors.crit,
  },
});
