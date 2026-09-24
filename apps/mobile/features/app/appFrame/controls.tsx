import { useState } from "react";
import { Platform, Pressable } from "react-native";
import { Icon, type IconName } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { useColors, useThemedStyles } from "../../design/theme";
import { makeStyles } from "./styles";

/* -------------------------------------------------------------------------- */
/*                                   pieces                                   */
/* -------------------------------------------------------------------------- */

/**
 * ⌘K.
 *
 * It said "Search notes and commands" and there are no commands. A field that
 * names a thing it does not contain teaches somebody to type a verb into it,
 * get nothing back, and stop using it — and the same words were its accessible
 * name, so a screen reader announced the same promise.
 *
 * It says what the palette's own placeholder says, and the two agreeing is the
 * point: the trigger and the thing it opens should not describe two different
 * tools.
 */
export function SearchTrigger({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      role="button"
      accessibilityLabel="Search this context"
      testID="frame-search"
      style={[styles.search, hovered && styles.searchHover]}
    >
      <Icon name="search" size={13} color={colors.chromeMuted} />
      {Platform.OS === "web" ? (
        <Text variant="treeMeta" style={styles.kbd}>
          ⌘K
        </Text>
      ) : (
        <Text variant="rowSub">Search</Text>
      )}
    </Pressable>
  );
}

/**
 * A control in the frame's chrome.
 *
 * Two shapes, and the difference is not decoration. Under a pointer it is a
 * 30pt square that tints on hover, sitting in a ruled bar — the hover is what
 * says it is a control, so the resting state can be nothing at all, and 30 is
 * fine because the *bar* around it is the 44pt band.
 *
 * A phone has no hover and no band. `round` gives it a filled circle with a
 * shadow, at `layout.chromeButton` — which is exactly `minTouchTarget`, and
 * derived from it rather than typed, because here the visible circle is the
 * whole target and there is no padding around it to make up a shortfall.
 */
export function FrameIconButton({
  label,
  icon,
  onPress,
  round = false,
  grouped = false,
  testID,
}: {
  label: string;
  icon: IconName;
  onPress: () => void;
  /*
    There is no `selected` here, and its removal is the point rather than a
    tidy-up. It lit this button with `accentDim` for exactly one caller — the
    note's read toggle — on the argument that one mark cannot draw both "will
    hide the markup" and "will bring it back", so the state had to live in the
    fill. That toggle now swaps its glyph between `eye` and `pencil`, which says
    the same thing in the place a reader is already looking, and a lit *pencil*
    would have contradicted it: a lit control here means "this mode is on",
    while the pencil means "press to start editing". The prop went with its last
    caller rather than staying as a facility nobody uses and the next person has
    to reason about. See `docs/decisions/app-and-console.md`.
  */
  /** The phone's shape: a filled circle lying over the document. */
  round?: boolean;
  /**
   * Inside the top bar's trailing capsule: a phone-sized target with no
   * surface of its own.
   *
   * The container is the object — one fill, one radius, one shadow, however
   * many actions are in it — so a button that brought its own would be the
   * nested-rounded-box defect this branch removed from the other corner. It
   * still clears `minTouchTarget`, because the target is what a thumb hits and
   * the capsule around it is only what a reader sees.
   */
  grouped?: boolean;
  testID?: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      role="button"
      accessibilityLabel={label}
      testID={testID}
      style={({ pressed }) => [
        styles.iconButton,
        grouped && styles.iconButtonGrouped,
        round && styles.iconButtonRound,
        // `iconButtonHover` tints an untinted square; on a filled circle it
        // would paint `surface3` *over* `chrome`, which is darker than the
        // resting state and reads as the control switching off. The circle
        // lights the way it does under a thumb instead — this is reachable on
        // a narrowed desktop browser, which is a real surface here.
        hovered && (round ? styles.iconButtonPressed : styles.iconButtonHover),
        (round || grouped) && pressed && styles.iconButtonPressed,
      ]}
    >
      <Icon name={icon} size={round || grouped ? 20 : 17} color={colors.text2} />
    </Pressable>
  );
}
