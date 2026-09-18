import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Button, PressRow } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { fonts, layout, pointerType as t, radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../design/theme";
import type { EditorControls } from "../console/files/LiveEditor";
import { offerDictation, reasonFor, type DictationOffer } from "./audience";
import { isLive } from "./dictation";
import type { DestinationContext } from "../meetings/destination";
import { useMeetingsSnapshot } from "../meetings/useMeetings";
import { useDictation } from "./useDictation";
import { VoiceSheet } from "./VoiceSheet";
import type { DictationEngine } from "./engine";

/**
 * The floating microphone, and everything it turns into.
 *
 * One control with three faces, because there is only ever one thing to say:
 *
 *  - **at rest**, a microphone you press to be asked a question;
 *  - **live**, a capsule carrying the elapsed clock, Stop and Discard;
 *  - **after a failure**, a card saying what happened and what was left alone.
 *
 * ## Why it is one control and not a toolbar
 *
 * `RecordingBar` makes the same argument for meetings and it is the reason this
 * component answers `null` while one is running: the bar "exists to reach a
 * recording you have walked away from", it is `bottomBarHeight` tall at the
 * same floated edge, and two controls in that corner are two copies of the same
 * three buttons lying over each other. There is one microphone on this machine;
 * there is one control for it.
 *
 * ## No level meter, on purpose
 *
 * The mock draws bars. This does not, and the reason is the one
 * `capture/level.ts` gives for a browser: nothing here can answer "how loud is
 * it". `SpeechRecognition` exposes no audio, and the only way to a meter would
 * be opening a *second* `getUserMedia` stream beside the engine's — a second
 * pipeline and a second thing to leak, for decoration. A bar drawn without a
 * level is the flat silhouette that "reads as a dead microphone", which is
 * worse than not drawing one. A pulsing dot and a clock are what this surface
 * can honestly claim.
 */

export interface VoicePage {
  /** The context the open note lives in, or `null`. */
  context: DestinationContext | null;
  /** The open note's bucket path, or `null` when a folder is on screen. */
  notePath: string | null;
  /** False for `privacy.md`, an encrypted envelope, or a reader's membership. */
  writable: boolean;
}

export function VoiceButton({
  page,
  controls,
  compact,
  onRecordMeeting,
  engine,
  now = Date.now,
}: {
  page: VoicePage;
  /** The live editor, read at the moment a phrase arrives. See `useDictation`. */
  controls: () => EditorControls | null;
  compact: boolean;
  /** Hands off to `useMeetingFlow`, which owns the meeting's own consent sheet. */
  onRecordMeeting: () => void;
  /** Injected by tests. */
  engine?: DictationEngine;
  now?: () => number;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [asking, setAsking] = useState(false);
  const dictation = useDictation({ controls, notePath: page.notePath, engine });
  const { state, start, stop, discard, cancel } = dictation;
  const live = isLive(state);
  /*
    A meeting is running, so this corner is not ours.

    `RecordingBar` is mounted above every route, floats at this same edge and
    already argues the case against two of these: on its own screen it renders
    `null` because a second copy of the same three controls would lie over the
    first, and `zIndex` cannot arbitrate between two react-native-web stacking
    contexts. The same is true here — and underneath the drawing rule there is a
    physical one, which is that there is a single microphone on this machine and
    the meeting has it.

    Read here rather than passed in, so no caller can forget it.
  */
  const meeting = useMeetingsSnapshot().live;

  const offer: DictationOffer = offerDictation({
    context: page.context,
    path: page.notePath ?? "",
    noteOpen: page.notePath !== null,
    writable: page.writable,
    engineAvailable: dictation.available,
    unavailable: dictation.unavailable,
  });

  const startedAt = useRef<number | null>(null);
  if (live && startedAt.current === null) startedAt.current = now();
  if (!live && startedAt.current !== null) startedAt.current = null;
  const elapsed = useElapsed(live, startedAt.current, now);

  const ask = useCallback(() => setAsking(true), []);
  const dismiss = useCallback(() => setAsking(false), []);

  const beginDictation = useCallback(() => {
    setAsking(false);
    start();
  }, [start]);

  const beginMeeting = useCallback(() => {
    setAsking(false);
    onRecordMeeting();
  }, [onRecordMeeting]);

  /*
    A meeting started while this was open or listening. `cancel`, for the reason
    `useDictation` gives at the note-change effect: the pending phrase belongs
    to a microphone that is now the meeting's and cannot be settled, but the
    sentences already in the note were said on purpose and starting a meeting is
    not a request to delete them.
  */
  const meetingRunning = meeting !== null;
  useEffect(() => {
    if (!meetingRunning) return;
    setAsking(false);
    cancel();
  }, [meetingRunning, cancel]);

  // Every hook above this line, so the yield cannot change their order.
  if (meetingRunning) return null;

  if (live) {
    return (
      <View style={styles.dock} pointerEvents="box-none">
        <View style={styles.capsule} testID="voice-capsule">
          <View style={styles.liveMark}>
            <View style={styles.liveDot} />
          </View>
          <Text variant="mini" style={styles.liveLabel}>
            {state.name === "stopping" ? "Finishing" : "Dictating"}
          </Text>
          <Text variant="mono" style={styles.clock} testID="voice-elapsed">
            {clock(elapsed)}
          </Text>
          <Button
            label="Stop"
            variant="white"
            onPress={stop}
            accessibilityLabel="Stop dictating and keep what was said"
            testID="voice-stop"
          />
          <PressRow
            onPress={discard}
            accessibilityLabel="Discard what was dictated"
            testID="voice-discard"
            radius={radii.pill}
            style={styles.discard}
            hoverStyle={{ backgroundColor: colors.chrome }}
          >
            <Icon name="close" size={14} />
          </PressRow>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.dock} pointerEvents="box-none">
      {state.name === "failed" ? (
        <View style={styles.failure} testID="voice-failure">
          <Text variant="rowSub" style={styles.failureText}>
            {reasonFor(state.reason, dictation.unavailable)}
          </Text>
        </View>
      ) : null}

      <Pressable
        onPress={ask}
        role="button"
        accessibilityLabel="Voice capture"
        aria-haspopup="menu"
        aria-expanded={asking}
        testID="voice-button"
        style={({ pressed }) => [styles.fab, (pressed || asking) && styles.fabActive]}
      >
        <Icon name="mic" size={23} color={asking ? colors.ink : colors.accent} />
      </Pressable>

      {asking ? (
        <VoiceSheet
          audience={offer.audience}
          refusal={offer.refusal}
          notePath={page.notePath}
          compact={compact}
          onDictate={beginDictation}
          onRecordMeeting={beginMeeting}
          onCancel={dismiss}
        />
      ) : null}
    </View>
  );
}

/** `0:41`, and `1:02:03` once a dictation has run past the hour. */
export function clock(ms: number): string {
  const whole = Math.max(0, Math.floor(ms / 1000));
  const seconds = String(whole % 60).padStart(2, "0");
  const minutes = Math.floor(whole / 60) % 60;
  const hours = Math.floor(whole / 3600);
  if (hours === 0) return `${minutes}:${seconds}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
}

/**
 * Milliseconds since dictation started, re-read once a second.
 *
 * Derived from a start time rather than counted up, so a tab that was
 * backgrounded — where `setInterval` is throttled to once a minute — reads the
 * true elapsed time on its first tick back rather than however many ticks it
 * was allowed.
 */
function useElapsed(live: boolean, startedAt: number | null, now: () => number): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const handle = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(handle);
  }, [live]);
  return startedAt === null ? 0 : now() - startedAt;
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    /*
      Anchored to the region rather than to the document, exactly as
      `NoteAccessory` is and for the same reason: inside a scroller's content
      it would anchor to the bottom of the *note* and scroll away with it.
    */
    dock: {
      position: "absolute",
      right: 24,
      bottom: 24,
      alignItems: "flex-end",
      gap: 10,
    },
    fab: {
      width: 56,
      height: 56,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surface3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hintBorder,
      boxShadow: shadows.floating,
    },
    fabActive: { backgroundColor: colors.accent, borderColor: colors.accent },
    capsule: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingLeft: 15,
      paddingRight: 8,
      paddingVertical: 8,
      minHeight: layout.minTouchTarget,
      borderRadius: radii.pill,
      backgroundColor: colors.surface3,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hintBorder,
      boxShadow: shadows.floating,
    },
    liveMark: {
      width: 16,
      height: 16,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.accentDim,
    },
    liveDot: { width: 8, height: 8, borderRadius: radii.pill, backgroundColor: colors.accent },
    liveLabel: { color: colors.accentText, fontWeight: "600" },
    clock: { color: colors.text2, fontFamily: fonts.mono, fontSize: t.ui },
    discard: {
      width: 32,
      height: 32,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
    },
    failure: {
      maxWidth: 320,
      padding: 12,
      borderRadius: radii.card,
      backgroundColor: colors.critWash,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.critBorder,
      boxShadow: shadows.floating,
    },
    failureText: { color: colors.critText },
  });
