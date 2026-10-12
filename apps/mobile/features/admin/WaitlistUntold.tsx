/**
 * "Never told" on the Waitlist tab: people let in by phone before Let in sent
 * a text (Dev2, 2026-10-12, "Text them once"). Shown only while there are
 * some; one press texts each of them "You're in", once, server side
 * (`apps/convex/functions/lib/adminFns/waitlistUntold.ts`). Somebody who
 * already signed in is not counted and not texted.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button, Text, space, useThemedStyles } from "../design";
import { useCompact } from "./AdminKit";
import { messageFor } from "./SecretDialogs";
import { people, untoldSentence, untoldTextedSentence } from "./waitlist";

export function WaitlistUntold({ onDone }: { onDone: (tone: "ok" | "warn", sentence: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const count = useQuery(api.functions.admin.untoldPhoneWaitlist, {});
  const text = useMutation(api.functions.admin.textUntoldPhoneWaitlist);
  const [busy, setBusy] = useState(false);
  if (count === undefined || count === 0) return null;

  async function onPress() {
    setBusy(true);
    try {
      const result = await text({});
      onDone("ok", untoldTextedSentence(result.texted, result.left));
    } catch (caught) {
      onDone("warn", messageFor(caught, "That did not work. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={[styles.row, compact && styles.rowCompact]} testID="admin-waitlist-untold">
      <View style={styles.words}>
        <Text variant="rowTitle">Never told they're in</Text>
        <Text variant="meta">{untoldSentence(count)}</Text>
      </View>
      <Button
        label="Text them"
        accessibilityLabel={`Text ${people(count)} that they're in`}
        variant="dialogPrimary"
        disabled={busy}
        onPress={onPress}
        testID="admin-waitlist-untold-text"
      />
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.x3 },
    rowCompact: { flexDirection: "column", alignItems: "stretch" },
    words: { flexShrink: 1, gap: 2 },
  });
