import { createContext, useContext, type ReactNode } from "react";
import { Pressable, StyleSheet, Text as RNText, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { Tex } from "../../chaos/Tex";
import { fonts, texPageType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import type { Mood } from "./texPageTypes";

/**
 * The pieces every part of the Tex page is built from, each one the mock's
 * CSS class of the same name (`/tex-page/mockup.html`, Dev2's approved v18):
 * `.eh` is `SectionHead`, `.more` is `More`, `.lk` is `LinkWord`, `.row` is
 * `JobRow`, `.sub` is `SubPage`. Context's paper and ink, the app's tokens:
 * a component never names a colour.
 *
 * `wide` is the mock's `@container (min-width:640px)`: the page's own width,
 * not the window's, so the desktop layout follows the column it sits in.
 */

export const WIDE_PX = 640;
export const WideContext = createContext(false);
export const useWide = () => useContext(WideContext);

/** The page's clock: the real one, or a fixed moment in the visual fixture so its times read as the mock's. */
export const NowContext = createContext<() => number>(() => Date.now());
export const useNow = () => useContext(NowContext)();

/** The mock's Tex figures, as `figureParts` draws them: chaos 0, 55, 70 tugging at 0.8, 90. */
const MOODS: Record<Mood, { chaos: number; tug?: number; dim?: boolean }> = {
  calm: { chaos: 0 },
  rest: { chaos: 0, dim: true },
  busy: { chaos: 55 },
  stuck: { chaos: 70, tug: 0.8 },
  wild: { chaos: 90 },
};

export function Figure({ mood, size, testID }: { mood: Mood; size: number; testID?: string }) {
  const m = MOODS[mood];
  return (
    <View style={{ width: size, height: size, opacity: m.dim ? 0.35 : 1 }} testID={testID}>
      <Tex chaos={m.chaos} tug={m.tug} size={size} />
    </View>
  );
}

type Tone = "text" | "text2" | "muted" | "accent" | "warn" | "crit" | "ok";

/** One run of type. `serif` is the reading face, as the mock's thoughts and headings are set. */
export function T({
  children,
  size = 15,
  weight = "400",
  tone = "text",
  serif = false,
  mono = false,
  line,
  upper = false,
  numberOfLines,
  selectable,
  style,
  testID,
}: {
  children: ReactNode;
  size?: number;
  weight?: "400" | "500" | "600";
  tone?: Tone;
  serif?: boolean;
  mono?: boolean;
  /** Line height as a multiple; the mock's body is 1.5. */
  line?: number;
  upper?: boolean;
  numberOfLines?: number;
  /** Lets the reader select and copy it, as a code they type elsewhere. */
  selectable?: boolean;
  style?: StyleProp<TextStyle>;
  testID?: string;
}) {
  const colors = useColors();
  const color = { text: colors.text, text2: colors.text2, muted: colors.muted, accent: colors.accent, warn: colors.warn, crit: colors.crit, ok: colors.ok }[tone];
  return (
    <RNText
      numberOfLines={numberOfLines}
      selectable={selectable}
      testID={testID}
      style={[
        {
          color,
          fontSize: size,
          fontWeight: weight,
          fontFamily: mono ? fonts.mono : serif ? fonts.reading : fonts.body,
          lineHeight: Math.round(size * (line ?? 1.5)),
        },
        upper ? { textTransform: "uppercase", letterSpacing: size * 0.05 } : null,
        style,
      ]}
    >
      {children}
    </RNText>
  );
}

/** `.eh`: a section's small capital heading. */
export function SectionHead({ children }: { children: ReactNode }) {
  return (
    <T size={12} weight="600" tone="muted" upper style={{ marginBottom: 4 }}>
      {children}
    </T>
  );
}

/** `.lk`: a link word inside a line of type. */
export function LinkWord({ children, onPress, testID }: { children: ReactNode; onPress: () => void; testID?: string }) {
  const colors = useColors();
  return (
    <RNText
      accessibilityRole="link"
      onPress={onPress}
      testID={testID}
      style={{ color: colors.accent, fontWeight: "500" }}
    >
      {children}
    </RNText>
  );
}

/** `.more`: "Show all 6 from today". */
export function More({ children, onPress, testID, style }: { children: ReactNode; onPress: () => void; testID?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} testID={testID} style={[{ paddingTop: 10, alignSelf: "flex-start" }, style]}>
      <T size={13} tone="accent">
        {children}
      </T>
    </Pressable>
  );
}

/** `.row`: a finished job, one line, its state on the right. */
export function JobRow({ title, right, onPress, testID }: { title: string; right: string; onPress: () => void; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable accessibilityRole="button" onPress={onPress} testID={testID} style={styles.row}>
      <T size={14} weight="500" style={{ flex: 1, minWidth: 0 }}>
        {title}
      </T>
      <T size={13} tone="muted" numberOfLines={1}>
        {right}
      </T>
    </Pressable>
  );
}

/** `.crumb` + `.back`: "‹ Tex", above every page that is not the first. */
export function Back({ onPress, label = "‹ Tex" }: { onPress: () => void; label?: string }) {
  return (
    <View style={{ flexDirection: "row" }}>
      <Pressable accessibilityRole="link" onPress={onPress} testID="tex-back">
        <T size={14} weight="500" tone="accent">
          {label}
        </T>
      </Pressable>
    </View>
  );
}

/** `.sub`: a page's serif title, its lead line, and what follows, 18 apart. */
export function SubPage({ title, lead, children, testID }: { title: string; lead?: string; children?: ReactNode; testID?: string }) {
  return (
    <View style={{ gap: 18 }} testID={testID}>
      <T size={26} serif line={1.25}>
        {title}
      </T>
      {lead ? (
        <T size={14} tone="muted" style={{ marginTop: -10 }}>
          {lead}
        </T>
      ) : null}
      {children}
    </View>
  );
}

/** `.list`: rows between hairlines. */
export function ListBox({ children, open = false }: { children: ReactNode; open?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={open ? null : styles.list}>{children}</View>;
}

/** `.li`: one row of a list, a title and its line, then whatever sits on the right. */
export function ListRow({
  title,
  sub,
  right,
  onPress,
  testID,
}: {
  title: string;
  sub?: string;
  right?: ReactNode;
  onPress?: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const body = (
    <>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T size={14} weight="500">
          {title}
        </T>
        {sub ? (
          <T size={13} tone="muted">
            {sub}
          </T>
        ) : null}
      </View>
      {right}
    </>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.li} testID={testID}>
      {body}
    </Pressable>
  ) : (
    <View style={styles.li} testID={testID}>
      {body}
    </View>
  );
}

/** `.ghost`: a small outlined button. */
export function Ghost({ label, onPress, danger = false, testID, disabled }: { label: string; onPress: () => void; danger?: boolean; testID?: string; disabled?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled} style={[styles.ghost, disabled ? { opacity: 0.5 } : null]} testID={testID}>
      <T size={12} weight="500" tone={danger ? "crit" : "text"} line={1.4}>
        {label}
      </T>
    </Pressable>
  );
}

/** `.think`: a block between hairlines, 6 apart. */
export function ThinkBlock({ children, testID }: { children: ReactNode; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.think} testID={testID}>
      {children}
    </View>
  );
}

/** `.hint`: a tinted line that says how to do what the page does not. */
export function Hint({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.hint}>
      <T size={14} tone="text2">
        {children}
      </T>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    row: {
      flexDirection: "row",
      gap: 10,
      alignItems: "baseline",
      paddingVertical: 9,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
      width: "100%",
    },
    list: { borderTopWidth: 1, borderTopColor: colors.line },
    li: {
      flexDirection: "row",
      gap: 12,
      alignItems: "center",
      paddingVertical: 11,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    ghost: {
      alignSelf: "flex-start",
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingVertical: 4,
      paddingHorizontal: 10,
    },
    think: { gap: 6, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line },
    hint: { backgroundColor: colors.accentDim, borderRadius: 10, paddingVertical: 10, paddingHorizontal: 12 },
  });

/** The styles the page's own sections share, for the screens. */
export const pageStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { borderWidth: 1, borderColor: colors.line, borderRadius: 12, backgroundColor: colors.surface },
    input: {
      height: 36,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface2,
      color: colors.text,
      paddingHorizontal: 12,
      fontSize: texPageType.field,
      fontFamily: fonts.body,
    },
  });
