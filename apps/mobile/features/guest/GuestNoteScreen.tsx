import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { useAction } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../design/components/Button";
import { CenteredScroll } from "../design/components/CenteredScroll";
import { StageBackdrop } from "../design/components/StageBackdrop";
import { Text } from "../design/components/Text";
import { fonts, leading, pointerType as t, space, tracking } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { CodeBoxes, OTP_LENGTH } from "../auth/CodeBoxes";
import { PhoneNumberField } from "../auth/PhoneNumberField";
import { PHONE_VERIFY_PROVIDER } from "../auth/usePhoneSignIn";
import { loginHref } from "../auth/redirect";
import { canonicalHrefFor, type NoteAddress } from "../console/noteLink";
import { NoteBody } from "../share/NoteBody";
import { noteTitle, parseNote } from "../share/markdown";
import { linkLabel } from "../share/share";
import {
  forgetGuestPass,
  guestStartError,
  guestVerifyError,
  readGuestPass,
  type GuestStartStatus,
  type GuestVerifyStatus,
} from "./guestPass";

/**
 * A note link from a Tex group chat, opened by somebody who isn't signed in (the owner, 2026-10-27: "an easy screen
 * for them to verify their number and open the artifact, and keep them logged in"; board: the "Guest Phone Pass"
 * mock).
 *
 * A guest in the chat has no account. They type the number they text the group from, get a code, and the note
 * opens; the pass the code gave is kept in this browser (`guestPass.ts`), so the next link opens with no code. The
 * server decides everything (`apps/convex/functions/guestPass.ts`): which numbers are texted, and what each pass
 * reads, worked out again on every read. A number an account holds is texted a sign-in code instead (`account`), and
 * the code signs that account in here: the route then opens the note in the console, with everything it may see
 * (the owner, 2026-10-27: "I should already be signed in").
 *
 * Read only: edits go through Tex in the chat.
 */
type Step =
  | { kind: "opening" }
  | { kind: "phone" }
  | { kind: "code"; phone: string; account: boolean }
  | { kind: "note"; path: string; text: string }
  | { kind: "unavailable" };

export function GuestNoteScreen({ address }: { address: NoteAddress }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const router = useRouter();
  const { signIn: signInWithCode } = useAuthActions();
  const start = useAction(api.functions.guestPass.start);
  const verify = useAction(api.functions.guestPass.verify);
  const readNote = useAction(api.functions.guestPass.readNote);
  const signOut = useAction(api.functions.guestPass.signOut);

  const [step, setStep] = useState<Step>(() => (readGuestPass() === null ? { kind: "phone" } : { kind: "opening" }));
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  const open = useCallback(
    async (pass: string) => {
      try {
        const result = await readNote({ pass, slug: address.slug, path: address.path });
        if (result.status === "ok") setStep({ kind: "note", path: result.path, text: result.text });
        else if (result.status === "unavailable") setStep({ kind: "unavailable" });
        else {
          forgetGuestPass();
          setStep({ kind: "phone" });
        }
      } catch {
        setError("The note didn't open. Check your connection and try again.");
        setStep({ kind: "unavailable" });
      }
    },
    [address.path, address.slug, readNote],
  );

  useEffect(() => {
    const pass = readGuestPass();
    if (pass !== null) void open(pass);
  }, [open]);

  async function send(again = false) {
    setError(null);
    setSubmitting(true);
    try {
      const result = (await start({ phone: step.kind === "code" ? step.phone : phone, slug: address.slug })) as {
        status: GuestStartStatus;
        phone?: string;
        account?: boolean;
      };
      setError(guestStartError(result.status));
      if (result.status === "sent" && result.phone !== undefined) {
        setStep({ kind: "code", phone: result.phone, account: result.account === true });
        setCode("");
        setResent(again);
      }
    } catch {
      setError(guestStartError("failed"));
    } finally {
      setSubmitting(false);
    }
  }

  async function check(value = code) {
    if (step.kind !== "code" || value.length !== OTP_LENGTH) return;
    setError(null);
    setSubmitting(true);
    if (step.account) {
      try {
        // Signed in, the route swaps this page for the note in the console. A refused code answers "not signed in".
        const result = await signInWithCode(PHONE_VERIFY_PROVIDER, { phone: step.phone, code: value });
        if (!result.signingIn) {
          setError(guestVerifyError("wrong"));
          setCode("");
        }
      } catch {
        setError(guestVerifyError("wrong"));
        setCode("");
      } finally {
        setSubmitting(false);
      }
      return;
    }
    try {
      const result = (await verify({ phone: step.phone, code: value })) as { status: GuestVerifyStatus; code?: string };
      if (result.status === "ok" && result.code !== undefined) {
        // The number's account was made for it (`guestPass.ts`): it signs in as a number an account holds does.
        const signedIn = await signInWithCode(PHONE_VERIFY_PROVIDER, { phone: step.phone, code: result.code });
        if (!signedIn.signingIn) {
          setError(guestVerifyError("wrong"));
          setCode("");
        }
      } else {
        setError(guestVerifyError(result.status));
        setCode("");
      }
    } catch {
      setError(guestVerifyError("wrong"));
      setCode("");
    } finally {
      setSubmitting(false);
    }
  }

  async function leave() {
    const pass = readGuestPass();
    forgetGuestPass();
    setStep({ kind: "phone" });
    setPhone("");
    if (pass !== null) await signOut({ pass }).catch(() => undefined);
  }

  const signIn = () => router.push(loginHref(canonicalHrefFor(address)));
  const spinner = submitting ? <ActivityIndicator color={colors.ink} size="small" /> : null;

  return (
    <View style={styles.ground} testID="guest-note">
      <StageBackdrop />
      <CenteredScroll>
        <View style={styles.wrap}>
          <Text variant="mark" style={styles.mark}>
            Context
          </Text>

          {step.kind === "opening" ? (
            <View style={styles.centered}>
              <ActivityIndicator color={colors.muted} />
              <Text variant="meta">Opening the note…</Text>
            </View>
          ) : null}

          {step.kind === "phone" ? (
            <View>
              <Text role="heading" aria-level={1} style={styles.title}>
                Open the note from your group chat
              </Text>
              <Text variant="rowSub" style={styles.sub}>
                Enter the number you text the group from. We'll text you a code. If it's your Context number, the code
                signs you in.
              </Text>
              <View style={styles.field}>
                <PhoneNumberField
                  value={phone}
                  onChangeText={(value) => {
                    setPhone(value);
                    setError(null);
                  }}
                  editable={!submitting}
                  onSubmitEditing={() => {
                    if (phone.trim().length >= 7 && !submitting) void send();
                  }}
                  testID="guest-phone"
                />
              </View>
              <Failure text={error} />
              <View style={styles.primaryRow}>
                <Button
                  label="Text me a code"
                  variant="accent"
                  disabled={submitting || phone.trim().length < 7}
                  onPress={() => void send()}
                  trailing={spinner}
                  style={styles.stretch}
                  testID="guest-phone-send"
                />
              </View>
              <Text variant="foot" style={styles.foot}>
                No account needed.{" "}
                <Text variant="foot" role="link" style={styles.link} onPress={signIn} testID="guest-sign-in">
                  Have one? Sign in
                </Text>
              </Text>
            </View>
          ) : null}

          {step.kind === "code" ? (
            <View>
              <Text role="heading" aria-level={1} style={styles.title}>
                Enter the code
              </Text>
              <Text variant="rowSub" style={styles.sub}>
                {step.account ? (
                  <>
                    A code is on its way to <Text style={styles.strong}>{step.phone}</Text>. It signs you in to your
                    account.
                  </>
                ) : (
                  <>
                    If <Text style={styles.strong}>{step.phone}</Text> is in the chat, a code is on its way to it.
                  </>
                )}
              </Text>
              <View style={styles.field}>
                <CodeBoxes
                  value={code}
                  editable={!submitting}
                  onChange={(value) => {
                    setCode(value);
                    setError(null);
                    if (value.length === OTP_LENGTH && !submitting) void check(value);
                  }}
                  testID="guest-code"
                />
              </View>
              {resent ? (
                <Text variant="foot" role="status" style={styles.foot}>
                  A new code is on its way. The last one no longer works.
                </Text>
              ) : null}
              <Failure text={error} />
              <View style={styles.primaryRow}>
                <Button
                  label={step.account ? "Sign in and open" : "Open the note"}
                  variant="accent"
                  disabled={submitting || code.length !== OTP_LENGTH}
                  onPress={() => void check()}
                  trailing={spinner}
                  style={styles.stretch}
                  testID="guest-code-verify"
                />
              </View>
              <Text variant="foot" style={styles.foot}>
                <Text variant="foot" role="link" style={styles.link} onPress={() => void send(true)} testID="guest-code-resend">
                  Text a new code
                </Text>
                {" · "}
                <Text
                  variant="foot"
                  role="link"
                  style={styles.link}
                  onPress={() => {
                    setStep({ kind: "phone" });
                    setError(null);
                  }}
                  testID="guest-code-change"
                >
                  Use a different number
                </Text>
              </Text>
            </View>
          ) : null}

          {step.kind === "note" ? <GuestNote path={step.path} text={step.text} onSignOut={() => void leave()} /> : null}

          {step.kind === "unavailable" ? (
            <View>
              <Text role="heading" aria-level={1} style={styles.title}>
                This note isn't open to your chat
              </Text>
              <Text variant="rowSub" style={styles.sub}>
                {error ??
                  "It may not be shared with the group, or you may have left the chat. Ask Tex in the chat to share it again."}
              </Text>
              <Text variant="foot" style={styles.foot}>
                <Text variant="foot" role="link" style={styles.link} onPress={() => void leave()} testID="guest-other-number">
                  Use a different number
                </Text>
                {" · "}
                <Text variant="foot" role="link" style={styles.link} onPress={signIn}>
                  Sign in
                </Text>
              </Text>
            </View>
          ) : null}
        </View>
      </CenteredScroll>
    </View>
  );
}

function Failure({ text }: { text: string | null }) {
  const styles = useThemedStyles(makeStyles);
  if (text === null) return null;
  return (
    <Text variant="error" role="alert" style={styles.error}>
      {text}
    </Text>
  );
}

/** The note itself, read only, its own first heading as its title. */
function GuestNote({ path, text, onSignOut }: { path: string; text: string; onSignOut: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const parsed = useMemo(() => parseNote(text), [text]);
  const heading = noteTitle(parsed.blocks);
  const title = heading ?? linkLabel(path);
  const body = heading === null ? parsed.blocks : parsed.blocks.slice(1);
  return (
    <View testID="guest-note-body">
      <Text variant="eyebrow" style={styles.eyebrow}>
        Shared with your group chat
      </Text>
      <Text role="heading" aria-level={1} style={styles.title}>
        {title}
      </Text>
      <View style={styles.body}>
        <NoteBody blocks={body} />
      </View>
      <View style={styles.footRow}>
        <Text variant="foot" style={styles.muted}>
          Signed in by phone. Text Tex in the chat to change anything here.
        </Text>
        <Text variant="foot" role="link" style={styles.link} onPress={onSignOut} testID="guest-sign-out">
          Sign out
        </Text>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.ground, overflow: "hidden" },
    wrap: { width: "100%", maxWidth: 640, marginHorizontal: "auto", paddingHorizontal: 24, paddingVertical: 40 },
    mark: { alignSelf: "flex-start", marginBottom: 28 },
    centered: { alignItems: "center", gap: space.x3, paddingVertical: space.x6 },
    eyebrow: { marginBottom: space.x2, color: colors.muted },
    title: {
      fontFamily: fonts.display,
      fontSize: t.h2,
      lineHeight: leading(26, 1.25),
      letterSpacing: tracking(26, -0.015),
      fontWeight: "600",
      color: colors.text,
    },
    sub: { marginTop: space.x3, color: colors.text2, lineHeight: leading(12.5, 1.5) },
    strong: { fontWeight: "600", color: colors.text },
    field: { marginTop: space.x6 },
    error: { marginTop: space.x3 },
    primaryRow: { marginTop: space.x5, alignSelf: "stretch" },
    stretch: { alignSelf: "stretch", justifyContent: "center" },
    foot: { marginTop: space.x4, color: colors.muted, lineHeight: leading(12.5, 1.5) },
    link: { color: colors.accent, fontWeight: "600", textDecorationLine: "underline" },
    body: { marginTop: space.x5 },
    footRow: {
      marginTop: space.x6,
      paddingTop: space.x4,
      borderTopWidth: 1,
      borderTopColor: colors.line,
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "space-between",
      gap: space.x3,
    },
    muted: { color: colors.muted, flexShrink: 1 },
  });
