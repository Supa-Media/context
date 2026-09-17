import { StyleSheet, View } from "react-native";

import type { DotTone } from "../design/components/Dot";
import { Text } from "../design/components/Text";
import { useThemedStyles, type Colors } from "../design/theme";
import { pointerType as t } from "../design/tokens";

/**
 * The workspace's mark: an 18pt rounded square carrying one letter.
 *
 * **It was a `Dot`, and a dot cannot say which workspace this is.** The dot was
 * a *status* light — `tone` is still exactly that — doing two jobs in a control
 * whose entire purpose is identity. The design canvas draws an avatar here, and
 * the letter is what distinguishes `@seyi` from `@lk` at a glance before you
 * have read either.
 *
 * Status did not go with the dot: `tone` picks the mark's fill, so a workspace
 * whose storage is in trouble is still the thing your eye lands on first.
 *
 * ## Why it is its own module
 *
 * It was private to `SwitcherMenu` and the phone wants the same object: the
 * canvas's `Phone-Note` board opens with `[S] @seyi` at the head of the context
 * strip, which is the switcher chip's mark on a different surface. Two copies
 * of an 18pt square with one letter in it is two places for the letter rule to
 * drift — and the rule is not obvious (see `letter` below).
 *
 * Not `AccountBlock`'s `Avatar`, which is a 26pt circle: this is smaller, it is
 * square-with-a-radius rather than round, and the two are different objects — a
 * person and a workspace. Sharing one component would mean a prop with two
 * values, each used in one place.
 */
export function WorkspaceMark({ label, tone }: { label: string; tone: DotTone }) {
  const styles = useThemedStyles(makeStyles);
  /*
    The first letter that is one, so `@seyi` marks S rather than `@`. A label
    with no letters at all — a slug of digits — falls back to the first
    character rather than drawing an empty square.
  */
  const letter = (/\p{L}/u.exec(label)?.[0] ?? label.slice(0, 1)).toUpperCase();
  return (
    <View
      style={[styles.mark, tone === "warn" && styles.markWarn, tone === "crit" && styles.markCrit]}
      aria-hidden
    >
      <Text style={styles.markLetter}>{letter}</Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    mark: {
      width: 18,
      height: 18,
      borderRadius: 5,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.accent,
    },
    markWarn: { backgroundColor: colors.warn },
    markCrit: { backgroundColor: colors.crit },
    /** `ink` is the colour that reads on a filled mark in either scheme. */
    markLetter: { fontSize: t.label, fontWeight: "600", color: colors.ink },
  });
