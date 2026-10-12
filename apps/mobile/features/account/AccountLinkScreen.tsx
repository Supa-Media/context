import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../design/components/Button";
import { Text } from "../design/components/Text";
import { useThemedStyles } from "../design/theme";
import { InvitePage, Title } from "../invite/InviteScreen";
import { firstParam } from "../invite/invite";

/**
 * The two links account mail carries, which work without signing in because
 * each only takes access away:
 *
 *  - `/not-me?t=…` from a new-sign-in email (board k3): signs every device
 *    out and pauses phone sign-in and the texting assistant.
 *  - `/stop-new-email?t=…` from a "new email is being added" notice
 *    (board k4): stops the seven-day wait.
 *
 * Nothing happens on opening the page. Mail scanners open links to check
 * them; only a press acts.
 */
export function NotMeScreen() {
  const report = useAction(api.functions.signInAlerts.reportNotMe);
  return (
    <LinkAction
      testID="not-me"
      title="Wasn't you?"
      body="Someone signed in to your Context with your phone number. If it wasn't you, this signs every device out, stops sign-in by phone and stops the assistant answering that number, until you turn it back on."
      button="This wasn't me"
      done={[
        "You're safe",
        "Every device is signed out, phone sign-in is paused and the assistant has stopped answering that number. Sign in with your email to turn them back on. Then call your carrier: your number may have been moved to someone else's SIM.",
      ]}
      act={async (token) => (await report({ token })).status === "done"}
    />
  );
}

export function StopNewEmailScreen() {
  const cancel = useAction(api.functions.emailRecovery.cancelByLink);
  return (
    <LinkAction
      testID="stop-new-email"
      title="Stop the new email?"
      body="Someone signed in with your phone number asked to add a new email to your Context. If it wasn't you, stop it here."
      button="Stop it"
      done={[
        "Stopped",
        "The new email won't be added. Sign in with this email and sign out the devices you don't know, then call your carrier.",
      ]}
      act={async (token) => (await cancel({ token })).status === "cancelled"}
    />
  );
}

function LinkAction(props: {
  testID: string;
  title: string;
  body: string;
  button: string;
  done: [string, string];
  act: (token: string) => Promise<boolean>;
}) {
  const styles = useThemedStyles(makeStyles);
  const token = firstParam(useLocalSearchParams<{ t?: string | string[] }>().t);
  const [state, setState] = useState<"idle" | "busy" | "done" | "dead">(token === null ? "dead" : "idle");

  const [title, body] =
    state === "done"
      ? props.done
      : state === "dead"
        ? ["This link has already been used or has expired", "Sign in to Context to see who is signed in to your account."]
        : [props.title, props.body];

  return (
    <InvitePage testID={props.testID}>
      <Title size={34}>{title}</Title>
      <Text variant="body" style={styles.body}>
        {body}
      </Text>
      <View style={styles.actions}>
        {state === "idle" || state === "busy" ? (
          <Button
            label={props.button}
            variant="danger"
            disabled={state === "busy"}
            onPress={() => {
              if (token === null) return;
              setState("busy");
              props.act(token).then(
                (ok) => setState(ok ? "done" : "dead"),
                () => setState("idle"),
              );
            }}
            testID={`${props.testID}-act`}
          />
        ) : (
          <Button label="Open Context" variant="accent" onPress={() => router.replace("/login")} />
        )}
      </View>
    </InvitePage>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    body: { marginTop: 16 },
    actions: { marginTop: 24, flexDirection: "row" },
  });
