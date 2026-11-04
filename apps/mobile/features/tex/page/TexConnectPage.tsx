import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { writeClipboard } from "../../design/clipboard";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import type { ViewProps } from "./TexPageBody";
import { Hint, SubPage, T, pageStyles, useWide } from "./TexPageParts";
import { Button, ButtonRow, DotLine, GlyphSquare } from "./TexMachineParts";
import { pairingFacts } from "./texMachineFormat";
import type { Read } from "./texPageSource";
import type { MachinesPage, Pairing } from "./texMachineTypes";

/** How often the page re-reads the machines while it is open: the pairing code appears on its own. */
const POLL_MS = 3_000;

const COMMAND = "npx @supa-media/context machine";

/**
 * Settings › Your machines › Connect a machine (artboards `03-connect` and
 * `03-connect-approve`). With no code waiting it offers the two ways to add a
 * machine; once a code arrives it asks the person to approve or decline it.
 */
export function ConnectPage({ source, page, chat, go }: ViewProps) {
  const colors = useColors();
  const wide = useWide();
  const styles = useThemedStyles(makeStyles);
  const card = pageStyles(colors).card;
  const [read, setRead] = useState<Read<MachinesPage> | null>(null);
  const [again, setAgain] = useState(0);
  const [copied, setCopied] = useState(false);

  // Re-read on mount, after an action, and every few seconds while open.
  useEffect(() => {
    let stale = false;
    const tick = () => {
      void source.machines(chat).then((r) => {
        if (!stale) setRead(r);
      });
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [chat, source, again]);

  const pairing: Pairing | null = read?.kind === "ok" ? read.value.pairing : null;

  const answer = async (approve: boolean) => {
    if (!pairing) return;
    const result = await page.act({ type: "machine.pair", code: pairing.code, approve });
    setAgain((n) => n + 1);
    if (approve && result.ok) go({ view: "machines" });
  };

  const copy = async () => {
    const ok = await writeClipboard(COMMAND);
    if (ok) setCopied(true);
  };

  if (pairing) {
    return (
      <SubPage title="Connect a machine" testID="tex-connect">
        <View style={[card, styles.pair]}>
          <T size={22} serif line={1.25}>
            {`Approve ${pairing.name}?`}
          </T>
          <View style={{ gap: 6 }}>
            <T size={32} weight="600" mono style={{ letterSpacing: 2 }} testID="tex-connect-code">
              {pairing.code}
            </T>
            <T size={13} tone="muted">
              {pairingFacts(pairing)}
            </T>
          </View>
          <Hint>Check this is the code on that computer's screen. If you did not run the command, decline it.</Hint>
          <ButtonRow>
            <Button label="Approve" look="primary" onPress={() => void answer(true)} testID="tex-connect-approve" />
            <Button label="Decline" onPress={() => void answer(false)} testID="tex-connect-decline" />
          </ButtonRow>
        </View>
        <T size={13} tone="muted">
          It starts with 2 slots, for just you, and 2 hours a day. You can change all of it after.
        </T>
      </SubPage>
    );
  }

  return (
    <SubPage
      title="Connect a machine"
      lead="Tex runs jobs there with your own Claude Code and Codex. Their sign-ins stay on that machine."
      testID="tex-connect"
    >
      <View style={[styles.paths, wide ? styles.pathsWide : null]}>
        <View style={[card, styles.path]} testID="tex-connect-mac">
          <Heading glyph="laptop" title="A Mac with the Context app" />
          <T size={13} tone="muted" line={1.5}>
            On that Mac, open Settings › Tex and turn on{" "}
            <T size={13} weight="600" tone="text2" line={1.5}>
              Let Tex use this Mac
            </T>
            . It shows up here at once, with no code.
          </T>
        </View>

        <View style={[card, styles.path]} testID="tex-connect-cli">
          <Heading glyph="terminal" title="Another computer" />
          <T size={13} tone="muted" line={1.5}>
            Any Mac, Linux computer or server with Node 20 or later. Run this there:
          </T>
          <View style={styles.code}>
            <T size={13} mono line={1.5} testID="tex-connect-command">
              <T size={13} mono line={1.5} tone="muted">
                {"$ "}
              </T>
              {COMMAND}
            </T>
          </View>
          <T size={13} tone="muted" line={1.5}>
            It prints a short code. You approve it here.
          </T>
          <View style={styles.pinned}>
            <Button label={copied ? "Copied" : "Copy the command"} look="primary" onPress={() => void copy()} testID="tex-connect-copy" />
          </View>
        </View>
      </View>

      <DotLine tone="warn" testID="tex-connect-wait">
        Waiting for a code. This page updates on its own.
      </DotLine>
    </SubPage>
  );
}

/** A path card's heading: the tinted icon square, then the title at 15 semibold. */
function Heading({ glyph, title }: { glyph: "laptop" | "terminal"; title: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.heading}>
      <GlyphSquare glyph={glyph} />
      <T size={15} weight="600" style={{ flex: 1, minWidth: 0 }}>
        {title}
      </T>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    paths: { gap: 12 },
    pathsWide: { flexDirection: "row", alignItems: "stretch" },
    path: { flex: 1, minWidth: 0, padding: 16, gap: 10 },
    heading: { flexDirection: "row", alignItems: "center", gap: 10 },
    /** Pushes the button to the card's foot, so the two cards' buttons share a line. */
    pinned: { marginTop: "auto", paddingTop: 6, alignSelf: "flex-start" },
    code: { borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 8, padding: 10, backgroundColor: colors.surface2 },
    pair: { padding: 16, gap: 12 },
  });
