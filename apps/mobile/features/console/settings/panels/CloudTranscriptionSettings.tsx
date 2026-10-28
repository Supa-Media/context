import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useConvex, useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { TRANSCRIPTION_SETTINGS_COPY } from "@context/shared";

import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles } from "../../../design/theme";
import { forgetSpooledAudio } from "../../../meetings/capture";
import {
  useTranscriptionConsentAnswer,
  useTranscriptionConsentGate,
  withdrawHereFor,
} from "../../../meetings/useTranscriptionConsent";

/** What the row says: a current yes, a no (or never asked), or a yes to an older disclosure. */
export type CloudTranscriptionState = "on" | "off" | "outdated";

const CLOUD = { audio: true, transcribesAt: "cloud" } as const;

/**
 * Settings › Meetings, Cloud transcription: the account's answer, and the one
 * place to take it back (`docs/decisions/meetings/transcription-consent.md`).
 *
 * Turn off stops this device at once, before the account has heard: the
 * recorders read the answer before every chunk, so a meeting that is running
 * stops sending with its next one, and audio still waiting on this device is
 * deleted rather than sent later. The account is then told, which stops every
 * other device and every server boundary too. Allow puts the same dialog in
 * front as a New meeting does, so a yes here is given to the same words.
 *
 * Shown for every account, whatever it answered: somebody who said no has to
 * be able to see that it is off.
 */
export function CloudTranscriptionSettings() {
  // Nothing to read or save without a client: the demo and the render tests.
  return useConvex() === undefined ? null : <CloudTranscriptionSettingsLive />;
}

function CloudTranscriptionSettingsLive() {
  const answer = useTranscriptionConsentAnswer();
  const withdraw = useMutation(api.functions.transcriptionConsent.withdrawTranscription);
  const consent = useTranscriptionConsentGate({ capture: CLOUD, account: answer?.account });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState(false);

  if (answer === undefined || answer === null) return null;
  const state: CloudTranscriptionState = answer.allowed ? "on" : answer.outdated ? "outdated" : "off";

  function turnOff() {
    // This device first, so nothing more leaves it even if the save fails,
    // and it stays off, across a restart too, until the account agrees or
    // Allow is pressed here.
    withdrawHereFor(answer!.account);
    forgetSpooledAudio();
    setBusy(true);
    setProblem(false);
    withdraw({})
      .catch(() => setProblem(true))
      .finally(() => setBusy(false));
  }

  return (
    <>
      <CloudTranscriptionView
        state={state}
        busy={busy}
        problem={problem}
        onTurnOff={turnOff}
        onAllow={() => consent.gate(() => {})}
      />
      {consent.sheet}
    </>
  );
}

/** What the card draws, with no client behind it: the live card and the screenshot fixture. */
export function CloudTranscriptionView({
  state,
  busy,
  problem,
  onTurnOff,
  onAllow,
}: {
  state: CloudTranscriptionState;
  busy: boolean;
  problem: boolean;
  onTurnOff: () => void;
  onAllow: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const copy = TRANSCRIPTION_SETTINGS_COPY;
  return (
    <View testID="cloud-transcription">
      <Text variant="eyebrow" style={styles.head} accessibilityRole="header">
        {copy.title}
      </Text>
      <Card>
        <Row>
          <Grow>
            <Text variant="rowTitle">{state === "on" ? "Allowed" : "Not allowed"}</Text>
            <Text variant="rowSub" style={styles.rowSub} testID="cloud-transcription-state">
              {copy[state]}
            </Text>
          </Grow>
          {state === "on" ? (
            <Button
              label={copy.turnOff}
              variant="danger"
              disabled={busy}
              onPress={onTurnOff}
              accessibilityLabel="Turn off cloud transcription"
              testID="cloud-transcription-turn-off"
            />
          ) : (
            <Button
              label={copy.turnOn}
              disabled={busy}
              onPress={onAllow}
              accessibilityLabel="Allow cloud transcription"
              testID="cloud-transcription-allow"
            />
          )}
        </Row>
      </Card>
      {problem ? (
        <Text variant="hint" style={styles.problem} testID="cloud-transcription-unsaved">
          This device stopped sending, but your account did not hear it. Check your connection and try again.
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    head: { marginTop: space.x6, marginBottom: space.x3 },
    rowSub: { marginTop: 2 },
    problem: { marginTop: space.x2 },
  });
