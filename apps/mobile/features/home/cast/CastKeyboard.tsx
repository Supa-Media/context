import { StyleSheet, Text, View } from "react-native";
import { useTheme } from "../../design/theme";
import { castKeyboardType } from "../../design/tokens";
import { castKeyboardLooks } from "../../design/tokens/colors";

const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"] as const;
const KEY = 40;
const GAP = 6;
const ROW_GAP = 11;
const TOP = 8;
const HOME = 24;

/** How tall the keyboard is at `scale`, so the cards above it can make room as it comes up. */
export function keyboardHeight(scale: number): number {
  return Math.round((TOP + 4 * KEY + 3 * ROW_GAP + HOME) * scale);
}

/**
 * The iPhone keyboard a person types a comment on, in a phone's cast (Dev2,
 * 2026-10-01: "you can hear the typing sounds but you cant see it … we should
 * probably have the keyboard come up and simulated"). Drawn, never focused:
 * the key just typed (`pressed`, from `pressedKey`) pops up the way an
 * iPhone's does, in step with the typing sound.
 */
export function CastKeyboard({ pressed, scale = 1 }: { pressed: string | null; scale?: number }) {
  const { scheme } = useTheme();
  const look = castKeyboardLooks[scheme === "dark" ? "dark" : "light"];
  const kh = KEY * scale;
  const key = { height: kh, borderRadius: 5 * scale, backgroundColor: look.key, boxShadow: `0 1px 0 ${look.shadow}` };
  const fn = { ...key, backgroundColor: look.fn };
  const letter = { fontSize: castKeyboardType.key * scale, color: look.ink };
  const small = { fontSize: castKeyboardType.fn * scale, color: look.ink };
  const keyOf = (k: string) => (
    <View key={k} style={[styles.key, key]} testID={pressed === k ? "cast-keyboard-pressed" : undefined}>
      <Text style={letter}>{k}</Text>
      {pressed === k ? (
        <View
          style={[
            styles.pop,
            { bottom: kh * 0.62, height: kh * 1.45, borderRadius: 9 * scale, backgroundColor: look.key, boxShadow: "0 2px 8px rgba(0,0,0,0.28)" },
          ]}
        >
          <Text style={{ fontSize: castKeyboardType.pop * scale, color: look.ink }}>{k}</Text>
        </View>
      ) : null}
    </View>
  );
  return (
    <View
      style={[styles.board, { backgroundColor: look.ground, height: keyboardHeight(scale), paddingTop: TOP * scale, gap: ROW_GAP * scale }]}
      pointerEvents="none"
      aria-hidden
      testID="cast-keyboard"
    >
      <View style={[styles.row, { gap: GAP * scale }]}>{[...ROWS[0]].map(keyOf)}</View>
      <View style={[styles.row, styles.middle, { gap: GAP * scale }]}>{[...ROWS[1]].map(keyOf)}</View>
      <View style={[styles.row, { gap: GAP * scale }]}>
        <View style={[styles.key, styles.wide, fn]}>
          <Text style={small}>⇧</Text>
        </View>
        <View style={[styles.letters, { gap: GAP * scale }]}>{[...ROWS[2]].map(keyOf)}</View>
        <View style={[styles.key, styles.wide, fn]}>
          <Text style={small}>⌫</Text>
        </View>
      </View>
      <View style={[styles.row, { gap: GAP * scale }]}>
        <View style={[styles.key, styles.side, fn]}>
          <Text style={small}>123</Text>
        </View>
        <View style={[styles.key, styles.space, key, pressed === "space" ? { backgroundColor: look.fn } : null]}>
          <Text style={small}>space</Text>
        </View>
        <View style={[styles.key, styles.side, fn, { backgroundColor: look.send }]}>
          <Text style={[small, { color: look.sendInk }]}>send</Text>
        </View>
      </View>
      <View style={styles.home}>
        <View style={[styles.homeBar, { width: 134 * scale, height: 5 * scale, backgroundColor: look.bar }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  board: { paddingHorizontal: 3, overflow: "visible" },
  row: { flexDirection: "row", justifyContent: "center" },
  middle: { paddingHorizontal: "5%" },
  letters: { flex: 7, flexDirection: "row" },
  key: { flex: 1, alignItems: "center", justifyContent: "center" },
  wide: { flex: 1.3 },
  side: { flex: 2.4 },
  space: { flex: 5 },
  pop: { position: "absolute", left: "-25%", right: "-25%", alignItems: "center", justifyContent: "center" },
  home: { flex: 1, alignItems: "center", justifyContent: "flex-end", paddingBottom: 6 },
  homeBar: { borderRadius: 3 },
});
