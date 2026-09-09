import type { ReactNode } from "react";
import { Modal, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { Text } from "./Text";
import { layout, radii, space } from "../tokens";
import { useThemedStyles, type Colors } from "../theme";

/**
 * A panel over the page, rather than a page you went to.
 *
 * Settings used to be a route that replaced Browse, and the cost was not only
 * visual: closing it had to *reconstruct* where somebody came from, because
 * the note they were reading was no longer anywhere in the URL. Drawn over the
 * top instead, the note stays addressed and on screen, and closing is a back
 * button.
 *
 * ## Two shapes, one component, and the same rule the rest of the app uses
 *
 * Above `layout.narrowBreakpoint` this is a centred panel with a sidebar
 * beside its content. Below it there is no centred panel and no bottom sheet:
 * it fills the screen. That is not a shrunken desktop — a sheet capped at some
 * fraction of the viewport is eaten by the keyboard the moment a settings
 * field takes focus, which is exactly the case `Palette` already answers this
 * way. The window answers "is this a thumb", the same test `Menu.web` makes.
 *
 * `Modal` rather than an absolutely-positioned view, because it is the one
 * overlay primitive already proven on all three platforms here — `Palette`,
 * `Menu`, `Dialogs` and `TabSwitcher` all use it — and because it traps focus
 * on iOS and Android for free.
 *
 * The scrim literal matches those four rather than `colors.scrim`, which no
 * overlay in this codebase uses yet. Moving all five onto the token is a real
 * visual change in the light palette and wants its own diff.
 */
export function Overlay({
  title,
  badge,
  trailing,
  sidebar,
  children,
  onDismiss,
  testID,
}: {
  title: string;
  /** A short mark beside the title — which context this is, or a role. */
  badge?: ReactNode;
  /** Anything before the close button. */
  trailing?: ReactNode;
  /** The section list. Absent on a phone's second level, which is a push. */
  sidebar?: ReactNode;
  children: ReactNode;
  onDismiss: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useWindowDimensions().width < layout.narrowBreakpoint;

  const head = (
    <View style={styles.head}>
      <Text variant="noteTitle" role="heading" aria-level={2}>
        {title}
      </Text>
      {badge}
      <View style={styles.grow} />
      {trailing}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close settings"
        onPress={onDismiss}
        style={styles.close}
        testID={testID ? `${testID}-close` : undefined}
      >
        <Text variant="rowSub">✕</Text>
      </Pressable>
    </View>
  );

  if (compact) {
    return (
      <Modal visible animationType="slide" onRequestClose={onDismiss} testID={testID}>
        <View style={styles.phone}>
          {head}
          <View style={styles.phoneBody}>{sidebar ?? children}</View>
        </View>
      </Modal>
    );
  }

  return (
    <Modal transparent animationType="fade" onRequestClose={onDismiss} visible testID={testID}>
      {/*
        The scrim closes; the panel swallows its own presses so a click inside
        does not dismiss. The same construction `Dialogs.Shell` uses.
      */}
      <Pressable style={styles.scrim} accessibilityLabel="Close settings" onPress={onDismiss}>
        <Pressable
          style={styles.panel}
          accessibilityRole={undefined}
          onPress={(event) => event.stopPropagation()}
        >
          {head}
          <View style={styles.body}>
            {sidebar === undefined ? null : <View style={styles.side}>{sidebar}</View>}
            <View style={styles.main}>{children}</View>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: {
      flex: 1,
      backgroundColor: "rgba(3,3,4,.72)",
      alignItems: "center",
      justifyContent: "center",
      padding: space.x6,
    },
    panel: {
      width: "100%",
      maxWidth: 940,
      height: "100%",
      maxHeight: 660,
      borderRadius: radii.console,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface,
      overflow: "hidden",
      boxShadow: "0 40px 100px -30px rgba(0,0,0,1)",
    },
    head: {
      minHeight: layout.topBarHeight,
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingLeft: space.x4,
      paddingRight: space.x2,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
      backgroundColor: colors.surface2,
    },
    grow: { flexGrow: 1 },
    close: {
      width: layout.minTouchTarget,
      height: layout.minTouchTarget,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radii.md,
    },
    body: { flex: 1, flexDirection: "row", minHeight: 0 },
    side: {
      width: layout.railWidth,
      borderRightWidth: 1,
      borderRightColor: colors.line,
      backgroundColor: colors.surface,
    },
    main: { flex: 1, minWidth: 0 },
    phone: { flex: 1, backgroundColor: colors.ground },
    phoneBody: { flex: 1, minHeight: 0 },
  });
