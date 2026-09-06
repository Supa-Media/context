import { useCallback } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { fonts, layout, radii } from "../../design/tokens";
import { floatingStackBottom, useBottomChromeHeight } from "../../app/bottomChrome";
import { useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import { Text } from "../../design/components/Text";
import { meetings, recordElapsedMs } from "../controller";
import { meetingHref } from "../route";
import { clock } from "../format";
import { useMeetingsSnapshot, useTick } from "../useMeetings";
import { Waveform } from "./Waveform";

/**
 * The bar that says a meeting is running, wherever you are.
 *
 * ## Why it renders nothing rather than being conditionally mounted
 *
 * It answers `null` when nothing is live, so a caller mounts it once and
 * forgets about it. That is what makes it cheap to put in a layout: there is no
 * "should I show the bar" logic anywhere in the app, and no screen has to know
 * this feature exists to be correct about it.
 *
 * **And `null` on the live meeting's own screen, which is the same rule rather
 * than an exception to it.** This bar exists to reach a recording you have
 * walked away from; on the screen you have not walked away from, it is a second
 * copy of the same three controls lying over the first. They are not merely
 * near each other — the live screen's transport is `bottomBarHeight` tall at
 * `bottomBarInset`, floated at this same edge, so the two overlap almost
 * exactly, and `zIndex` cannot arbitrate between them because every
 * react-native-web `View` opens a stacking context and they are in different
 * ones (`docs/decisions/app-and-console.md`).
 *
 * ## Where it is mounted
 *
 * `app/(app)/_layout.tsx`, once, beside that layout's `Stack` — above every
 * route in the section, which is what makes it app-wide. It needs nothing
 * passed to it, because the recording lives in an external store
 * (`controller.ts`) rather than in a provider.
 *
 * Two things did have to change with it, and both were found rather than
 * assumed. The meetings navigator mounted a second copy, which is two bars over
 * each other the moment you are on a meetings screen; it does not any more. And
 * `AppFrame` floats the console's toolbar in this same 66pt of glass, so the
 * bar stacks above whatever chrome is already at that edge rather than covering
 * a screen's navigation for the length of a meeting — `floatingStackBottom`,
 * over the height the frame publishes in `features/app/bottomChrome.ts`.
 *
 * ## What it shows, and what it deliberately does not
 *
 * Elapsed time, a pause/resume control, and End. Not the title, not the
 * transcript, not a level meter — it lies over somebody else's screen and every
 * extra thing on it is a thing covering their work. The title is one tap away
 * because the bar itself navigates to the meeting.
 *
 * The clock is derived from the session's own event log rather than counted by
 * this component (`recordElapsedMs`), so a bar mounted thirty minutes into a
 * meeting reads thirty minutes. `useTick` exists only to cause a re-render.
 *
 * ## Layout
 *
 * The floating-chrome geometry the rest of the phone layout already uses:
 * `bottomBarHeight` tall, inset by `bottomBarInset` on each side so the screen
 * shows either side of it, `floatingGap` from the bottom edge — or the home
 * indicator's own inset where that is larger, which is `floatingGapFor`'s
 * `max`. It sits *above* the safe-area inset rather than inside it, because a
 * control under the home indicator is a control a swipe takes instead of a tap.
 */
export function RecordingBar({ bottomInset = 0 }: { bottomInset?: number }) {
  const snapshot = useMeetingsSnapshot();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const pathname = usePathname();
  const live = snapshot.live;
  const now = useTick(live !== null);
  // Whatever the screen underneath is already floating at this edge, so the two
  // stack instead of overlapping. Zero on every screen that has no chrome there.
  const chrome = useBottomChromeHeight();

  const open = useCallback(() => {
    if (live === null) return;
    router.push(meetingHref(live.session.id));
  }, [router, live]);

  /**
   * End the recording, and land on the meeting that just ended.
   *
   * `controller.end` touches no router — the controller owns no navigation, by
   * `controller.ts`'s own rule — and for a while nothing else did either, so
   * this press left somebody standing on whatever screen they were reading
   * while their meeting was filed into a list a phone had no route into. That
   * is the report this fixed: "the note sort of just disappeared… I don't know
   * if it succeeded, if it failed. Just nothing at all."
   *
   * Taking them there is stronger than any list entry, because the meeting
   * screen is what answers the question they are actually asking:
   * `MeetingNoteScreen` says whether the note reached the bucket, and on this
   * build — where the gateway credential is deliberately unwired — the honest
   * answer is that it has not.
   *
   * **After the end resolves, not before.** `/meetings/:id` chooses its screen
   * off the session's state, so navigating first would show the live screen for
   * a frame on the way to the note.
   *
   * **And not at all when this is already the screen underneath.** The bar is
   * mounted above every route including that one, and pushing there would put a
   * second copy of the meeting on the stack for somebody who is looking at it.
   *
   * **A failed end still lands them on the meeting.** This used to be
   * `void (async () => { await meetings.end(); … })()`, which turns a rejecting
   * `end()` into an unhandled rejection: the bar stays up, nothing on screen
   * changes, and the person is left in the state this whole seam exists to
   * close — *"I don't know if it succeeded, if it failed. Just nothing at
   * all."* The navigation is the signal, and it is deliberately not a toast:
   * the meeting screen is what says what state the meeting is in, and a
   * recording whose end failed is exactly the one somebody needs to read that
   * about and copy their notes out of.
   */
  const end = useCallback(() => {
    if (live === null) return;
    const href = meetingHref(live.session.id);
    void (async () => {
      try {
        await meetings.end();
      } catch {
        // See above: the meeting screen is where this is reported, because it
        // is the screen that can say what is actually on the device.
      }
      if (pathname !== href) router.push(href);
    })();
  }, [live, pathname, router]);

  if (live === null) return null;
  // The screen underneath is this meeting's own, and it has a transport of its
  // own in this exact 66pt of glass. See the header.
  if (pathname === meetingHref(live.session.id)) return null;

  const paused = live.session.state === "paused";
  const elapsed = clock(recordElapsedMs(live, now === 0 ? Date.now() : now));

  return (
    <View
      style={[styles.slot, { bottom: floatingStackBottom(bottomInset, chrome) }]}
      // The bar floats over whatever is behind it, so the region has to be
      // announced as one thing rather than as three loose controls on top of
      // somebody else's screen.
      accessibilityRole="toolbar"
      accessibilityLabel="Recording"
      testID="recording-bar"
    >
      <View style={styles.bar}>
        <Pressable
          onPress={paused ? () => meetings.resume() : () => meetings.pause()}
          accessibilityRole="button"
          accessibilityLabel={paused ? "Resume recording" : "Pause recording"}
          style={({ pressed }) => [styles.round, paused && styles.roundPaused, pressed && styles.pressed]}
          testID="recording-bar-pause"
        >
          {paused ? <Play /> : <PauseBars />}
        </Pressable>

        <Pressable
          onPress={open}
          accessibilityRole="button"
          accessibilityLabel={`${live.session.title}, ${elapsed} recorded. Open the meeting.`}
          style={styles.middle}
          testID="recording-bar-open"
        >
          <Waveform tone={paused ? "muted" : "ok"} paused={paused} />
          <Text style={styles.clock}>{elapsed}</Text>
        </Pressable>

        <Pressable
          onPress={end}
          accessibilityRole="button"
          accessibilityLabel="End the recording"
          style={({ pressed }) => [styles.end, pressed && styles.pressed]}
          testID="recording-bar-end"
        >
          <Text variant="mini" style={styles.endLabel}>
            End
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Two bars. The universal pause mark, drawn rather than typed — see `Waveform`. */
function PauseBars() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.glyphRow} aria-hidden>
      <View style={styles.pauseBar} />
      <View style={styles.pauseBar} />
    </View>
  );
}

/**
 * A triangle, from a border trick.
 *
 * React Native has no polygon primitive and this app draws its marks from
 * `View`s rather than pulling in a vector for one shape (`Icon.tsx` makes the
 * whole argument). A right-pointing triangle is a zero-width box with a left
 * border and transparent top and bottom.
 */
function Play() {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.play} aria-hidden />;
}

const makeStyles = (colors: Colors, shadows: Shadows) => StyleSheet.create({
  slot: {
    position: "absolute",
    left: layout.bottomBarInset,
    right: layout.bottomBarInset,
    // The bar lies over the screen it is on. `zIndex` is only ever an ordering
    // *among siblings* in react-native-web — every `View` opens a stacking
    // context — so this number does nothing on its own, and the bar is
    // correct because it is mounted last in whatever layout holds it. See
    // `docs/decisions/app-and-console.md`, "Every react-native-web `View` is a
    // stacking context".
    zIndex: 1,
  },
  bar: {
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
    backgroundColor: colors.okWash,
    alignItems: "center",
    justifyContent: "center",
  },
  roundPaused: { backgroundColor: colors.warnWash },
  pressed: { backgroundColor: colors.chromePressed },
  middle: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    height: layout.chromeButton,
  },
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
  glyphRow: { flexDirection: "row", gap: 3 },
  pauseBar: { width: 4, height: 16, borderRadius: 1.2, backgroundColor: colors.okText },
  play: {
    width: 0,
    height: 0,
    marginLeft: 3,
    borderTopWidth: 7,
    borderBottomWidth: 7,
    borderLeftWidth: 12,
    borderTopColor: "transparent",
    borderBottomColor: "transparent",
    borderLeftColor: colors.warnText,
  },
});
