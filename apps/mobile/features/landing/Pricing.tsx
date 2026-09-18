import { StyleSheet, View } from "react-native";

import { Icon } from "../design/components/Icon";
import { PressRow } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { fonts, leading, pointerType as t, radii, space, tracking } from "../design/tokens";
import {
  FREE_BODY,
  FREE_CTA,
  FREE_LABEL,
  FREE_POINT_FOUR,
  FREE_POINT_ONE,
  FREE_POINT_THREE,
  FREE_POINT_TWO,
  FREE_TITLE,
  PAID_BADGE,
  PAID_BODY,
  PAID_CTA,
  PAID_LABEL,
  PAID_POINT_FOUR,
  PAID_POINT_ONE,
  PAID_POINT_THREE,
  PAID_POINT_TWO,
  PAID_PRICE,
  PAID_PRICE_NOTE,
  PRICING_EYEBROW,
  PRICING_TITLE,
} from "./pricingCopy";

/**
 * THE TWO PLANS, AS `Landing-Sections.dc.html` DRAWS THEM.
 *
 * A paper card and a graphite one, side by side, each with a label, a
 * headline, a paragraph, its ticks and its own call to action. The words and
 * every figure in them are `pricingCopy.ts` — including two places where this
 * deliberately does not say what the board says, argued there.
 *
 * ## Why the paid card is dark in both palettes
 *
 * The same rule the endpoint bar already follows, and `tokens.ts`'s `app*`
 * group is written for: this is the product's own surface quoted inside a
 * page, not a panel of the page. On paper the board draws it graphite too, and
 * re-tinting it produces a cream card with cream chrome that reads as a second
 * free plan rather than as the one you pay for. See
 * `docs/decisions/app-and-console.md`, "A picture of the application does not
 * invert with the page it sits on".
 *
 * ## Both cards begin the same way
 *
 * Each action runs the hero's primary button's own handler, because there is one
 * way to begin and a pricing card is not a second checkout. A card whose
 * button opened a payment page would be selling storage to somebody with no
 * workspace to put it on — and the paid card's own label says so: *start free,
 * add storage later*.
 */
export function Pricing({ onPress }: { onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);

  return (
    <View style={styles.pricing} testID="landing-pricing">
      <View style={styles.head}>
        <Text style={styles.eyebrow}>{PRICING_EYEBROW}</Text>
        <View role="heading" aria-level={2}>
          <Text style={styles.title}>{PRICING_TITLE}</Text>
        </View>
      </View>

      <View style={styles.cards}>
        <View style={styles.card} testID="pricing-free">
          <Text style={styles.label}>{FREE_LABEL}</Text>
          <Text style={styles.amount}>{FREE_TITLE}</Text>
          <Text style={styles.body}>{FREE_BODY}</Text>
          <View style={styles.points}>
            {[FREE_POINT_ONE, FREE_POINT_TWO, FREE_POINT_THREE, FREE_POINT_FOUR].map(
              (point) => (
                <Point key={point} text={point} />
              ),
            )}
          </View>
          <Action label={FREE_CTA} onPress={onPress} />
        </View>

        <View style={[styles.card, styles.cardPaid]} testID="pricing-managed">
          <View style={styles.labelRow}>
            <Text style={[styles.label, styles.labelPaid]}>{PAID_LABEL}</Text>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{PAID_BADGE}</Text>
            </View>
          </View>
          <Text style={[styles.amount, styles.amountPaid]}>{PAID_PRICE}</Text>
          {/*
            The early-tester sentence sits directly under the number, which is
            where the number is read. `premium.ts` holds the wording and the
            reason it is one constant; `docs/decisions/billing.md` records that
            its second half is a commitment on the Stripe side rather than a
            turn of phrase.
          */}
          <Text style={[styles.priceNote, styles.bodyPaid]}>{PAID_PRICE_NOTE}</Text>
          <Text style={[styles.body, styles.bodyPaid]}>{PAID_BODY}</Text>
          <View style={styles.points}>
            {[PAID_POINT_ONE, PAID_POINT_TWO, PAID_POINT_THREE, PAID_POINT_FOUR].map(
              (point) => (
                <Point key={point} text={point} paid />
              ),
            )}
          </View>
          <Action label={PAID_CTA} onPress={onPress} paid />
        </View>
      </View>
    </View>
  );
}

function Point({ text, paid = false }: { text: string; paid?: boolean }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.point}>
      <View style={styles.tick} aria-hidden>
        {/*
          `appAccent` on the graphite card and `accent` on the paper one. The
          card does not invert with the page, so its marks cannot either — a
          paper-palette accent on graphite is the one colour on the card that
          would belong to the website rather than to the thing being sold.
        */}
        <Icon name="check" size={13} color={paid ? colors.appAccent : colors.accent} />
      </View>
      <Text style={[styles.pointText, paid && styles.pointTextPaid]}>{text}</Text>
    </View>
  );
}

/**
 * A card's action.
 *
 * `PressRow` rather than `Button`: this is a full-width block with centred
 * text, and `Button`'s variants are sized for a control in a row of controls.
 * `PressRow` takes the geometry as a style and still carries the hover, the
 * radius and the accessible name the rest of this page's press targets have.
 */
function Action({
  label,
  onPress,
  paid = false,
}: {
  label: string;
  onPress: () => void;
  paid?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <PressRow
      accessibilityLabel={label}
      onPress={onPress}
      radius={radii.lg}
      style={[styles.action, paid && styles.actionPaid]}
      hoverStyle={paid ? styles.actionPaidHover : styles.actionHover}
      testID={paid ? "pricing-managed-cta" : "pricing-free-cta"}
    >
      <Text style={[styles.actionLabel, paid && styles.actionLabelPaid]}>{label}</Text>
    </PressRow>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    pricing: { marginTop: 72 },
    head: { marginBottom: space.x5 },
    eyebrow: {
      fontFamily: fonts.body,
      fontSize: t.label,
      lineHeight: leading(t.label, 1.55),
      fontWeight: "600",
      letterSpacing: tracking(t.label, 0.13),
      textTransform: "uppercase",
      color: colors.muted,
      marginBottom: space.x2,
    },
    title: {
      fontFamily: fonts.display,
      fontSize: t.title,
      lineHeight: leading(t.title, 1.15),
      fontWeight: "600",
      letterSpacing: tracking(t.title, -0.025),
      color: colors.text,
    },

    /*
      Two cards that become one column, by `flexWrap` rather than a breakpoint
      — `Sections.tsx`'s own rule, and the same reason: a pair of cards does
      not need to know the width to know it should stack.
    */
    cards: { flexDirection: "row", flexWrap: "wrap", gap: space.x5 },
    card: {
      flexGrow: 1,
      flexBasis: 380,
      minWidth: 280,
      // A column, so the action below can take the slack with `marginTop`.
      flexDirection: "column",
      borderRadius: radii.xl,
      padding: 28,
      backgroundColor: colors.surface2,
    },
    /** Graphite in both palettes — see the header. */
    cardPaid: { backgroundColor: colors.appSurface },

    labelRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.x2 },
    label: {
      fontFamily: fonts.body,
      fontSize: t.label,
      lineHeight: leading(t.label, 1.55),
      fontWeight: "600",
      letterSpacing: tracking(t.label, 0.13),
      textTransform: "uppercase",
      color: colors.muted,
    },
    labelPaid: { color: colors.appMuted },
    badge: {
      height: 20,
      justifyContent: "center",
      paddingHorizontal: 8,
      borderRadius: radii.pill,
      backgroundColor: colors.appChip,
    },
    badgeText: {
      fontFamily: fonts.body,
      fontSize: t.label,
      lineHeight: leading(t.label, 1.2),
      fontWeight: "500",
      color: colors.appAccent,
    },

    amount: {
      marginTop: space.x2,
      fontFamily: fonts.display,
      fontSize: t.h2,
      lineHeight: leading(t.h2, 1.2),
      fontWeight: "600",
      letterSpacing: tracking(t.h2, -0.03),
      color: colors.text,
    },
    amountPaid: { color: colors.appInk },
    priceNote: {
      marginTop: space.x1,
      fontFamily: fonts.body,
      fontSize: t.ui,
      lineHeight: leading(t.ui, 1.5),
      color: colors.muted,
    },
    body: {
      marginTop: space.x2,
      fontFamily: fonts.body,
      fontSize: t.lede,
      lineHeight: leading(t.lede, 1.6),
      color: colors.muted,
    },
    bodyPaid: { color: colors.appMuted },

    /* The 22 below the ticks lives here, because the action's own top margin is `auto`. */
    points: { marginTop: space.x4, marginBottom: 22, gap: 9 },
    point: { flexDirection: "row", gap: 10 },
    tick: { paddingTop: 3 },
    pointText: {
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      fontFamily: fonts.body,
      fontSize: t.ui,
      lineHeight: leading(t.ui, 1.5),
      color: colors.text2,
    },
    pointTextPaid: { color: colors.appBody },

    action: {
      /*
        `auto`, so both cards' actions sit on the same line however many ticks
        each carries — which is what the board draws and what makes two cards
        read as one comparison rather than as two boxes. The margin below is
        the floor when the card has room to spare.
      */
      marginTop: "auto",
      height: 44,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: radii.lg,
      backgroundColor: colors.rowSelected,
    },
    actionHover: { backgroundColor: colors.chipFill },
    actionPaid: { backgroundColor: colors.appAccent },
    actionPaidHover: { backgroundColor: colors.appChipHover },
    actionLabel: {
      fontFamily: fonts.body,
      fontSize: t.lede,
      lineHeight: leading(t.lede, 1.4),
      fontWeight: "500",
      color: colors.text,
    },
    actionLabelPaid: { color: colors.appSurface },
  });
