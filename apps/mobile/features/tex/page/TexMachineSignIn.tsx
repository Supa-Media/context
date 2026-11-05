import { useState } from "react";
import { Linking, StyleSheet, TextInput, View } from "react-native";
import { useFieldFont } from "../../design/fieldFont";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { texPageType } from "../../design/tokens";
import { Button, ButtonRow, Notice } from "./TexMachineParts";
import { T, pageStyles } from "./TexPageParts";
import { TOOL_LABEL, hereOf } from "./texMachineFormat";
import type { Machine, MachineSignIn, ToolName } from "./texMachineTypes";

/** As long as the computer waits for the code (`SIGN_IN_WAIT_MS` in the gateway's `serveMachines.js`). */
export const SIGN_IN_FRESH_MS = 16 * 60 * 1000;

/** The sign-in to draw for a tool now: the computer's latest one for it, while it is still worth showing. */
export function signInFor(m: Pick<Machine, "signIn">, tool: ToolName, now: number): MachineSignIn | null {
  const s = m.signIn;
  if (!s || s.tool !== tool || now - s.at > SIGN_IN_FRESH_MS) return null;
  return s;
}

/** Whether the computer is still working on a sign-in, so the page reads it again soon. */
export function signInBusy(m: Pick<Machine, "signIn">, now: number): boolean {
  const s = m.signIn;
  return !!s && (s.state === "starting" || s.state === "checking") && now - s.at < 2 * 60 * 1000;
}

/** Only ever the tool maker's own page: anything else the page won't open. */
export function signInLinkOk(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return url.startsWith("https://") && ["claude.com", "claude.ai", "anthropic.com"].some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/**
 * Signing a coding tool in on a computer from the page, with no terminal (the owner, 2026-11-05; artboard
 * "Sign in coding tools from anywhere"). Step 1 opens the tool's own sign-in page, on this phone or any browser;
 * step 2 sends the code that page shows to the computer, which finishes the sign-in. The code is never kept here.
 */
export function SignInPanel({
  m,
  tool,
  signIn,
  onStart,
  onCode,
  onClose,
}: {
  m: Machine;
  tool: ToolName;
  signIn: MachineSignIn | null;
  onStart: () => void;
  onCode: (signInId: string, code: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const field = useFieldFont(texPageType.field);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const label = TOOL_LABEL[tool];
  const here = hereOf(m);

  if (signIn === null || signIn.state === "starting") {
    return (
      <View style={styles.panel} testID="tex-machine-signin-starting">
        <T size={14} line={1.5}>{`Getting ${label}'s sign-in link from ${here}…`}</T>
      </View>
    );
  }
  if (signIn.state === "checking") {
    return (
      <View style={styles.panel} testID="tex-machine-signin-checking">
        <T size={14} line={1.5}>{`Signing ${label} in on ${here}…`}</T>
      </View>
    );
  }
  if (signIn.state === "done") {
    return (
      <View style={styles.panel} testID="tex-machine-signin-done">
        <T size={15} weight="500">{`${label} is signed in on ${here}`}</T>
        <T size={14} tone="muted" line={1.5}>
          Tex can run jobs there again. Text Tex to pick up a job that couldn't start.
        </T>
        <ButtonRow>
          <Button label="Done" look="primary" onPress={onClose} testID="tex-machine-signin-close" />
        </ButtonRow>
      </View>
    );
  }
  if (signIn.state === "failed") {
    return (
      <View style={styles.panel} testID="tex-machine-signin-failed">
        <Notice
          action={<Button label="Start again" look="primary" onPress={onStart} testID="tex-machine-signin-again" />}
        >
          {`That didn't work: ${signIn.error ?? "the sign-in didn't finish."} Each sign-in link works once, so start again for a fresh one.`}
        </Notice>
      </View>
    );
  }

  const send = async () => {
    const typed = code.trim();
    if (typed === "") return;
    setSending(true);
    setRefused(null);
    const error = await onCode(signIn.id, typed);
    setSending(false);
    if (error === null) setCode("");
    else setRefused(error === "bad_code" ? "That doesn't look like the code Claude shows. Copy it again." : error === "sign_in_ended" ? "This sign-in has ended. Start again." : `${here} didn't take it. Try again.`);
  };

  return (
    <View style={styles.panel} testID="tex-machine-signin">
      <View style={styles.step}>
        <T size={12} weight="600" tone="muted" upper>Step 1</T>
        <T size={14} line={1.5}>{`Open ${label}'s sign-in page and sign in with the account you use for it.`}</T>
        <ButtonRow aside={`${here} made this link just now. It works on this phone or any browser.`}>
          <Button
            label={`Open ${label} sign-in`}
            look="primary"
            disabled={!signInLinkOk(signIn.url)}
            onPress={() => {
              if (signInLinkOk(signIn.url)) void Linking.openURL(signIn.url);
            }}
            testID="tex-machine-signin-open"
          />
        </ButtonRow>
      </View>
      <View style={styles.step}>
        <T size={12} weight="600" tone="muted" upper>Step 2</T>
        <T size={14} line={1.5}>{`The page then shows a code. Paste it here.`}</T>
        <TextInput
          value={code}
          onChangeText={setCode}
          placeholder="Paste the code"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          accessibilityLabel={`${label} sign-in code`}
          onSubmitEditing={() => void send()}
          style={[pageStyles(colors).input, field]}
          testID="tex-machine-signin-code"
        />
        {refused ? (
          <T size={13} tone="crit" testID="tex-machine-signin-refused">
            {refused}
          </T>
        ) : null}
        <ButtonRow aside={`The code goes straight to ${here} to finish signing in. Context doesn't keep it.`}>
          <Button label="Finish sign-in" disabled={sending || code.trim() === ""} onPress={() => void send()} testID="tex-machine-signin-send" />
          <Button label="Cancel" look="quiet" onPress={onClose} testID="tex-machine-signin-cancel" />
        </ButtonRow>
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    panel: { gap: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line },
    step: { gap: 8 },
  });
