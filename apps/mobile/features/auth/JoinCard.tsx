import { useEffect, useRef } from "react";
import { ActivityIndicator, Platform, StyleSheet, View, type TextInput as NativeField } from "react-native";
import { Button } from "../design/components/Button";
import { TextField } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { leading, pointerType as t, radii, space } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { CodeBoxes, OTP_LENGTH } from "./CodeBoxes";
import { landAfterSignIn } from "./landing";
import { CONSOLE_ROUTE } from "./redirect";
import { useEmailSignIn, type EmailSignIn } from "./useEmailSignIn";
import { WaitlistResult } from "./WaitlistResult";

/**
 * The homepage's one email field: sign in if you're let in, join the waitlist
 * if not, without leaving the page (Dev2, 2026-09-28).
 *
 * It sits at the top of the note the visitor is reading, inside the console's
 * own editor (`NoteEditor`'s `lead`), so it scrolls with the page and the
 * shell around it stays the real one. Every "Create your workspace" link and
 * the account button's "Sign in or join" bring it into view and focus it
 * (`ask` changes) instead of opening `/login`.
 *
 * The flow's state is the page's (`useHomeJoin`), not this card's: the card is
 * drawn inside whichever note is open, and moving to another page must not
 * throw away an address or a code half typed.
 */
export function JoinCard({
  flow,
  ask,
  answered,
}: {
  flow: EmailSignIn;
  /** Bumped each time the visitor asks to sign in or join. */
  ask: number;
  /** The last `ask` acted on, held by the page so a remount does not act again. */
  answered: { current: number };
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const { step, email, code, submitting, error, resent, canSubmit } = flow;
  const box = useRef<View>(null);
  const field = useRef<NativeField>(null);

  useEffect(() => {
    if (ask === answered.current) return;
    answered.current = ask;
    if (Platform.OS === "web") {
      (box.current as unknown as HTMLElement | null)?.scrollIntoView?.({ behavior: "smooth", block: "center" });
    }
    field.current?.focus();
  }, [ask]);

  const spinner = submitting ? <ActivityIndicator color={colors.ink} size="small" /> : null;

  return (
    <View ref={box} style={styles.card} testID="join-card">
      {step === "joined" || step === "already" ? (
        <WaitlistResult flow={flow} />
      ) : step === "request" ? (
        <>
          <Text variant="eyebrow" style={styles.eyebrow}>
            Invite only for now
          </Text>
          <View style={styles.row}>
            <TextField
              ref={field}
              label="Email"
              labelHidden
              value={email}
              onChangeText={flow.setEmail}
              placeholder="you@work.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
              editable={!submitting}
              onSubmitEditing={() => {
                if (canSubmit && !submitting) void flow.submitEmail();
              }}
              containerStyle={styles.input}
              testID="join-email"
            />
            <Button
              label="Continue"
              variant="accent"
              disabled={submitting || !canSubmit}
              onPress={() => void flow.submitEmail()}
              trailing={spinner}
              testID="join-submit"
            />
          </View>
          <Text variant="foot" style={styles.foot}>
            We're letting people in a few at a time. Already in? You'll get a sign-in code here.
          </Text>
        </>
      ) : (
        <>
          <Text role="heading" aria-level={2} style={styles.title}>
            Check your email
          </Text>
          <Text variant="rowSub" style={styles.foot}>
            We sent a six-digit code to <Text style={styles.strong}>{email.trim()}</Text>.
          </Text>
          <CodeBoxes
            value={code}
            editable={!submitting}
            onChange={(value) => {
              flow.setCode(value);
              if (value.length === OTP_LENGTH && !submitting) void flow.verify(value);
            }}
            testID="join-code"
          />
          {resent ? (
            <Text variant="foot" role="status" style={styles.foot}>
              A new code is on its way. The last one no longer works.
            </Text>
          ) : null}
          <Text variant="foot" style={styles.links}>
            <Text role="link" style={styles.link} onPress={flow.changeEmail} testID="join-change-email">
              Use a different email
            </Text>
            {"  ·  "}
            <Text role="link" style={styles.link} onPress={() => void flow.resend()} testID="join-resend">
              Resend code
            </Text>
          </Text>
        </>
      )}
      {error ? (
        <Text variant="error" role="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** The homepage's sign-in-or-join state, held by the page rather than the card. */
export function useHomeJoin(router: { replace: (href: string) => void }): EmailSignIn {
  return useEmailSignIn({
    source: "homepage",
    onSignedIn: () => landAfterSignIn(CONSOLE_ROUTE, (href) => router.replace(href)),
  });
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      gap: space.x2,
      padding: space.x4,
      marginBottom: space.x5,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      maxWidth: 520,
    },
    eyebrow: { color: colors.muted },
    row: { flexDirection: "row", flexWrap: "wrap", gap: space.x2, alignItems: "center" },
    input: { flexGrow: 1, flexBasis: 200, minWidth: 0 },
    title: { fontSize: t.body, fontWeight: "600", color: colors.text },
    strong: { fontWeight: "600", color: colors.text },
    foot: { color: colors.muted, lineHeight: leading(12.5, 1.5) },
    links: { color: colors.muted },
    link: { color: colors.accent, fontWeight: "600" },
  });
