import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../../design/components/Text";
import { fonts, pointerType as t, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { MCP_ENDPOINT } from "../../console/placeholderData";
import { CLAUDE_CUSTOM_INSTRUCTION } from "../../onboarding/agents";
import type { SetupAgent, StepKey } from "../guides";

/**
 * "What you'll see in Claude": a schematic of the other app, never a copy of
 * it. Grey lines where their words are, our words where somebody has to find
 * them, and a numbered ring on each thing to press. A screenshot would date
 * the day either product moved a pixel; a diagram only dates if the path does,
 * and the path is in the words beside it.
 *
 * Always pointer-sized: it is a picture, drawn at one scale, and on a phone it
 * sits behind "Show me where" rather than beside the steps.
 */

const CLAUDE_NAV = ["General", "Account", "Privacy", "Billing", "Capabilities", "Connectors"];
const GPT_NAV = ["General", "Notifications", "Personalization", "Apps", "Data controls", "Security"];

function useIll() {
  return useThemedStyles(makeStyles);
}

function Frame({ caption, children }: { caption: string; children: ReactNode }) {
  const s = useIll();
  return (
    <View style={s.ill} aria-hidden>
      <Text style={s.cap}>{caption}</Text>
      {children}
    </View>
  );
}

function Pin({ n }: { n: number }) {
  const s = useIll();
  return (
    <View style={s.pin}>
      <Text style={s.pinText}>{n}</Text>
    </View>
  );
}

function Win({
  title,
  nav,
  hit,
  hitPin,
  children,
}: {
  title?: string;
  nav?: string[];
  hit?: string;
  /** Ring the highlighted nav item itself, numbered, when it is the thing to press. */
  hitPin?: number;
  children: ReactNode;
}) {
  const s = useIll();
  return (
    <View style={s.win}>
      {title === undefined ? null : (
        <View style={s.wbar}>
          <View style={s.light} />
          <View style={s.light} />
          <View style={s.light} />
          <Text style={s.wbarTitle}>{title}</Text>
        </View>
      )}
      <View style={s.wbody}>
        {nav === undefined ? null : (
          <View style={s.wnav}>
            {nav.map((item) =>
              item === hit && hitPin !== undefined ? (
                <View key={item} style={s.hl}>
                  <Text style={[s.navItem, s.navHit]}>{item}</Text>
                  <Pin n={hitPin} />
                </View>
              ) : (
                <Text key={item} style={[s.navItem, item === hit && s.navHit]}>
                  {item}
                </Text>
              ),
            )}
          </View>
        )}
        <View style={s.wpane}>{children}</View>
      </View>
    </View>
  );
}

const Line = ({ width = "70%" as `${number}%` }) => {
  const s = useIll();
  return <View style={[s.line, { width }]} />;
};

function Fake({ label, solid = false, pin }: { label: string; solid?: boolean; pin?: number }) {
  const s = useIll();
  return (
    <View style={[s.fake, solid && s.fakeSolid, pin !== undefined && s.hl]}>
      <Text style={[s.fakeLabel, solid && s.fakeLabelSolid]}>{label}</Text>
      {pin === undefined ? null : <Pin n={pin} />}
    </View>
  );
}

function Input({ label, value, pin, plain = false }: { label: string; value: string; pin?: number; plain?: boolean }) {
  const s = useIll();
  return (
    <View>
      <Text style={s.lab}>{label}</Text>
      <View style={[s.inp, pin !== undefined && s.hl]}>
        <Text style={[s.inpText, !plain && s.mono]} numberOfLines={3}>
          {value}
        </Text>
        {pin === undefined ? null : <Pin n={pin} />}
      </View>
    </View>
  );
}

function RowItem({ children, hl = false }: { children: ReactNode; hl?: boolean }) {
  const s = useIll();
  return <View style={[s.rowi, hl && s.hl]}>{children}</View>;
}

const Right = ({ children }: { children: ReactNode }) => {
  const s = useIll();
  return <View style={s.right}>{children}</View>;
};

function Chat({ ask, detail, allow, input }: { ask: string; detail: string; allow: string; input: string }) {
  const s = useIll();
  return (
    <View style={s.win}>
      <View style={s.chat}>
        <View style={s.bubble} />
        <RowItem>
          <View style={{ gap: 8, flex: 1 }}>
            <Text style={s.strong}>{ask}</Text>
            <Text style={s.lab}>{detail}</Text>
            <Right>
              <Fake label="Deny" />
              <Fake label={allow} solid pin={1} />
            </Right>
          </View>
        </RowItem>
        <View style={[s.inp, s.spread]}>
          <Text style={s.inpText}>{input}</Text>
          <Text style={s.inpText}>↑</Text>
        </View>
      </View>
    </View>
  );
}

/** Our own consent window — the one screen in the flow that is ours. */
function Consent({ agent, slug }: { agent: string; slug: string }) {
  const s = useIll();
  return (
    <View style={s.consent}>
      <Text style={s.lab}>Allow access</Text>
      <Text style={s.consentTitle}>{agent}</Text>
      <Text style={s.lab}>wants to read and add notes in your context.</Text>
      <Text style={[s.lab, { marginTop: 12 }]}>Which context it starts in</Text>
      <View style={[s.inp, s.spread]}>
        <Text style={[s.inpText, s.mono]}>@{slug}</Text>
        <Text style={s.inpText}>⌄</Text>
      </View>
      <Text style={[s.lab, { marginTop: 8 }]}>How much of this context it sees</Text>
      <View style={[s.inp, s.spread]}>
        <Text style={s.inpText}>Team notes</Text>
        <Text style={s.inpText}>⌄</Text>
      </View>
      <View style={[s.right, { marginTop: 14 }]}>
        <Fake label="Deny" />
        <Fake label="Approve" solid pin={1} />
      </View>
    </View>
  );
}

const SEEN_IN: Record<SetupAgent, string> = {
  claude: "What you'll see in Claude",
  chatgpt: "What you'll see in ChatGPT",
};

/** The picture beside a step, or `null` for a step with nothing to point at. */
export function StepIllustration({ agent, step, slug }: { agent: SetupAgent; step: StepKey; slug: string }) {
  const s = useIll();
  const short = CLAUDE_CUSTOM_INSTRUCTION.slice(0, 84) + "…";
  switch (step) {
    case "open":
      return (
        <Frame caption={SEEN_IN.claude}>
          <Win title="Settings" nav={CLAUDE_NAV} hit="Connectors" hitPin={1}>
            <Text style={s.strong}>Connectors</Text>
            <Line />
            <RowItem><Line width="50%" /><Fake label="Connect" /></RowItem>
            <RowItem><Line width="50%" /><Fake label="Connect" /></RowItem>
            <View style={{ flexDirection: "row" }}><Fake label="Add custom connector" /></View>
          </Win>
        </Frame>
      );
    case "add":
      return (
        <Frame caption={SEEN_IN.claude}>
          <Win title="Add custom connector">
            <Input label="Name" value="Context" pin={1} />
            <Input label="Remote MCP server URL" value={MCP_ENDPOINT} pin={2} />
            <Text style={s.lab}>› Advanced settings</Text>
            <Right>
              <Fake label="Cancel" />
              <Fake label="Add" solid pin={3} />
            </Right>
          </Win>
        </Frame>
      );
    case "devmode":
      return (
        <Frame caption={SEEN_IN.chatgpt}>
          <Win title="Settings" nav={GPT_NAV} hit="Apps">
            <Text style={s.strong}>Apps</Text>
            <RowItem><Line width="50%" /><Fake label="Connect" /></RowItem>
            <Text style={s.lab}>Advanced settings ›</Text>
            <RowItem hl>
              <Text style={s.strong}>Developer mode</Text>
              <View style={s.toggle}><View style={s.knob} /></View>
              <Pin n={1} />
            </RowItem>
          </Win>
        </Frame>
      );
    case "create":
      return (
        <Frame caption={SEEN_IN.chatgpt}>
          <Win title="New app">
            <Input label="Name" value="Context" pin={1} />
            <Input label="MCP server URL" value={MCP_ENDPOINT} pin={2} />
            <Input label="Authentication" value="OAuth ⌄" pin={3} plain />
            <View style={s.tick}>
              <View style={[s.tickBox, s.hl]}>
                <Text style={s.tickMark}>✓</Text>
                <Pin n={4} />
              </View>
              <Text style={s.lab}>I understand and want to continue</Text>
            </View>
            <Right>
              <Fake label="Create" solid pin={5} />
            </Right>
          </Win>
        </Frame>
      );
    case "signin":
      return (
        <Frame caption="The window Context shows you">
          <Consent agent={agent === "claude" ? "Claude" : "ChatGPT"} slug={slug} />
        </Frame>
      );
    case "stick":
      return agent === "claude" ? (
        <Frame caption={SEEN_IN.claude}>
          <Win title="Settings" nav={CLAUDE_NAV} hit="General">
            <Text style={s.strong}>Profile</Text>
            <Input label="What personal preferences should Claude consider in responses?" value={short} pin={1} plain />
            <Right><Fake label="Save" solid /></Right>
          </Win>
        </Frame>
      ) : (
        <Frame caption={SEEN_IN.chatgpt}>
          <Win title="Settings" nav={GPT_NAV} hit="Personalization">
            <Text style={s.strong}>Custom instructions</Text>
            <Text style={s.lab}>What traits should ChatGPT have?</Text>
            <Line width="80%" />
            <Input label="Anything else ChatGPT should know about you?" value={short} pin={1} plain />
            <Right><Fake label="Save" solid /></Right>
          </Win>
        </Frame>
      );
    case "bring":
      return (
        <Frame caption={SEEN_IN[agent]}>
          {agent === "claude" ? (
            <Chat ask="Claude wants to use Context" detail="write_note · 1-projects/context-lc.md" allow="Always allow" input="Reply to Claude…" />
          ) : (
            <Chat ask="Context wants to write a note" detail="1-projects/context-lc.md" allow="Confirm" input="+ · Developer mode · Context" />
          )}
        </Frame>
      );
  }
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    ill: {
      borderRadius: radii.tile,
      backgroundColor: colors.surface2,
      borderWidth: 1,
      borderColor: colors.line,
      padding: 22,
    },
    cap: { fontSize: t.meta, color: colors.muted, marginBottom: space.x3 },
    win: {
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.ground,
      overflow: "hidden",
    },
    wbar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      paddingVertical: 9,
      paddingHorizontal: space.x3,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
      backgroundColor: colors.surface3,
    },
    light: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.lineStrong },
    wbarTitle: { marginLeft: space.x2, fontSize: t.label, color: colors.muted },
    wbody: { flexDirection: "row", minHeight: 240 },
    wnav: { width: 130, borderRightWidth: 1, borderRightColor: colors.line, padding: space.x2, gap: 2 },
    navItem: { paddingVertical: 5, paddingHorizontal: space.x2, borderRadius: radii.md, fontSize: t.meta, color: colors.muted },
    navHit: { color: colors.text, backgroundColor: colors.chipFill, fontWeight: "600" },
    wpane: { flex: 1, minWidth: 0, paddingVertical: 14, paddingHorizontal: space.x4, gap: 10 },
    strong: { fontSize: t.meta, fontWeight: "600", color: colors.text },
    line: { height: 8, borderRadius: 4, backgroundColor: colors.line },
    rowi: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
      paddingVertical: 9,
      paddingHorizontal: 10,
      borderRadius: radii.lg,
      borderWidth: 1,
      borderColor: colors.line,
    },
    right: { flexDirection: "row", justifyContent: "flex-end", gap: space.x2 },
    spread: { flexDirection: "row", justifyContent: "space-between" },
    fake: {
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.surface3,
    },
    fakeSolid: { backgroundColor: colors.text, borderColor: colors.text },
    fakeLabel: { fontSize: t.meta, fontWeight: "600", color: colors.text },
    fakeLabelSolid: { color: colors.ground },
    hl: { outlineWidth: 2, outlineStyle: "solid", outlineColor: colors.accent, outlineOffset: 3, borderRadius: radii.md },
    pin: {
      position: "absolute",
      right: -12,
      top: -12,
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: colors.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    pinText: { fontSize: t.label, fontWeight: "700", color: colors.ink },
    lab: { fontSize: t.label, color: colors.muted, marginBottom: 3 },
    inp: {
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.md,
      paddingVertical: 6,
      paddingHorizontal: space.x2,
      backgroundColor: colors.ground,
    },
    inpText: { fontSize: t.meta, color: colors.text, lineHeight: 18 },
    mono: { fontFamily: fonts.mono },
    tick: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    tickBox: {
      width: 16,
      height: 16,
      borderRadius: 4,
      backgroundColor: colors.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    tickMark: { fontSize: t.label, fontWeight: "700", color: colors.ink },
    toggle: { width: 30, height: 18, borderRadius: 9, backgroundColor: colors.accent, justifyContent: "center" },
    knob: { width: 14, height: 14, borderRadius: 7, backgroundColor: colors.ground, alignSelf: "flex-end", marginRight: 2 },
    chat: { flex: 1, minHeight: 240, padding: 18, gap: 10, justifyContent: "flex-end" },
    bubble: { width: "60%", height: 26, borderRadius: 12, backgroundColor: colors.line, alignSelf: "flex-end" },
    consent: {
      maxWidth: 320,
      width: "100%",
      alignSelf: "center",
      borderRadius: radii.tile,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      backgroundColor: colors.ground,
      padding: 22,
    },
    consentTitle: { fontSize: t.lede, fontWeight: "600", color: colors.text, marginTop: 8, marginBottom: 4 },
  });
