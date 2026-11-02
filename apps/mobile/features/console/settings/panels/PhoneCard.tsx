import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { CodeBoxes, OTP_LENGTH } from "../../../auth/CodeBoxes";
import { PhoneNumberField } from "../../../auth/PhoneNumberField";
import { confirmError, sendError } from "../../../auth/phoneCheck";

/**
 * "Phone you sign in with" (board k4, left). Changing it is a big change: the
 * server asks for an emailed code first (`EmailProofHost` shows the box), so a
 * stolen number can't move the account to another phone. The texting
 * assistant follows to the new number.
 */
export function PhoneCard() {
  const styles = useThemedStyles(makeStyles);
  const { isAuthenticated } = useConvexAuth();
  const check = useQuery(api.functions.phoneCheck.myPhoneCheck, isAuthenticated ? {} : "skip");
  const sendCode = useAction(api.functions.phoneCheck.sendPhoneCode);
  const confirmCode = useAction(api.functions.phoneCheck.confirmPhoneCode);

  const [changing, setChanging] = useState(false);
  const [draft, setDraft] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setChanging(false);
    setDraft("");
    setSentTo(null);
    setCode("");
    setError(null);
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (failure) {
      const message = (failure as { data?: { message?: string } })?.data?.message;
      setError(message ?? "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const send = () =>
    run(async () => {
      const result = await sendCode({ phone: sentTo ?? draft });
      if (result.status === "not_needed") return reset();
      setError(sendError(result.status));
      if (result.status === "sent" && result.phone !== undefined) {
        setSentTo(result.phone);
        setCode("");
      }
    });

  const confirm = (value: string) =>
    run(async () => {
      if (sentTo === null) return;
      const result = await confirmCode({ phone: sentTo, code: value });
      if (result.status === "confirmed") return reset();
      setError(confirmError(result.status));
      setCode("");
    });

  if (check === undefined || check === null) return null;

  return (
    <View testID="account-phone">
      <Text variant="eyebrow" style={styles.head}>
        Phone you sign in with
      </Text>
      <Text variant="rowSub" style={styles.sub}>
        {check.phone === undefined
          ? "Add one so you can sign in by text if you ever lose your email."
          : "You sign in and text the assistant with this number. Changing it needs a code from your email first."}
      </Text>
      <Card>
        <Row>
          <Grow>
            <Text variant="rowTitle">{check.phone ?? "No phone yet"}</Text>
          </Grow>
          {changing ? null : (
            <Button label={check.phone === undefined ? "Add a phone" : "Change"} disabled={busy} onPress={() => setChanging(true)} testID="account-phone-change" />
          )}
        </Row>
        {changing ? (
          <Row divided>
            <Grow>
              {sentTo === null ? (
                <PhoneNumberField
                  value={draft}
                  onChangeText={setDraft}
                  editable={!busy}
                  onSubmitEditing={() => void send()}
                  testID="account-phone-number"
                />
              ) : (
                <>
                  <Text variant="rowSub" style={styles.sub}>
                    We sent a code to <Text variant="rowTitle">{sentTo}</Text>.
                  </Text>
                  <CodeBoxes
                    value={code}
                    editable={!busy}
                    onChange={(value) => {
                      setCode(value);
                      if (value.length === OTP_LENGTH) void confirm(value);
                    }}
                    testID="account-phone-code"
                  />
                </>
              )}
              <View style={styles.actions}>
                <Button label="Cancel" disabled={busy} onPress={reset} testID="account-phone-cancel" />
                {sentTo === null ? (
                  <Button
                    label="Text me a code"
                    variant="accent"
                    disabled={busy || draft.trim() === ""}
                    onPress={() => void send()}
                    testID="account-phone-send"
                  />
                ) : (
                  <Button label="Send a new code" disabled={busy} onPress={() => void send()} testID="account-phone-resend" />
                )}
              </View>
            </Grow>
          </Row>
        ) : null}
      </Card>
      {error === null ? null : (
        <Text variant="error" role="alert" style={styles.error}>
          {error}
        </Text>
      )}
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    head: { marginBottom: space.x2 },
    sub: { marginBottom: space.x3 },
    actions: { marginTop: space.x3, flexDirection: "row", gap: space.x3, justifyContent: "flex-end" },
    error: { marginTop: space.x2 },
  });
