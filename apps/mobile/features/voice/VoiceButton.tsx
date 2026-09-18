import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { floatingStackBottom, useBottomChromeHeight } from "../app/bottomChrome";
import { Button, PressRow } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { fonts, layout, pointerType as t, radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../design/theme";
import type { EditorControls } from "../console/files/LiveEditor";
import { offerDictation, reasonFor, type DictationOffer } from "./audience";
import type { Visibility } from "../console/files/types";
import { isLive } from "./dictation";
import type { DestinationContext } from "../meetings/destination";
import { useMeetingsSnapshot } from "../meetings/useMeetings";
import { useDictation } from "./useDictation";
import { VoiceSheet } from "./VoiceSheet";
import { AgentPanel } from "../agent/AgentPanel";
import { createStubEngine, type AgentEngine } from "../agent/engine";
import type { AgentPage } from "../agent/page";
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
 * ## And it is not drawn at all where something else already carries one
 *
 * The rule above was applied to a running meeting and to nothing else, so a
 * phone with a note open drew this button 24pt above the seventh key of the
 * bottom row — the same `mic` glyph twice on a 390pt screen, raising two
 * different sheets. *"Why are there 2 microphones?"*
 *
 * The seventh key is the one that stays, and that was not decided here:
 * `docs/decisions/meetings.md` makes it the phone's only way into meeting
 * capture, and the only route to a *finished* meeting hangs off the sheet it
 * raises — a route that exists because somebody recorded a meeting on their
 * phone and could not find it afterwards. So `barMicrophone` stands this
 * control down while that key is on the glass, which leaves dictation offered
 * at exactly the moment it has somewhere to type: the keyboard accessory bar
 * takes the toolbar away (`AppFrame`'s `toolbarHidden`), and the microphone
 * comes back with the caret. `NoteEditor` owns the condition; see
 * `oneMicrophone.test.ts` for both states driven through the real editor.
 *
 * **What never stands down is a microphone that is already open.** The live
 * capsule is the only way to stop a run and the only way to take back what it
 * typed, and the failure card is a sentence about a microphone that was opened
 * rather than an offer to open one. Both are drawn whatever the bar is doing.
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
  /**
   * What the open note's own entry says about who can read it.
   *
   * The sheet's sentence is about the note, and the workspace's `kind` cannot
   * answer it: a personal workspace takes members, so a `team` note in one is
   * read by every one of them. Absent is not private — see `audience.ts`.
   */
  noteVisibility?: Visibility | undefined;
}

export function VoiceButton({
  page,
  controls,
  compact,
  onRecordMeeting,
  barMicrophone = false,
  bottomInset = 0,
  place,
  engine,
  agent,
  now = Date.now,
}: {
  page: VoicePage;
  /** The live editor, read at the moment a phrase arrives. See `useDictation`. */
  controls: () => EditorControls | null;
  compact: boolean;
  /** Hands off to `useMeetingFlow`, which owns the meeting's own consent sheet. */
  onRecordMeeting: () => void;
  /**
   * Whether another control on this glass already opens the microphone.
   *
   * True on a phone whenever the frame's bottom toolbar is showing, because its
   * seventh key is that control. False by default, which is the right answer
   * for every pointer density — there is no bottom bar at any of them
   * (`regionsFor`) — and for the fixtures, which mount this pane with no frame
   * around it at all.
   */
  barMicrophone?: boolean;
  /**
   * Where the person is, for the conversation.
   *
   * `null` on a surface that has no context around it — the fixtures and the
   * landing page's demo console — and the sheet then draws no agent row at
   * all, rather than one that answers a press with nothing.
   */
  place?: AgentPage | null;
  /**
   * The safe area under this edge, as `RecordingBar` takes it and for the same
   * reason: `useSafeAreaInsets` throws outside a `SafeAreaProvider`, and this
   * component is mounted by `NoteEditor`, which several surfaces render without
   * one. Zero is right for every browser.
   */
  bottomInset?: number;
  /** Injected by tests. */
  engine?: DictationEngine;
  /** Injected by tests. The stub until a provider can be stored. */
  agent?: AgentEngine;
  now?: () => number;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  /*
    Stacked above whatever is already floating at this edge, exactly as
    `RecordingBar` is and through the same two functions. A phone's console
    floats its toolbar in 66pt of glass here; a fixed `bottom: 24` puts this
    over it, and a floating control over somebody else's control is a control
    that eats their presses. `AppFrame` publishes the height, this reads it.
  */
  const bottom = floatingStackBottom(bottomInset, useBottomChromeHeight());
  const [asking, setAsking] = useState(false);
  const [talking, setTalking] = useState(false);
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
    noteVisibility: page.noteVisibility,
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

  const beginAgent = useCallback(() => {
    setAsking(false);
    setTalking(true);
  }, []);

  const endAgent = useCallback(() => setTalking(false), []);

  /*
    The stub is built once per mount rather than per render: `AgentPanel`
    depends on the engine identity in the `useCallback` that sends, and a fresh
    object every render would rebuild that callback on every keystroke.
  */
  const agentEngine = useMemo(() => agent ?? createStubEngine(), [agent]);

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
    /*
      The conversation goes too — and not because it would otherwise stay on
      screen. This control renders `null` for the length of a meeting, so the
      panel is gone either way; that was the first version of this comment and
      the sabotage run disproved it, because removing this line broke nothing.

      What it actually prevents is the panel coming *back*. The flag would
      still be set when the meeting finishes and the corner returns, reopening
      a conversation somebody left twenty minutes ago over whatever they are
      now looking at. `agentSurface.test.ts` drives both ends of that.
    */
    setTalking(false);
    cancel();
  }, [meetingRunning, cancel]);

  // Every hook above this line, so the yield cannot change their order.
  if (meetingRunning) return null;

  if (live) {
    return (
      <View style={[styles.dock, { bottom }]} pointerEvents="box-none">
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

  /*
    The bottom row's seventh key is the microphone on this screen, so this one
    is not drawn — and with nothing left to say, neither is the dock it floats
    in. `failed` is the exception and is the reason this is not a bare yield at
    the top: a sentence about a microphone that was already opened is owed to
    whoever opened it, wherever the toolbar happens to be.

    An open sheet holds it on screen too. Raising a `Modal` can take the caret
    out of the editor, which puts the toolbar back — and a sheet that vanished
    under the thumb that opened it would be this button answering a press by
    disappearing.
  */
  if (barMicrophone && !asking && !talking && state.name !== "failed") return null;

  return (
    <View style={[styles.dock, { bottom }]} pointerEvents="box-none">
      {state.name === "failed" ? (
        <View style={styles.failure} testID="voice-failure">
          <Text variant="rowSub" style={styles.failureText}>
            {reasonFor(state.reason, dictation.unavailable)}
          </Text>
        </View>
      ) : null}

      {barMicrophone ? null : (
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
      )}

      {asking ? (
        <VoiceSheet
          audience={offer.audience}
          refusal={offer.refusal}
          notePath={page.notePath}
          compact={compact}
          onDictate={beginDictation}
          onRecordMeeting={beginMeeting}
          onAskAgent={place == null ? null : beginAgent}
          onCancel={dismiss}
        />
      ) : null}

      {talking && place != null ? (
        <AgentPanel
          engine={agentEngine}
          place={place}
          compact={compact}
          onClose={endAgent}
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
