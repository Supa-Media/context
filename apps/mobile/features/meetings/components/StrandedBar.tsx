import { useCallback } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { layout, pointerType as t, radii, space } from "../../design/tokens";
import { floatingStackBottom, useBottomChromeHeight } from "../../app/bottomChrome";
import { useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { meetings } from "../controller";
import { meetingLanding, unacknowledgedStranded } from "../landing";
import { meetingHref } from "../route";
import { useMeetingsSnapshot } from "../useMeetings";

/**
 * A MEETING THAT DID NOT MAKE IT, SAID WHERE SOMEBODY IS ACTUALLY LOOKING.
 *
 * ## The gap this closes
 *
 * A meeting that fails to reach the bucket was once visible only on its own
 * page and in the console's Meetings panel, both of which require having gone
 * looking. The owner recorded 31 minutes, the finalize got stuck, and they
 * found out days later. So a stranded meeting is said here, at the edge of the
 * screen this app already uses to interrupt somebody.
 *
 * ## Why it is small, and why it can be closed
 *
 * The first version was a full-width red bar with no dismiss, on the argument
 * that a meeting which did not save is still not saved eight seconds later.
 * On the desktop it sat over the note list for days ("it's blocking
 * everything"), partly because it fired for meetings the machine was still
 * sending (see `handedOver` in `record.ts`). A notice that hides content is a
 * second failure on top of the first, so it now hugs its text, wears the
 * chrome every floating control wears with a red dot rather than a red box
 * (no tinted boxes), and has a close button.
 *
 * Closing hides the notice for this meeting's current problem only
 * (`dismissNotice`, `unacknowledgedStranded`). The recording stays on the
 * device, in the Meetings list and on its own page with Retry and Copy note,
 * and a different problem brings the notice back. Nothing is lost by closing.
 *
 * ## Why it stands down for a live recording
 *
 * `RecordingBar` occupies this exact slot, and `zIndex` cannot arbitrate
 * between them because every react-native-web `View` opens a stacking context
 * (`docs/decisions/app-and-console.md`). Somebody recording now is also the
 * one person who must not be pulled away from it.
 *
 * ## What it offers
 *
 * Retry, in place, when retrying can help. Tapping the text opens the meeting,
 * which is where the reason, the transcript and Copy note are. The close
 * button is the third and last thing on it.
 */
export function StrandedBar({ bottomInset = 0 }: { bottomInset?: number }) {
  const styles = useThemedStyles(makeStyles);
  const snapshot = useMeetingsSnapshot();
  const chrome = useBottomChromeHeight();
  const router = useRouter();
  const pathname = usePathname();

  const stranded = unacknowledgedStranded(snapshot.records);
  // The first one, and a count for the rest.
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

  const dismiss = useCallback(() => {
    // Every one it is naming, not only the first: "+2" closed is three
    // notices closed, or the next press would be a surprise.
    for (const record of stranded) meetings.dismissNotice(record.session.id);
  }, [stranded]);

  if (first === null || landing === null) return null;
  if (snapshot.live !== null) return null;
  if (pathname === meetingHref(first.session.id)) return null;

  const others = stranded.length - 1;
  const name = others > 0 ? `${first.session.title} +${others}` : first.session.title;
  const label =
    `${first.session.title} was not saved to your context. ${landing.title}` +
    (others > 0 ? ` And ${others} more like it.` : "");

  return (
    <View
      pointerEvents="box-none"
      style={[styles.slot, { bottom: floatingStackBottom(bottomInset, chrome) }]}
      testID="stranded-bar-slot"
    >
      <View style={styles.bar} accessibilityRole="alert" accessibilityLabel={label} testID="stranded-bar">
        <Pressable
          onPress={open}
          accessibilityRole="button"
          accessibilityLabel={`${label} Open the meeting.`}
          style={styles.middle}
          testID="stranded-bar-open"
        >
          <View style={styles.dot} />
          <Text variant="foot" style={styles.title} numberOfLines={1}>
            {name}
          </Text>
          <Text variant="foot" style={styles.reason} numberOfLines={1}>
            not saved
          </Text>
        </Pressable>

        {landing.retry !== null ? (
          <Pressable
            onPress={retry}
            accessibilityRole="button"
            accessibilityLabel={`Try saving ${first.session.title} again`}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            testID="stranded-bar-retry"
          >
            <Text variant="foot" style={styles.actionLabel}>
              Retry
            </Text>
          </Pressable>
        ) : null}

        <Pressable
          onPress={dismiss}
          accessibilityRole="button"
          accessibilityLabel="Close this notice. The meeting stays in Meetings."
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}
          testID="stranded-bar-dismiss"
        >
          <Icon name="close" size={14} color={styles.closeGlyph.color} />
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
      // Centred and hugging its content, so the band either side of it stays
      // clickable (`box-none`) and the notice covers one line of a list, not
      // the width of the window.
      alignItems: "center",
      // Ordering among siblings only — see `RecordingBar`'s note and the
      // stacking-context section of `docs/decisions/app-and-console.md`. This
      // is correct because it is mounted last in the layout that holds it.
      zIndex: 1,
    },
    bar: {
      maxWidth: "100%",
      borderRadius: radii.pill,
      backgroundColor: colors.chrome,
      boxShadow: shadows.floating,
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      paddingLeft: space.x3,
      paddingRight: space.x1,
      paddingVertical: 0,
    },
    middle: { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: space.x2, minHeight: layout.chromeButton },
    dot: { width: 8, height: 8, borderRadius: radii.pill, backgroundColor: colors.crit },
    title: { color: colors.text, fontWeight: "600", flexShrink: 1 },
    reason: { color: colors.critText, flexShrink: 0 },
    action: {
      minHeight: layout.chromeButton,
      justifyContent: "center",
      paddingHorizontal: space.x2,
      borderRadius: radii.pill,
    },
    actionLabel: { color: colors.text, fontWeight: "600", fontSize: t.meta },
    close: {
      width: layout.chromeButton,
      height: layout.chromeButton,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
    },
    closeGlyph: { color: colors.muted },
    pressed: { opacity: 0.6 },
  });
