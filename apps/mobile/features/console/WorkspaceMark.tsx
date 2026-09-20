import { Image, StyleSheet, View } from "react-native";

import type { DotTone } from "../design/components/Dot";
import { Text } from "../design/components/Text";
import { useThemedStyles, type Colors } from "../design/theme";
import { pointerType as t } from "../design/tokens";
import type { MarkIcon } from "./useWorkspaceIcons";

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
 *
 * ## The letter is now the *fallback*, not the drawing
 *
 * It was the whole component, and it is a good default that stops
 * distinguishing the moment somebody holds two contexts whose names start
 * alike: `@seyi` and `@supa` are both **S**, in the same square, in the same
 * colour, side by side. An owner can choose a photo or an emoji instead, and
 * this draws whichever of the three it is handed.
 *
 * **It still never fetches.** A photo arrives already resolved to a `uri` by
 * `useWorkspaceIcons`, which is where the action call and the cache live —
 * this component is mounted three or four times on one screen for the same
 * workspace, and a fetch in here would be one request per mount of a picture
 * that cannot have changed.
 */
export function WorkspaceMark({
  label,
  tone,
  icon,
}: {
  label: string;
  tone: DotTone;
  /** The owner's choice, resolved. Absent — and a photo still loading — is the letter. */
  icon?: MarkIcon;
}) {
  const styles = useThemedStyles(makeStyles);
  /*
    The first letter that is one, so `@seyi` marks S rather than `@`. A label
    with no letters at all — a slug of digits — falls back to the first
    character rather than drawing an empty square.
  */
  const letter = (/\p{L}/u.exec(label)?.[0] ?? label.slice(0, 1)).toUpperCase();
  /*
    A PHOTO FILLS THE SQUARE AND KEEPS THE STATUS RING.

    The fill is what `tone` paints, and a photo covers it — so a workspace whose
    storage is in trouble would lose the one signal that made it the thing your
    eye lands on. The photo is inset by a point and the tone stays visible as
    the edge around it, which keeps both facts on one 18pt object: whose it is,
    and whether it is working.

    `resizeMode="cover"` rather than `contain`: these are square and photos are
    not, and a letterboxed avatar in a rail reads as a broken image.

    React Native's own `Image` rather than `expo-image`. The source is a `data:`
    URI that `useWorkspaceIcons` has already cached for the session, so the
    caching and the transitions that would justify the heavier component have
    nothing left to do here — and the built-in maps through `react-native-web`,
    which this app already ships to and which the test suite already renders.
  */
  if (icon?.kind === "photo") {
    return (
      <View
        style={[
          styles.mark,
          tone === "warn" && styles.markWarn,
          tone === "crit" && styles.markCrit,
        ]}
        aria-hidden
      >
        <Image source={{ uri: icon.uri }} style={styles.markPhoto} resizeMode="cover" />
      </View>
    );
  }
  return (
    <View
      style={[styles.mark, tone === "warn" && styles.markWarn, tone === "crit" && styles.markCrit]}
      aria-hidden
    >
      {icon?.kind === "emoji" ? (
        /*
          An emoji is drawn on the tone rather than instead of it, so the same
          two facts stay on the square. `markEmoji` drops the weight and the
          colour the letter needs — a colour emoji ignores `color`, but a
          monochrome one (✏️, ⚖️, ⭐ without its variation selector on some
          platforms) does not, and would otherwise come out in `ink`.
        */
        <Text style={styles.markEmoji}>{icon.emoji}</Text>
      ) : (
        <Text style={styles.markLetter}>{letter}</Text>
      )}
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
    /*
      No `color` and no weight: an emoji is its own artwork. `ui` rather than
      the letter's `label`, because a glyph with no ascender to spare reads
      smaller than a capital at the same size — and a role from the scale
      rather than `label + 2`, which is a literal wearing a token's clothes.
    */
    markEmoji: { fontSize: t.ui, lineHeight: 17 },
    /** Inset by a point, so `tone` survives as the ring around the photo. */
    markPhoto: { width: 16, height: 16, borderRadius: 4 },
  });
