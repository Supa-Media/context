import { useEffect, useRef } from "react";
import { Animated, Easing, Pressable, StyleSheet, View, type TextStyle } from "react-native";
import { Circle, Path, Svg } from "react-native-svg";
import { Text } from "../../design/components/Text";
import { radii, space, texChatType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useReducedMotion } from "../../design/useReducedMotion";
import {
  runHead,
  secsLabel,
  stepIcon,
  stepWords,
  type LiveStep,
  type RunCardData,
  type StepIcon,
} from "./appChatRun";

type Glyph = { paths: string[]; circles?: Array<[number, number, number]> };

/** The mock's icon set, drawn in a 24 box at one stroke weight. */
const GLYPHS: Record<StepIcon | "check", Glyph> = {
  brain: {
    paths: [
      "M12 5a3 3 0 0 0-5.8 1A3 3 0 0 0 4 11a3 3 0 0 0 2 5 3 3 0 0 0 6 1zm0 0a3 3 0 0 1 5.8 1A3 3 0 0 1 20 11a3 3 0 0 1-2 5 3 3 0 0 1-6 1z",
    ],
  },
  search: { circles: [[11, 11, 7]], paths: ["m20 20-3.5-3.5"] },
  read: {
    paths: ["M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z", "M14 3v5h5M9 13h6M9 17h4"],
  },
  write: { paths: ["M4 20h4L19 9l-4-4L4 16z"] },
  mail: {
    paths: ["M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z", "m3 7 9 6 9-6"],
  },
  web: {
    circles: [[12, 12, 9]],
    paths: ["M3 12h18", "M12 3c2.5 2.7 2.5 15.3 0 18", "M12 3c-2.5 2.7-2.5 15.3 0 18"],
  },
  calendar: { paths: ["M4 6h16v14H4z", "M4 10h16", "M8 3v4", "M16 3v4"] },
  chat: { paths: ["M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"] },
  hist: { paths: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5M12 7v5l3 2"] },
  tool: { paths: ["M7 7h10v10H7z"] },
  check: { paths: ["m5 12 5 5L20 7"] },
};

function GlyphIcon({ name, color, size = 14, weight = 2 }: { name: StepIcon | "check"; color: string; size?: number; weight?: number }) {
  const glyph = GLYPHS[name];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      {(glyph.circles ?? []).map(([cx, cy, r], i) => (
        <Circle key={`c${i}`} cx={cx} cy={cy} r={r} stroke={color} strokeWidth={weight} fill="none" />
      ))}
      {glyph.paths.map((d, i) => (
        <Path key={`p${i}`} d={d} stroke={color} strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      ))}
    </Svg>
  );
}

/** The live spinner, or a static dot under reduced motion. */
function Spinner({ color, ring, reduced }: { color: string; ring: string; reduced: boolean }) {
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) return;
    turn.setValue(0);
    const loop = Animated.loop(
      Animated.timing(turn, { toValue: 1, duration: 700, easing: Easing.linear, useNativeDriver: false }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, turn]);

  if (reduced) {
    return <View style={[spinStyles.dot, { backgroundColor: color }]} testID="tex-run-spinner-static" />;
  }
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View
      style={[spinStyles.ring, { borderColor: ring, borderTopColor: color, transform: [{ rotate }] }]}
      testID="tex-run-spinner"
    />
  );
}

/** The shimmering live label: the mock's gradient sweep drawn as a breathing fade. */
function LiveLabel({ label, reduced, style }: { label: string; reduced: boolean; style: TextStyle }) {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.45, duration: 800, useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(1);
    };
  }, [reduced, pulse]);
  return (
    <Animated.View style={{ opacity: pulse, flexShrink: 1 }}>
      <Text variant="foot" style={style}>
        {label}
      </Text>
    </Animated.View>
  );
}

/** The index of the last tool step, or -1 when there is none. */
function lastToolIndex(steps: LiveStep[]): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].k === "tool") return i;
  }
  return -1;
}

/**
 * Tex's run card: what it did for one text, drawn as the mock's `.run`.
 *
 * Live, the header shows a spinner, the current step in shimmering words and
 * the elapsed seconds, and the steps are always open. Settled, the header
 * shows the total time and step count and folds the steps away until pressed.
 * Words only: a step's text is drawn as text, never as markup.
 */
export function TexRunCard({
  run,
  now,
  open,
  onToggle,
  testID,
}: {
  run: RunCardData;
  /** The clock, in epoch milliseconds: the live elapsed time is measured against it. */
  now: number;
  open: boolean;
  onToggle: () => void;
  testID?: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const reduced = useReducedMotion();
  const head = runHead(run, now);
  const live = run.live;
  const showSteps = live || open;
  const lastTool = lastToolIndex(run.steps);

  return (
    <View style={styles.card} testID={testID}>
      <Pressable
        style={styles.head}
        disabled={live}
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: showSteps, disabled: live }}
        accessibilityLabel={head.label}
        testID={testID === undefined ? undefined : `${testID}-head`}
      >
        {head.live ? (
          <>
            <Spinner color={colors.accent} ring={colors.line} reduced={reduced} />
            <LiveLabel label={head.label} reduced={reduced} style={styles.title} />
            <Text variant="mono" style={styles.time}>
              {`${head.elapsed}s`}
            </Text>
          </>
        ) : (
          <>
            <GlyphIcon name="check" color={colors.ok} size={14} weight={2.5} />
            <Text variant="foot" style={styles.title}>
              {head.label}
            </Text>
            <Text variant="foot" style={styles.muted}>
              {`· ${head.steps}`}
            </Text>
            <Text variant="mono" style={styles.time}>
              {open ? "Hide ▴" : "Show steps ▾"}
            </Text>
          </>
        )}
      </Pressable>

      {showSteps ? (
        <View style={styles.steps}>
          {run.steps.map((step, i) => {
            const spinning = live && i === lastTool && step.ms === undefined;
            return (
              <View key={i} style={styles.step} testID={testID === undefined ? undefined : `${testID}-step-${i}`}>
                <View style={styles.icon}>
                  {spinning ? (
                    <Spinner color={colors.accent} ring={colors.line} reduced={reduced} />
                  ) : (
                    <GlyphIcon name={stepIcon(step)} color={colors.muted} />
                  )}
                </View>
                <View style={styles.body}>
                  <Text variant="foot" style={step.k === "think" ? styles.thought : styles.words}>
                    {stepWords(step)}
                  </Text>
                  {step.res ? (
                    <Text variant="meta" style={styles.res}>
                      {step.res}
                    </Text>
                  ) : null}
                </View>
                {step.ms !== undefined ? (
                  <Text variant="mono" style={styles.ms}>
                    {secsLabel(step.ms)}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const spinStyles = StyleSheet.create({
  ring: { width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
  dot: { width: 8, height: 8, borderRadius: 4, marginHorizontal: 2 },
});

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      alignSelf: "stretch",
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.ground,
      overflow: "hidden",
    },
    head: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingVertical: space.x2,
      paddingHorizontal: space.x3,
    },
    title: { color: colors.text, fontWeight: "600", flexShrink: 1 },
    muted: { color: colors.muted },
    time: { color: colors.appDim, marginLeft: "auto" },
    steps: {
      borderTopWidth: 1,
      borderTopColor: colors.line,
      paddingTop: space.x2 - 2,
      paddingBottom: space.x2,
      paddingHorizontal: space.x3 - 2,
      gap: 2,
    },
    step: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: space.x2,
      paddingVertical: space.x1 - 1,
    },
    icon: { width: 18, height: 18, alignItems: "center", justifyContent: "center" },
    body: { flex: 1, minWidth: 0 },
    words: { color: colors.text2 },
    thought: { color: colors.muted, fontStyle: "italic" },
    res: { color: colors.appDim },
    ms: { color: colors.appDim, fontSize: texChatType.status },
  });
