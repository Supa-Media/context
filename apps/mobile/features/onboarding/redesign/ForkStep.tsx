import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { fonts, leading, radii, space, tracking } from "../../design/tokens";
import { pointerType as t } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { FormError } from "../../design/components/Input";

/**
 * What the first card offers, decided by the control plane — never assumed.
 *
 * `free` where this deployment offers the free managed tier and this owner
 * may start it; `paid` where it can only sell managed storage; `null` where it
 * can do neither (a self-hoster, or production before the exit path lands), in
 * which case the only card is bringing a bucket.
 */
export type ForkOffer = { kind: "free"; cap: number } | { kind: "paid"; price: string } | null;

/**
 * A-04 — the fork.
 *
 * One binary question the six-step flow used to fold into the storage step: do
 * you have a bucket already, or do you want us to run one? Asking it here means
 * the storage step can be one shape rather than three, and the person who
 * chose "run one for me" never sees the connect form.
 *
 * A third row is present but framed as an escape hatch: somebody who arrived
 * with an invitation is not signing up for their own context, and the flow
 * should route them out rather than push them through the branches.
 */
export function ForkStep({
  offer,
  starting = false,
  failure,
  onPickManaged,
  onPickBYO,
  onOpenInvitations,
}: {
  offer: ForkOffer;
  /** The free bucket has been asked for and the answer is on its way. */
  starting?: boolean;
  /** Our sentence for a start that did not go through. */
  failure?: string;
  onPickManaged: () => void;
  onPickBYO: () => void;
  onOpenInvitations: () => void;
}) {
  const styles = useThemedStyles(makeStyles);

  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        Where should your context live? Every path keeps the notes as plain
        Markdown files you can take with you at any time.
      </Text>

      {offer?.kind === "free" ? (
        <Choice
          eyebrow="Recommended"
          title="Start on a bucket we run"
          body={`Free for your first ${offer.cap.toLocaleString("en-US")} notes. No card and no time limit. Past that you can keep reading, editing and exporting everything; adding more notes asks you to level up or bring a bucket of your own.`}
          cta={starting ? "Starting…" : "Start free"}
          onPress={onPickManaged}
          variant="primary"
          disabled={starting}
          testID="welcome-fork-free"
        />
      ) : offer?.kind === "paid" ? (
        <Choice
          eyebrow="We run it"
          title="Let us keep the bucket"
          body={`A bucket we create and run for you, ${offer.price}. You see the price and what it covers before anything is charged.`}
          cta="Choose managed storage"
          onPress={onPickManaged}
          variant="secondary"
          testID="welcome-fork-managed"
        />
      ) : null}
      {failure ? <FormError headline={failure} style={styles.failure} /> : null}
      <Choice
        eyebrow="Bring your own"
        title="Point at a bucket you already have"
        body="Cloudflare R2, Amazon S3, or anything S3-compatible. We check the bucket, tell you what we found, and write nothing of yours until you say go."
        cta="I have a bucket"
        onPress={onPickBYO}
        variant={offer?.kind === "free" ? "secondary" : "primary"}
        testID="welcome-fork-own"
      />

      <View style={styles.foot}>
        <Text variant="foot" style={styles.footLine}>
          Got an invitation?{" "}
          <Text
            variant="foot"
            style={styles.link}
            onPress={onOpenInvitations}
            accessibilityRole="link"
            accessibilityLabel="Open an invitation"
            testID="welcome-fork-invitation"
          >
            Open it here →
          </Text>
        </Text>
      </View>
    </View>
  );
}

function Choice({
  eyebrow,
  title,
  body,
  cta,
  onPress,
  variant,
  disabled = false,
  testID,
}: {
  eyebrow: string;
  title: string;
  body: string;
  cta: string;
  onPress: () => void;
  variant: "primary" | "secondary";
  disabled?: boolean;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      style={[
        styles.card,
        variant === "primary" ? styles.cardPrimary : styles.cardSecondary,
      ]}
    >
      <Text variant="eyebrow" style={variant === "primary" ? styles.eyebrowOn : styles.eyebrow}>
        {eyebrow}
      </Text>
      <Text style={styles.title}>{title}</Text>
      <Text variant="rowSub" style={styles.body}>
        {body}
      </Text>
      <View style={styles.action}>
        <Button
          label={cta}
          variant={variant === "primary" ? "white" : "ghost"}
          onPress={onPress}
          disabled={disabled}
          testID={testID}
        />
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    lede: { marginBottom: space.x5, lineHeight: leading(12.5, 1.7) },
    failure: { marginBottom: space.x3 },
    card: {
      borderWidth: 1,
      borderRadius: radii.card,
      paddingVertical: space.x5,
      paddingHorizontal: space.x5,
      marginBottom: space.x3,
    },
    cardPrimary: {
      borderColor: colors.accent,
      backgroundColor: colors.hintWash,
    },
    cardSecondary: {
      borderColor: colors.line,
      backgroundColor: colors.surface2,
    },
    eyebrow: { color: colors.muted, marginBottom: space.x2 },
    eyebrowOn: { color: colors.accent, marginBottom: space.x2 },
    title: {
      fontFamily: fonts.display,
      fontSize: t.body,
      lineHeight: leading(18, 1.25),
      letterSpacing: tracking(18, -0.015),
      fontWeight: "600",
      color: colors.text,
      marginBottom: space.x2,
    },
    body: { color: colors.text2, lineHeight: leading(12.5, 1.6) },
    action: { marginTop: space.x4, flexDirection: "row" },
    foot: {
      marginTop: space.x4,
      paddingTop: space.x4,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    footLine: { color: colors.muted, lineHeight: leading(12.5, 1.6) },
    link: { color: colors.accent, fontWeight: "600" },
  });
