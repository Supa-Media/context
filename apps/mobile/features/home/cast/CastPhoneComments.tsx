import { StyleSheet, View, type ViewStyle } from "react-native";
import { layout, space } from "../../design/tokens";
import { motion } from "../../design/tokens/motion";
import type { CastComments } from "./castComments";
import { pressedKey } from "./castComments";
import { CastCommentCard } from "./CastCommentCard";
import { CastKeyboard, keyboardHeight } from "./CastKeyboard";

/** The floating search bar's room, as the frame reserves it (`layout.floatingInset`). */
const BAR_ROOM = layout.bottomBarHeight + layout.floatingInset + layout.floatingGap;

/**
 * A phone's comments, at the foot of Context's window: the latest as a card,
 * the one before it faded behind (`CastCommentCard`), and while a person
 * types one, the keyboard they type it on, coming up from the bottom and
 * pushing the cards up with it (Dev2, 2026-10-01). `keyboard: off` in the
 * script leaves it down.
 *
 * `overBar`: the frame has its floating search bar, so the cards rest above
 * it (the keyboard, when it comes up, covers it, as an iPhone's does).
 */
export function CastPhoneComments({
  comments,
  keyboard,
  colors,
  overBar,
  scale = 1,
}: {
  comments: CastComments;
  keyboard: boolean;
  colors?: ReadonlyMap<string, string>;
  overBar: boolean;
  scale?: number;
}) {
  const { current, ghost } = comments;
  const typing = keyboard && current?.draft === true;
  const room = typing ? keyboardHeight(scale) : overBar ? BAR_ROOM : space.x3;
  return (
    <View style={styles.foot} pointerEvents="none">
      {current === null ? null : (
        <View style={styles.cards}>
          {ghost !== null ? <CastCommentCard said={ghost} badge={colors?.get(ghost.who)} ghost /> : null}
          <CastCommentCard said={current} badge={colors?.get(current.who)} />
        </View>
      )}
      <View style={{ height: room, transition: `height ${motion.layoutMs}ms ${motion.ease}` } as ViewStyle} />
      {keyboard ? (
        // Below the window until somebody types, then up from the bottom edge.
        <View
          style={[
            styles.keyboard,
            { transform: typing ? "translateY(0)" : "translateY(100%)", transition: `transform ${motion.layoutMs}ms ${motion.ease}` } as ViewStyle,
          ]}
        >
          <CastKeyboard pressed={typing ? pressedKey(current.text) : null} scale={scale} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  foot: { position: "absolute", left: 0, right: 0, bottom: 0, overflow: "hidden" },
  // Room above for the cards' shadow, which the foot would otherwise clip.
  cards: { gap: space.x2, paddingHorizontal: space.x3, paddingTop: space.x5, paddingBottom: space.x2 },
  keyboard: { position: "absolute", left: 0, right: 0, bottom: 0 },
});
