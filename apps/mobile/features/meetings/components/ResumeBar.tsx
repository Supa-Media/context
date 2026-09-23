import { useCallback } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { usePathname } from "expo-router";
import { layout, pointerType as t, radii, space } from "../../design/tokens";
import { floatingStackBottom, useBottomChromeHeight } from "../../app/bottomChrome";
import { useThemedStyles, type Colors, type Shadows } from "../../design/theme";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { meetings } from "../controller";
import { duration, endedAgo } from "../format";
import { strandedMeetings } from "../landing";
import { continuationFromRecord, recordedSoFarMs, resumeBarOffer } from "../resume";
import { meetingHref } from "../route";
import { useMeetingsSnapshot, useTick } from "../useMeetings";
import { useResumeMeeting } from "../useResumeMeeting";

/**
 * THE MEETING THAT JUST STOPPED, OFFERED BACK WHEREVER SOMEBODY WENT NEXT.
 *
 * A meeting breaks for five minutes, the person stops recording, and goes to
 * read something. When the meeting starts again the one thing they need is a
 * way back into it that does not start a second note — and they are no longer
 * on the meeting's page. So the offer follows them, in the slot the recording
 * bar was just in.
 *
 * ## Teal, never red
 *
 * Resuming is a continuation, not an error. Red in this slot belongs to
 * `StrandedBar` — a meeting that did not save — and a second red bar that
 * means "everything is fine, and you could do more" would teach somebody to
 * look past the one that means their meeting is not in their context. So this
 * wears the accent, and **it stands down whenever that one is up**: a meeting
 * that did not save is louder than one that did.
 *
 * ## The impatient offer
 *
 * The note and the meeting's page offer Resume for as long as the meeting
 * exists. This one goes the moment it stops being about the break: when
 * something else is recorded (`resumeBarOffer` only ever offers the newest
 * meeting), when it is dismissed, which is remembered, or a couple of hours
 * after the meeting stopped (`RESUME_BAR_WINDOW_MS`).
 *
 * It also stands down while anything is recording — `RecordingBar` holds this
 * exact slot, for `StrandedBar`'s reason — and on the meeting's own page, which
 * offers the same press with room to explain it.
 */
export function ResumeBar({ bottomInset = 0 }: { bottomInset?: number }) {
  const styles = useThemedStyles(makeStyles);
  const snapshot = useMeetingsSnapshot();
  const chrome = useBottomChromeHeight();
  const pathname = usePathname();
  const resume = useResumeMeeting();
  /*
    A minute is the finest this bar says anything at, and a tick is what moves
    "ended 4 min ago" on and retires the offer when its window closes.
  */
  const now = useTick(snapshot.status === "ready", 30_000);

  const offer =
    snapshot.status !== "ready" || now === 0
      ? null
      : resumeBarOffer({
          records: snapshot.records,
          live: snapshot.live,
          canContinue: snapshot.canContinue,
          now,
        });
  const id = offer?.session.id ?? null;

  const press = useCallback(() => {
    if (offer === null) return;
    const continues = continuationFromRecord(snapshot.records, offer);
    if (continues === null) return;
    void resume({ continues, title: offer.session.title, destination: offer.destination });
  }, [offer, resume, snapshot.records]);

  const dismiss = useCallback(() => {
    if (id !== null) meetings.dismissResumeOffer(id);
  }, [id]);

  if (offer === null) return null;
  // A meeting that did not save owns this slot. See the header.
  if (strandedMeetings(snapshot.records).length > 0) return null;
  if (pathname === meetingHref(offer.session.id)) return null;

  const recorded = `${duration(recordedSoFarMs(offer))} recorded`;
  const ago = endedAgo(offer.session.endedAt, now);
  const line = ago === "" ? recorded : `${recorded} · ${ago}`;
  const lead = offer.interrupted === true ? "Cut short: " : "";

  return (
    <View
      style={[styles.slot, { bottom: floatingStackBottom(bottomInset, chrome) }]}
      accessibilityLabel={`${lead}${offer.session.title}, ${line}. You can pick this meeting back up.`}
      testID="resume-bar"
    >
      <View style={styles.bar}>
        <View style={styles.mark} aria-hidden>
          <Icon name="undo" size={16} color={styles.markGlyph.color} />
        </View>

        <View style={styles.middle}>
          <Text variant="mini" style={styles.title} numberOfLines={1}>
            {offer.session.title}
          </Text>
          <Text variant="foot" style={styles.line} numberOfLines={1} testID="resume-bar-line">
            {lead}
            {line}
          </Text>
        </View>

        <Pressable
          onPress={press}
          accessibilityRole="button"
          accessibilityLabel={`Resume recording ${offer.session.title}, into the same note`}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          testID="resume-bar-resume"
        >
          <Text variant="mini" style={styles.actionLabel}>
            Resume
          </Text>
        </Pressable>

        <Pressable
          onPress={dismiss}
          accessibilityRole="button"
          accessibilityLabel="Hide this until the next meeting"
          hitSlop={8}
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}
          testID="resume-bar-dismiss"
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
      // Ordering among siblings only; see `StrandedBar`, which this mirrors.
      zIndex: 1,
    },
    bar: {
      minHeight: layout.bottomBarHeight,
      borderRadius: radii.pill,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hintBorder,
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
      backgroundColor: colors.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    markGlyph: { color: colors.ground },
    middle: { flex: 1, gap: 1 },
    title: { color: colors.text, fontWeight: "600" },
    line: { color: colors.accentText },
    action: {
      minHeight: layout.chromeButton,
      justifyContent: "center",
      paddingHorizontal: space.x3,
      borderRadius: radii.pill,
      backgroundColor: colors.accent,
    },
    actionLabel: { color: colors.ground, fontWeight: "600", fontSize: t.meta },
    close: {
      minHeight: layout.chromeButton,
      minWidth: 32,
      alignItems: "center",
      justifyContent: "center",
    },
    closeGlyph: { color: colors.muted },
    pressed: { opacity: 0.8 },
  });
