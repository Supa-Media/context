import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";
import { layout } from "../../design/tokens";
import type { FrameState, Regions } from "../frame";
import { AsideResizer, ExplorerResizer } from "./resizers";
import { ClosedExplorerSeam, FocusEdge } from "./seams";
import type { FrameStyles } from "./styles";

/**
 * `inert`, spread rather than written as a prop.
 *
 * It is a real DOM attribute that react-native-web forwards
 * (`modules/forwardedProps`), and it is not in React Native's `ViewProps` —
 * because on native it means nothing and `accessibilityViewIsModal` on the
 * panel does the job instead. Spreading a typed constant keeps the escape
 * hatch in one named place, the way `css.ts` does for gradients and
 * `cursor: col-resize` does below.
 *
 * `true`, not `""`. The empty string is how the attribute is spelled in HTML
 * and it is dropped on the way to the DOM; only a boolean survives.
 */
const INERT = { inert: true } as unknown as { pointerEvents?: undefined };

/**
 * The frame's body: the explorer column, the seam, the editor, the right
 * panel, and whatever panel lies over the editor.
 *
 * A function returning the element rather than a component, for
 * `frameTopBar`'s reason: the tree stays exactly what `AppFrame` drew inline.
 */
export function frameBody({
  styles,
  regions,
  state,
  explorer,
  explorerFoldable,
  toggleExplorer,
  setExplorerPeeking,
  children,
  setExplorerWidth,
  aside,
  setAsideWidth,
  closeOverlays,
  compact,
  toggleFocus,
  insets,
}: {
  styles: FrameStyles;
  regions: Regions;
  state: FrameState;
  explorer?: ReactNode;
  explorerFoldable: boolean;
  toggleExplorer: () => void;
  setExplorerPeeking: (peeking: boolean) => void;
  children: ReactNode;
  setExplorerWidth: (width: number) => void;
  aside?: ReactNode;
  setAsideWidth: (width: number) => void;
  closeOverlays: () => boolean;
  compact: boolean;
  toggleFocus: () => void;
  insets: EdgeInsets;
}) {
  return (
    <View style={styles.body}>
      {regions.explorer === "column" ? (
        <View style={[styles.explorerColumn, { width: state.explorerWidth }]}>{explorer}</View>
      ) : null}

      {/*
        What is left where the tree was: a seam that is wider than the one
        between two panels, because it is the only thing standing where a
        whole column stood, and because it is a control rather than a rule.

        Drawn for `peek` as well as `hidden` — the peek floats *over* the
        editor and does not take the seam's place, so the seam has to stay
        put underneath it or the pointer resting on it would be resting on
        nothing and the peek would close the instant it opened.
      */}
      {explorerFoldable && (regions.explorer === "hidden" || regions.explorer === "peek") ? (
        <ClosedExplorerSeam
          peeking={regions.explorer === "peek"}
          onOpen={toggleExplorer}
          onPeek={setExplorerPeeking}
        />
      ) : null}

      {/*
        Behind a panel, out of reach — of the pointer via the scrim, and of
        the keyboard and the screen reader via these.

        Without them Tab from the switcher lands *in the note the sheet is
        covering*, and a swipe order walks the whole editor before reaching
        the navigation somebody just asked for. `inert` is forwarded by
        react-native-web and ignored by native; `importantForAccessibility`
        is Android's and ignored on web. Each platform reads its own.
      */}
      <View
        style={styles.editor}
        {...(regions.scrim ? INERT : null)}
        importantForAccessibility={regions.scrim ? "no-hide-descendants" : "auto"}
      >
        {children}
      </View>

      {/*
        The tree's drag handle, **after the editor rather than inside the
        column it resizes**, and that is a hit-testing fact rather than a
        preference.

        It straddles the column's border — a target you can grab is wider
        than a hairline, and people aim *at* the edge rather than a few
        points inside it — so part of it lies over the editor. As the
        column's last child it was drawn there and pressed nowhere: later
        siblings are on top, the editor is a later sibling, and it took
        every press that landed on the outer half of the strip. What that
        felt like is a handle that ignored the first grab and answered the
        second, or answered only a pull that started well inside the tree.

        So it is a sibling of the editor, laid over the border from the
        width the column was given, and painted before the scrim and the
        peek, which still cover it.
      */}
      {regions.explorer === "column" ? (
        <ExplorerResizer
          width={state.explorerWidth}
          onResize={setExplorerWidth}
          onClose={toggleExplorer}
        />
      ) : null}

      {/*
        The right panel as a column, a flex sibling after the editor.

        After it rather than before, because that is where it is on the
        glass and because a row's order is its reading order for a screen
        reader: the tree, the note, then the conversation about the note.
        It takes part in the row, so opening it narrows the note rather
        than covering it — which is the difference between this and the
        `overlay` arm below, and the whole reason `wide` gets one and
        `medium` gets the other.
      */}
      {regions.aside === "column" ? (
        <View style={[styles.asideColumn, { width: state.asideWidth }]}>{aside}</View>
      ) : null}

      {/*
        Its drag handle, a sibling laid over the column's leading border
        for `ExplorerResizer`'s hit-testing reason — a target you can grab
        is wider than a hairline, so part of it lies over the editor, and
        as the column's own child the editor would take those presses.
      */}
      {regions.aside === "column" ? (
        <AsideResizer width={state.asideWidth} onResize={setAsideWidth} />
      ) : null}

      {/*
        The panels are painted last so they lie over the editor without any
        z-index arithmetic — in React Native, later siblings are on top, and
        `zIndex` is the thing that behaves differently between the two
        platforms. Only ever one of them is up (`frame.ts` resolves it), so
        their order relative to each other decides nothing.
      */}
      {regions.scrim ? (
        <Pressable
          style={[
            styles.scrim,
            /*
              **The scrim starts where the editor does, not where the body
              does.**

              At `medium` the right panel is over the *note* while the tree
              keeps its column, so a full-body scrim would grey out and
              make inert a region that is still live — and the way out of
              the panel is often "press the file I actually wanted", which
              a scrim over the tree would swallow. `appFrame.test.ts` states
              the region half of this rule and says out loud that the "not
              covered by it" half is a drawing fact, which is this line.

              Zero when the tree is not a column, which is every drawer
              case: there is no column to keep clear of.
            */
            regions.explorer === "column" ? { left: state.explorerWidth } : null,
          ]}
          onPress={closeOverlays}
          // It is focusable — `Pressable` gives it a tab stop — so it needs
          // a role as well as a name. Labelled and roleless, a screen
          // reader announces a stop it cannot describe.
          role="button"
          accessibilityLabel="Close this panel"
          testID="frame-scrim"
        />
      ) : null}

      {/*
        The right panel as an overlay, at `medium`, painted after the scrim
        so it lies over it — later siblings are on top, which is the same
        ordering rule the peek below relies on.
      */}
      {regions.aside === "overlay" ? (
        <View style={[styles.asideOverlay, { width: state.asideWidth }]}>{aside}</View>
      ) : null}

      {/*
        The peek: the folded tree, back over the editor while the pointer
        rests on its seam.

        **Absolutely positioned rather than a flex sibling, which is the
        point of it.** A panel that took part in the row would push the
        editor across every time the pointer crossed the seam, and the
        paragraph somebody is reading would jump under their eyes. This
        floats, so nothing reflows, and the note stays exactly where it was
        — which is what makes folding the tree away a cheap decision rather
        than a commitment.

        No scrim, deliberately, and that is why `peek` is its own arm of
        `Regions.explorer` rather than the `drawer` with the scrim
        suppressed: it is dismissed by moving the pointer away, and a scrim
        would grey out and make inert the note being peeked at in order to
        reach.

        `left` is arithmetic on tokens rather than a measurement, so it is
        correct on the first frame. Measuring the rail would put the panel
        at zero for a frame and slide it into place, which reads as a bug.
      */}
      {regions.explorer === "peek" ? (
        <Pressable
          style={[
            styles.explorerPeek,
            styles.panelRounded,
            {
              left: layout.seamWidth + layout.seamClosedWidth,
              width: state.explorerWidth,
            },
          ]}
          /*
            The pointer leaving the panel ends the peek, exactly as it
            leaving the seam does. Both send `false`, and `setExplorerPeeking`
            is idempotent so the pair costs one render rather than two.
          */
          onHoverOut={() => setExplorerPeeking(false)}
          onHoverIn={() => setExplorerPeeking(true)}
          /*
            A hover surface, so not a tab stop. `Pressable` gives every
            instance a `tabIndex` and the scrim a few lines down states the
            rule this would otherwise break: labelled and roleless, a screen
            reader announces a stop it cannot describe — and this one would
            be roleless *and* nameless, sitting between the rail and the
            note. The tree inside carries the semantics; this only carries
            the pointer.

            `tabIndex` rather than `focusable`: react-native-web's
            `Pressable` reads the first and ignores the second, so the
            obvious spelling compiles, renders `tabindex="0"` anyway, and is
            only caught by asserting the attribute.
          */
          tabIndex={-1}
          testID="explorer-peek"
        >
          {explorer}
        </Pressable>
      ) : null}

      {/*
        Focus mode's way back.

        A strip of the leading edge that draws nothing and holds a pill once
        the pointer arrives, because the edge of the window is where a hand
        goes looking for a panel that was there a moment ago. ⌘\ and Escape
        both do the same thing; this is for the hand that reaches before it
        remembers.
      */}
      {state.focus && !compact ? <FocusEdge onLeave={toggleFocus} /> : null}

      {regions.explorer === "drawer" ? (
        <View
          /*
            A panel is full height now, because the body is: the chrome
            floats over it rather than sitting above it. So the panel runs
            from the top of the glass to the bottom, the way Obsidian's
            sidebar does, and pays for what is over it in padding — the top
            clears the status bar, the bottom the home indicator.

            **The toolbar is not at that edge while this is up** — see
            `toolbarHidden` — so the bottom is `insets.bottom` rather than
            `contentInsets.bottom` at both densities. Reserving the
            toolbar's band anyway would put a hand's width of dead panel
            under the count line, which is the second half of the same bug:
            the bar was drawn there *and* paid for there.

            **It does not clear the toggle**, and that was 34pt of dead
            space above the first row of the tree — measured at 126pt
            against the reference's 92. The toggle crossed to the sliver of
            note the moment a panel was up, so it was not over this surface
            at all; paying `contentInsets.top` here was reserving room for a
            control that had moved out of the way. `panelGutter` is what is
            left: the air Obsidian leaves between the status bar and its
            first row.

            The toggle itself is gone, along with the style this once cited
            by name (`toggleOnSliver`, which no longer exists as a symbol
            anywhere). A phone has no panel to raise, so nothing raises one.
            The arithmetic is unchanged and is kept in the past tense.

            All of it is on the panel rather than inside the tree's own
            scroller, which is what keeps rows from riding up under the
            clock once the tree is longer than the glass.
          */
          style={[
            styles.drawer,
            compact && styles.panelRounded,
            compact
              ? {
                  paddingTop: insets.top + layout.panelGutter,
                  paddingBottom: insets.bottom,
                }
              : { paddingBottom: insets.bottom },
          ]}
          accessibilityViewIsModal
          testID="frame-drawer"
        >
          {explorer}
        </View>
      ) : null}

    </View>
  );
}
