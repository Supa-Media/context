import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Text } from "../../design/components/Text";
import { leading, pointerType as t, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { ConnectForm } from "../../console/storage/ConnectForm";
import type { ConnectFormValues } from "../../console/storage/connect";

/**
 * B1-01 — "Show us what's already there", for somebody who picked "I have a
 * bucket" on the fork.
 *
 * The canvas says "we list your bucket, read-only — nothing is written". The
 * connect probe is not read-only: it writes one temporary object under
 * `.context/probes/` and removes it, because that is the only way to learn
 * whether the bucket honours conditional writes. So this says exactly that,
 * the same sentence the dry-run report repeats afterwards.
 *
 * The vault row is not a button. An Obsidian vault needs somewhere to go, so
 * its import runs once a bucket is connected, from Settings → Storage — and a
 * card that looked choosable here would be a card that does nothing.
 */
export function PointAtBucket({
  connect,
  onPickFree,
}: {
  connect: (values: ConnectFormValues) => Promise<{ status: string }>;
  /** Present only where this deployment offers the free bucket to this owner. */
  onPickFree?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);

  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        We list your bucket and check we can write to it — one temporary test object, written
        and removed. Nothing of yours is written, moved or renamed, and we show you what we found
        before anything else happens.
      </Text>

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
        style={[styles.card, styles.cardOn]}
        testID="point-at-bucket"
      >
        <Text style={styles.cardTitle}>Cloudflare R2 · Amazon S3 · anything S3-compatible</Text>
        <Text variant="rowSub" style={styles.cardSub}>
          Endpoint, region, bucket and a key. We check what it supports and show you.
        </Text>
      </Pressable>

      <View style={[styles.card, styles.cardQuiet]} testID="point-at-vault">
        <Text style={styles.cardTitle}>Obsidian vault on this device</Text>
        <Text variant="rowSub" style={styles.cardSub}>
          Connect the bucket it should live in first, then import the vault from Settings →
          Storage. Nothing leaves your machine until you say so.
        </Text>
      </View>

      {open ? (
        <View style={styles.form}>
          <ConnectForm connect={connect} onCancel={() => setOpen(false)} />
        </View>
      ) : (
        <View style={styles.actions}>
          <Button
            label="Point at my bucket →"
            variant="accent"
            onPress={() => setOpen(true)}
            testID="point-at-bucket-open"
          />
          {onPickFree ? (
            <Text
              role="link"
              style={styles.link}
              onPress={onPickFree}
              testID="point-at-bucket-free"
            >
              Start on our free bucket instead (1,000 notes, no time limit)
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    lede: { color: colors.text2, fontSize: t.lede, lineHeight: leading(15, 1.6), marginBottom: space.x5 },
    card: {
      borderWidth: 1,
      borderRadius: radii.card,
      paddingVertical: 18,
      paddingHorizontal: 18,
      marginBottom: 10,
      gap: 4,
    },
    cardOn: { borderColor: colors.accent, backgroundColor: colors.hintWash },
    cardQuiet: { borderColor: colors.line, backgroundColor: colors.well },
    cardTitle: { fontSize: t.lede, fontWeight: "600", color: colors.text },
    cardSub: { color: colors.text2 },
    form: { marginTop: space.x4 },
    actions: { marginTop: space.x4, flexDirection: "row", alignItems: "center", gap: 14, flexWrap: "wrap" },
    link: { color: colors.accent, fontWeight: "600", textDecorationLine: "underline", fontSize: t.ui },
  });
