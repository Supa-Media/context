import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { floatingStackBottom, useBottomChromeHeight } from "../app/bottomChrome";
import { Button, PressRow } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { TOAST_MS } from "../design/components/Toast";
import { ACCESSORY_HEIGHT } from "../console/files/accessory";
import { measureCornerControl } from "../app/cornerControl";
import { fonts, layout, pointerType as t, radii, space } from "../design/tokens";
import { useColors, useThemedStyles, type Colors, type Shadows } from "../design/theme";
import type { EditorControls } from "../console/files/LiveEditor";
import { offerDictation, reasonFor, type DictationOffer } from "./audience";
import type { Visibility } from "../console/files/types";
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
 * ## And it is not drawn at all where something else already carries one
 *
 * The rule above was applied to a running meeting and to nothing else, so a
 * phone with a note open drew this button 24pt above the seventh key of the
 * bottom row — the same `mic` glyph twice on a 390pt screen, raising two
 * different sheets. *"Why are there 2 microphones?"*
 *
 * **And the same is now true of the console**, for a different control: the
 * corner holds a `+` rather than a microphone, so this draws none at rest at
 * any pointer density either. Dictation is reached from the note's own context
 * menu — see `microphoneElsewhere`.
 *
 * The phone's bottom row is the same rule with the same shape. The key that
 * stood this control down used to be a microphone of its own, which
 * `docs/decisions/meetings.md` made the phone's only way into meeting capture —
 * a route that exists because somebody recorded a meeting on their phone and
 * could not find it afterwards. That key is gone (*"we no longer need a
 * dedicated mic button on the bottom row, just a plus button that opens
 * different options"*) and the route is not: recording is a row in the sheet the
 * row's `+` raises, and the finished meeting still hangs off it. So
 * `microphoneElsewhere` stands this control down while that row is on the glass
 * — one control in the corner, whichever surface owns it — which leaves
 * dictation offered at exactly the moment it has somewhere to type: the keyboard
 * accessory bar takes the toolbar away (`AppFrame`'s `toolbarHidden`), and the
 * microphone comes back with the caret. `NoteEditor` owns the condition; see
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
  microphoneElsewhere = false,
  bottomInset = 0,
  aboveAccessory = false,
  engine,
  startDictation = null,
  now = Date.now,
}: {
  page: VoicePage;
  /** The live editor, read at the moment a phrase arrives. See `useDictation`. */
  controls: () => EditorControls | null;
  /**
   * A request for the microphone from somewhere other than this button.
   *
   * The note's right-click menu is the caller. A counter rather than a
   * boolean, because asking twice is ordinary and a flag looks unchanged the
   * second time; `null` is "nobody has asked", which is every other surface.
   */
  startDictation?: number | null;
  compact: boolean;
  /** Hands off to `useMeetingFlow`, which owns the meeting's own consent sheet. */
  onRecordMeeting: () => void;
  /**
   * Whether this corner belongs to something else, so no microphone is drawn
   * at rest.
   *
   * Two surfaces set it, for the same reason and not for the same control:
   *
     *  - **A phone**, whenever the frame's bottom toolbar is showing, because that
   *    row's `+` is the control in this corner. It was a microphone once — its
   *    seventh key — and two mic glyphs 24pt apart is the defect
   *    `oneMicrophone.test.ts` exists for; the key has since gone and the
   *    condition has not, because what it protects is the corner rather than the
   *    glyph.
   *  - **The console at every pointer density**, because the corner is the `+`
   *    now (`features/console/CreateButton.tsx`) and there is one corner. The
   *    microphone did not lose its door in the trade: "Dictate here" is on the
   *    note's own context menu, where the caret is, and `startDictation` is how
   *    it reaches this component.
   *
   * It was called `barMicrophone` while the phone's bar was the only caller.
   * The name is the *condition* now rather than the control, because a second
   * caller with a different control is exactly what proved the old name was
   * describing the wrong half.
   *
   * False by default, which is right for the fixtures — they mount this pane
   * with no frame and no `+` around it at all.
   */
  microphoneElsewhere?: boolean;
  /**
   * The safe area under this edge, as `RecordingBar` takes it and for the same
   * reason: `useSafeAreaInsets` throws outside a `SafeAreaProvider`, and this
   * component is mounted by `NoteEditor`, which several surfaces render without
   * one. Zero is right for every browser.
   */
  bottomInset?: number;
  /**
   * The phone's keyboard accessory bar is on the glass in this corner.
   *
   * It hides the frame's toolbar, so `useBottomChromeHeight` reads 0 while a
   * 44pt row sits exactly where the dock is anchored — and the capsule and the
   * failure card were drawn under it. `NoteEditor` knows when it is up
   * (`barUp`) and says so; the dock then stands on top of it.
   */
  aboveAccessory?: boolean;
  /** Injected by tests. */
  engine?: DictationEngine;
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
  const stacked = floatingStackBottom(bottomInset, useBottomChromeHeight());
  // On the bar: its own edges, so the capsule's right edge is the Done key's
  // and it stands the dock's gap above the row rather than the frame's.
  const bottom = aboveAccessory ? ACCESSORY_HEIGHT + DOCK_GAP : stacked;
  const onBar = aboveAccessory ? { right: layout.floatingInset } : null;
  const [asking, setAsking] = useState(false);
  const dictation = useDictation({ controls, notePath: page.notePath, engine });
  const { state, start, stop, discard, cancel, dismiss: dismissFailure } = dictation;
  const live = isLive(state);
  const failed = state.name === "failed";
  /*
    The failure card goes away on its own, on the toast's clock.

    It used to stay until the next dictation, and on the console nothing in
    this corner starts one — the microphone is on the note's context menu — so
    a refusal read once sat over the corner for the rest of the session.
    Hovering holds it, the toast's rule: "I am still reading this" is honoured.
    A press puts it away at once.
  */
  const [failureHeld, setFailureHeld] = useState(false);
  useEffect(() => {
    // A card that went away under the pointer never hears `onHoverOut`.
    if (!failed) {
      setFailureHeld(false);
      return;
    }
    if (failureHeld) return;
    const timer = setTimeout(dismissFailure, TOAST_MS);
    return () => clearTimeout(timer);
  }, [failed, failureHeld, dismissFailure]);

  /*
    Where the dock goes so its right edge is the `+`'s and its card stands
    `DOCK_GAP` above it. Measured from an invisible fill of the region this
    dock is positioned in, against the `+` itself; re-measured when a card
    appears and whenever the region resizes.
  */
  const regionProbe = useRef<View>(null);
  const [besidePlus, setBesidePlus] = useState<{ right: number; bottom: number } | null>(null);
  const placeBesidePlus = useCallback(() => {
    measureCornerControl((plus) => {
      regionProbe.current?.measureInWindow((x, y, width, height) => {
        if (width === 0 || height === 0) return;
        setBesidePlus({
          right: Math.round(x + width - (plus.x + plus.width)),
          bottom: Math.round(y + height - plus.y + DOCK_GAP),
        });
      });
    });
  }, []);
  useEffect(() => {
    if (failed && microphoneElsewhere && !compact) placeBesidePlus();
  }, [failed, microphoneElsewhere, compact, placeBesidePlus]);
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

  /**
   * Dictation started from somewhere other than this control.
   *
   * The note's right-click menu is the caller: somebody pointed at a line and
   * asked for the microphone there, and the sheet this button raises would be
   * a second question after they had already answered it.
   *
   * A counter rather than a boolean, for `AsidePanel`'s reason: asking for the
   * microphone twice is an ordinary thing to do, and a flag looks unchanged
   * the second time. `start` is read through a ref so the effect depends on
   * the *event* and not on a callback that changes with the engine.
   */
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    if (startDictation === null) return;
    startRef.current();
  }, [startDictation]);

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
      <View style={[styles.dock, { bottom }, onBar]} pointerEvents="box-none">
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
            variant="accent"
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
  if (microphoneElsewhere && !asking && state.name !== "failed") return null;

  /*
    The console's `+` floats in this corner at this same height, so a failure
    card drawn at the dock's bottom lay under it — the `+` covering the end of
    the sentence. With no microphone of ours at rest the dock lifts by the
    `+`'s height and the dock's own gap, so the card sits above it exactly
    where it would sit above our own button. The phone's `+` is in the bottom
    row, which `floatingStackBottom` already clears.
  */
  const clearsCorner = microphoneElsewhere && !compact;
  const dockBottom = clearsCorner ? bottom + FAB_SIZE + DOCK_GAP : bottom;
  /*
    The arithmetic above is right only if both docks measure from the same
    edges, and on the console they do not: the `+` is the frame's, this is the
    note pane's, which sits inside a padded region. So while a card is up
    beside the `+`, the dock is placed from where the `+` actually is —
    measured, see `cornerControl.ts` — and the arithmetic is the fallback for
    a host that never answers.
  */
  const placed = besidePlus !== null && clearsCorner && failed ? besidePlus : null;

  return (
    <>
      <View ref={regionProbe} style={StyleSheet.absoluteFill} pointerEvents="none" onLayout={placeBesidePlus} />
      <View
        style={[
          styles.dock,
          placed === null ? { bottom: dockBottom } : { bottom: placed.bottom, right: placed.right },
          onBar,
        ]}
        pointerEvents="box-none"
      >
        {state.name === "failed" ? (
          <Pressable
            onPress={dismissFailure}
            onHoverIn={() => setFailureHeld(true)}
            onHoverOut={() => setFailureHeld(false)}
            accessibilityRole="alert"
            accessibilityHint="Press to dismiss"
            style={styles.failure}
            testID="voice-failure"
          >
            <View style={styles.failureWash} pointerEvents="none" />
            <Text variant="rowSub" style={styles.failureText}>
              {reasonFor(state.reason, dictation.unavailable, compact)}
            </Text>
          </Pressable>
        ) : null}

        {microphoneElsewhere ? null : (
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
            onCancel={dismiss}
          />
        ) : null}
      </View>
    </>
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

/** The floating button's diameter, ours and the console's `+` alike. */
const FAB_SIZE = 56;
/** Space between the dock's children, and so between a card and a button. */
const DOCK_GAP = 10;

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
      gap: DOCK_GAP,
      /*
        Above the note it floats over. Every react-native-web View is its own
        `z-index: 0` stacking context, and the editor's lines come later in
        the tree, so with no index of its own the card's sentence had the
        note's text printed through it. 5 is the console `+`'s dock, the
        other floating control in this corner.
      */
      zIndex: 5,
    },
    fab: {
      width: FAB_SIZE,
      height: FAB_SIZE,
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
    /*
      An opaque card with the wash laid over it, not the wash alone. The wash
      is 8% ink, so on its own the note it floats over printed straight
      through the sentence — invisible while the card sat low in an empty
      corner, plain once it lifted above the `+` and over a paragraph.
    */
    failure: {
      // The toast's measure, so the two crit notices in this app read alike.
      maxWidth: 340,
      paddingVertical: space.x3,
      paddingHorizontal: space.x4,
      borderRadius: radii.card,
      overflow: "hidden",
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.critBorder,
      boxShadow: shadows.floating,
    },
    failureWash: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.critWash },
    failureText: { color: colors.critText },
  });
