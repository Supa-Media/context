import type { ReactNode } from "react";
import { View } from "react-native";
import { layout } from "../../design/tokens";
import type { Regions } from "../frame";
import { PanelToggle } from "./seams";
import type { FrameStyles } from "./styles";

/**
 * The status row along a pointer layout's bottom edge, with the frame's own
 * panel toggle at its leading end. A function returning the element, for
 * `frameTopBar`'s reason.
 */
export function frameStatusRow({
  styles,
  regions,
  status,
  hasExplorer,
  toggleExplorer,
  account,
}: {
  styles: FrameStyles;
  regions: Regions;
  status?: ReactNode;
  hasExplorer: boolean;
  toggleExplorer: () => void;
  account?: ReactNode;
}) {
  return (
    regions.statusBar && status ? (
      <View style={styles.status}>
        {/*
          The account button, while the tree that normally carries it at its
          foot is not a column — folded away, peeking, or absent on this
          route. The bottom-left corner either way, so the button does not
          jump to the other end of the window when the tree folds.
        */}
        {account != null && regions.explorer !== "column" ? (
          <View style={styles.statusAccount}>{account}</View>
        ) : null}
        {/*
          The two panel toggles, at the leading edge where VS Code, Zed and
          every editor with a foldable sidebar put them.

          They are the frame's own and not part of the `status` node
          because they are geometry, which is the only thing this component
          knows about — the counts and the save state beside them belong to
          whatever is in the editor.

          Two controls for one action, with the seam, is deliberate and the
          split is clean: **the seam is the gesture and the status bar is
          the state**. The seam costs nothing at rest because it is only
          revealed under the pointer, and a person who has folded something
          away and forgotten what needs somewhere that never moves to look.
          It is also the only one of the two a keyboard can reach by
          tabbing, and the only one left standing in focus mode.
        */}
        {hasExplorer ? (
          <PanelToggle
            testID="status-toggle-explorer"
            label="File tree"
            chord="⌘B"
            state={regions.explorer === "column" ? "open" : "off"}
            onPress={toggleExplorer}
          />
        ) : null}
        <View style={styles.statusDivider} />
        {/*
          The bar takes the rest of the row, which is what puts its
          trailing group against the trailing edge.

          Without this it shrank to its contents and the whole strip — the
          path, the counts, the save state and the bucket — sat bunched
          against the toggle with 900pt of empty bar after it. The
          `StatusBar` has always had the spacer that separates its two
          groups; it had nothing to spread across.
        */}
        <View style={styles.statusFill}>{status}</View>
      </View>
    ) : null
  );
}

/**
 * The phone's floating toolbar slot. A function returning the element, for
 * `frameTopBar`'s reason.
 */
export function frameBottomBar({
  styles,
  bottomBarShowing,
  chromeGap,
  bottomBar,
}: {
  styles: FrameStyles;
  bottomBarShowing: boolean;
  chromeGap: number;
  bottomBar?: ReactNode;
}) {
  /*
    The toolbar's room, and both of its edges.

    `max` rather than a sum: on a notched phone the home indicator's inset
    is already a gap, and adding the float inset on top of it is the "bar
    floating 68px above the home indicator" `BottomBar` warns about. On a
    phone or a browser with no inset there is nothing, and a pill flush
    against the bottom of the glass is not a floating object. So the pill
    gets whichever gap is larger, from here, and `BottomBar` sets nothing
    on that edge at all.

    The floor is `floatingGap` (25), measured off the reference, not the
    10pt `floatingInset` that used to serve here — at 10 the pill sat
    near enough to the edge to read as attached to it. See the token.
  */
  /*
    Not while the keyboard accessory bar is up — see `toolbarHidden`. The
    reference has no bottom bar in either screenshot, and two floating bars
    in the same 66pt of glass is worse than either.

    `toolbarHidden`'s other arm is `regions.scrim`, which is false at every
    density now that no panel comes in over the editor. It is still read
    rather than dropped, for the reason `frame.ts`'s enumeration gives for
    keeping the panels representable at all; what is corrected here is a
    comment that named the dead arm first, as if the common case were a
    drawer rather than the keyboard.
  */
  return (
    bottomBarShowing ? (
      <View
        style={[
          styles.bottomBar,
          {
            paddingTop: layout.floatingInset,
            paddingBottom: chromeGap,
            /*
              The sliver of note showing either side, from here rather than
              from whatever the bar happens to contain. See
              `layout.bottomBarInset`: sizing the pill to its own controls
              made the gap a function of how many actions the current route
              has, so a context somebody is only a member of — no New note —
              drew the bar 78pt in on a screen where the reference is 52.

              **It is 24, and this comment said 52.** That was the
              measurement off the reference and it is what the token *was*;
              the seventh key was bought with it, because seven targets do
              not clear the touch floor inside a pill inset by 52. The
              number is not repeated here at all now — the token is the one
              place it lives, and a second spelling of it is how the two
              drift.
            */
            paddingHorizontal: layout.bottomBarInset,
          },
        ]}
        /*
          The toolbar floats over the document; only the document's own
          last line needs to clear it, and `contentInsets.bottom` is how it
          does. This band therefore must not eat presses aimed at the text
          running behind it — only the pill inside it may.
        */
        pointerEvents="box-none"
      >
        {bottomBar}
      </View>
    ) : null
  );
}
