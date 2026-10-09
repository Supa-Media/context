import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useAction, useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../design/components/Button";
import { CenteredScroll } from "../design/components/CenteredScroll";
import { TextField } from "../design/components/Input";
import { Pill } from "../design/components/Pill";
import { Text } from "../design/components/Text";
import { fonts, layout, leading, pointerType as t, space, tracking } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { CodeBoxes, OTP_LENGTH } from "./CodeBoxes";
import { normalizeSignInEmail, signInProviderForEmail } from "./email";
import { CODE_FAILED, OTHER_EMAIL_TITLE, SEND_FAILED, finishError, notOnAccount, type FinishStatus } from "./otherEmail";

type Step = "ask" | "which" | "code";

/**
 * "Do you already use Context with another email?" (Dev2, 2026-10-09, board
 * s7): asked once, right after the first sign-in with an address no account
 * has, so a work email does not quietly become a second account.
 *
 * "Yes" signs in with the other address the ordinary way, with a code mailed
 * there, carrying a hand-off token the new account minted; that account then
 * takes the new address over (`functions/otherEmail.ts`). "No" is kept on the
 * account and never asked again. Drawn by `app/(app)/_layout.tsx` in place of
 * every route; `done` is the last panel, shown by the layout once the session
 * belongs to the other account.
 */
export function OtherEmailScreen({
  email,
  done = false,
  onAdded,
  onContinue,
  initialStep = "ask",
  initialOther = "",
}: {
  /** The address that just signed in. */
  email: string;
  done?: boolean;
  onAdded: (email: string) => void;
  onContinue: () => void;
  initialStep?: Step;
  /** For the fixture: the other address, already typed. */
  initialOther?: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const { signIn } = useAuthActions();
  const startHandOff = useAction(api.functions.otherEmail.startHandOff);
  const finishHandOff = useMutation(api.functions.otherEmail.finishHandOff);
  const markSeen = useMutation(api.functions.messages.markMessageSeen);

  const [step, setStep] = useState<Step>(initialStep);
  const [other, setOther] = useState(initialOther);
  const [token, setToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<void>, failed: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch {
      setError(failed);
    } finally {
      setBusy(false);
    }
  }

  const sayNo = () => run(() => markSeen({ message: "other-email" }).then(() => undefined), SEND_FAILED);

  const sendCode = () =>
    run(async () => {
      const address = normalizeSignInEmail(other);
      let carried = token;
      if (carried === null) {
        const started = await startHandOff({});
        if (started.token === undefined) return;
        carried = started.token;
        setToken(carried);
      }
      await signIn(signInProviderForEmail(address), { email: address });
      setCode("");
      setStep("code");
    }, SEND_FAILED);

  const confirm = (value = code) =>
    run(async () => {
      if (value.length !== OTP_LENGTH || token === null) return;
      const address = normalizeSignInEmail(other);
      try {
        await signIn(signInProviderForEmail(address), { email: address, code: value.trim() });
      } catch {
        setCode("");
        setError(CODE_FAILED);
        return;
      }
      // Signed in as the other account now; it takes this address over.
      const result = await finishHandOff({ token });
      const problem = finishError(result.status as FinishStatus, email);
      if (problem === null) onAdded(email);
      else {
        setStep("which");
        setError(problem);
      }
    }, finishError("expired", email) ?? SEND_FAILED);

  const spinner = busy ? <ActivityIndicator color={colors.ink} size="small" /> : null;

  return (
    <View style={styles.ground}>
      <CenteredScroll testID="other-email">
        <View style={styles.form}>
          <Text variant="mark" style={styles.mark}>
            Context
            <Text variant="mark" style={styles.markSuffix}>
              .lc
            </Text>
          </Text>
          {done ? (
            <DonePanel added={email} onContinue={onContinue} />
          ) : step === "ask" ? (
            <>
              <Text role="heading" aria-level={1} style={styles.pitch}>
                {OTHER_EMAIL_TITLE}
              </Text>
              <Text variant="rowSub" style={styles.body}>
                {notOnAccount(email)}
              </Text>
              <View style={styles.stack}>
                <Button
                  label="Yes, add this email to it"
                  variant="accent"
                  disabled={busy}
                  onPress={() => setStep("which")}
                  style={styles.wide}
                  testID="other-email-yes"
                />
                <Button
                  label="No, I'm new here"
                  variant="decision"
                  disabled={busy}
                  onPress={() => void sayNo()}
                  trailing={spinner}
                  style={styles.wide}
                  testID="other-email-no"
                />
              </View>
            </>
          ) : step === "which" ? (
            <>
              <Text role="heading" aria-level={1} style={styles.pitch}>
                Which email?
              </Text>
              <Text variant="rowSub" style={styles.body}>
                The one you already sign in to Context with. We'll send it a code.
              </Text>
              <View style={styles.field}>
                <TextField
                  label="Email"
                  value={other}
                  onChangeText={setOther}
                  placeholder="you@example.com"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  editable={!busy}
                  onSubmitEditing={() => void sendCode()}
                  testID="other-email-address"
                />
              </View>
              <View style={styles.stack}>
                <Button
                  label="Email me a code"
                  variant="accent"
                  disabled={busy || other.trim() === ""}
                  onPress={() => void sendCode()}
                  trailing={spinner}
                  style={styles.wide}
                  testID="other-email-send"
                />
              </View>
            </>
          ) : (
            <>
              <Text role="heading" aria-level={1} style={styles.pitch}>
                Which email?
              </Text>
              <Text variant="rowSub" style={styles.body}>
                We sent a code to <Text style={styles.strong}>{normalizeSignInEmail(other)}</Text>.
              </Text>
              <Text variant="eyebrow" style={styles.label}>
                Code
              </Text>
              <CodeBoxes
                value={code}
                editable={!busy}
                onChange={(value) => {
                  setCode(value);
                  setError(null);
                  if (value.length === OTP_LENGTH) void confirm(value);
                }}
                testID="other-email-code"
              />
              <View style={styles.row}>
                <Button
                  label="Send a new code"
                  variant="decision"
                  disabled={busy}
                  onPress={() => void sendCode()}
                  testID="other-email-resend"
                />
                <Button
                  label="Continue →"
                  variant="accent"
                  disabled={busy || code.length !== OTP_LENGTH}
                  onPress={() => void confirm()}
                  trailing={spinner}
                  testID="other-email-confirm"
                />
              </View>
            </>
          )}

          {error ? (
            <Text variant="error" role="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}

          {!done && step !== "ask" ? (
            <Text
              variant="foot"
              role="link"
              style={styles.link}
              onPress={() => {
                if (busy) return;
                setStep(step === "code" ? "which" : "ask");
                setCode("");
                setError(null);
              }}
              testID="other-email-back"
            >
              {step === "code" ? "Use a different email" : "Back"}
            </Text>
          ) : null}
        </View>
      </CenteredScroll>
    </View>
  );
}

/** Board s7, panel 3: one account, both emails. */
function DonePanel({ added, onContinue }: { added: string; onContinue: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const emails = useQuery(api.functions.signInEmails.myEmails, {});
  return (
    <>
      <Text role="heading" aria-level={1} style={styles.pitch}>
        You're signed in
      </Text>
      <Text variant="rowSub" style={styles.body}>
        One account, every email you sign in with.
      </Text>
      <View style={styles.emails}>
        {(emails ?? []).map((row) => (
          <View key={row.email} style={styles.emailRow}>
            <Text variant="mono" style={styles.grow}>
              {row.email}
            </Text>
            {row.mail ? <Pill>Mail goes here</Pill> : row.email === added ? <Pill>Just added</Pill> : null}
          </View>
        ))}
      </View>
      <View style={styles.stack}>
        <Button label="Continue →" variant="accent" onPress={onContinue} style={styles.wide}
                  testID="other-email-continue" />
      </View>
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.ground },
    form: {
      width: "100%",
      maxWidth: 400,
      alignSelf: "center",
      paddingHorizontal: layout.gutter,
      paddingVertical: 48,
    },
    mark: { marginBottom: 32 },
    markSuffix: { color: colors.accent },
    pitch: {
      fontFamily: fonts.display,
      fontSize: t.h2,
      lineHeight: leading(26, 1.25),
      letterSpacing: tracking(26, -0.015),
      fontWeight: "600",
      color: colors.text,
    },
    body: { marginTop: space.x3, color: colors.text2, lineHeight: leading(12.5, 1.5) },
    strong: { fontWeight: "600", color: colors.text },
    field: { marginTop: space.x6 },
    label: { marginTop: space.x5, marginBottom: space.x2, color: colors.muted },
    stack: { marginTop: space.x5, gap: space.x3, alignSelf: "stretch" },
    row: { marginTop: space.x5, flexDirection: "row", justifyContent: "space-between", gap: space.x3 },
    error: { marginTop: space.x3 },
    link: { marginTop: space.x5, color: colors.accent, fontWeight: "600", textDecorationLine: "underline" },
    emails: { marginTop: space.x5, gap: space.x2 },
    emailRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      padding: space.x3,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
    },
    grow: { flex: 1 },
    wide: { alignSelf: "stretch" },
  });
