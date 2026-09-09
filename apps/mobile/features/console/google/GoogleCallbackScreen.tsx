import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View, useWindowDimensions } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../../design/components/Button";
import { Card } from "../../design/components/Card";
import { CenteredScroll } from "../../design/components/CenteredScroll";
import { StageBackdrop } from "../../design/components/StageBackdrop";
import { Text } from "../../design/components/Text";
import { clamp, fonts, leading } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { CONSOLE_ROUTE } from "../../auth/redirect";
import { parseGoogleCallback, takeGoogleCompletionSecret } from "./google";

export function GoogleCallbackScreen() {
  const styles = useThemedStyles(makeStyles);
  const params = useLocalSearchParams<{
    code?: string | string[];
    state?: string | string[];
    error?: string | string[];
  }>();
  const callback = useMemo(
    () => parseGoogleCallback(params),
    [params],
  );
  const complete = useAction(api.functions.googleConnect.completeGoogleConnect);
  const router = useRouter();
  const colors = useColors();
  const { width } = useWindowDimensions();
  const titleSize = clamp(26, 2.9, 36, width);
  const started = useRef(false);
  const [status, setStatus] = useState<"working" | "done" | "failed">(
    callback.kind === "ready" ? "working" : "failed",
  );

  useEffect(() => {
    if (started.current || callback.kind !== "ready") return;
    started.current = true;
    const completionSecret = takeGoogleCompletionSecret(callback.state);
    if (completionSecret === null) {
      setStatus("failed");
      return;
    }
    void (async () => {
      try {
        await complete({ state: callback.state, code: callback.code, completionSecret });
        setStatus("done");
      } catch {
        setStatus("failed");
      }
    })();
  }, [callback, complete]);

  const headline =
    callback.kind === "cancelled"
      ? "Google was not connected"
      : status === "done"
        ? "Google is connected"
        : status === "working"
          ? "Google is connecting"
          : "Google did not connect";

  const detail =
    callback.kind === "cancelled"
      ? "No account was added. Your context is unchanged."
      : status === "done"
        ? "Google accepted the connection. We are finishing the account setup in the background, then sync status will appear in settings."
        : status === "working"
          ? "The connection is finishing on our side."
          : "This Google connection expired, failed, or was opened in a different browser. Start it again from settings.";

  return (
    <View style={styles.ground}>
      <StageBackdrop />
      <CenteredScroll testID="google-callback-page">
        <View style={styles.wrap}>
          <Text variant="mark" style={styles.mark}>
            Context
            <Text variant="mark" style={styles.markSuffix}>
              .lc
            </Text>
          </Text>
          {status === "working" ? (
            <Card style={styles.card}>
              <View style={styles.loadingRow}>
                <ActivityIndicator color={colors.text2} size="small" />
                <Text variant="rowSub" role="status" style={styles.loadingBody}>
                  {detail}
                </Text>
              </View>
            </Card>
          ) : (
            <View style={styles.stack}>
              <Text
                role="heading"
                aria-level={1}
                style={[
                  styles.title,
                  {
                    fontSize: titleSize,
                    lineHeight: leading(titleSize, 1.08),
                    letterSpacing: 0,
                  },
                ]}
              >
                {headline}
              </Text>
              <Text variant="heroSub" role={status === "done" ? "status" : undefined} style={styles.sub}>
                {detail}
              </Text>
              <View style={styles.actions}>
                <Button
                  label="Back to console"
                  variant="decision"
                  onPress={() => router.replace(CONSOLE_ROUTE)}
                />
              </View>
            </View>
          )}
        </View>
      </CenteredScroll>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
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
  title: { fontFamily: fonts.display, fontWeight: "500", color: colors.text },
  sub: { marginTop: 14, fontSize: 15.5, lineHeight: leading(15.5, 1.55) },
  stack: { width: "100%" },
  card: { width: "100%" },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 11 },
  loadingBody: { flex: 1, minWidth: 0 },
  actions: {
    marginTop: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    flexWrap: "wrap",
  },
});
