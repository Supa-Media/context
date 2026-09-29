/**
 * Add emails: paste a list, let them all in.
 *
 * An inline area under the tab's header rather than a dialog — it is a paste
 * and a press, and the answer ("let 3 in, 1 wasn't an email address") belongs
 * beside the list it just changed. Whatever the server could not read as an
 * address is handed back and listed, never dropped quietly.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button, Card, Text, fonts, leading, space, TextField, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import { useCompact } from "./AdminKit";
import { messageFor } from "./SecretDialogs";
import { admittedSentence } from "./waitlist";

export function WaitlistAdd({
  onClose,
  onDone,
}: {
  onClose: () => void;
  /** The sentence to show once it landed, and anything that was not an address. */
  onDone: (sentence: string, invalid: readonly string[]) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const addToWaitlist = useMutation(api.functions.admin.addToWaitlist);
  const [emails, setEmails] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await addToWaitlist({ emails });
      setEmails("");
      onDone(admittedSentence(result.changed), result.invalid);
    } catch (caught) {
      setError(messageFor(caught, "That did not work. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const buttonStyle = compact ? styles.actionCompact : undefined;
  const cancel = (
    <Button key="cancel" label="Cancel" variant="dialog" onPress={onClose} style={buttonStyle} />
  );
  const primary = (
    <Button
      key="add"
      label={busy ? "Letting them in…" : "Let them in"}
      variant="dialogPrimary"
      disabled={busy || emails.trim().length === 0}
      onPress={submit}
      style={buttonStyle}
      testID="admin-waitlist-add-submit"
    />
  );

  return (
    <Card style={compact ? styles.cardCompact : styles.card} testID="admin-waitlist-add">
      <TextField
        label="Emails"
        value={emails}
        onChangeText={setEmails}
        multiline
        numberOfLines={4}
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        placeholder={"ada@example.com\ngrace@example.com"}
        hint="One per line, or separated by commas. Each gets a “You're in” email."
        style={styles.field}
        testID="admin-waitlist-add-emails"
      />
      {error ? (
        <Text variant="error" role="alert" testID="admin-waitlist-add-error">
          {error}
        </Text>
      ) : null}
      <View style={[styles.actions, compact && styles.actionsCompact]}>
        {compact ? [primary, cancel] : [cancel, primary]}
      </View>
    </Card>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    card: { gap: space.x3, paddingVertical: 18, paddingHorizontal: space.x5 },
    cardCompact: { gap: space.x3, padding: space.x4 },
    field: {
      minHeight: 96,
      textAlignVertical: "top",
      fontFamily: fonts.mono,
      fontSize: pointerType.ui,
      lineHeight: leading(pointerType.ui, 1.55),
    },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: space.x2 },
    actionsCompact: { flexDirection: "column", alignItems: "stretch", gap: space.x3 },
    actionCompact: { alignSelf: "stretch", paddingVertical: 13, borderRadius: 14 },
  });
