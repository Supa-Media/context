import { useEffect, useState } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useAction, useConvex, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../design/components/Button";
import { TextField } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { TextLink } from "../design/components/TextLink";
import { radii } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { CodeBoxes, OTP_LENGTH } from "../auth/CodeBoxes";
import { installEmailProofRetry, settleEmailProof, subscribeEmailProof } from "./emailProofGate";
import { proofError, recoveryDate, recoveryError } from "./emailProofText";

/**
 * The one "Check it's you" dialog (board k2), mounted once under the Convex
 * provider. It opens when the server refuses a big change from this device
 * (`emailProofGate.ts`), mails a code to the account's own email, and settles
 * the waiting change when the code is typed back.
 *
 * "I can't get into any of my emails" turns it into the seven-day wait for a
 * new address (board k4, `apps/convex/functions/emailRecovery.ts`).
 */
export function EmailProofHost() {
  const client = useConvex();
  const [open, setOpen] = useState(false);
  useEffect(() => installEmailProofRetry(client), [client]);
  useEffect(() => subscribeEmailProof(setOpen), []);
  return open ? <EmailProofDialog /> : null;
}

function EmailProofDialog() {
  const styles = useThemedStyles(makeStyles);
  const state = useQuery(api.functions.emailProof.myEmailProof, {});
  const start = useAction(api.functions.emailProof.startEmailProof);
  const confirm = useAction(api.functions.emailProof.confirmEmailProof);

  const [to, setTo] = useState(0);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);

  async function send(index: number) {
    setBusy(true);
    setError(null);
    try {
      const result = await start({ to: index });
      setError(proofError(result.status));
      if (result.status === "sent") {
        setSentTo(result.sentTo ?? null);
        setCode("");
      }
    } catch {
      setError(proofError("failed"));
    } finally {
      setBusy(false);
    }
  }

  // The code goes out as the dialog opens: the board shows it already sent.
  useEffect(() => {
    void send(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function check(value: string) {
    if (value.length !== OTP_LENGTH) return;
    setBusy(true);
    setError(null);
    try {
      const result = await confirm({ code: value });
      if (result.status === "confirmed") {
        settleEmailProof(true);
        return;
      }
      setError(proofError(result.status));
      setCode("");
    } catch {
      setError(proofError("failed"));
    } finally {
      setBusy(false);
    }
  }

  const emails = state?.emails ?? [];
  const close = () => settleEmailProof(false);

  return (
    <Modal transparent animationType="fade" onRequestClose={close} visible>
      <Pressable style={styles.scrim} accessibilityLabel="Close" onPress={close}>
        <Pressable style={styles.card} onPress={() => {}} accessibilityLabel="Check it's you" testID="email-proof-dialog">
          {recovering ? (
            <NewEmailWait onClose={close} />
          ) : (
            <>
              <Text variant="paneTitle" role="heading" aria-level={2}>
                Check it&apos;s you
              </Text>
              <Text variant="rowSub" style={styles.line}>
                {sentTo === null
                  ? "Sending a code to your email…"
                  : `We sent a code to ${sentTo}. This change needs it, so a stolen phone number can't make it.`}
              </Text>
              <CodeBoxes
                value={code}
                editable={!busy && sentTo !== null}
                onChange={(value) => {
                  setCode(value);
                  if (value.length === OTP_LENGTH) void check(value);
                }}
                testID="email-proof-code"
              />
              {error === null ? null : (
                <Text variant="error" role="alert">
                  {error}
                </Text>
              )}
              <View style={styles.links}>
                {emails.length > 1 ? (
                  <TextLink
                    label="Send to another of my emails"
                    onPress={() => {
                      const next = (to + 1) % emails.length;
                      setTo(next);
                      void send(next);
                    }}
                    testID="email-proof-other"
                  />
                ) : (
                  <TextLink label="Send a new code" onPress={() => void send(to)} testID="email-proof-again" />
                )}
                <TextLink
                  label="I can't get into any of my emails"
                  onPress={() => setRecovering(true)}
                  testID="email-proof-lost"
                />
              </View>
              <View style={styles.actions}>
                <Button label="Cancel" onPress={close} testID="email-proof-cancel" />
              </View>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** Board k4, right: a new email by phone alone, after seven days. */
function NewEmailWait({ onClose }: { onClose: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const start = useAction(api.functions.emailRecovery.startEmailRecovery);
  const confirm = useAction(api.functions.emailRecovery.confirmEmailRecovery);
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finishesAt, setFinishesAt] = useState<number | null>(null);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch {
      setError(recoveryError("failed"));
    } finally {
      setBusy(false);
    }
  }

  if (finishesAt !== null) {
    return (
      <>
        <Text variant="paneTitle" role="heading" aria-level={2}>
          Your new email is on its way
        </Text>
        <Text variant="rowSub" style={styles.line}>
          {`${draft.trim()} will be added on ${recoveryDate(finishesAt)}. We told your current emails, and any of them can stop it. Your notes stay fully usable while you wait.`}
        </Text>
        <View style={styles.actions}>
          <Button label="Done" variant="accent" onPress={onClose} testID="email-recovery-done" />
        </View>
      </>
    );
  }

  return (
    <>
      <Text variant="paneTitle" role="heading" aria-level={2}>
        Add a new email
      </Text>
      <Text variant="rowSub" style={styles.line}>
        None of your emails can confirm this. To keep a stolen number from doing it, a new email takes{" "}
        <Text variant="rowTitle">7 days</Text>. We&apos;ll tell all your current emails now and again on day 6, and any
        of them can cancel it.
      </Text>
      {sent ? (
        <>
          <Text variant="rowSub">
            We sent a code to <Text variant="rowTitle">{draft.trim()}</Text>.
          </Text>
          <CodeBoxes
            value={code}
            editable={!busy}
            onChange={(value) => {
              setCode(value);
              if (value.length !== OTP_LENGTH) return;
              void run(async () => {
                const result = await confirm({ code: value });
                if (result.status === "started" && result.finishesAt !== undefined) setFinishesAt(result.finishesAt);
                else {
                  setError(recoveryError(result.status));
                  setCode("");
                }
              });
            }}
            testID="email-recovery-code"
          />
        </>
      ) : (
        <TextField
          label="New email"
          value={draft}
          onChangeText={setDraft}
          placeholder="you@example.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          editable={!busy}
          testID="email-recovery-draft"
        />
      )}
      {error === null ? null : (
        <Text variant="error" role="alert">
          {error}
        </Text>
      )}
      <View style={styles.actions}>
        <Button label="Cancel" onPress={onClose} />
        {sent ? null : (
          <Button
            label="Start the 7 days"
            variant="accent"
            disabled={busy || draft.trim() === ""}
            onPress={() =>
              void run(async () => {
                const result = await start({ email: draft });
                setError(recoveryError(result.status));
                if (result.status === "sent") setSent(true);
              })
            }
            testID="email-recovery-start"
          />
        )}
      </View>
    </>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    scrim: {
      flex: 1,
      backgroundColor: "rgba(3,3,4,.72)",
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
    },
    card: {
      width: "100%",
      maxWidth: 460,
      gap: 14,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      paddingVertical: 24,
      paddingHorizontal: 26,
      boxShadow: "0 40px 100px -30px rgba(0,0,0,1)",
    },
    line: { lineHeight: 21 },
    links: { gap: 10, alignItems: "flex-start" },
    actions: { flexDirection: "row", gap: 10, justifyContent: "flex-end" },
  });
}
