import { StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button } from "../design/components/Button";
import { CenteredScroll } from "../design/components/CenteredScroll";
import { StageBackdrop } from "../design/components/StageBackdrop";
import { Text } from "../design/components/Text";
import { leading, pointerType as t, radii } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { CONSOLE_ROUTE } from "../auth/redirect";

/**
 * `/connect/cli?result=connected|refused`: where the browser lands after
 * `npx @supa-media/context` signs in.
 *
 * The CLI receives the OAuth code on a loopback port and serves that page
 * itself, so it cannot use these components. When the gateway names the app
 * (`context_app_origin` in its OAuth metadata), the loopback page redirects
 * here instead, carrying only the outcome: the code never leaves the loopback
 * URL. Built from the same parts as the dead-link and connect-callback pages.
 *
 * Anything but an exact `connected` reads as not signed in. The parameter is a
 * link anybody can type, and "you are signed in" on a guess would be a claim
 * this page cannot check.
 */
export type CliResult = "connected" | "refused";

export function cliResult(value: string | string[] | undefined): CliResult {
  const first = Array.isArray(value) ? value[0] : value;
  return first === "connected" ? "connected" : "refused";
}

export function CliConnectedScreen() {
  const params = useLocalSearchParams<{ result?: string | string[] }>();
  const router = useRouter();
  return <CliConnectedBody result={cliResult(params.result)} onLeave={(href) => router.replace(href)} />;
}

export function CliConnectedBody({ result, onLeave }: { result: CliResult; onLeave: (href: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const connected = result === "connected";

  return (
    <View style={styles.ground} testID="cli-connected">
      <StageBackdrop />
      <CenteredScroll>
        <View style={styles.wrap}>
          <Text variant="mark" style={styles.mark}>
            Context
            <Text variant="mark" style={styles.markSuffix}>
              .lc
            </Text>
          </Text>

          <Text role="heading" aria-level={1} style={styles.title}>
            {connected ? "You are signed in" : "Not signed in"}
          </Text>

          <Text variant="heroSub" role="status" style={styles.sub}>
            {connected
              ? "The Context CLI is signed in. Close this tab and go back to your terminal to finish setting up."
              : "The sign-in was refused, so the CLI has no access. Run npx @supa-media/context in your terminal to try again."}
          </Text>

          {connected ? (
            <View style={styles.note}>
              <Text variant="foot">
                This sign-in appears in Connections, where you can revoke it on its own at any time.
              </Text>
            </View>
          ) : null}

          <View style={styles.actions}>
            <Button
              label="Go to your notes"
              variant="white"
              onPress={() => onLeave(CONSOLE_ROUTE)}
              testID="cli-connected-console"
            />
          </View>
        </View>
      </CenteredScroll>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  ground: { flex: 1, backgroundColor: colors.ground, overflow: "hidden" },
  wrap: {
    width: "100%",
    maxWidth: 520,
    marginHorizontal: "auto",
    paddingHorizontal: 28,
    paddingVertical: 48,
  },
  mark: { alignSelf: "flex-start", marginBottom: 30 },
  markSuffix: { color: colors.muted },
  title: {
    fontSize: t.title,
    lineHeight: leading(t.title, 1.1),
    fontWeight: "500",
    color: colors.text,
  },
  sub: { marginTop: 14, fontSize: t.body, lineHeight: leading(t.body, 1.55) },
  note: {
    marginTop: 22,
    paddingVertical: 12,
    paddingHorizontal: 15,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.well,
  },
  actions: { marginTop: 24, flexDirection: "row", gap: 16, flexWrap: "wrap" },
});
