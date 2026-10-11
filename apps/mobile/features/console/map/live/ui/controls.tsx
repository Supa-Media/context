import { useEffect, useRef, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { fonts, space, pointerType } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";

/**
 * The map bar's pills. One shape for every control on the bar — Live, Today,
 * This week, the view and scope switches, Back to live, Following — so the
 * bar reads as one row of choices. A chosen pill is ink on paper reversed.
 */
export function Chip({
  label,
  on = false,
  onPress,
  accessibilityLabel,
  testID,
  leading,
  trailing,
  role = "button",
}: {
  label: string;
  on?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  testID?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  role?: "button" | "radio";
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={role}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={role === "radio" ? { checked: on } : { selected: on }}
      style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
        styles.chip,
        on ? styles.chipOn : hovered || pressed ? styles.chipHover : null,
      ]}
      testID={testID}
    >
      {leading}
      <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={1}>
        {label}
      </Text>
      {trailing}
    </Pressable>
  );
}

/** A row of pills where exactly one is chosen: Live / Today / This week, Map / Folders. */
export function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
  testID,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string; leading?: ReactNode }>;
  /** `null` when the choice is something the row does not offer, so none is chosen. */
  value: T | null;
  onChange: (value: T) => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.choice} accessibilityRole="radiogroup" accessibilityLabel={label} testID={testID}>
      {options.map((option) => (
        <Chip
          key={option.value}
          role="radio"
          label={option.label}
          on={option.value === value}
          leading={option.leading}
          onPress={() => onChange(option.value)}
          testID={testID === undefined ? undefined : `${testID}-${option.value}`}
        />
      ))}
    </View>
  );
}

/**
 * The phone's version of `Choice`: one track with the options inside it,
 * evenly split, the chosen one filled. Two of these fit across a phone where
 * a row of separate pills scrolled sideways, and a track reads as "pick one"
 * at a glance.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  testID,
  grow = 1,
}: {
  label: string;
  /** `accessibilityLabel` names a segment whose visible words are not its whole name, such as an icon alone. */
  options: ReadonlyArray<{ value: T; label: string; leading?: ReactNode; accessibilityLabel?: string }>;
  /** `null` when the choice is something the track does not offer, so none is chosen. */
  value: T | null;
  onChange: (value: T) => void;
  testID?: string;
  /** Share of the row this track takes beside others. */
  grow?: number;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.track, { flexGrow: grow }]} accessibilityRole="radiogroup" accessibilityLabel={label} testID={testID}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="radio"
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ checked: on }}
            style={({ pressed }: { pressed: boolean }) => [styles.segment, on ? styles.segmentOn : pressed ? styles.chipHover : null]}
            testID={testID === undefined ? undefined : `${testID}-${option.value}`}
          >
            {option.leading}
            {option.label === "" ? null : (
              <Text style={[styles.segmentText, on && styles.chipTextOn]} numberOfLines={1}>
                {option.label}
              </Text>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

/** Live's dot: teal, breathing while the map is live, still under reduced motion. */
export function LiveDot({ pulsing, reducedMotion }: { pulsing: boolean; reducedMotion: boolean }) {
  const colors = useColors();
  const ring = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!pulsing || reducedMotion) {
      ring.setValue(0);
      return;
    }
    const loop = Animated.loop(Animated.timing(ring, { toValue: 1, duration: 1600, useNativeDriver: false }));
    loop.start();
    return () => loop.stop();
  }, [pulsing, reducedMotion, ring]);
  return (
    <View style={dot.box} aria-hidden testID="map-live-dot">
      <Animated.View
        style={[
          dot.ring,
          {
            backgroundColor: colors.accent,
            opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
            transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] }) }],
          },
        ]}
      />
      <View style={[dot.core, { backgroundColor: colors.accent }]} />
    </View>
  );
}

/** A small round icon button: the zoom control's − and +, the replay's play. */
export function RoundButton({
  icon,
  label,
  onPress,
  filled = false,
  size = 32,
  testID,
}: {
  icon: "plus" | "minus" | "play" | "pause" | "close" | "chevronUp" | "chevronDown";
  label: string;
  onPress: () => void;
  filled?: boolean;
  size?: number;
  testID?: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [
        styles.round,
        { width: size, height: size, borderRadius: size / 2 },
        filled ? styles.roundFilled : hovered ? styles.chipHover : null,
      ]}
      testID={testID}
    >
      <Icon name={icon} size={Math.round(size * 0.42)} color={filled ? colors.pageSurface : colors.text2} />
    </Pressable>
  );
}

/** The panels' small capitals heading: WORKING NOW, WHAT'S HAPPENING. */
export function PanelHeading({ children, testID }: { children: string; testID?: string }) {
  return (
    <Text variant="eyebrow" accessibilityRole="header" testID={testID}>
      {children}
    </Text>
  );
}

const dot = StyleSheet.create({
  box: { width: 8, height: 8, alignItems: "center", justifyContent: "center" },
  ring: { position: "absolute", width: 8, height: 8, borderRadius: 4 },
  core: { width: 8, height: 8, borderRadius: 4 },
});

export const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    chip: {
      height: 32,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      paddingHorizontal: 14,
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      backgroundColor: colors.pageSurface,
      flexShrink: 0,
    },
    chipHover: { backgroundColor: colors.surface3 },
    chipOn: { backgroundColor: colors.text, borderColor: colors.text },
    chipText: { fontFamily: fonts.body, fontSize: pointerType.ui, fontWeight: "600", color: colors.text2 },
    chipTextOn: { color: colors.pageSurface },
    choice: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    track: {
      flexBasis: 0,
      minWidth: 0,
      height: 36,
      borderRadius: 11,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface2,
      padding: 3,
      flexDirection: "row",
      gap: 2,
    },
    segment: {
      flex: 1,
      minWidth: 0,
      borderRadius: 8,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      paddingHorizontal: 6,
    },
    segmentOn: { backgroundColor: colors.text },
    segmentText: { fontFamily: fonts.body, fontSize: pointerType.label, fontWeight: "600", color: colors.text2 },
    round: {
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.pageSurface,
    },
    roundFilled: { backgroundColor: colors.text, borderColor: colors.text },
  });
