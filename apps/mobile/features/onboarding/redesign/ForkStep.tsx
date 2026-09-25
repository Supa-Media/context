import { useState } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { Button } from "../../design/components/Button";
import { FormError } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { TextLink } from "../../design/components/TextLink";
import { leading, pointerType as t, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";

/**
 * What "Start fresh" can offer, decided by the control plane — never assumed.
 *
 * `free` where this deployment offers the free managed tier and this owner may
 * start it; `paid` where it can only sell managed storage; `null` where it can
 * do neither (a self-hoster, or production while the free tier is switched
 * off), in which case the only card is bringing what you have.
 */
export type ForkOffer = { kind: "free"; cap: number } | { kind: "paid"; price: string } | null;

/**
 * A-04 — "Where should we start you?"
 *
 * Two cards side by side and one way on, as the canvas draws it:
 *
 *  - **Start fresh** is the selected card, and "Take me to the console →" is
 *    what it does: our bucket, the five standard folders, and straight into
 *    the workspace. It is not a card with its own button inside it — one
 *    screen, one primary action.
 *  - **I already have notes** is a card you press. It goes to the
 *    point-at-your-bucket track, which is a different kind of step (a form and
 *    a report) and so is a different screen rather than a second primary here.
 *
 * Where "Start fresh" cannot be offered at all, the other card is the only one
 * and the primary action is its own.
 */
export function ForkStep({
  offer,
  starting = false,
  failure,
  onPickManaged,
  onPickBYO,
}: {
  offer: ForkOffer;
  /** The bucket has been asked for and the answer is on its way. */
  starting?: boolean;
  /** Our sentence for a start that did not go through. */
  failure?: string;
  onPickManaged: () => void;
  onPickBYO: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const [explaining, setExplaining] = useState(false);
  const sideBySide = width >= 640;

  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        Either path lands you in a working workspace in seconds. You can change your mind later —
        none of this is permanent.
      </Text>

      <View style={[styles.cards, sideBySide && styles.cardsRow]}>
        {offer === null ? null : (
          <View
            style={[styles.card, styles.cardOn, sideBySide && styles.cardHalf]}
            accessibilityRole="radio"
            accessibilityState={{ checked: true }}
            testID="welcome-fork-fresh"
          >
            <Text style={styles.cardTitle}>Start fresh</Text>
            <Text variant="rowSub" style={styles.cardBody}>
              {offer.kind === "free"
                ? `Five folders to get you going, on our free bucket · ${offer.cap.toLocaleString("en-US")} notes. No countdown.`
                : `Five folders to get you going, on a bucket we run for you · ${offer.price}. You see what it covers before anything is charged.`}
            </Text>
            <Text style={styles.cardNote}>
              Setting up for a team? Do this first — you can add a shared workspace from the
              switcher once you're in.
            </Text>
          </View>
        )}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="I already have notes — point at my bucket"
          onPress={onPickBYO}
          style={[styles.card, styles.cardOff, sideBySide && styles.cardHalf]}
          testID="welcome-fork-own"
        >
          <Text style={styles.cardTitle}>I already have notes</Text>
          <Text variant="rowSub" style={styles.cardBody}>
            An Obsidian vault or an S3-compatible bucket. We read what is there — we never move it.
          </Text>
          <Text style={styles.cardNote}>Recommended if this replaces something.</Text>
        </Pressable>
      </View>

      {failure ? <FormError headline={failure} style={styles.failure} /> : null}

      <View style={styles.actions}>
        {offer === null ? (
          <Button
            label="Point at my bucket →"
            variant="accent"
            onPress={onPickBYO}
            testID="welcome-fork-primary"
          />
        ) : (
          <Button
            label={
              starting
                ? "Starting…"
                : offer.kind === "free"
                  ? "Take me to the console →"
                  : // Paid goes to a confirmation of what is charged, not the
                    // console — the label says so.
                    "Continue →"
            }
            variant="accent"
            onPress={onPickManaged}
            disabled={starting}
            testID="welcome-fork-primary"
          />
        )}
        {offer === null ? null : (
          <TextLink
            label="What is the difference?"
            onPress={() => setExplaining((open) => !open)}
            testID="welcome-fork-difference"
          />
        )}
      </View>

      {explaining && offer !== null ? (
        <Text variant="rowSub" style={styles.difference} testID="welcome-fork-explained">
          {offer.kind === "free"
            ? "Start fresh keeps your notes in a bucket we run, free up to "
            : "Start fresh keeps your notes in a bucket we run and bill for, "}
          {offer.kind === "free" ? `${offer.cap.toLocaleString("en-US")} notes. ` : ""}
          Bringing your own keeps them in storage you already pay for, with no note limit. Either
          way they are plain Markdown files, you can download all of them at any time, and you can
          move between the two later from Settings → Storage.
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    lede: { color: colors.text2, fontSize: t.lede, lineHeight: leading(15, 1.6), marginBottom: space.x5 },
    cards: { gap: 12 },
    cardsRow: { flexDirection: "row", alignItems: "stretch" },
    card: {
      borderWidth: 1,
      borderRadius: radii.card,
      paddingVertical: 18,
      paddingHorizontal: 18,
      gap: 4,
    },
    cardHalf: { flex: 1, flexBasis: 0 },
    cardOn: {
      borderColor: colors.accent,
      backgroundColor: colors.hintWash,
      boxShadow: `0 0 0 3px ${colors.hintWash}`,
    },
    cardOff: { borderColor: colors.lineStrong, backgroundColor: colors.surface2 },
    cardTitle: { fontSize: t.lede, fontWeight: "600", color: colors.text },
    cardBody: { color: colors.text2, lineHeight: leading(13, 1.5) },
    cardNote: { marginTop: space.x3, fontSize: t.meta, color: colors.muted, lineHeight: leading(12, 1.5) },
    failure: { marginTop: space.x3 },
    actions: { marginTop: 20, flexDirection: "row", alignItems: "center", gap: 14, flexWrap: "wrap" },
    difference: { marginTop: space.x2, color: colors.text2, lineHeight: leading(13, 1.6) },
  });
