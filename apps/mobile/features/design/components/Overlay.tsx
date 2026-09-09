import type { ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReducedMotion } from "../useReducedMotion";
import { Icon } from "./Icon";
import { Text } from "./Text";
import { layout, radii, space } from "../tokens";

import { useThemedStyles, type Colors, type Shadows } from "../theme";

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
 * it fills the screen, showing whichever of `sidebar`/`children` the caller
 * hands it — never both, because there is no room for both. That is not a shrunken desktop — a sheet capped at some
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
  closeLabel = "Close",
  trailing,
  sidebar,
  children,
  onBack,
  onDismiss,
  testID,
}: {
  title: string;
  /** A short mark beside the title — which context this is, or a role. */
  badge?: ReactNode;
  /**
   * What the close button announces. A generic primitive must not tell every
   * screen reader "settings" for whatever it is ever wrapped around.
   */
  closeLabel?: string;
  /** Anything before the close button. */
  trailing?: ReactNode;
  /**
   * The section list, drawn beside the content at pointer widths.
   *
   * **Compact is not a two-level push in here.** Below the breakpoint this
   * renders `sidebar` when given one and `children` otherwise, so a caller
   * that wants list-then-content owns that step and passes one at a time —
   * which is what `SettingsOverlay` does, with `onBack` for the way back. An
   * earlier version of this comment described a push the component did not
   * implement, which would have left the next caller's content unreachable.
   */
  sidebar?: ReactNode;
  children: ReactNode;
  /**
   * Back, on a phone's second level. Present means the head draws a chevron
   * before the title and Android's back gesture pops a level instead of
   * closing — a phone reaches a section by pushing onto the list, so
   * dismissing from there would throw away a step the person just took.
   */
  onBack?: () => void;
  onDismiss: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useWindowDimensions().width < layout.narrowBreakpoint;
  /*
    A `Modal` is its own root view, so nothing above it pays the notch — the
    defect `__tests__/safeArea.test.ts` exists for, whose header records the
    settings screen drawing its title on the same line as the clock. `Palette`
    pays these in its own sheet for the same reason.
  */
  const insets = useSafeAreaInsets();
  // Starts `true`, so nothing moves before the preference has resolved.
  const reduced = useReducedMotion();

  const head = (
    <View style={styles.head}>
      {onBack === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={onBack}
          style={styles.close}
          testID={testID ? `${testID}-back` : undefined}
        >
          <Icon name="chevronLeft" size={16} />
        </Pressable>
      )}
      <Text variant="noteTitle" role="heading" aria-level={2} numberOfLines={1} style={styles.title}>
        {title}
      </Text>
      {badge}
      <View style={styles.grow} />
      {trailing}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={closeLabel}
        onPress={onDismiss}
        style={styles.close}
        testID={testID ? `${testID}-close` : undefined}
      >
        <Icon name="close" size={16} />
      </Pressable>
    </View>
  );

  if (compact) {
    /*
      Two levels, pushed rather than shown side by side: a phone has no room
      for a list beside its content, and a caller that hands over both gets the
      list first and the section after a press. `onRequestClose` — Android's
      back gesture, and the iOS swipe — pops that step rather than closing the
      whole overlay, which is what a person who has just opened a section
      means by "back".
    */
    return (
      <Modal
        visible
        animationType={reduced ? "none" : "slide"}
        onRequestClose={onBack ?? onDismiss}
        testID={testID}
      >
        {/*
          `padding` on iOS shortens the sheet by the keyboard's height so the
          bottom of a form stays reachable; Android resizes the window and
          `height` cooperates with that. This pane holds the connect form —
          endpoint, bucket, access key, secret — so a keyboard covering its
          submit is not hypothetical. Taken from `Palette`, which argues it.
        */}
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={[
            styles.phone,
            { paddingTop: insets.top, paddingBottom: insets.bottom },
          ]}
        >
          {head}
          <View style={styles.phoneBody}>{sidebar ?? children}</View>
        </KeyboardAvoidingView>
      </Modal>
    );
  }

  return (
    <Modal
      transparent
      animationType={reduced ? "none" : "fade"}
      onRequestClose={onDismiss}
      visible
      testID={testID}
    >
      {/*
        The scrim closes; the panel swallows its own presses so a click inside
        does not dismiss. The same construction `Dialogs.Shell` uses.
      */}
      {/*
        `accessible={false}` on both, and it is not cosmetic. `Pressable`
        defaults to `accessible`, and an accessible View on iOS collapses into
        a single element whose descendants VoiceOver cannot reach — which for a
        wrapper around an entire settings surface means the section list, the
        binding card and the connect form all disappear behind one "Close"
        button. The dialogs this pattern comes from wrap a title and two
        buttons, where that cost does not arise.

        The inner handler is `() => {}` rather than a `stopPropagation` call:
        nested responders mean the outer never fires anyway, and a handler that
        dereferences its argument throws the day something invokes it bare.
      */}
      <Pressable
        style={styles.scrim}
        accessible={false}
        accessibilityLabel={closeLabel}
        onPress={onDismiss}
      >
        <Pressable style={styles.panel} accessible={false} onPress={() => {}}>
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

const makeStyles = (colors: Colors, shadows: Shadows) =>
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
      // The token rather than a fourth copy of the same literal: `Palette`,
      // `Dialogs` and `TabSwitcher` each hardcode this string today.
      boxShadow: shadows.rising,
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
    title: { flexShrink: 1 },
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
