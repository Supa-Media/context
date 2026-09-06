import { useCallback, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Screen } from "../app/Screen";
import { floatingGapFor } from "../app/frame";
import { KeyboardSticky, dismissKeyboard, useKeyboardHeight } from "../design/keyboardSticky";
import { fonts, layout, radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../design/theme";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { Waveform } from "./components/Waveform";
import { NotesPad } from "./components/NotesPad";
import { meetings, recordElapsedMs } from "./controller";
import { attendeeCount, clock, sourceLabel, timeOfDay } from "./format";
import type { MeetingRecord } from "./record";
import { isSynced } from "./record";
import { useMeetingsSnapshot, useTick } from "./useMeetings";

/**
 * The recording screen, which is a notepad with a recorder attached.
 *
 * Read the layout top to bottom and the priority is the argument: a title and
 * three small facts, then **the rest of the screen is the text area**, then two
 * status chips, then the transport. Everything above the notepad is a line
 * high; everything below it is a chip. That ratio is the product.
 *
 * ## The one interaction that matters
 *
 * Nothing that arrives while somebody is typing may touch the caret. Transcript
 * segments land continuously and the clock ticks every second, and both of them
 * re-render *this* component — but not `NotesPad`, which is uncontrolled and
 * memoised on a stable callback. `NotesPad`'s header is the full argument;
 * `meetingsTyping.test.ts` asserts the render count rather than the appearance,
 * because a broken version looks identical at rest.
 *
 * The transcript is a **chip**, not a column, for the same reason: a live
 * transcript scrolling beside a notepad is a second thing moving on a screen
 * whose whole promise is that nothing does. Its content is one number and one
 * word, and it is placed where a glance costs nothing.
 *
 * ## The transport rides the keyboard, because the notepad holds it open
 *
 * `NotesPad` autofocuses — it is the screen — so on a phone the soft keyboard
 * is up from the first second of a recording and stays up. The keyboard is
 * drawn *over* the app on both native platforms, so a transport at the bottom
 * of the glass is behind it, and the one control that stops a recording was
 * unreachable: *"I had to like leave and go to another page"* to end the
 * meeting. A recording you cannot stop from where you are is the same family
 * of defect as a meeting you cannot find.
 *
 * So the transport is inside `KeyboardSticky`, which translates it by the
 * keyboard's own height on native and is plain bottom-anchoring on the web
 * (where the browser shrinks the viewport for us). A spacer holds its place in
 * the flow, so the chips above are never drawn underneath it.
 *
 * ## Riding the keyboard is half of it, and the other half is the room
 *
 * A bar lifted by the keyboard's full height lands *inside* whatever the
 * keyboard was covering. `NotesPad` is `flex: 1` in a non-scrolling `Screen`,
 * so its frame ran behind the keyboard and did not shrink — which put an opaque
 * 66pt control in the middle of the visible text, and about ten lines in, the
 * caret went under it. The bar was reachable and the thing it was there to
 * protect was not.
 *
 * So the screen gives the keyboard its room through `Screen`'s own `chrome`
 * prop — "our own floating chrome over this surface", the mechanism that
 * already exists for this — and the content box ends where the keyboard begins.
 * The spacer is the last thing in that box, so the lifted bar lands on it. On
 * the web `useKeyboardHeight` is 0 and that is the right answer rather than a
 * stub: the browser has already reflowed the document into what is left.
 *
 * The other two numbers are the caller's, because `KeyboardSticky` says they
 * are: it anchors at `bottom: 0` and has no offset on purpose. An absolutely
 * positioned child is laid out against its parent's padding box, so `Screen`'s
 * safe-area `paddingBottom` does not hold the bar back — without an inset of
 * its own it sat in the home-indicator band, which is `RecordingBar`'s rule
 * inverted: *a control under the home indicator is a control a swipe takes
 * instead of a tap.* And it is drawn over the chips, so it carries a `zIndex`.
 * `NoteAccessory` is the pair's other caller and sets both; this is that call
 * site copied rather than a second opinion about the same geometry.
 *
 * The leading key on the bar puts the keyboard away, which the note editor has
 * had on its accessory bar and this screen had nowhere. It is the *leading*
 * position deliberately: End is the destructive-feeling one and stays at the
 * trailing edge where it has always been, so a thumb reaching for the key it
 * knows does not find a new control under it.
 *
 * ## Ending does not navigate
 *
 * `end()` moves the session to `finalizing`, and this route then renders the
 * finalized view for the same id. The person stays where they were and watches
 * their meeting become a note, rather than being thrown back to a list and
 * having to find it. `app/(app)/meetings/[id].tsx` is the one place that
 * chooses which of the two screens to draw.
 */
export function LiveMeetingScreen({ meetingId }: { meetingId: string }) {
  const snapshot = useMeetingsSnapshot();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  /*
    The same `max` the recording bar spends at the same edge, so the two
    floating bars on this product clear the home indicator by one rule.
  */
  const gap = floatingGapFor(insets.bottom);
  const keyboard = useKeyboardHeight();

  const record = useMemo(
    () => snapshot.records.find((candidate) => candidate.session.id === meetingId) ?? null,
    [snapshot.records, meetingId],
  );

  const live = record !== null && (record.session.state === "recording" || record.session.state === "paused");
  const now = useTick(live);

  /*
    Stable across every render of this screen, which is what keeps `NotesPad`
    from re-rendering when a segment arrives. `meetingId` is the only
    dependency, and it does not change for the life of the route.
  */
  const onChangeText = useCallback(
    (text: string) => meetings.setNotes(meetingId, text),
    [meetingId],
  );

  if (record === null) {
    // Loading is not absence — see `MeetingNoteScreen`, which carries the
    // argument. Reachable here too: this route is the live screen only while a
    // meeting *is* live, and a cold start into one arrives through the store.
    if (snapshot.status !== "ready") {
      return (
        <Screen style={styles.screen} testID="meeting-loading">
          <View style={styles.quiet} />
        </Screen>
      );
    }
    return (
      <Screen style={styles.screen}>
        <Text variant="rowSub" style={styles.missing} testID="meeting-missing">
          That meeting is not on this device.
        </Text>
      </Screen>
    );
  }

  const { session } = record;
  const paused = session.state === "paused";

  return (
    <Screen style={styles.screen} chrome={{ bottom: keyboard }} testID="live-meeting">
      <View style={styles.topBar}>
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back to meetings"
          style={({ pressed }) => [styles.round, pressed && styles.roundPressed]}
        >
          <Icon name="chevronDown" size={20} color={colors.text2} />
        </Pressable>
      </View>

      <View style={styles.head}>
        <Text variant="paneTitle" style={styles.title} numberOfLines={2}>
          {session.title}
        </Text>
        <View style={styles.facts}>
          <Fact label={timeOfDay(session.startedAt)} />
          <Fact label={peopleLabel(attendeeCount(session.attendees))} />
          <SourceChip label={sourceLabel(session.source)} detected={session.source.kind !== "unknown"} />
        </View>
      </View>

      <NotesPad
        initialValue={session.notes}
        onChangeText={onChangeText}
        autoFocus
        placeholder="Type your notes — nothing on this screen moves while you do."
        testID="meeting-notes"
      />

      <View style={styles.chips}>
        <TranscriptChip record={record} />
        <SyncChip record={record} syncing={snapshot.syncing} />
      </View>

      {/*
        The transport's place in the flow, so the chips above it are never
        drawn underneath the bar that rides over them. Sized from the same two
        tokens the slot below spends.
      */}
      <View
        style={[styles.transportSpacer, { height: layout.bottomBarHeight + gap }]}
        aria-hidden
        testID="meeting-transport-spacer"
      />

      <KeyboardSticky
        style={[styles.transportSticky, { paddingBottom: gap }]}
        testID="meeting-transport-sticky"
      >
        <View style={styles.transportSlot}>
        <View style={styles.transport}>
          <Pressable
            onPress={dismissKeyboard}
            accessibilityRole="button"
            accessibilityLabel="Hide the keyboard"
            style={({ pressed }) => [styles.round, pressed && styles.roundPressed]}
            testID="meeting-keyboard-hide"
          >
            <Icon name="keyboardHide" size={19} color={colors.text2} />
          </Pressable>

          <Pressable
            onPress={paused ? () => meetings.resume() : () => meetings.pause()}
            accessibilityRole="button"
            accessibilityLabel={paused ? "Resume recording" : "Pause recording"}
            style={({ pressed }) => [
              styles.round,
              paused ? styles.roundWarn : styles.roundOk,
              pressed && styles.roundPressed,
            ]}
            testID="meeting-pause"
          >
            <Waveform tone={paused ? "muted" : "ok"} paused={paused} size={17} />
          </Pressable>

          <View style={styles.clockGroup}>
            <Waveform tone={paused ? "muted" : "ok"} paused={paused} />
            <Text style={styles.clock} testID="meeting-clock">
              {clock(recordElapsedMs(record, now === 0 ? Date.now() : now))}
            </Text>
          </View>

          <Pressable
            onPress={() => void meetings.end()}
            accessibilityRole="button"
            accessibilityLabel="End the meeting and write the note"
            style={({ pressed }) => [styles.end, pressed && styles.chipPressed]}
            testID="meeting-end"
          >
            <Text variant="mini" style={styles.endLabel}>
              End
            </Text>
          </Pressable>
        </View>
        </View>
      </KeyboardSticky>
    </Screen>
  );
}

/**
 * What the transcript is doing, in one chip.
 *
 * Three states and they are genuinely different, which is why this is not a
 * boolean:
 *
 *  - **nothing is listening** — the honest state of every build today, and the
 *    recorder's own sentence is what it says. Not silence: somebody who pressed
 *    record is entitled to know that no audio is being captured, before the
 *    meeting rather than after it.
 *  - **listening, nothing yet** — capture is on and the first words have not
 *    arrived.
 *  - **transcribing** — a word count, which is the only number about a
 *    transcript that means anything at a glance.
 */
function TranscriptChip({ record }: { record: MeetingRecord }) {
  const snapshot = useMeetingsSnapshot();
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();

  /*
    A capture failure that happened *to this meeting* outranks the build's
    standing capability, because it is newer and more specific: "the microphone
    was taken by a call" is what somebody needs, not "this build cannot capture
    audio" — which would be false, since it was capturing a moment ago.
  */
  if (snapshot.captureError !== null) {
    return (
      <View style={[styles.chip, styles.chipCrit]} testID="meeting-transcript-chip">
        <View style={[styles.pip, { backgroundColor: colors.crit }]} aria-hidden />
        <Text variant="pill" style={styles.chipCritText} numberOfLines={1}>
          {snapshot.captureError}
        </Text>
      </View>
    );
  }

  if (!snapshot.capture.audio) {
    return (
      <View style={styles.chip} testID="meeting-transcript-chip">
        <View style={[styles.pip, { backgroundColor: colors.muted }]} aria-hidden />
        <Text variant="pill" style={styles.chipText} numberOfLines={1}>
          {snapshot.capture.unavailableReason ?? "Typed notes only"}
        </Text>
      </View>
    );
  }

  const words = record.session.transcript.reduce(
    (total, segment) => total + countWords(segment.text),
    0,
  );
  return (
    <View style={styles.chip} testID="meeting-transcript-chip">
      <View style={[styles.pip, { backgroundColor: colors.ok }]} aria-hidden />
      <Text variant="pill" style={styles.chipText}>
        {words === 0 ? "Listening" : `Transcribing · ${words.toLocaleString()} words`}
      </Text>
    </View>
  );
}

/**
 * Whether this meeting has left the device.
 *
 * Never says "saved". Reaching the gateway is not reaching the customer's
 * bucket, and only a `notePath` says the second — so the two states here are
 * "queued on this device" and "synced", and the word that means *written* is
 * reserved for the screen that has a path to show.
 */
function SyncChip({ record, syncing }: { record: MeetingRecord; syncing: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();

  if (record.rejection !== undefined) {
    return (
      <View style={[styles.chip, styles.chipCrit]} testID="meeting-sync-chip">
        <View style={[styles.pip, { backgroundColor: colors.crit }]} aria-hidden />
        <Text variant="pill" style={styles.chipCritText} numberOfLines={1}>
          Needs you
        </Text>
      </View>
    );
  }

  const label = syncing ? "Syncing" : isSynced(record) ? "Synced" : "Queued on this device";
  return (
    <View style={styles.chip} testID="meeting-sync-chip">
      <Icon name="arrowRight" size={12} color={colors.muted} />
      <Text variant="pill" style={styles.chipText}>
        {label}
      </Text>
    </View>
  );
}

/**
 * One small fact, in a chip.
 *
 * **No icon.** The mockup draws a calendar mark beside the time and a person
 * beside the count, and `features/design/components/Icon.tsx` has neither —
 * its own rule is that an icon is added "when a control needs it, in the same
 * change as the control", and inventing two drawings inside this feature would
 * put marks outside the set every other screen is checked against
 * (`icons.test.ts` walks `ICON_NAMES`). A near-miss mark — a folder standing
 * for a clock — is worse than none: it is read, and it is read wrong.
 *
 * So the label carries the meaning instead, which is also what makes the chip
 * announce itself correctly: "3 people" is a sentence, and an unlabelled person
 * glyph beside a bare "3" is not.
 */
function Fact({ label }: { label: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.fact}>
      <Text variant="rowSub" style={styles.factText}>
        {label}
      </Text>
    </View>
  );
}

function peopleLabel(count: number): string {
  if (count === 0) return "Just you";
  return `${count} ${count === 1 ? "person" : "people"}`;
}

/**
 * Where the audio came from.
 *
 * Green and confident only when something actually detected it — "Zoom
 * detected" in the mockup is a *claim about the world*, and a screen that says
 * it over a `kind: "unknown"` source is the invented-fact bug this repo has
 * shipped twice. An undetected source draws in the neutral tone and says "In
 * person", which is the honest default for a phone on a table.
 */
function SourceChip({ label, detected }: { label: string; detected: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  if (!detected) {
    return (
      <View style={styles.fact}>
        <Text variant="rowSub" style={styles.factText}>
          In person
        </Text>
      </View>
    );
  }
  return (
    <View style={[styles.fact, styles.factOk]} testID="meeting-source-chip">
      <View style={[styles.pip, { backgroundColor: colors.ok }]} aria-hidden />
      <Text variant="pill" style={styles.factOkText}>
        {label} detected
      </Text>
    </View>
  );
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

const makeStyles = (colors: Colors, shadows: Shadows) => StyleSheet.create({
  screen: { backgroundColor: colors.ground },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 13,
    paddingTop: 14,
    paddingBottom: 8,
  },
  head: { paddingHorizontal: layout.readingMargin, paddingTop: 10, gap: 14 },
  title: { fontSize: 27, lineHeight: 32, letterSpacing: -0.81 },
  facts: { flexDirection: "row", alignItems: "center", gap: 7, flexWrap: "wrap" },
  fact: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 28,
    paddingHorizontal: 11,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface2,
  },
  factText: { color: colors.text2 },
  factOk: { borderColor: colors.okBorder, backgroundColor: colors.okWash },
  factOkText: { color: colors.okText, fontSize: 12.5 },
  chips: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: layout.readingMargin,
    paddingBottom: 12,
    flexWrap: "wrap",
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 26,
    maxWidth: "100%",
    paddingHorizontal: 10,
    borderRadius: radii.pill,
    backgroundColor: colors.surface2,
    borderWidth: 1,
    borderColor: colors.line,
  },
  chipText: { color: colors.muted, fontWeight: "500" },
  chipCrit: { backgroundColor: colors.critWash, borderColor: colors.critBorder },
  chipCritText: { color: colors.critText },
  chipPressed: { opacity: 0.8 },
  pip: { width: 5, height: 5, borderRadius: 3 },
  /**
   * The bar's own inset, and why it is not 52 any more.
   *
   * 52 was the room three targets needed. There are four now — the keyboard key
   * joined at the leading edge — and 24 is what the phone's bottom row already
   * spends (`layout.bottomBarInset`), so the two floating bars on this product
   * sit on the same margin rather than two.
   */
  transportSlot: { paddingHorizontal: layout.bottomBarInset },
  /**
   * What the anchored wrapper owes its own container, which `KeyboardSticky`
   * deliberately does not decide. The bottom inset arrives from the safe area
   * at the call site; this is the part that is not a number about a device.
   *
   * `2` rather than `1` is `NoteAccessory`'s: the frame's own floating chrome
   * sits at `1`, and this is drawn over it.
   */
  transportSticky: { zIndex: 2 },
  /**
   * Exactly what the slot above occupies, so removing it from the flow costs
   * nothing. The height arrives from the call site with the sticky's, so the
   * two cannot drift — they used to be `layout.floatingGap` in both places,
   * which is the wrong number on a phone with a home indicator and the right
   * one in a browser.
   */
  transportSpacer: {},
  transport: {
    height: layout.bottomBarHeight,
    borderRadius: radii.pill,
    backgroundColor: colors.chrome,
    boxShadow: shadows.floating,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: layout.bottomBarPad,
  },
  round: {
    width: layout.chromeButton,
    height: layout.chromeButton,
    borderRadius: radii.pill,
    backgroundColor: colors.chrome,
    alignItems: "center",
    justifyContent: "center",
  },
  roundOk: { backgroundColor: colors.okWash },
  roundWarn: { backgroundColor: colors.warnWash },
  roundPressed: { backgroundColor: colors.chromePressed },
  clockGroup: { flexDirection: "row", alignItems: "center", gap: 10 },
  clock: {
    fontFamily: fonts.mono,
    fontSize: 15.5,
    fontWeight: "500",
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  end: {
    height: layout.chromeButton,
    paddingHorizontal: 20,
    borderRadius: radii.pill,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
  },
  endLabel: { color: colors.ink, fontSize: 15 },
  missing: { padding: layout.readingMargin },
  quiet: { flex: 1 },
});
