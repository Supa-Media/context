import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../../design/components/Button";
import { CenteredScroll } from "../../design/components/CenteredScroll";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { useColors, useThemedStyles } from "../../design/theme";
import { CONSOLE_ROUTE } from "../redirect";
import { newGmail, type GmailFirstMode } from "./gmailFirst";
import { makeGmailStyles } from "./gmailStyles";

/** How long to wait for the binding before saying "Connected" without the address. */
const LANDING_MS = 30_000;

/**
 * Google came back from a Gmail-first page (board 08, 09b). Says which
 * address is connected and what it is now, with Back to Messages first: Tex
 * texts on its own when the first Gmail connects (`apps/agent/src/
 * gmailWatch.ts`), so one tap returns them to the reply. The binding lands a
 * moment after Google returns, so the address is read live: `primary` waits
 * for the first Gmail, `another` for one not there when the page opened.
 */
export function GmailDone({ mode }: { mode: GmailFirstMode }) {
  const colors = useColors();
  const styles = useThemedStyles(makeGmailStyles);
  const router = useRouter();
  const home = useQuery(api.functions.texHome.mine, {});
  const before = useRef<string[] | null>(null);
  if (before.current === null && home) before.current = home.gmails;
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), LANDING_MS);
    return () => clearTimeout(timer);
  }, []);

  const gmails = home?.gmails ?? [];
  const main = home?.mainEmail ?? null;
  const address =
    mode === "primary"
      ? main !== null && gmails.includes(main)
        ? main
        : (gmails[0] ?? null)
      : newGmail(before.current ?? gmails, gmails);
  const settled = address !== null || late;

  const line = home?.line ?? null;
  const openConsole = () => router.replace(CONSOLE_ROUTE);
  const strong = (text: string) => <Text style={styles.strong}>{text}</Text>;

  // Tex texts on its own only to somebody it set up by text (`gmailWatch.ts`).
  const next = home?.firstText === false ? "Tex is reading your mail now and will text you." : "Text Tex to get started.";
  let body: React.ReactNode;
  if (address === null) body = mode === "primary" ? next : "Tex can read it now.";
  else if (mode === "another")
    body = main === null ? <>Tex can read {strong(address)} now.</> : <>Tex can read {strong(address)} now. Your main email is still {strong(main)}.</>;
  else if (main === address) body = <>{strong(address)} is your main email. {next}</>;
  else body = <>Tex can read {strong(address)} now. Another Context account already has this address, so it can't be your main email here. {next}</>;

  return (
    <View style={styles.ground}>
      <CenteredScroll testID="gmail-done">
        <View style={styles.form}>
          <Text variant="mark" style={styles.mark}>
            Context
            <Text variant="mark" style={styles.markSuffix}>
              .lc
            </Text>
          </Text>
          {settled ? (
            <>
              <View style={styles.tick}>
                <Icon name="check" size={20} color={colors.ok} />
              </View>
              <Text role="heading" aria-level={1} style={styles.pitch}>
                {mode === "primary" ? "Connected." : "Added."}
              </Text>
              <Text style={styles.body} role="status">
                {body}
              </Text>
              <View style={styles.primaryRow}>
                {line !== null ? (
                  <Button
                    label="Back to Messages"
                    variant="accent"
                    leading={<Icon name="chat" size={18} color={colors.ink} />}
                    onPress={() => void Linking.openURL(`sms:${line}`)}
                    testID="gmail-done-messages"
                  />
                ) : null}
                <Button
                  label="Open console"
                  variant={line !== null ? "decision" : "accent"}
                  onPress={openConsole}
                  testID="gmail-done-console"
                />
              </View>
              {mode === "primary" && address !== null && main === address ? (
                <Text variant="foot" style={styles.foot}>
                  You can change your main email in Settings › Account.
                </Text>
              ) : null}
            </>
          ) : (
            <View style={styles.waiting}>
              <ActivityIndicator color={colors.text2} size="small" />
              <Text variant="rowSub" role="status">
                Finishing up with Google…
              </Text>
            </View>
          )}
        </View>
      </CenteredScroll>
    </View>
  );
}
