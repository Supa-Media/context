import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { recoveryDate, signedInWhen } from "../../../account/emailProofText";

/**
 * "Signed in" (board k3's footer), with the two states account safety can
 * leave behind: phone sign-in paused by "This wasn't me", and a new email
 * waiting out its seven days (board k4). Signing other devices out, turning
 * phone sign-in back on and stopping the wait from here all need an emailed
 * code; the server asks, and `EmailProofHost` shows the box.
 */
export function AccountSafetyCard() {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { isAuthenticated } = useConvexAuth();
  const sessions = useQuery(api.functions.emailProof.mySessions, isAuthenticated ? {} : "skip");
  const pause = useQuery(api.functions.signInAlerts.myPhonePause, isAuthenticated ? {} : "skip");
  const recovery = useQuery(api.functions.emailRecovery.myEmailRecovery, isAuthenticated ? {} : "skip");
  const signOutOthers = useMutation(api.functions.emailProof.signOutOthers);
  const resume = useMutation(api.functions.signInAlerts.resumePhoneSignIn);
  const stopRecovery = useMutation(api.functions.emailRecovery.cancelMine);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<unknown>) {
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

  const others = (sessions ?? []).filter((session) => !session.current);

  return (
    <View testID="account-safety">
      <Text variant="eyebrow" style={styles.head}>
        Signed in
      </Text>
      <Text variant="rowSub" style={styles.sub}>
        Every device signed in to your account. Signing other devices out needs a code from your email.
      </Text>
      <Card>
        {sessions === undefined ? (
          <Row>
            <ActivityIndicator color={colors.text2} size="small" />
          </Row>
        ) : (
          sessions.map((session, index) => (
            <Row key={session.id} divided={index > 0}>
              <Grow>
                <Text variant="rowTitle">{session.current ? "This device" : "Another device"}</Text>
                <Text variant="rowSub">{signedInWhen(session.signedInAt)}</Text>
              </Grow>
              {session.current ? null : (
                <Button
                  label="Sign out"
                  disabled={busy}
                  onPress={() => void run(() => signOutOthers({ session: session.id as Id<"authSessions"> }))}
                  testID={`account-session-sign-out-${index}`}
                />
              )}
            </Row>
          ))
        )}
        {others.length > 1 ? (
          <Row divided>
            <Grow>
              <Text variant="rowSub">Signs out everywhere but here.</Text>
            </Grow>
            <Button
              label="Sign out every other device"
              disabled={busy}
              onPress={() => void run(() => signOutOthers({}))}
              testID="account-sign-out-others"
            />
          </Row>
        ) : null}
        {pause?.paused ? (
          <Row divided testID="account-phone-paused">
            <Grow>
              <Text variant="rowTitle">Phone sign-in is paused</Text>
              <Text variant="rowSub">
                Someone pressed &quot;This wasn&apos;t me&quot;. Your number can&apos;t sign in and the assistant won&apos;t
                answer it until you turn it back on.
              </Text>
            </Grow>
            <Button label="Turn back on" disabled={busy} onPress={() => void run(() => resume({}))} testID="account-phone-resume" />
          </Row>
        ) : null}
        {recovery ? (
          <Row divided testID="account-email-waiting">
            <Grow>
              <Text variant="rowTitle">{recovery.email}</Text>
              <Text variant="rowSub">{`Will be added on ${recoveryDate(recovery.finishesAt)}`}</Text>
            </Grow>
            <Button label="Stop it" disabled={busy} onPress={() => void run(() => stopRecovery({}))} testID="account-email-stop" />
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
    error: { marginTop: space.x2 },
  });
