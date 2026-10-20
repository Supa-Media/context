import { useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { leading, radii } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { EARLY_TESTER_PRICE_SHORT } from "../settings/panels/premium";
import { FOUNDING_NOTES_LINE, FOUNDING_PRICE_LINE } from "../settings/panels/founding";
import { ConnectForm } from "./ConnectForm";
import type { ConnectFormValues } from "./connect";

/**
 * Storage starts with the decision a person is actually making: run it
 * themselves or let Context run it. Provider details stay behind the first
 * path.
 */
export function StorageChoice({
  connect,
  onCancel,
  ours,
  managed,
}: {
  connect: (values: ConnectFormValues) => Promise<{ status: string }>;
  /** Present when this is replacing a binding rather than making the first one. */
  onCancel?: () => void;
  /**
   * Storage we run, when this owner can start it here. One offer: no price,
   * no cap, no tier. First, because it is the path with nothing to set up.
   */
  ours?: { onChoose: () => void };
  /**
   * The priced card. Dormant while Context is free: callers pass it only when
   * billing says this deployment sells (`isSelling`), so turning pricing back
   * on brings it back unchanged.
   */
  managed?: { price: string; founding?: boolean; stagingFreeStorage?: boolean; onChoose: () => void };
}) {
  const styles = useThemedStyles(makeStyles);
  const [ownOpen, setOwnOpen] = useState(false);
  const [bucketOpen, setBucketOpen] = useState(false);

  return (
    <View style={styles.stack}>
      <View style={styles.cards}>
        {ours === undefined ? null : (
          <ChoiceCard
            testID="choose-ours"
            title="Storage we run"
            sub="We set up a bucket for this workspace and keep it running. Nothing to configure, and you can download every note any time."
            selected={false}
            onPress={ours.onChoose}
          />
        )}
        <ChoiceCard
          testID="choose-own-storage"
          title="Bring your own storage"
          sub="Use storage you control through an S3-compatible provider."
          selected={ownOpen}
          onPress={() => {
            setOwnOpen((open) => !open);
            setBucketOpen(false);
          }}
        />
        {Platform.OS !== "web" || managed === undefined ? null : (
          /*
            The badge is the number and the sub says what kind of number it is.
            Splitting it that way keeps the badge a badge — it is a pill beside
            a title, and "$5 a month — early tester price, held for as long as
            you keep it" is a paragraph — while still putting the framing on
            the card somebody chooses from rather than only on the confirm
            screen behind it.
          */
          <ChoiceCard
            testID="choose-managed"
            title="Context-managed Premium storage"
            sub={managed.founding === true && managed.stagingFreeStorage !== true
              ? `Context sets it up and keeps it running. ${FOUNDING_PRICE_LINE} ${FOUNDING_NOTES_LINE}`
              : `Get 50 GB for this context. Context sets it up and keeps it running. ${managed.stagingFreeStorage ? "Free on staging; no payment required." : EARLY_TESTER_PRICE_SHORT}`}
            badge={managed.founding === true ? "Included" : managed.price}
            badgeTone={managed.founding === true ? "ok" : "neutral"}
            selected={false}
            onPress={managed.onChoose}
          />
        )}
      </View>

      {ownOpen ? (
        <View style={styles.providerSection} testID="own-storage-providers">
          <Text variant="eyebrow">Choose a provider</Text>
          <View style={styles.cards}>
            <ChoiceCard
              testID="choose-bucket"
              title="S3-compatible storage"
              sub="Connect R2, Amazon S3, Backblaze B2, Wasabi, or another compatible provider."
              selected={bucketOpen}
              onPress={() => setBucketOpen((open) => !open)}
            />
          </View>
        </View>
      ) : null}

      {ownOpen && bucketOpen ? <ConnectForm connect={connect} onCancel={onCancel} /> : null}
    </View>
  );
}

/**
 * One square-ish option. A `Pressable` rather than a `Card`, because the whole
 * face is the control — and `minWidth` + `flexWrap` on the row above is what
 * stacks them on a phone without a width branch (`useWindowDimensions` is 0 in
 * jsdom, so a width branch would also make every test silently take the phone
 * path).
 */
function ChoiceCard({
  title,
  sub,
  badge,
  badgeTone = "ok",
  selected,
  onPress,
  testID,
}: {
  title: string;
  sub: string;
  badge?: string;
  /** `ok` for a positive status, `neutral` for a price. */
  badgeTone?: "ok" | "neutral";
  selected: boolean;
  onPress: () => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.choice,
        selected && styles.choiceSelected,
        pressed && styles.choicePressed,
      ]}
    >
      {badge ? (
        <Text variant="foot" style={badgeTone === "ok" ? styles.badge : styles.badgePrice}>
          {badge}
        </Text>
      ) : null}
      <Text variant="rowTitle">{title}</Text>
      <Text variant="rowSub" style={styles.sub}>
        {sub}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    stack: { gap: 14 },
    cards: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 12,
    },
    choice: {
      flexGrow: 1,
      flexBasis: 220,
      minHeight: 132,
      gap: 6,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      paddingVertical: 16,
      paddingHorizontal: 16,
    },
    providerSection: { gap: 10 },
    choiceSelected: {
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface3,
    },
    choicePressed: { backgroundColor: colors.surface3 },
    badge: { color: colors.okText },
    badgePrice: { color: colors.text2 },
    sub: { lineHeight: leading(13, 1.55) },
  });
