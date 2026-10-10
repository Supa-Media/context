import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card } from "../../design/components/Card";
import { FormError, Notice } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { leading } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import {
  describeFastSearch,
  describeIndexProgress,
  fastSearchControl,
  indexedLabel,
  type FastSearchView,
} from "./fastSearch";

/**
 * Fast search, in a context's settings.
 *
 * Fast search is always on for a workspace now, so the card states it rather
 * than offering a switch to turn it off. The one control left is "Turn on",
 * for an owner whose workspace was switched off before; the server still
 * allows that. Everything else is a state line: the title says which of the
 * states this context is in, the second line says what that means, and the
 * progress or failure is one line each.
 *
 * ## What is absent rather than disabled
 *
 * Everything the server would refuse. `fastSearchControl` is the single place
 * that decides, and it reads the server's own `canChange` — a member sees the
 * state and no button, the landing page's demo console sees the same card with
 * nothing behind it, and neither is offered a press whose only outcome is a
 * permission error.
 */
export function FastSearchCard({
  view,
  /** True on the landing page's picture of a console, which has no context. */
  demo = false,
}: {
  view: FastSearchView;
  demo?: boolean;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const run = (action: (() => Promise<void>) | undefined) => {
    if (action === undefined) return;
    setWorking(true);
    setFailure(null);
    void action()
      .catch(() =>
        // Our sentence, never the backend's: a Convex error can carry a
        // function path, and a person reading a settings card is owed the next
        // step instead. The state itself is the record — `failed` arrives on
        // the status with the deployment's own reason.
        setFailure("That did not go through. Check your connection and try again."),
      )
      .finally(() => setWorking(false));
  };

  if (view.status === null) {
    return (
      <Card>
        <View style={styles.loadingRow}>
          {view.loading ? <ActivityIndicator color={colors.text2} size="small" /> : null}
          <Text variant="rowSub">
            {view.loading
              ? "Loading…"
              : "How this context's search is served could not be read just now."}
          </Text>
        </View>
      </Card>
    );
  }

  const status = view.status;
  const copy = describeFastSearch(status.state);
  const control = fastSearchControl(view);
  const indexed = indexedLabel(status);
  // Once it is on, the count is the second line. The progress notice is for a
  // context still being prepared or one that stopped.
  const on = status.state === "on";
  const progress = on ? null : describeIndexProgress(status);

  return (
    <Card>
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text variant="rowTitle">{copy.title}</Text>
          <Text variant="rowSub" style={styles.blurb}>
            {on && indexed !== null ? indexed : copy.blurb}
          </Text>
        </View>
        {control === "enable" || control === "retry" ? (
          <Button
            variant="mini"
            label={
              working ? "Turning on…" : control === "retry" ? "Try again" : "Turn on"
            }
            accessibilityLabel={
              control === "retry"
                ? "Try preparing the index again"
                : "Turn fast search on for this context"
            }
            disabled={working}
            onPress={() => run(view.enable)}
            trailing={working ? <ActivityIndicator color={colors.text} size="small" /> : null}
            testID="fast-search-enable"
          />
        ) : null}
      </View>

      {progress === null ? null : (
        <Notice style={styles.notice} testID="fast-search-index">
          <Text
            variant="check"
            role="status"
            // The visible string is a fragment — "62% indexed" says nothing
            // about *what* is indexed or what the denominator is. A screen
            // reader gets the sentence.
            accessibilityLabel={progress.detail}
            testID="fast-search-progress"
          >
            {progress.label}
          </Text>
          {indexed === null ? null : (
            <Text variant="rowSub" role="status" style={styles.progressCount}>
              {indexed}
            </Text>
          )}
        </Notice>
      )}

      {/*
        The deployment's own sentence for a failed provision, from the closed
        set in `fastSearchProvision.ts`. It never carries Cloudflare's text —
        a provider message can name the account or the token.
      */}
      {status.state === "failed" && status.error ? (
        <FormError headline={status.error} style={styles.notice} />
      ) : null}

      {failure === null ? null : <FormError headline={failure} style={styles.notice} />}

      {control === "none" && (status.state === "off" || status.state === "failed") ? (
        <Text variant="foot" style={styles.readOnly}>
          {demo
            ? "Sign in and open your own workspace to decide this for it."
            : "Only an owner of this context can turn this on."}
        </Text>
      ) : null}
    </Card>
  );
}

const makeStyles = (_colors: Colors) => StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 12 },
  headText: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  blurb: { marginTop: 4, maxWidth: 546 },
  notice: { marginTop: 15 },
  /** The count under the percentage, not beside it. */
  progressCount: { marginTop: 3 },
  readOnly: { marginTop: 12, lineHeight: leading(12.5, 1.6) },
  loadingRow: { flexDirection: "row", alignItems: "center", gap: 11 },
});
