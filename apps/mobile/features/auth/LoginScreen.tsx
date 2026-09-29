import { ActivityIndicator, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { densityFor } from "../app/frame";
import { Button } from "../design/components/Button";
import { CenteredScroll } from "../design/components/CenteredScroll";
import { TextField } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { fonts, layout, leading, pointerType as t, radii, space, tracking } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { landAfterSignIn } from "./landing";
import { LANDING_ROUTE, LOGIN_ROUTE, safeNextRoute } from "./redirect";
import { JOIN_HELPER, signInView, WRONG_EMAIL, type JoinVariant } from "./joinInvite";
import { JoinHeading } from "./JoinHeading";
import { useEmailSignIn } from "./useEmailSignIn";
import { WaitlistResult } from "./WaitlistResult";
import { CodeBoxes, OTP_LENGTH } from "./CodeBoxes";
import { SignInPreview } from "./SignInPreview";

/**
 * A-01 and A-02 — sign in, then the code. Or the waitlist.
 *
 * Context is invite-only: the address is asked about first, and only one that
 * has been let in goes on to the code. Anybody else sees "you're on the list"
 * right here (`useEmailSignIn`, `WaitlistResult`), and the homepage's
 * `JoinCard` runs the same flow in the page.
 *
 * Two steps against `@convex-dev/auth`'s email provider, configured by
 * `createSupaAuth` in `apps/convex/auth.ts`, which sends a six-digit code that
 * expires in ten minutes — the only reason this screen may say either. There
 * is no password anywhere in the product.
 *
 * A `?next=` parameter survives the round trip, narrowed by `safeNextRoute` on
 * the way through. It exists for the consent screen: an AI client sends someone
 * to `/authorize?request_id=…`, and dropping them on the console afterwards
 * would strand the OAuth attempt with nothing to retry.
 *
 * On a wide window the form sits beside a picture of the product (A-01) or of
 * the email just sent (A-02); on a phone it is the form alone, because the
 * picture is decoration and the keyboard already takes half the screen.
 *
 * `/join/<token>` is this screen too, with `join` set: a friend's invite puts
 * who invited them (or that the link no longer works) above the same field, and
 * on a working invite an address that is not let in is the wrong address, said
 * as an error rather than as a place on the waitlist (`joinInvite.ts`).
 */
export function LoginScreen({ join }: { join?: JoinVariant }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { width } = useWindowDimensions();
  const params = useLocalSearchParams<{ next?: string | string[] }>();
  const next = safeNextRoute(Array.isArray(params.next) ? params.next[0] : params.next);

  const flow = useEmailSignIn({
    source: "login",
    // A real navigation on the web, not a client-side replace — see
    // `landAfterSignIn` for the URL that hop was measured losing.
    onSignedIn: () => landAfterSignIn(next, (href) => router.replace(href)),
  });
  const { step, email, code, submitting, error, resent, canSubmit } = flow;
  const view = signInView(join, step);
  const asking = view === "request" || view === "wrongEmail";

  const wide = width >= 900;
  const phone = densityFor(width) === "compact";

  const spinner = submitting ? <ActivityIndicator color={colors.ink} size="small" /> : null;

  const form = (
    <View style={styles.form}>
      <Pressable
        onPress={() => router.replace(LANDING_ROUTE)}
        accessibilityLabel="Context.lc home"
        role="link"
        style={styles.mark}
      >
        <Text variant="mark">
          Context
          <Text variant="mark" style={styles.markSuffix}>
            .lc
          </Text>
        </Text>
      </Pressable>

      {view === "waitlist" ? (
        <WaitlistResult flow={flow} />
      ) : asking ? (
        <>
          {join ? (
            <JoinHeading variant={join} />
          ) : (
            <>
              <Text variant="eyebrow" style={styles.eyebrow}>
                Invite only for now
              </Text>
              <Text role="heading" aria-level={1} style={styles.pitch}>
                Notes for your team and your AI tools
              </Text>
            </>
          )}
          <View style={styles.field}>
            <TextField
              label="Email"
              value={email}
              onChangeText={(value) => {
                // Editing the address after "wrong email" is the retry.
                if (view === "wrongEmail") flow.changeEmail();
                flow.setEmail(value);
              }}
              placeholder="you@work.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
              editable={!submitting}
              onSubmitEditing={() => {
                if (canSubmit && !submitting) void flow.submitEmail();
              }}
              testID="login-email"
            />
          </View>
        </>
      ) : (
        <>
          <Text role="heading" aria-level={1} style={styles.pitch}>
            Check your email.
          </Text>
          <Text variant="rowSub" style={styles.sent}>
            We sent a six-digit code to <Text style={styles.strong}>{email.trim()}</Text>. It expires in ten
            minutes.
          </Text>
          <Text variant="eyebrow" style={styles.label}>
            Code
          </Text>
          <CodeBoxes
            value={code}
            editable={!submitting}
            onChange={(value) => {
              flow.setCode(value);
              // The sixth digit is the submit: a person who typed the whole
              // code has said everything this screen asks for.
              if (value.length === OTP_LENGTH && !submitting) void flow.verify(value);
            }}
            testID="login-code"
          />
          {resent ? (
            <Text variant="foot" role="status" style={styles.resent}>
              A new code is on its way. The last one no longer works.
            </Text>
          ) : null}
        </>
      )}

      {error ? (
        <Text variant="error" role="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}

      {view === "wrongEmail" ? (
        <View style={styles.error} testID="join-wrong-email">
          <Text variant="error" role="alert">
            {WRONG_EMAIL}
          </Text>
          <Text
            variant="foot"
            role="link"
            style={styles.link}
            onPress={() => router.replace(LOGIN_ROUTE)}
            testID="join-waitlist-instead"
          >
            Join the waitlist instead
          </Text>
        </View>
      ) : null}

      {view === "waitlist" ? null : asking ? (
        <View style={styles.primaryRow}>
          <Button
            label="Continue"
            variant="accent"
            disabled={submitting || !canSubmit}
            onPress={() => void flow.submitEmail()}
            trailing={spinner}
            // The width of the thumb's reach on a phone, as one target.
            style={phone ? styles.submitPhone : undefined}
            testID="login-submit"
          />
        </View>
      ) : (
        <>
          <View style={styles.verifyRow}>
            <Button
              label="Resend code"
              variant="decision"
              disabled={submitting}
              onPress={() => void flow.resend()}
              testID="login-resend"
            />
            <Button
              label="Continue →"
              variant="accent"
              disabled={submitting || !canSubmit}
              onPress={() => void flow.verify()}
              trailing={spinner}
              testID="login-submit"
            />
          </View>
          <Text
            variant="foot"
            role="link"
            style={styles.link}
            onPress={flow.changeEmail}
            testID="login-change-email"
          >
            Change email →
          </Text>
        </>
      )}

      {view !== "waitlist" ? (
        <Text variant="foot" style={styles.foot}>
          {view === "verify"
            ? "Next: pick the name your notes live under."
            : join?.kind === "invite"
              ? JOIN_HELPER
              : "Context is invite only for now. Already in? We'll email you a code. Not yet? We'll add you to the waitlist."}
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={styles.ground}>
      <CenteredScroll testID="login-page">
        <View style={[styles.frame, wide && styles.frameWide]}>
          <View style={[styles.formCol, wide && styles.formColWide]}>{form}</View>
          {wide ? (
            <View style={styles.previewCol}>
              <SignInPreview kind={step === "verify" ? "email" : "product"} email={email.trim()} />
            </View>
          ) : null}
        </View>
      </CenteredScroll>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.ground, overflow: "hidden" },
    frame: { width: "100%", alignSelf: "center" },
    frameWide: {
      maxWidth: 1180,
      flexDirection: "row",
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      overflow: "hidden",
      backgroundColor: colors.surface2,
      marginVertical: space.x6,
    },
    formCol: {
      width: "100%",
      maxWidth: 480,
      alignSelf: "center",
      paddingHorizontal: layout.gutter,
      paddingVertical: 48,
    },
    formColWide: { flex: 1, maxWidth: undefined, paddingHorizontal: 46, paddingVertical: 60, justifyContent: "center" },
    previewCol: { flex: 1, minHeight: 560 },
    form: { maxWidth: 360 },
    mark: { alignSelf: "flex-start", marginBottom: 32 },
    eyebrow: { marginBottom: space.x2, color: colors.muted },
    markSuffix: { color: colors.accent },
    pitch: {
      fontFamily: fonts.display,
      fontSize: t.h2,
      lineHeight: leading(26, 1.25),
      letterSpacing: tracking(26, -0.015),
      fontWeight: "600",
      color: colors.text,
    },
    strong: { fontWeight: "600", color: colors.text },
    sent: { marginTop: space.x3, color: colors.text2, lineHeight: leading(12.5, 1.5) },
    label: { marginTop: space.x5, marginBottom: space.x2, color: colors.muted },
    field: { marginTop: space.x6 },
    resent: { marginTop: space.x3, color: colors.muted },
    error: { marginTop: space.x3 },
    primaryRow: { marginTop: space.x5, alignSelf: "stretch" },
    submitPhone: { alignSelf: "stretch", justifyContent: "center" },
    verifyRow: { marginTop: space.x5, flexDirection: "row", justifyContent: "space-between", gap: space.x3 },
    link: { marginTop: space.x4, color: colors.accent, fontWeight: "600", textDecorationLine: "underline" },
    foot: { marginTop: space.x4, color: colors.muted, lineHeight: leading(12.5, 1.5) },
  });
