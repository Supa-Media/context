import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { fonts, leading, radii, space, tracking } from "../../design/tokens";
import { pointerType as t } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";

/**
 * A-12 — the soft paywall.
 *
 * A person on the managed tier crosses 1,000 notes and this appears. Not a
 * hard stop: the "Bring my own bucket" escape hatch beside the level-up
 * button is the whole reason the free tier can be small in the first place.
 * The exit promise is restated here in one line so the number never reads as
 * a lock-in.
 */
export function PaymentStep({
  used,
  cap,
  monthly,
  onLevelUp,
  onBringOwn,
}: {
  used: number;
  cap: number;
  monthly: string;
  onLevelUp: () => void;
  onBringOwn: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const pct = Math.min(100, Math.round((used / cap) * 100));

  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        You're using the managed bucket we run for you. It has a soft cap so
        the free tier stays free.
      </Text>

      <View style={styles.panel}>
        <View style={styles.meter}>
          <View style={[styles.meterFill, { width: `${pct}%` }]} />
        </View>
        <Text style={styles.metric}>
          <Text style={styles.metricNum}>{used.toLocaleString()}</Text>
          <Text style={styles.metricDim}> / {cap.toLocaleString()} notes</Text>
        </Text>
        <Text variant="foot" style={styles.metricHint}>
          You've reached the free-tier cap. Nothing has been deleted, and reads
          keep working. New writes pause until you level up or point at your
          own bucket.
        </Text>
      </View>

      <View style={styles.grid}>
        <View style={[styles.card, styles.cardPrimary]}>
          <Text variant="eyebrow" style={styles.eyebrowOn}>
            Level up
          </Text>
          <Text style={styles.cardTitle}>Managed bucket</Text>
          <Text variant="rowSub" style={styles.cardBody}>
            Unlimited notes and up to 25&nbsp;GB. Same bucket, same URL,
            everything you've written stays where it is.
          </Text>
          <Text style={styles.price}>{monthly}</Text>
          <View style={styles.cardAction}>
            <Button label="Level up" variant="white" onPress={onLevelUp} />
          </View>
        </View>
        <View style={[styles.card, styles.cardSecondary]}>
          <Text variant="eyebrow" style={styles.eyebrow}>
            Bring your own
          </Text>
          <Text style={styles.cardTitle}>Point at your bucket</Text>
          <Text variant="rowSub" style={styles.cardBody}>
            Cloudflare R2, Amazon S3, or anything S3-compatible. We export
            everything you've written into it, in one call. Free.
          </Text>
          <View style={styles.cardAction}>
            <Button label="Bring my own bucket" variant="ghost" onPress={onBringOwn} />
          </View>
        </View>
      </View>

      <Text variant="foot" style={styles.exit}>
        <Text style={styles.exitBold}>You can take everything with you, any time — including after you cancel.</Text>{" "}
        Non-negotiable #1, in code.
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    lede: {
      marginBottom: space.x5,
      lineHeight: leading(12.5, 1.7),
      color: colors.text2,
    },
    panel: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.md,
      backgroundColor: colors.surface2,
      padding: space.x5,
      marginBottom: space.x5,
      gap: space.x2,
    },
    meter: {
      height: 6,
      backgroundColor: colors.surface3,
      borderRadius: 3,
      overflow: "hidden",
    },
    meterFill: {
      height: "100%",
      backgroundColor: colors.accent,
    },
    metric: {
      fontFamily: fonts.body,
      fontSize: t.lede,
      color: colors.text,
      marginTop: space.x2,
    },
    metricNum: { fontWeight: "700" },
    metricDim: { color: colors.muted, fontWeight: "500" },
    metricHint: { color: colors.muted, lineHeight: leading(12.5, 1.6) },
    grid: { gap: space.x3 },
    card: {
      borderWidth: 1,
      borderRadius: radii.md,
      padding: space.x5,
      gap: space.x2,
    },
    cardPrimary: {
      borderColor: colors.accent,
      backgroundColor: colors.hintWash,
    },
    cardSecondary: {
      borderColor: colors.line,
      backgroundColor: colors.surface2,
    },
    eyebrow: { color: colors.muted, marginBottom: space.x1 },
    eyebrowOn: { color: colors.accent, marginBottom: space.x1 },
    cardTitle: {
      fontFamily: fonts.display,
      fontSize: t.body,
      fontWeight: "600",
      color: colors.text,
      letterSpacing: tracking(17, -0.015),
    },
    cardBody: { color: colors.text2, lineHeight: leading(12.5, 1.6) },
    price: {
      fontFamily: fonts.display,
      fontSize: t.h3,
      fontWeight: "700",
      color: colors.text,
      marginTop: space.x2,
      letterSpacing: tracking(20, -0.02),
    },
    cardAction: { marginTop: space.x3, flexDirection: "row" },
    exit: {
      marginTop: space.x5,
      color: colors.muted,
      lineHeight: leading(12.5, 1.6),
      paddingTop: space.x4,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    exitBold: { color: colors.text, fontWeight: "600" },
  });
