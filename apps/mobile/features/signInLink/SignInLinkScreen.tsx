import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useAction } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@context/convex/_generated/api";
import { Text } from "../design/components/Text";
import { useColors } from "../design/theme";
import { firstParam } from "../invite/invite";
import { PHONE_VERIFY_PROVIDER } from "../auth/usePhoneSignIn";
import { afterOpening, type OpenAnswer } from "./signInLink";

/**
 * `/signin/<token>`: the link Tex texts once the notes of somebody set up by
 * text are ready (`functions/textSignIn.ts`). It signs them in as the phone it
 * was texted to and goes straight on, to "What's your email?" the first time
 * and then Google's connect card (Dev2, 2026-10-18).
 *
 * Opening happens here, in the page, never on the request for it, so a link
 * preview that fetches the address without running the page spends nothing.
 * A spent link, or a refused sign-in, falls back to the ordinary sign-in on
 * the way to the same place.
 */
export function SignInLinkScreen() {
  const colors = useColors();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = firstParam(params.token);
  const open = useAction(api.functions.textSignIn.open);
  const { signIn } = useAuthActions();
  const [target, setTarget] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      let answer: OpenAnswer = { status: "spent" };
      try {
        answer = token === null ? answer : await open({ token });
      } catch {
        // Unreachable: the ordinary sign-in still works.
      }
      let signedIn = false;
      if (answer.status === "open") {
        try {
          signedIn = (await signIn(PHONE_VERIFY_PROVIDER, { phone: answer.phone, code: answer.code })).signingIn;
        } catch {
          signedIn = false;
        }
      }
      setTarget(afterOpening(answer, signedIn));
    })();
  }, [open, signIn, token]);

  if (target !== null) return <Redirect href={target as never} />;
  return (
    <View style={[styles.ground, { backgroundColor: colors.ground }]} testID="signin-link-page">
      <ActivityIndicator color={colors.text2} size="small" />
      <Text variant="rowSub">Signing you in…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
});
