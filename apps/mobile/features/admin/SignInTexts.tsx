/**
 * Sign-in texts: who codes come from, set here rather than in the deployment
 * (Dev2, 2026-10-09). The Messaging Service ID names a sender and opens
 * nothing, so unlike a credential it is shown back. A value the deployment
 * sets wins, and this panel says so instead of offering a field that would do
 * nothing.
 */

import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button, Text, TextField, space, useThemedStyles, type Colors } from "../design";
import { Panel, Skeleton, useCompact, usePanelPad } from "./AdminKit";
import { messageFor } from "./SecretDialogs";

export function SignInTexts() {
  const styles = useThemedStyles(makeStyles);
  const pad = usePanelPad();
  const compact = useCompact();
  const state = useQuery(api.functions.admin.signInTexts, {});
  const save = useMutation(api.functions.admin.setSignInTextsSender);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stored = state?.messagingServiceSid ?? "";
  useEffect(() => setValue(stored), [stored]);

  async function submit(next: string) {
    setBusy(true);
    setError(null);
    try {
      await save({ messagingServiceSid: next.trim() });
    } catch (caught) {
      setError(messageFor(caught, "That did not save. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Sign-in texts" testID="admin-sign-in-texts">
      {state === undefined ? (
        <Skeleton width="100%" height={48} />
      ) : (
        <View style={styles.body}>
          <Text variant="meta" testID="admin-sign-in-texts-status">
            {state.saysContext
              ? "Codes say “123456 is your Context code.”"
              : "Codes come through Twilio Verify, which signs them with Togather’s name."}
          </Text>
          {state.fromDeployment ? (
            <Text variant="meta" style={styles.note}>
              The deployment sets the Messaging Service itself, so that one is used.
            </Text>
          ) : (
            <>
              <TextField
                label="Twilio Messaging Service ID"
                value={value}
                onChangeText={setValue}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="MG…"
                hint="The A2P-registered service codes are texted through. Leave empty to use Verify."
                testID="admin-sign-in-texts-sid"
              />
              {error ? (
                <Text variant="error" role="alert" testID="admin-sign-in-texts-error">
                  {error}
                </Text>
              ) : null}
              <View style={[styles.actions, compact && styles.actionsCompact]}>
                {stored !== "" ? (
                  <Button label="Clear" variant="dialog" disabled={busy} onPress={() => submit("")} />
                ) : null}
                <Button
                  label={busy ? "Saving…" : "Save"}
                  variant="dialogPrimary"
                  disabled={busy || value.trim() === stored}
                  onPress={() => submit(value)}
                  testID="admin-sign-in-texts-save"
                />
              </View>
            </>
          )}
        </View>
      )}
    </Panel>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    body: { gap: space.x3 },
    note: { color: colors.text2 },
    actions: { flexDirection: "row", justifyContent: "flex-end", gap: space.x2 },
    actionsCompact: { flexDirection: "column-reverse", alignItems: "stretch" },
  });
