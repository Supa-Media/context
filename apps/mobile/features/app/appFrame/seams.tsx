import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { useColors, useThemedStyles } from "../../design/theme";
import { makeStyles } from "./styles";

/**
 * The seam left standing where the folded tree was.
 *
 * Two controls in one 10pt strip, and they are different gestures on purpose:
 * **pressing** it brings the column back for good, **resting** on it brings the
 * tree back for as long as the pointer stays. One is a decision and the other
 * is a glance, and a person who only wants to check where a note lives should
 * not have to reflow their editor twice to do it.
 *
 * The delay before a rest counts is what keeps a pointer crossing the seam on
 * its way somewhere else from opening anything.
 */
export function ClosedExplorerSeam({
  peeking,
  onOpen,
  onPeek,
}: {
  peeking: boolean;
  onOpen: () => void;
  onPeek: (peeking: boolean) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  /*
    A pending timer outliving the component would call `onPeek` on a frame that
    is gone — which is what happens every time somebody navigates from Browse to
    Map with the pointer sitting on this seam.
  */
  useEffect(() => cancel, [cancel]);

  return (
    <Pressable
      style={[styles.seamClosed, (hovered || peeking) && styles.seamClosedActive]}
      onPress={() => {
        cancel();
        onOpen();
      }}
      onHoverIn={() => {
        setHovered(true);
        cancel();
        timer.current = setTimeout(() => onPeek(true), PEEK_DELAY_MS);
      }}
      /*
        Hovering out cancels a pending peek but does not close one that is
        already up: the pointer leaving this seam is usually the pointer moving
        *onto* the panel that opened beside it, and closing here would make the
        peek impossible to reach. The panel reports its own exit.
      */
      onHoverOut={() => {
        setHovered(false);
        cancel();
      }}
      role="button"
      accessibilityLabel="Open the file tree"
      testID="explorer-seam-closed"
    >
      <SeamPill shown={hovered || peeking} direction="expand" />
    </Pressable>
  );
}

/**
 * How long the pointer has to rest on the closed seam before the tree peeks.
 *
 * Short enough to feel like a property of the seam rather than a wait; long
 * enough that crossing it on the way to the editor opens nothing. Exported for
 * the render test, which drives it with fake timers rather than guessing.
 */
export const PEEK_DELAY_MS = 300;

/**
 * The chevron centred on a seam, revealed under the pointer.
 *
 * A drawing rather than a control: the seam it sits on is the button, and one
 * press target inside another is how a click lands on the wrong one. It is
 * rendered at `opacity: 0` rather than not at all so that revealing it is a
 * fade and not a layout change under the pointer that caused it.
 */
function SeamPill({ shown, direction }: { shown: boolean; direction: "collapse" | "expand" }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View
      style={[styles.seamPill, shown && styles.seamPillShown]}
      /*
        **A drawing must not take pointer events, and this one was.** The pill is
        18pt wide on a 7pt or 10pt seam — deliberately, because a chevron inside
        a hairline is unreadable — so it overhangs its own seam by several points
        on each side. As a plain child it therefore sat *on top of* whatever was
        next to it: with the tree folded, the closed seam's pill covered the
        rail's seam, and clicking the rail's seam re-opened the file tree
        instead. Found by the browser fixture; jsdom has no pointers to
        intercept, so nothing in the render suite could have seen it.
      */
      pointerEvents="none"
    >
      <Icon
        name={direction === "expand" ? "chevronRight" : "chevronLeft"}
        size={12}
        color={colors.text2}
      />
    </View>
  );
}

/**
 * The leading edge in focus mode, and the pill that ends it.
 *
 * Nothing is drawn until the pointer arrives. The strip exists because the edge
 * of the window is where a hand goes for a panel that was there a moment ago,
 * and finding the note there instead is the moment somebody decides the mode
 * ate their sidebar.
 */
export function FocusEdge({ onLeave }: { onLeave: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [near, setNear] = useState(false);
  return (
    <Pressable
      style={styles.focusEdge}
      onHoverIn={() => setNear(true)}
      onHoverOut={() => setNear(false)}
      onPress={onLeave}
      role="button"
      accessibilityLabel="Bring the panels back"
      testID="frame-focus-edge"
    >
      {near ? (
        <View style={styles.focusExit} testID="frame-focus-exit">
          <Icon name="panelLeft" size={14} color={colors.text2} />
          <Text variant="treeMeta">Panels</Text>
          <Text variant="treeMeta">⌘\</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * One of the two panel toggles in the status bar.
 *
 * Draws the layout rather than naming it: a cell for the panel and a wider one
 * for the document, so the glyph is a two-pane picture that fills in when the
 * panel is out and thins to a bar when the rail is down to its icons. A word
 * would be just as clear and twice as wide, and this bar is 26pt tall.
 */
export function PanelToggle({
  state,
  label,
  chord,
  onPress,
  testID,
}: {
  state: "open" | "half" | "off";
  label: string;
  chord: string;
  onPress: () => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      style={[styles.panelToggle, hovered && styles.panelTogglePressed]}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      role="switch"
      aria-checked={state === "open"}
      accessibilityLabel={`${label} (${chord})`}
      testID={testID}
    >
      <View style={styles.toggleGlyph}>
        <View
          style={[styles.toggleCell, state === "open" && styles.toggleCellOn]}
        />
        <View style={styles.toggleDoc} />
      </View>
    </Pressable>
  );
}
