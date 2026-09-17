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

import { useColors, useThemedStyles, type Colors } from "../theme";

/**
 * The settings surface: a page over the page, rather than a page you went to.
 *
 * Settings used to be a route that replaced Browse, and the cost was not only
 * visual: closing it had to *reconstruct* where somebody came from, because
 * the note they were reading was no longer anywhere in the URL. Drawn over the
 * top instead, the note stays addressed and on screen, and closing is a back
 * button. **None of that changed**, and this is the thing most likely to be
 * misread about the shape below: `?settings=` is still the address, Browse is
 * still mounted under this, and closing still drops one parameter.
 *
 * What changed is that it stopped *looking* like a dialog. It was a 940×660
 * panel with a radius, a border and a drop shadow, centred on a 72%-black
 * scrim — chrome that says "the real screen is the one behind me, this is
 * temporary". Settings is neither temporary nor small: nineteen sections, a
 * connect form, a plugin list. So the surface fills the window, the scrim is
 * gone because there is nothing behind it to look at, and the way out is a
 * named control rather than a glyph in a corner. `settingsFrame.test.ts`
 * holds each of those.
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
 * `Menu`, `Dialogs` and `RecentSheet` all use it — and because it traps focus
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
  breadcrumb,
  sidebar,
  sidebarWidth = layout.railWidth,
  children,
  onBack,
  backLabel,
  onDismiss,
  testID,
}: {
  /**
   * The bar's own title, where the bar is the only thing naming the screen.
   *
   * **Omitted where the content carries a heading of its own**, which on a
   * phone's section screen it does: a bar titled "Overview" over a panel
   * titled "Overview" spends about seventy points of the first screenful
   * restating a word already on it. There the bar says where Back goes and
   * nothing else, which is what a phone's nav bar is for.
   */
  title?: string;
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
   * The address, stated in the bar — `settings / plugins`.
   *
   * A full page has to say which page it is, and this one has an address
   * already: every section is `?settings=<key>`. Drawn in the mono face
   * because it is a path rather than a sentence, and because that is what
   * makes a screenshot in a support thread name its own screen.
   */
  breadcrumb?: string;
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
  /**
   * How wide that sidebar is drawn. Defaults to the rail's width, which is
   * what every caller wanted while a sidebar held nothing but labels.
   */
  sidebarWidth?: number;
  children: ReactNode;
  /**
   * Back, on a phone's second level. Present means the head draws a chevron
   * before the title and Android's back gesture pops a level instead of
   * closing — a phone reaches a section by pushing onto the list, so
   * dismissing from there would throw away a step the person just took.
   */
  onBack?: () => void;
  /**
   * The word beside the back chevron — where Back goes, not where you are.
   *
   * A bare chevron leaves the bar's title as the only thing naming the
   * screen, which is how a section ends up titled twice: once in the bar and
   * once, properly, at the top of its own content. Named, the bar can say
   * "Settings" and the content can carry the heading.
   */
  backLabel?: string;
  onDismiss: () => void;
  testID?: string;
}) {
  const colors = useColors();
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

  /**
   * The phone's bar: a back chevron to the list, the screen's name, the close.
   *
   * Left as it was. A phone is already full-bleed — it never had the panel or
   * the scrim — so the change below is a pointer-width one, and giving the
   * phone a second left-hand control beside its Back would be a bar with two
   * ways out and no room for either.
   */
  const head = (
    <View style={styles.head}>
      {onBack === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={onBack}
          style={backLabel === undefined ? styles.close : styles.back}
          testID={testID ? `${testID}-back` : undefined}
        >
          <Icon name="chevronLeft" size={16} color={colors.accent} />
          {backLabel === undefined ? null : (
            <Text variant="rail" style={styles.backLabel} numberOfLines={1}>
              {backLabel}
            </Text>
          )}
        </Pressable>
      )}
      {title === undefined ? null : (
        <Text
          variant="noteTitle"
          role="heading"
          aria-level={2}
          numberOfLines={1}
          style={styles.title}
        >
          {title}
        </Text>
      )}
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

  /**
   * The pointer bar: out, which context, where you are, and how it is.
   *
   * Reading order is the reader's question order — *how do I get back*, *whose
   * settings are these*, *which screen is this*, *is anything wrong* — and the
   * close is first because on a page that fills the window it is the only
   * thing that is not settings.
   */
  const bar = (
    <View style={styles.bar}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={closeLabel}
        onPress={onDismiss}
        style={styles.out}
        testID={testID ? `${testID}-close` : undefined}
      >
        <Icon name="chevronLeft" size={15} color={colors.muted} />
        <Text variant="rail" style={styles.outLabel} numberOfLines={1}>
          Notes
        </Text>
      </Pressable>
      {badge}
      {breadcrumb === undefined ? null : (
        <Text
          variant="mono"
          style={styles.crumb}
          numberOfLines={1}
          testID={testID ? `${testID}-breadcrumb` : undefined}
        >
          {breadcrumb}
        </Text>
      )}
      <View style={styles.grow} />
      {trailing}
    </View>
  );

  return (
    <Modal
      animationType={reduced ? "none" : "fade"}
      onRequestClose={onDismiss}
      visible
      testID={testID}
    >
      {/*
        A plain View, where this used to be a scrim wrapping a panel that
        swallowed its own presses. With nothing dismissable behind it there is
        no press to swallow and nothing to grey out — and the `accessible=
        {false}` the pair needed goes with them, which is one fewer way for an
        entire settings surface to collapse into a single VoiceOver element.
      */}
      <View
        style={[styles.page, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
        testID={testID ? `${testID}-panel` : undefined}
      >
        {bar}
        <View style={styles.body}>
          {sidebar === undefined ? null : (
            <View style={[styles.side, { width: sidebarWidth }]}>{sidebar}</View>
          )}
          <View style={styles.main} testID={testID ? `${testID}-pane` : undefined}>
            {children}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    /*
      The page. No radius, no cap, no border and no shadow — every one of
      those says "card", and three of them were doing it at once. It paints
      `ground`, the shell colour the rail beside it is painted in, so the bar
      and the list read as one surface and only the pane lifts off it.
    */
    page: {
      flex: 1,
      backgroundColor: colors.ground,
    },
    bar: {
      height: layout.topBarHeight,
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingHorizontal: space.x3,
    },
    /*
      Named, and the name is where it goes rather than what it does. "Close"
      on a dialog is obvious because the thing behind it is visible around its
      edges; on a page that fills the window nothing is, so the control has to
      say what comes back.
    */
    out: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x1,
      height: 32,
      paddingLeft: space.x2,
      paddingRight: space.x3,
      borderRadius: radii.md,
      backgroundColor: colors.surface,
    },
    outLabel: { color: colors.text2 },
    crumb: { color: colors.muted, flexShrink: 1 },
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
    back: {
      flexDirection: "row",
      alignItems: "center",
      gap: 2,
      minHeight: layout.minTouchTarget,
      paddingRight: space.x2,
      marginLeft: -space.x1,
      borderRadius: radii.md,
    },
    backLabel: { color: colors.accent },
    close: {
      width: layout.minTouchTarget,
      height: layout.minTouchTarget,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radii.md,
    },
    body: { flex: 1, flexDirection: "row", minHeight: 0 },
    /*
      No rule down the side of the list. It sits on `ground` and the pane sits
      on `surface`, so the seam is a change of value — which is how this
      palette separates every other pair of panels, and one fewer line on a
      screen that had a border around each of six things.
    */
    side: { backgroundColor: colors.ground },
    /*
      The one corner left on the surface. The pane is the page's content and
      the bar and list are its chrome, so it turns that corner the way a
      window's content area does; the other three run to the edges because
      there is nothing out there to round away from.
    */
    main: {
      flex: 1,
      minWidth: 0,
      backgroundColor: colors.surface,
      borderTopLeftRadius: radii.card,
    },
    phone: { flex: 1, backgroundColor: colors.ground },
    phoneBody: { flex: 1, minHeight: 0 },
  });
