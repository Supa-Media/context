import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text as RNText, View, useWindowDimensions } from "react-native";
import { Link } from "expo-router";
import { ScreenScroll } from "../app/Screen";
import { writeClipboard } from "../design/clipboard";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { fonts, leading, pointerType as t } from "../design/tokens";
import { PLATFORM_ORIGIN } from "../site/host";
import {
  AGENT_CARD_LEAD,
  AGENT_CARD_TITLE,
  INSTALL_FOOT,
  INSTALL_LEAD,
  INSTALL_SECTIONS,
  INSTALL_TITLE,
  agentInstructions,
  sectionFor,
  type InstallLink,
  type InstallStep,
  type InstallTab,
} from "./installGuide";

/** Below this the tabs use their short labels and code wraps rather than scrolls. */
const NARROW_PX = 520;

/**
 * `context.lc/download`: how to put Context on a Mac, a Linux computer or a
 * headless server so Tex can run jobs there, and a block of instructions to
 * hand a coding agent instead. Public, no sign-in. The words live in
 * `installGuide.ts`; this file only draws them.
 */
export function InstallPage({ initialTab = "mac" }: { initialTab?: InstallTab }) {
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const narrow = width < NARROW_PX;
  const [tab, setTab] = useState<InstallTab>(initialTab);
  const [showPrompt, setShowPrompt] = useState(false);
  const section = sectionFor(tab);

  return (
    <ScreenScroll style={styles.ground} contentContainerStyle={styles.scroll}>
      <View style={styles.wrap}>
        <View style={styles.nav}>
          <Link href="/" style={styles.brand} accessibilityLabel="Context home">
            Context.lc
          </Link>
        </View>

        <RNText role="heading" aria-level={1} style={[styles.title, narrow ? styles.titleNarrow : null]}>
          {INSTALL_TITLE}
        </RNText>
        <RNText style={styles.lead}>{INSTALL_LEAD}</RNText>

        <View style={styles.tabs} accessibilityRole="tablist">
          {INSTALL_SECTIONS.map((s) => {
            const on = s.tab === tab;
            return (
              <Pressable
                key={s.tab}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                onPress={() => setTab(s.tab)}
                style={[styles.tab, on ? styles.tabOn : null]}
                testID={`install-tab-${s.tab}`}
              >
                <RNText style={[styles.tabText, on ? styles.tabTextOn : null]}>{narrow ? s.shortLabel : s.label}</RNText>
              </Pressable>
            );
          })}
        </View>

        {section.intro ? <RNText style={[styles.body, styles.intro]}>{section.intro}</RNText> : null}

        <View style={styles.steps} testID={`install-steps-${tab}`}>
          {section.steps.map((step, i) => (
            <Step key={step.title} n={i + 1} step={step} narrow={narrow} />
          ))}
        </View>

        {section.aside ? (
          <View style={styles.aside}>
            <RNText style={styles.small}>
              {section.aside}
              {section.asideLinks?.map((link, i) => (
                <RNText key={link.href}>
                  {i === 0 ? " " : " · "}
                  <RNText style={styles.link} onPress={() => openDownload(link.href)}>
                    {link.label}
                  </RNText>
                </RNText>
              ))}
            </RNText>
          </View>
        ) : null}

        <View style={styles.agent} testID="install-agent">
          <View style={styles.agentHead}>
            <View style={{ flex: 1, minWidth: 200, gap: 4 }}>
              <RNText style={styles.agentTitle}>{AGENT_CARD_TITLE}</RNText>
              <RNText style={styles.small}>{AGENT_CARD_LEAD}</RNText>
            </View>
            <CopyButton text={agentInstructions(tab)} label="Copy instructions" primary testID="install-agent-copy" />
          </View>
          <Pressable onPress={() => setShowPrompt((v) => !v)} accessibilityRole="button" testID="install-agent-toggle">
            <RNText style={[styles.small, styles.link]}>{showPrompt ? "Hide them" : "Show them"}</RNText>
          </Pressable>
          {showPrompt ? (
            <RNText selectable style={styles.prompt} testID="install-agent-text">
              {agentInstructions(tab)}
            </RNText>
          ) : null}
        </View>

        <RNText style={[styles.small, styles.foot]}>{INSTALL_FOOT}</RNText>
      </View>
    </ScreenScroll>
  );
}

function Step({ n, step, narrow }: { n: number; step: InstallStep; narrow: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.step}>
      <View style={styles.num}>
        <RNText style={styles.numText}>{n}</RNText>
      </View>
      <View style={styles.stepBody}>
        <RNText style={styles.stepTitle}>{step.title}</RNText>
        {step.body && !step.commands ? <RNText style={styles.body}>{step.body}</RNText> : null}
        {step.links ? (
          <View style={styles.buttons}>
            {step.links.map((link) => (
              <DownloadButton key={link.href} link={link} />
            ))}
          </View>
        ) : null}
        {step.commands ? <Code lines={step.commands} narrow={narrow} /> : null}
        {step.body && step.commands ? <RNText style={styles.body}>{step.body}</RNText> : null}
        {step.note ? <RNText style={styles.small}>{step.note}</RNText> : null}
      </View>
    </View>
  );
}

function Code({ lines, narrow }: { lines: readonly string[]; narrow: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.code}>
      <RNText selectable style={[styles.codeText, narrow ? styles.codeWrap : null]}>
        {lines.map((line, i) => (
          <RNText key={line}>
            {i > 0 ? "\n" : ""}
            <RNText style={{ color: colors.muted }}>{"$ "}</RNText>
            {line}
          </RNText>
        ))}
      </RNText>
      <View style={styles.codeCopy}>
        <CopyButton text={lines.join("\n")} label="Copy" small />
      </View>
    </View>
  );
}

function CopyButton({ text, label, primary = false, small = false, testID }: { text: string; label: string; primary?: boolean; small?: boolean; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await writeClipboard(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => void copy()}
      style={[styles.btn, primary ? styles.btnPrimary : null, small ? styles.btnSmall : null]}
      testID={testID}
    >
      <RNText style={[styles.btnText, primary ? styles.btnTextPrimary : null, small ? styles.btnTextSmall : null]}>
        {copied ? "Copied" : label}
      </RNText>
    </Pressable>
  );
}

function DownloadButton({ link }: { link: InstallLink }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable accessibilityRole="link" onPress={() => openDownload(link.href)} style={[styles.btn, link.primary ? styles.btnPrimary : null]}>
      <RNText style={[styles.btnText, link.primary ? styles.btnTextPrimary : null]}>{link.label}</RNText>
    </Pressable>
  );
}

/** The router redirects these to the newest release; they are not app routes. */
function openDownload(href: string) {
  void Linking.openURL(`${PLATFORM_ORIGIN}${href}`).catch(() => {});
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ground: { flex: 1, backgroundColor: colors.ground },
    scroll: { minHeight: "100%" },
    wrap: { width: "100%", maxWidth: 760, alignSelf: "center", paddingHorizontal: 16, paddingTop: 24, paddingBottom: 72 },
    nav: { minHeight: 44, flexDirection: "row", alignItems: "center", marginBottom: 40 },
    brand: { fontFamily: fonts.display, fontSize: t.lede, fontWeight: "600", color: colors.text, textDecorationLine: "none" },
    title: { fontFamily: fonts.reading, fontSize: t.page, lineHeight: leading(t.page, 1.2), fontWeight: "500", color: colors.text, marginBottom: 8 },
    titleNarrow: { fontSize: t.title, lineHeight: leading(t.title, 1.2) },
    lead: { fontFamily: fonts.body, fontSize: t.body, lineHeight: leading(t.body, 1.5), color: colors.text2, marginBottom: 24, maxWidth: 580 },
    tabs: { flexDirection: "row", gap: 4, padding: 4, borderRadius: 10, backgroundColor: colors.surface2, borderWidth: 1, borderColor: colors.line, marginBottom: 22 },
    tab: { flex: 1, alignItems: "center", paddingVertical: 8, paddingHorizontal: 6, borderRadius: 7 },
    tabOn: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.lineStrong },
    tabText: { fontFamily: fonts.body, fontSize: t.ui, color: colors.text2 },
    tabTextOn: { color: colors.text, fontWeight: "600" },
    intro: { marginBottom: 18 },
    steps: { gap: 20 },
    step: { flexDirection: "row", gap: 12 },
    num: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.accentDim, alignItems: "center", justifyContent: "center", marginTop: 1 },
    numText: { fontFamily: fonts.body, fontSize: t.ui, fontWeight: "600", color: colors.accent },
    stepBody: { flex: 1, minWidth: 0, gap: 6 },
    stepTitle: { fontFamily: fonts.body, fontSize: t.lede, lineHeight: leading(t.lede, 1.45), fontWeight: "600", color: colors.text },
    body: { fontFamily: fonts.body, fontSize: t.lede, lineHeight: leading(t.lede, 1.5), color: colors.text2 },
    small: { fontFamily: fonts.body, fontSize: t.ui, lineHeight: leading(t.ui, 1.45), color: colors.muted },
    link: { color: colors.accent },
    buttons: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 2 },
    btn: { borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14, backgroundColor: colors.surface, alignSelf: "flex-start" },
    btnPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
    btnSmall: { paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6, backgroundColor: colors.surface2 },
    btnText: { fontFamily: fonts.body, fontSize: t.lede, color: colors.text },
    btnTextPrimary: { color: colors.ink, fontWeight: "600" },
    btnTextSmall: { fontSize: t.meta, color: colors.text2 },
    code: { flexDirection: "row", alignItems: "flex-start", gap: 8, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface2, borderRadius: 8, paddingVertical: 10, paddingLeft: 12, paddingRight: 8 },
    codeText: { flex: 1, minWidth: 0, fontFamily: fonts.mono, fontSize: t.ui, lineHeight: leading(t.ui, 1.55), color: colors.text },
    codeWrap: { overflowWrap: "anywhere" } as object,
    codeCopy: { flexShrink: 0 },
    aside: { marginTop: 20, padding: 12, borderRadius: 8, backgroundColor: colors.warnWash },
    agent: { marginTop: 28, padding: 18, gap: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface2 },
    agentHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 },
    agentTitle: { fontFamily: fonts.body, fontSize: t.h3, fontWeight: "600", color: colors.text },
    prompt: { fontFamily: fonts.mono, fontSize: t.meta, lineHeight: leading(t.meta, 1.6), color: colors.text2, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 8, padding: 12 },
    foot: { marginTop: 24, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.line },
  });
