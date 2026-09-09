import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../../design/components/Button";
import { Card } from "../../design/components/Card";
import { CenteredScroll } from "../../design/components/CenteredScroll";
import { Text } from "../../design/components/Text";
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
        ? "The account is saved and queued for sync. You can close this and check settings."
        : status === "working"
          ? "The connection is finishing on our side."
          : "This Google connection expired, failed, or was opened in a different browser. Start it again from settings.";

  return (
    <CenteredScroll>
      <Card style={styles.card}>
        <View style={styles.stack}>
          {status === "working" ? <ActivityIndicator color={colors.text2} /> : null}
          <Text variant="paneTitle">{headline}</Text>
          <Text variant="rowSub">{detail}</Text>
          <Button label="Back to console" onPress={() => router.replace(CONSOLE_ROUTE)} />
        </View>
      </Card>
    </CenteredScroll>
  );
}

const makeStyles = (_colors: Colors) => StyleSheet.create({
  card: { width: "100%", maxWidth: 520 },
  stack: { gap: 12 },
});
