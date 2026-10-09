import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useAction, useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { TextField } from "../../../design/components/Input";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { CodeBoxes, OTP_LENGTH } from "../../../auth/CodeBoxes";
import { EMAILS_INTRO, confirmError, startError } from "./signInEmails";

/**
 * "Emails you sign in with" (Dev2, 2026-10-09, board s5): one account per
 * person, with every email they sign in with. Adding one mails a code to it.
 * The server decides what an address may join (`functions/signInEmails.ts`);
 * this only asks and says what it answered.
 */
export function SignInEmailsCard() {
  const styles = useThemedStyles(makeStyles);
  const { isAuthenticated } = useConvexAuth();
  const emails = useQuery(api.functions.signInEmails.myEmails, isAuthenticated ? {} : "skip");
  const startAdd = useAction(api.functions.signInEmails.startAddEmail);
  const confirmAdd = useAction(api.functions.signInEmails.confirmAddEmail);
  const remove = useMutation(api.functions.signInEmails.removeEmail);
  const setMail = useMutation(api.functions.signInEmails.setMailEmail);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const result = await startAdd({ email: sentTo ?? draft });
      setError(startError(result.status));
      if (result.status === "sent" && result.email !== undefined) {
        setSentTo(result.email);
        setCode("");
      }
    });

  const confirm = (value = code) =>
    run(async () => {
      if (value.length !== OTP_LENGTH) return;
      const result = await confirmAdd({ code: value });
      setError(confirmError(result.status));
      if (result.status === "added") reset();
      else setCode("");
    });

  function reset() {
    setAdding(false);
    setDraft("");
    setSentTo(null);
    setCode("");
  }

  return (
    <View testID="sign-in-emails">
      <Text variant="eyebrow" style={styles.head}>
        Emails you sign in with
      </Text>
      <Text variant="rowSub" style={styles.sub}>
        {EMAILS_INTRO}
      </Text>
      <Card>
        {emails === undefined ? (
          <Row>
            <Grow>
              <Text variant="rowSub">Loading…</Text>
            </Grow>
          </Row>
        ) : (
          emails.map((row, index) => (
            <Row key={row.email} divided={index > 0}>
              <Grow>
                <Text variant="mono">{row.email}</Text>
              </Grow>
              {row.mail ? (
                <Pill>Mail goes here</Pill>
              ) : (
                <View style={styles.actions}>
                  <Button
                    label="Send mail here"
                    disabled={busy}
                    onPress={() => void run(() => setMail({ email: row.email }).then(() => undefined))}
                    testID={`sign-in-email-mail-${index}`}
                  />
                  <Button
                    label="Remove"
                    disabled={busy}
                    onPress={() => void run(() => remove({ email: row.email }).then(() => undefined))}
                    testID={`sign-in-email-remove-${index}`}
                  />
                </View>
              )}
            </Row>
          ))
        )}
        {adding ? (
          <View style={styles.adding}>
            {sentTo === null ? (
              <>
                <TextField
                  label="Email to add"
                  value={draft}
                  onChangeText={setDraft}
                  placeholder="you@work.com"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  editable={!busy}
                  onSubmitEditing={() => void send()}
                  testID="sign-in-email-draft"
                />
                <View style={styles.actions}>
                  <Button label="Cancel" disabled={busy} onPress={reset} />
                  <Button
                    label="Email me a code"
                    variant="accent"
                    disabled={busy || draft.trim() === ""}
                    onPress={() => void send()}
                    testID="sign-in-email-send"
                  />
                </View>
              </>
            ) : (
              <>
                <Text variant="rowSub">
                  We sent a code to <Text variant="rowTitle">{sentTo}</Text>. It expires in ten minutes.
                </Text>
                <CodeBoxes
                  value={code}
                  editable={!busy}
                  onChange={(value) => {
                    setCode(value);
                    if (value.length === OTP_LENGTH) void confirm(value);
                  }}
                  testID="sign-in-email-code"
                />
                <View style={styles.actions}>
                  <Button label="Cancel" disabled={busy} onPress={reset} />
                  <Button label="Send a new code" disabled={busy} onPress={() => void send()} />
                </View>
              </>
            )}
          </View>
        ) : (
          <Row divided={emails !== undefined && emails.length > 0}>
            <Grow>
              <Text variant="rowSub">Add a work or school email so things shared with it find you.</Text>
            </Grow>
            <Button label="Add an email" onPress={() => setAdding(true)} testID="sign-in-email-add" />
          </Row>
        )}
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
    actions: { flexDirection: "row", gap: space.x2, flexWrap: "wrap" },
    adding: { padding: space.x3, gap: space.x3 },
    error: { marginTop: space.x2 },
  });
