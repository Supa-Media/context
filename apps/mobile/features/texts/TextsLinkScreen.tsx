import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View, useWindowDimensions } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useAction, useConvexAuth } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../design/components/Button";
import { Card } from "../design/components/Card";
import { Text } from "../design/components/Text";
import { writeClipboard } from "../design/clipboard";
import { clamp, fonts, leading, pointerType as t, radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { InvitePage, Title } from "../invite/InviteScreen";
import { firstParam } from "../invite/invite";
import { resolveTextsLinkView, type Claim, type TextsLinkView } from "./textsLink";

/**
 * `/texts/<token>`: the page a texted link opens.
 *
 * Owns its own sign-in gate, like `/invite/<token>`, so a signed-out visitor
 * goes to `/login?next=/texts/<token>` and comes straight back here. The code
 * is asked for once per visit; a reload asks again and the new code replaces
 * the old one.
 */
export function TextsLinkScreen() {
  const styles = useThemedStyles(makeStyles);
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const token = firstParam(params.token);
  const auth = useConvexAuth();
  const claimInvite = useAction(api.functions.textLinks.claimPhoneLinkInvite);
  const [claim, setClaim] = useState<Claim>({ kind: "idle" });
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current || !auth.isAuthenticated || token === null) return;
    asked.current = true;
    setClaim({ kind: "claiming" });
    claimInvite({ token }).then(
      (shown) => setClaim({ kind: "shown", ...shown }),
      (error: unknown) => setClaim({ kind: "failed", error }),
    );
  }, [auth.isAuthenticated, claimInvite, token]);

  const view = resolveTextsLinkView({ token, auth, claim });
  if (view.kind === "wait") return <View style={styles.ground} />;
  if (view.kind === "signIn") return <Redirect href={view.href} />;

  return (
    <InvitePage testID="texts-link-page">
      <TextsLinkBody view={view} />
    </InvitePage>
  );
}

/** Every state but the redirects, drawable without a session. */
export function TextsLinkBody({ view }: { view: TextsLinkView }) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const titleSize = clamp(26, 2.9, 36, width);
  const [copied, setCopied] = useState(false);
  const message = view.kind === "ready" ? view.message : null;
  const copy = useCallback(async () => {
    if (message !== null) setCopied(await writeClipboard(message));
  }, [message]);

  switch (view.kind) {
    case "wait":
    case "signIn":
      return null;
    case "loading":
      return (
        <Card>
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.text2} size="small" />
            <Text variant="rowSub">Getting your code…</Text>
          </View>
        </Card>
      );
    case "dead":
      return (
        <View testID="texts-link-dead">
          <Title size={titleSize}>{view.headline}</Title>
          <Text variant="heroSub" style={styles.sub}>
            {view.detail}
          </Text>
        </View>
      );
    case "ready":
      return (
        <View testID="texts-link-ready">
          <Title size={titleSize}>Text this back</Title>
          <Text variant="heroSub" style={styles.sub}>
            {`Go back to Messages and send this to your Context from the phone ending in ${view.phoneEnding}. It works for 10 minutes.`}
          </Text>
          <View style={styles.codeBox}>
            <Text selectable style={styles.code} testID="texts-link-code">
              {view.message}
            </Text>
          </View>
          <Button
            label={copied ? "Copied" : "Copy"}
            variant="decision"
            style={styles.copy}
            onPress={() => void copy()}
            testID="texts-link-copy"
          />
          <Text variant="foot" style={styles.foot}>
            The code only works from that phone, so nobody else can use it to read your notes.
          </Text>
        </View>
      );
  }
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.ground },
    sub: { marginTop: 14, fontSize: t.body, lineHeight: leading(t.body, 1.55) },
    loadingRow: { flexDirection: "row", alignItems: "center", gap: 11 },
    codeBox: {
      marginTop: 24,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface2,
      paddingVertical: 22,
      paddingHorizontal: 18,
      alignItems: "center",
    },
    code: {
      fontFamily: fonts.mono,
      fontSize: t.title,
      letterSpacing: 2,
      color: colors.text,
    },
    copy: { marginTop: 16 },
    foot: { marginTop: 18, color: colors.muted, lineHeight: leading(12.5, 1.5) },
  });
