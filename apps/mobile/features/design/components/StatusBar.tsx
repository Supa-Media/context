import { Platform, StyleSheet, View, type ViewStyle } from "react-native";
import { colors, fonts, layout, space } from "../tokens";
import { Text } from "./Text";

/**
 * The strip along the bottom of the application frame.
 *
 * Purely presentational: it takes segments and paints them. What they *say*
 * lives in `features/console/files/status.ts`, which is a pure module with
 * tests, because the rule that matters here is a content rule rather than a
 * styling one — a bucket that cannot do conditional writes has to say so, in a
 * tone that differs from one that can (`CLAUDE.md`, "degrade honestly").
 *
 * Two consequences for this component:
 *
 *  - **It never invents a tone.** `warn` arrives as `warn`; there is no
 *    "de-emphasise the trailing segments because they are chrome" rule that
 *    could quietly turn an honest warning back into a grey footnote.
 *  - **It cannot grow.** The frame reserves exactly `layout.statusBarHeight`
 *    for this row (see `AppFrame`). A strip that wrapped onto a second line
 *    would either be clipped mid-sentence or push the editor's height around
 *    as somebody types. So: one row, `numberOfLines={1}`, overflow hidden. The
 *    full sentence lives in `detail`, which is a tooltip on web and is what a
 *    screen reader is handed everywhere.
 *
 * The type is `treeMeta`'s scale in the mono face: these are numbers and
 * machine states sitting beside each other, and proportional digits jittering
 * as a word count ticks over is the sort of movement a person notices at the
 * edge of vision while trying to write.
 */

export type StatusBarTone = "quiet" | "ok" | "warn" | "crit";

/**
 * Structurally what `statusSegments()` returns.
 *
 * Declared here rather than imported so that `features/design` keeps no
 * dependency on `features/console` — the same reason `files/types.ts` declares
 * its own shapes rather than importing Convex's generated ones.
 */
export interface StatusBarSegment {
  id: string;
  text: string;
  tone: StatusBarTone;
  detail?: string;
}

const toneColor: Record<StatusBarTone, string> = {
  quiet: colors.muted,
  ok: colors.okText,
  warn: colors.warnText,
  crit: colors.critText,
};

/** Segments pushed against the trailing edge: where the note lives, and how safely. */
const DEFAULT_TRAILING = ["conflictCheck", "storage"];

export function StatusBar({
  segments,
  trailingIds = DEFAULT_TRAILING,
  style,
  testID,
}: {
  segments: StatusBarSegment[];
  /** Ids rendered right-aligned. Everything else stays on the leading edge. */
  trailingIds?: readonly string[];
  style?: ViewStyle;
  testID?: string;
}) {
  const leading = segments.filter((segment) => !trailingIds.includes(segment.id));
  const trailing = segments.filter((segment) => trailingIds.includes(segment.id));

  return (
    <View
      style={[styles.bar, style]}
      // A landmark rather than a live region: it changes on every keystroke,
      // and announcing a word count as somebody types would make the editor
      // unusable with a screen reader.
      role="contentinfo"
      accessibilityLabel="Status"
      testID={testID}
    >
      <View style={styles.group}>
        {leading.map((segment) => (
          <Segment key={segment.id} segment={segment} />
        ))}
      </View>
      <View style={styles.spacer} />
      <View style={styles.group}>
        {trailing.map((segment) => (
          <Segment key={segment.id} segment={segment} />
        ))}
      </View>
    </View>
  );
}

function Segment({ segment }: { segment: StatusBarSegment }) {
  // RN-Web forwards `title` to the DOM node, which is the cheapest honest
  // tooltip there is. Native has no hover, so the same sentence goes to the
  // accessibility label instead — it is never only in a hover state.
  const webTitle =
    Platform.OS === "web" && segment.detail ? ({ title: segment.detail } as object) : null;

  return (
    <Text
      variant="treeMeta"
      numberOfLines={1}
      accessibilityLabel={segment.detail ? `${segment.text}. ${segment.detail}` : segment.text}
      style={[styles.segment, { color: toneColor[segment.tone] }]}
      testID={`status-${segment.id}`}
      {...webTitle}
    >
      {segment.text}
    </Text>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: layout.statusBarHeight,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.x4,
    gap: space.x3,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.surface2,
    // Fixed height, so anything that does not fit is cut rather than allowed
    // to spill into the editor above.
    overflow: "hidden",
  },
  /** A row of segments; `flexShrink` lets the counts give way before the bar does. */
  group: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.x4,
    flexShrink: 1,
    overflow: "hidden",
  },
  spacer: { flexGrow: 1, flexShrink: 0 },
  segment: {
    fontFamily: fonts.mono,
    flexShrink: 1,
  },
});
