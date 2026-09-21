import { useCallback } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { layout, pointerType as t, radii, space } from "../../design/tokens";
import { floatingStackBottom, useBottomChromeHeight } from "../../app/bottomChrome";
import { useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { meetings } from "../controller";
import { meetingLanding, strandedMeetings } from "../landing";
import { meetingHref } from "../route";
import { useMeetingsSnapshot } from "../useMeetings";

/**
 * A MEETING THAT DID NOT MAKE IT, SAID WHERE SOMEBODY IS ACTUALLY LOOKING.
 *
 * ## The gap this closes
 *
 * A meeting that fails to reach the bucket was, until this, visible in exactly
 * two places: its own page at `/meetings/:id`, and the console's Meetings
 * panel. Both require having gone looking. Nothing in the app said a word
 * anywhere else — not the recording bar (`live === null` for a failed meeting,
 * so it renders `null`), not the aside tab's dot (`meetingNeedsAttention` in
 * `aside/tabs.ts` reads `meetingLive` only), not the console's title pill, not
 * a notification: `expo-notifications` is in the binary and nothing in this app
 * imports it.
 *
 * So the owner recorded 31 minutes, the finalize got stuck, the app said
 * nothing at all, and they found out days later by opening the meeting. Their
 * instruction was *"it should be very LOUD and dramatic if something went
 * wrong"*. This is that, at the one edge of the screen this app already uses to
 * interrupt somebody.
 *
 * ## Why a bar and not a toast
 *
 * `Toast` exists and is wrong for this. A toast is eight seconds long, which is
 * tuned for an undo somebody is already looking at; a meeting that did not save
 * is still not saved eight seconds later, and a notice that removes itself is a
 * notice that can be missed by being in another room. **This has no dismiss.**
 * It is up while the meeting is stranded and it goes when the meeting is filed
 * or discarded — which are the two things that make it untrue.
 *
 * ## Why it stands down for a live recording
 *
 * `RecordingBar` occupies this exact slot — same inset, same height, same
 * floated edge — and `zIndex` cannot arbitrate between them, because every
 * react-native-web `View` opens a stacking context and they are in different
 * ones (`docs/decisions/app-and-console.md`). Two bars in one place is the
 * defect `RecordingBar`'s own header is mostly about.
 *
 * It is also the right call on its own terms. Somebody recording *now* is the
 * one person who must not be pulled away from it, and a meeting that failed an
 * hour ago will still have failed when they stop. The bar comes up the moment
 * the recording ends.
 *
 * ## What it offers, and why Retry is on the bar itself
 *
 * One press, in place. The whole failure this exists for is a person who did
 * not know there was anything to press; putting the press three screens away
 * behind a notice would be the same bug with a sentence in front of it. Tapping
 * the body opens the meeting, which is where the reason, the transcript and
 * Copy note are.
 */
export function StrandedBar({ bottomInset = 0 }: { bottomInset?: number }) {
  const styles = useThemedStyles(makeStyles);
  const snapshot = useMeetingsSnapshot();
  const chrome = useBottomChromeHeight();
  const router = useRouter();
  const pathname = usePathname();

  const stranded = strandedMeetings(snapshot.records);
  /*
    The first one, and a count for the rest. A bar wide enough for one meeting
    that lists three is a bar that names none of them legibly — and the count
    is what stops "Jhon / Seyi didn't save" from reading as though it is the
    only thing wrong.
  */
  const first = stranded[0] ?? null;
  const id = first?.session.id ?? null;
  const landing = first === null ? null : meetingLanding(first);

  const open = useCallback(() => {
    if (id === null) return;
    router.push(meetingHref(id));
  }, [id, router]);

  const retry = useCallback(() => {
    if (id === null || landing?.retry == null) return;
    if (landing.retry === "finalize") void meetings.retryFinalize(id);
    else void meetings.retry(id);
  }, [id, landing?.retry]);

  if (first === null || landing === null) return null;
  // A recording owns this slot. See the header — both for the geometry and for
  // the reason it is right anyway.
  if (snapshot.live !== null) return null;
  // The meeting's own screen says all of this, with room to say it properly.
  if (pathname === meetingHref(first.session.id)) return null;

  const others = stranded.length - 1;
  const label =
    `${first.session.title} was not saved to your context. ${landing.title}` +
    (others > 0 ? ` And ${others} more like it.` : "");

  return (
    <View
      style={[styles.slot, { bottom: floatingStackBottom(bottomInset, chrome) }]}
      accessibilityRole="alert"
      accessibilityLabel={label}
      testID="stranded-bar"
    >
      <View style={styles.bar}>
        <View style={styles.mark}>
          <Icon name="close" size={15} color={styles.markGlyph.color} />
        </View>

        <Pressable
          onPress={open}
          accessibilityRole="button"
          accessibilityLabel={`${label} Open the meeting.`}
          style={styles.middle}
          testID="stranded-bar-open"
        >
          <Text variant="mini" style={styles.title} numberOfLines={1}>
            {others > 0 ? `${first.session.title} +${others}` : first.session.title}
          </Text>
          <Text variant="foot" style={styles.reason} numberOfLines={1}>
            Not saved to your context
          </Text>
        </Pressable>

        <Pressable
          onPress={retry}
          accessibilityRole="button"
          accessibilityLabel={`Try saving ${first.session.title} again`}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          testID="stranded-bar-retry"
        >
          <Text variant="mini" style={styles.actionLabel}>
            Retry
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors, shadows: Shadows) =>
  StyleSheet.create({
    slot: {
      position: "absolute",
      left: layout.bottomBarInset,
      right: layout.bottomBarInset,
      // Ordering among siblings only — see `RecordingBar`'s note and the
      // stacking-context section of `docs/decisions/app-and-console.md`. This
      // is correct because it is mounted last in the layout that holds it.
      zIndex: 1,
    },
    bar: {
      minHeight: layout.bottomBarHeight,
      borderRadius: radii.pill,
      /*
        The crit wash rather than the chrome the recording bar wears. This is
        the one piece of floating furniture in the app that is about something
        being wrong, and it may not read as another neutral pill somebody has
        learned to look past.
      */
      backgroundColor: colors.critWash,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.crit,
      boxShadow: shadows.floating,
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingHorizontal: layout.bottomBarPad,
      paddingVertical: space.x2,
    },
    mark: {
      width: layout.chromeButton,
      height: layout.chromeButton,
      borderRadius: radii.pill,
      backgroundColor: colors.crit,
      alignItems: "center",
      justifyContent: "center",
    },
    markGlyph: { color: colors.ground },
    middle: { flex: 1, gap: 1 },
    title: { color: colors.text, fontWeight: "600" },
    reason: { color: colors.critText },
    action: {
      minHeight: layout.chromeButton,
      justifyContent: "center",
      paddingHorizontal: space.x3,
      borderRadius: radii.pill,
      backgroundColor: colors.crit,
    },
    actionLabel: { color: colors.ground, fontWeight: "600", fontSize: t.meta },
    pressed: { opacity: 0.8 },
  });
