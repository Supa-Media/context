import { useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View, useWindowDimensions } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../design/components/Button";
import { Card } from "../design/components/Card";
import { FormError } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { clamp, leading, pointerType as t } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { InvitePage, Title } from "../invite/InviteScreen";
import { firstParam } from "../invite/invite";
import { loginHref } from "../auth/redirect";
import { useSwitchAccount } from "../auth/useSwitchAccount";
import {
  EXPIRED_LINK_MESSAGE,
  browserCompletionStore,
  connectHref,
  connectLinkCopy,
  failureMessage,
  providerParam,
  rememberCompletionSecret,
} from "./connectFlow";
import { leaveForConsent } from "./leaveForConsent";

/**
 * `/connect/<provider>/<token>`: the link Tex texts when it needs a connector
 * to Slack (or another provider) opened for this person.
 *
 * Owns its own sign-in gate, like `/vault/<token>`, so a signed-out visitor
 * goes to `/login` and comes straight back to the link. Nothing leaves the
 * app until the person presses Continue: that press starts the attempt, keeps
 * its completion secret in this browser, and sends them to the provider.
 */
export function ConnectLinkScreen() {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { width } = useWindowDimensions();
  const titleSize = clamp(26, 2.9, 36, width);
  const params = useLocalSearchParams<{ provider?: string | string[]; token?: string | string[] }>();
  const provider = providerParam(params.provider);
  const token = firstParam(params.token);
  const auth = useConvexAuth();
  const switchAccount = useSwitchAccount();
  const start = useAction(api.functions.connections.startProviderConnect);
  const live = provider !== null && token !== null && auth.isAuthenticated;
  const info = useQuery(api.functions.connections.connectLinkInfo, live ? { token } : "skip");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const pressed = useRef(false);

  // A route that is not a known provider, or has no token, is the expired page: nothing to sign in for.
  if (provider === null || token === null) {
    return <Ending titleSize={titleSize} testID="connect-link-expired" />;
  }
  if (auth.isLoading) return <View style={styles.ground} />;
  if (!auth.isAuthenticated) return <Redirect href={loginHref(connectHref(provider, token))} />;
  if (info === undefined) {
    return (
      <InvitePage testID="connect-link-page">
        <Card>
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.text2} size="small" />
            <Text variant="rowSub">Opening your link…</Text>
          </View>
        </Card>
      </InvitePage>
    );
  }
  if (info.state === "expired") return <Ending titleSize={titleSize} testID="connect-link-expired" />;
  if (info.state === "not_yours") {
    return (
      <InvitePage testID="connect-link-page">
        <View testID="connect-link-not-yours">
          <Title size={titleSize}>This link is for someone else</Title>
          <Text variant="heroSub" style={styles.sub}>
            Sign in as the person it was sent to, then open it again.
          </Text>
        </View>
        <Button
          label="Sign in as someone else"
          variant="accent"
          style={styles.switchAccount}
          onPress={() => switchAccount(loginHref(connectHref(provider, token)))}
          testID="connect-link-switch-account"
        />
      </InvitePage>
    );
  }

  if (info.state !== "ready") return <Ending titleSize={titleSize} testID="connect-link-expired" />;

  const copy = connectLinkCopy({
    providerName: info.providerName,
    connectedTeams: info.connectedTeams,
    available: info.available,
  });

  // The ref, not `busy`, is what stops a double press: state has not re-rendered yet on the second one.
  const fail = (message: string) => {
    pressed.current = false;
    setBusy(false);
    setFailure(message);
  };

  const onContinue = async () => {
    if (pressed.current) return;
    pressed.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const { authorizeUrl, completionSecret } = await start({ token });
      if (!rememberCompletionSecret(provider, completionSecret, browserCompletionStore())) {
        fail("This browser could not keep the connection secret. Try again.");
        return;
      }
      leaveForConsent(authorizeUrl);
    } catch (error) {
      fail(failureMessage(error));
    }
  };

  return (
    <InvitePage testID="connect-link-page">
      <View testID="connect-link-ready">
        <Title size={titleSize}>{copy.title}</Title>
        <Text variant="heroSub" style={styles.sub}>
          {copy.line}
        </Text>
        {copy.already === null ? null : (
          <Text variant="rowSub" style={styles.sub} testID="connect-link-already">
            {copy.already}
          </Text>
        )}
        {copy.unavailableLine === null ? null : (
          <Text variant="heroSub" style={styles.sub} testID="connect-link-unavailable">
            {copy.unavailableLine}
          </Text>
        )}
      </View>
      {failure === null ? null : <FormError headline={failure} style={styles.error} />}
      {copy.button === null ? null : (
        <Button
          label={copy.button}
          variant="accent"
          style={styles.switchAccount}
          disabled={busy}
          onPress={() => void onContinue()}
          trailing={busy ? <ActivityIndicator color={colors.ink} size="small" /> : null}
          testID="connect-link-continue"
        />
      )}
    </InvitePage>
  );
}

/** The link that cannot be used any more, in one line. */
function Ending({ titleSize, testID }: { titleSize: number; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <InvitePage testID={testID}>
      <View>
        <Title size={titleSize}>Link expired</Title>
        <Text variant="heroSub" style={styles.sub}>
          {EXPIRED_LINK_MESSAGE}
        </Text>
      </View>
    </InvitePage>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.ground },
    sub: { marginTop: 14, fontSize: t.body, lineHeight: leading(t.body, 1.55) },
    loadingRow: { flexDirection: "row", alignItems: "center", gap: 11 },
    error: { marginTop: 16 },
    switchAccount: { marginTop: 24 },
  });
