import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View, useWindowDimensions } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../design/components/Button";
import { Card } from "../design/components/Card";
import { CenteredScroll } from "../design/components/CenteredScroll";
import { StageBackdrop } from "../design/components/StageBackdrop";
import { Text } from "../design/components/Text";
import { clamp, fonts, leading, pointerType as t } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { CONSOLE_ROUTE } from "../auth/redirect";
import { firstParam } from "../invite/invite";
import {
  EXPIRED_LINK_MESSAGE,
  browserCompletionStore,
  callbackMessage,
  failureMessage,
  parseConnectCallback,
  providerParam,
  takeCompletionSecret,
  type CallbackMessage,
  type CallbackOutcome,
} from "./connectFlow";

const SIGN_IN_FIRST = "Sign in to Context in this browser, then open the link from Tex again.";

/**
 * `/connect/<provider>?code=…&state=…` (or `?error=access_denied`): where a
 * provider sends the person after consent. The completion secret is read from
 * the browser that started the connection and removed in the same breath, so
 * the code is exchanged once, by the browser that asked for it.
 */
export function ConnectCallbackScreen() {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { width } = useWindowDimensions();
  const titleSize = clamp(26, 2.9, 36, width);
  const params = useLocalSearchParams<{
    provider?: string | string[];
    code?: string | string[];
    state?: string | string[];
    error?: string | string[];
  }>();
  const router = useRouter();
  const provider = providerParam(params.provider);
  const code = firstParam(params.code);
  const state = firstParam(params.state);
  const error = firstParam(params.error);
  // Memoized on the strings, so the effect below is not re-run by every render's new params object.
  const callback = useMemo(
    () => parseConnectCallback({ code: code ?? undefined, state: state ?? undefined, error: error ?? undefined }),
    [code, state, error],
  );
  const auth = useConvexAuth();
  const complete = useAction(api.functions.connections.completeProviderConnect);
  const [outcome, setOutcome] = useState<CallbackOutcome | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // Wait for the session: an exchange sent before it is ready has nobody to act for.
    if (started.current || auth.isLoading) return;
    started.current = true;
    if (provider === null) {
      setOutcome({ kind: "failed", message: EXPIRED_LINK_MESSAGE });
      return;
    }
    // Taken whatever the answer, so a refused or stale callback leaves nothing behind.
    const completionSecret = takeCompletionSecret(provider, browserCompletionStore());
    if (callback.kind === "denied") {
      setOutcome({ kind: "denied" });
      return;
    }
    if (callback.kind === "incomplete") {
      setOutcome({ kind: "failed", message: failureMessage(null) });
      return;
    }
    if (!auth.isAuthenticated) {
      setOutcome({ kind: "failed", message: SIGN_IN_FIRST });
      return;
    }
    if (completionSecret === null) {
      setOutcome({ kind: "missing-secret" });
      return;
    }
    void (async () => {
      try {
        const done = await complete({
          provider,
          state: callback.state,
          code: callback.code,
          completionSecret,
        });
        // An app connected through its own MCP server finishes on the server; the query below watches it.
        setOutcome(
          done.pending === undefined
            ? { kind: "connected", teamName: done.teamName }
            : { kind: "finishing", teamName: done.teamName, since: done.pending },
        );
      } catch (failure) {
        setOutcome({ kind: "failed", message: failureMessage(failure) });
      }
    })();
  }, [auth.isLoading, auth.isAuthenticated, callback, complete, provider]);

  const finishing = outcome?.kind === "finishing" && provider !== null ? { provider, since: outcome.since } : "skip";
  const connection = useQuery(api.functions.connections.connectionState, finishing);
  useEffect(() => {
    if (outcome?.kind !== "finishing") return;
    if (connection === "connected") setOutcome({ kind: "connected", teamName: outcome.teamName });
    if (connection === "failed") setOutcome({ kind: "failed", message: failureMessage(null) });
  }, [outcome, connection]);

  if (outcome === null) {
    return (
      <View style={styles.ground}>
        <StageBackdrop />
        <CenteredScroll testID="connect-callback-page">
          <View style={styles.wrap}>
            <Text variant="mark" style={styles.mark}>
              Context
              <Text variant="mark" style={styles.markSuffix}>
                .lc
              </Text>
            </Text>
            <Card style={styles.card}>
              <View style={styles.loadingRow}>
                <ActivityIndicator color={colors.text2} size="small" />
                <Text variant="rowSub" role="status" style={styles.loadingBody}>
                  Finishing the connection…
                </Text>
              </View>
            </Card>
          </View>
        </CenteredScroll>
      </View>
    );
  }

  const message: CallbackMessage = callbackMessage(outcome);
  return (
    <View style={styles.ground}>
      <StageBackdrop />
      <CenteredScroll testID="connect-callback-page">
        <View style={styles.wrap}>
          <Text variant="mark" style={styles.mark}>
            Context
            <Text variant="mark" style={styles.markSuffix}>
              .lc
            </Text>
          </Text>
          <Text
            role="heading"
            aria-level={1}
            style={[styles.title, { fontSize: titleSize, lineHeight: leading(titleSize, 1.08) }]}
          >
            {message.headline}
          </Text>
          <Text variant="heroSub" role={outcome.kind === "connected" ? "status" : undefined} style={styles.sub}>
            {message.body}
          </Text>
          <View style={styles.actions}>
            <Button label="Back to console" variant="decision" onPress={() => router.replace(CONSOLE_ROUTE)} />
          </View>
        </View>
      </CenteredScroll>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.ground, overflow: "hidden" },
    wrap: {
      width: "100%",
      maxWidth: 560,
      marginHorizontal: "auto",
      paddingHorizontal: 28,
      paddingVertical: 48,
    },
    mark: { alignSelf: "flex-start", marginBottom: 30 },
    markSuffix: { color: colors.muted },
    title: { fontFamily: fonts.display, fontWeight: "500", color: colors.text, letterSpacing: 0 },
    sub: { marginTop: 14, fontSize: t.body, lineHeight: leading(t.body, 1.55) },
    card: { width: "100%" },
    loadingRow: { flexDirection: "row", alignItems: "center", gap: 11 },
    loadingBody: { flex: 1, minWidth: 0 },
    actions: { marginTop: 24, flexDirection: "row", alignItems: "center", gap: 16, flexWrap: "wrap" },
  });
