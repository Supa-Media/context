import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ShellTitleBand } from "../../app/ShellTitleBandView";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { fonts, layout, pointerType, radii, space, touchType } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { useReducedMotion } from "../../design/useReducedMotion";
import { GuidePhone } from "./styles";
import { Reveal } from "./parts";

/**
 * The guide's page: one action per screen, over the workspace.
 *
 * A full page rather than a dialog, for `Overlay`'s reason — this is a task
 * somebody gives their whole attention to for a few minutes, not a question —
 * but with its own bar, because the bar here says whose guide it is and how
 * far along, not which settings section is open.
 *
 * On a pointer the steps and the picture of the other app sit side by side and
 * the pair is centred in the window (the owner's note on the artboards: a step
 * pinned to the top looked unfinished). On a phone there is one column from the
 * top, and the picture is one press away under "Show me where".
 *
 * The count is in the bar and nowhere else: no progress bar, because five
 * screens do not need two ways to say "3 of 5".
 */
export function GuideFrame({
  agentName,
  slug,
  count,
  picture,
  children,
  footLeft,
  footRight,
  onClose,
}: {
  agentName: string;
  slug: string;
  /** `[n, of]`, or `undefined` on the finish screens. */
  count?: readonly [number, number];
  picture?: ReactNode;
  children: ReactNode;
  footLeft?: ReactNode;
  footRight?: ReactNode;
  onClose: () => void;
}) {
  const colors = useColors();
  const s = useThemedStyles(makeStyles);
  const phone = useWindowDimensions().width < layout.narrowBreakpoint;
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();

  return (
    <Modal visible animationType={reduced ? "none" : phone ? "slide" : "fade"} onRequestClose={onClose}>
      <GuidePhone.Provider value={phone}>
        <View style={[s.page, { paddingTop: insets.top, paddingBottom: insets.bottom }]} testID="agent-setup">
          <ShellTitleBand color={colors.surface2} />
          <View style={[s.top, phone && s.topPhone]}>
            <Text style={[s.who, phone && s.whoPhone]} numberOfLines={1} role="heading" aria-level={2}>
              Connect {agentName} to <Text style={s.slug}>@{slug}</Text>
            </Text>
            <View style={s.grow} />
            {count === undefined ? null : (
              <Text style={s.count} testID="agent-setup-count">
                {count[0]} of {count[1]}
              </Text>
            )}
            <Pressable
              role="button"
              accessibilityLabel="Close the guide"
              onPress={onClose}
              // The modal focuses its first control on open; a browser ring on
              // a mouse user's close button reads as stuck. The ring is drawn
              // here instead, quietly, in the accent.
              style={(press) => [s.close, (press as { focused?: boolean }).focused === true && s.closeFocused]}
              testID="agent-setup-close"
            >
              <Icon name="close" size={14} color={colors.text2} />
            </Pressable>
          </View>
          <ScrollView
            style={s.scroll}
            contentContainerStyle={[s.main, phone ? s.mainPhone : s.mainDesk]}
            keyboardShouldPersistTaps="handled"
          >
            <View style={[s.left, !picture && s.leftAlone, phone && s.leftPhone]}>
              {children}
              {phone && picture ? (
                <Reveal label="Show me where" testID="agent-setup-show-me">
                  {picture}
                </Reveal>
              ) : null}
            </View>
            {!phone && picture ? <View style={s.right}>{picture}</View> : null}
          </ScrollView>
          <View style={[s.foot, phone && s.footPhone]}>
            <View style={s.footSide}>{footLeft}</View>
            <View style={[s.footSide, s.footRight]}>{footRight}</View>
          </View>
        </View>
      </GuidePhone.Provider>
    </Modal>
  );
}

/** "← Back", quiet, as the foot's left side. */
export function BackLink({ onPress }: { onPress: () => void }) {
  const s = useThemedStyles(makeStyles);
  const phone = useWindowDimensions().width < layout.narrowBreakpoint;
  return (
    <Pressable role="button" onPress={onPress} style={s.quietPress} testID="agent-setup-back">
      <Text style={[s.quiet, phone && s.quietPhone]}>← Back</Text>
    </Pressable>
  );
}

/** A quiet word link in the foot: "Do this later", "Connect ChatGPT too". */
export function QuietLink({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
  const s = useThemedStyles(makeStyles);
  const phone = useWindowDimensions().width < layout.narrowBreakpoint;
  return (
    <Pressable role="button" onPress={onPress} style={s.quietPress} testID={testID}>
      <Text style={[s.quiet, phone && s.quietPhone]}>{label}</Text>
    </Pressable>
  );
}

/**
 * The guide's two buttons: teal for the one thing to do next (onboarding's
 * primary since the setup widget), and a quiet one for "Copy the prompt
 * again" while the page is waiting on the other app.
 */
export function GuideButton({
  label,
  onPress,
  quiet = false,
  style,
  testID,
}: {
  label: string;
  onPress: () => void;
  quiet?: boolean;
  style?: ViewStyle;
  testID?: string;
}) {
  const s = useThemedStyles(makeStyles);
  const phone = useWindowDimensions().width < layout.narrowBreakpoint;
  return (
    <Pressable
      role="button"
      onPress={onPress}
      style={({ pressed }) => [s.btn, phone && s.btnPhone, quiet && s.btnQuiet, pressed && s.btnPressed, style]}
      testID={testID}
    >
      <Text style={[s.btnLabel, phone && s.btnLabelPhone, quiet && s.btnLabelQuiet]}>{label}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { flex: 1, backgroundColor: colors.ground },
    top: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x4,
      paddingVertical: 14,
      paddingHorizontal: space.x6,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
      backgroundColor: colors.surface2,
    },
    topPhone: { paddingHorizontal: space.x4, paddingVertical: space.x3, gap: space.x3 },
    who: { fontSize: pointerType.ui, fontWeight: "600", color: colors.text, flexShrink: 1 },
    whoPhone: { fontSize: touchType.ui },
    slug: { fontFamily: fonts.mono, fontWeight: "500" },
    grow: { flexGrow: 1 },
    count: { fontSize: pointerType.meta, color: colors.muted, fontVariant: ["tabular-nums"] },
    close: {
      width: 28,
      height: 28,
      borderRadius: radii.lg,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.surface3,
      outlineWidth: 0,
    },
    closeFocused: { borderWidth: 1.5, borderColor: colors.accent },
    scroll: { flex: 1 },
    main: { flexGrow: 1 },
    mainDesk: {
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "center",
      gap: 64,
      paddingHorizontal: space.x8,
      paddingTop: space.x8,
      paddingBottom: 56,
    },
    mainPhone: { paddingHorizontal: space.x4, paddingTop: space.x7, paddingBottom: space.x6 },
    left: { flexShrink: 1, width: 440, maxWidth: "100%" },
    leftAlone: { width: 560 },
    leftPhone: { width: "100%" },
    right: { flexShrink: 1, width: 520, maxWidth: "100%" },
    foot: {
      minHeight: 76,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: space.x3,
      paddingVertical: space.x4,
      paddingHorizontal: space.x6,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    footPhone: { paddingHorizontal: space.x4 },
    footSide: { flexDirection: "row", alignItems: "center", gap: space.x4 },
    footRight: { flexShrink: 1, justifyContent: "flex-end" },
    btn: {
      paddingVertical: 11,
      paddingHorizontal: 22,
      borderRadius: radii.cta,
      backgroundColor: colors.accent,
      borderWidth: 1,
      borderColor: colors.accent,
    },
    btnPhone: { paddingVertical: 13, paddingHorizontal: space.x5, flexShrink: 1 },
    btnQuiet: { backgroundColor: colors.surface3, borderColor: colors.lineStrong },
    btnPressed: { opacity: 0.85 },
    btnLabel: { fontSize: pointerType.ui, fontWeight: "600", color: colors.ink },
    btnLabelPhone: { fontSize: touchType.ui },
    btnLabelQuiet: { color: colors.text },
    quietPress: { paddingVertical: space.x2, flexShrink: 0 },
    quiet: { fontSize: pointerType.ui, fontWeight: "500", color: colors.text2 },
    quietPhone: { fontSize: touchType.ui },
  });
