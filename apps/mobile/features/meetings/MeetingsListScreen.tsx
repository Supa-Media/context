import { useCallback, useEffect, useMemo, useRef } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { ScreenScroll } from "../app/Screen";
import { useOptionalLocalSearchParams } from "../app/useOptionalLocalSearchParams";
import { layout, pointerType as t, radii, tracking } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { MeetingRow, RowDivider } from "./components/MeetingRow";
import { RecordButton } from "./components/RecordButton";
import { meetings } from "./controller";
import { groupMeetings, type MeetingListSection } from "./format";
import { ScheduledRow } from "./components/ScheduledRow";
import { useTranscriptionConsentGate } from "./useTranscriptionConsent";
import { joinStartInput } from "./join";
import { useScheduledMeetings } from "./scheduled";
import { nextMeeting } from "@context/meetings/scheduled";
import type { CalendarEvent } from "./protocol";
import { CONSOLE_ROOT } from "../console/nav";
import { strandedMeetings } from "./landing";
import { oneRowPerMeeting, recordedSoFarMs } from "./resume";
import { MEETINGS_ROUTE, meetingHref } from "./route";
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
 * ## The calendar is the person's connected Google calendars, read live
 *
 * "Coming up" is today's meetings from `scheduled.ts`, each with Join and take
 * notes, and it renders only when there are real events: no calendar
 * connected, or none answered yet, draws no section rather than a
 * plausible-looking placeholder. That is `placeholderData.ts`'s rule: "an
 * invented value may never reach a signed-in person as a fact about their own
 * data".
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
  upcoming: upcomingProp,
  locale,
}: {
  upcoming?: readonly CalendarEvent[];
  locale?: string;
}) {
  const snapshot = useMeetingsSnapshot();
  const scheduled = useScheduledMeetings();
  /*
    Today's meetings from the person's own calendars (`scheduled.ts`), unless
    a caller hands a list in, which is what the render tests do.
  */
  const upcoming = upcomingProp ?? (scheduled.meetings.length > 0 ? scheduled.meetings : NO_EVENTS);
  const router = useRouter();
  const styles = useThemedStyles(makeStyles);
  const now = useTick(upcoming.length > 0, 30_000);
  const params = useOptionalLocalSearchParams<{ quickAction?: string | string[] }>();
  const handledQuickAction = useRef(false);

  /*
    Which rows are parked. The sections are built from sessions — `groupMeetings`
    is about dates and a session carries its own — but "is anything going to
    send this" lives on the *record*, beside the session. So it is computed
    once here, where both are in hand, and carried down as ids.
  */
  const strandedIds = useMemo(
    () => new Set(strandedMeetings(snapshot.records).map((record) => record.session.id)),
    [snapshot.records],
  );

  const sections = useMemo(
    () =>
      groupMeetings({
        /*
          One row per meeting: a resumed meeting is one note, and its newest
          part stands for it, carrying the whole meeting's length.
        */
        meetings: oneRowPerMeeting(snapshot.records).map((record) => ({
          ...record.session,
          recordedMs: recordedSoFarMs(record),
        })),
        upcoming,
        now: now === 0 ? Date.now() : now,
        locale,
      }),
    [snapshot.records, upcoming, now, locale],
  );

  /*
    Cloud transcription consent, in front of both starts below
    (docs/decisions/meetings/transcription-consent.md). Not now still starts
    the meeting: it runs as typed notes, with no microphone opened.
  */
  const consent = useTranscriptionConsentGate({ capture: snapshot.capture });
  const consentGate = consent.gate;

  const start = useCallback(
    (title: string) =>
      new Promise<void>((resolve, reject) => {
        consentGate(() => {
          void meetings
            .start({ title })
            .then((id) => {
              router.push(meetingHref(id));
              resolve();
            }, reject);
        });
      }),
    [consentGate, router],
  );

  /*
    Join and take notes. The call opens in the same press where nothing else
    needs it (a phone records the microphone, no share prompt); a browser opens
    its prompt and the live screen offers the call after
    (docs/decisions/meetings/joining-from-the-calendar.md).
  */
  const join = useCallback(
    async (meeting: CalendarEvent) => {
      if (meeting.conferenceUrl !== undefined && !snapshot.capture.systemAudioNeedsPicker) {
        void Linking.openURL(meeting.conferenceUrl).catch(() => {});
      }
      consentGate(() => {
        void meetings.start(joinStartInput(meeting)).then((id) => router.push(meetingHref(id)), () => {});
      });
    },
    [consentGate, router, snapshot.capture.systemAudioNeedsPicker],
  );

  useEffect(() => {
    if (
      params.quickAction !== "meeting" ||
      handledQuickAction.current ||
      snapshot.status !== "ready"
    ) return;
    handledQuickAction.current = true;
    if (snapshot.live !== null) {
      router.replace(meetingHref(snapshot.live.session.id));
      return;
    }
    // Consume the command in the current history entry before starting. Going
    // back to, or remounting, the list must not open the microphone again.
    router.replace(MEETINGS_ROUTE);
    void start("New meeting");
  }, [params.quickAction, router, snapshot.live, snapshot.status, start]);

  return (
    <>
      <ScreenScroll
        // The floating record button lies over the list, so the last row can be
        // scrolled out from under it rather than being stranded behind it.
        chrome={{ bottom: layout.bottomBarHeight + layout.floatingInset }}
        contentContainerStyle={styles.content}
      >
        {/*
          The way out, which this screen did not have.

          `/meetings` sits outside the console, so nothing above it draws
          chrome: the `(app)` stack sets `headerShown: false` and the meetings
          navigator paints a background and a `Stack`. The live screen and the
          note screen each carry their own back control; this one carried none,
          which was invisible for as long as nothing navigated here and is a
          dead end the moment something does.

          Round and unlabelled, like the live screen's, because it is the same
          object on the same kind of screen: `chromeButton` is exactly
          `minTouchTarget`, so the visible circle is the whole target.
        */}
        <BackButton />

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
              onOpen={(id) => router.push(meetingHref(id))}
              stranded={strandedIds}
              onJoin={(meeting) => void join(meeting)}
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

      {snapshot.live === null ? (
        <RecordButton
          onPress={() => void start("New meeting")}
          accessibilityLabel="Start recording a meeting"
          testID="meetings-record"
        />
      ) : null}
      {consent.sheet}
    </>
  );
}

/**
 * Back to wherever somebody came from, and to the console when that is nowhere.
 *
 * `router.back()` alone is a press that does nothing on a cold start — a typed
 * URL, a deep link, or a reload on the web has no entry behind it — and a
 * control that sometimes does nothing is worse than no control, because the
 * person keeps pressing it. `CONSOLE_ROOT` is the fallback because `nav.ts`
 * calls it "the one destination that is always meaningful": it resolves to a
 * context this person can actually reach rather than to a fixed pane.
 *
 * `replace` rather than `push` on that path: there is nothing behind this
 * screen to keep, and pushing would build a history where Back walks between
 * two screens forever.
 */
function BackButton() {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  return (
    <View style={styles.topBar}>
      <Pressable
        onPress={() => (router.canGoBack() ? router.back() : router.replace(CONSOLE_ROOT))}
        accessibilityRole="button"
        accessibilityLabel="Back to your notes"
        style={({ pressed }) => [styles.round, pressed && styles.roundPressed]}
        testID="meetings-back"
      >
        <Icon name="chevronLeft" size={20} color={colors.text2} />
      </Pressable>
    </View>
  );
}

function Section({
  section,
  locale,
  now,
  onOpen,
  stranded,
  onJoin,
}: {
  section: MeetingListSection;
  locale?: string;
  now: number;
  onOpen: (id: string) => void;
  /** Ids of the meetings nothing is going to send on its own. */
  stranded: ReadonlySet<string>;
  onJoin: (meeting: CalendarEvent) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.section}>
      <Text variant="railHead">{section.heading}</Text>

      {section.upcoming.map((event) => (
        <View key={event.id} testID={`meeting-upcoming-${event.id}`}>
          <ScheduledRow
            meeting={event}
            now={now}
            next={nextMeeting(section.upcoming, now)?.id === event.id}
            onJoin={onJoin}
            locale={locale}
          />
        </View>
      ))}

      {section.meetings.length > 0 ? (
        <View style={styles.card}>
          {section.meetings.map((meeting, index) => (
            <View key={meeting.id}>
              {index > 0 ? <RowDivider /> : null}
              <MeetingRow
                meeting={meeting}
                locale={locale}
                stranded={stranded.has(meeting.id)}
                onPress={() => onOpen(meeting.id)}
              />
            </View>
          ))}
        </View>
      ) : null}
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

const makeStyles = (colors: Colors) => StyleSheet.create({
  content: {
    paddingHorizontal: layout.readingMargin,
    gap: 22,
  },
  /**
   * The back control's row.
   *
   * A negative leading margin so the round button's *optical* left edge lands
   * on `readingMargin` with the headings below it, rather than a touch target's
   * worth further in — the content container has already paid that padding and
   * the circle is 44pt of it.
   */
  topBar: { flexDirection: "row", alignItems: "center", marginLeft: -10, marginBottom: -8 },
  round: {
    width: layout.chromeButton,
    height: layout.chromeButton,
    borderRadius: radii.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  roundPressed: { backgroundColor: colors.chromePressed },
  title: {
    fontSize: t.title,
    letterSpacing: tracking(t.title, -0.03),
    marginBottom: -6,
  },
  section: { gap: 10 },
  card: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.sheet,
    backgroundColor: colors.surface2,
    overflow: "hidden",
  },
  grow: { flex: 1, minWidth: 0, gap: 3 },
  recordChipLabel: { color: colors.ink, fontSize: t.ui },
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
});
