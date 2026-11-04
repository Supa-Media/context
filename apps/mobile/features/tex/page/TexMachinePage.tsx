import { useState, type ReactNode } from "react";
import { Linking, StyleSheet, TextInput, View } from "react-native";
import { Switch } from "../../design/components/Switch";
import { useFieldFont } from "../../design/fieldFont";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { texPageType } from "../../design/tokens";
import type { ViewProps } from "./TexPageBody";
import { ListBox, ListRow, SectionHead, SubPage, T, pageStyles, useNow } from "./TexPageParts";
import { TexSelect, type SelectOption } from "./TexSelect";
import { Button, ButtonRow, Chevron, DotLine, Meter, Notice, Pips, RowLink, Stepper } from "./TexMachineParts";
import {
  OTHERS_PER_DAY,
  TOOL_LABEL,
  dotOf,
  detailStatus,
  hm,
  hereOf,
  hoursWord,
  limitChoices,
  runningLine,
  sharedLine,
  slotsLine,
  toolLine,
} from "./texMachineFormat";
import type { MachineValues, ToolName, ToolState } from "./texMachineTypes";
import { useTexMachines } from "./useTexPage";

/** Where each coding tool's sign-in and install instructions are. */
const TOOL_HELP: Record<ToolName, string> = {
  claude: "https://docs.anthropic.com/en/docs/claude-code/quickstart",
  codex: "https://github.com/openai/codex",
};

/** The one value a tool's switch may send: that tool's own key. */
const toolValues = (tool: ToolName, on: boolean): MachineValues => (tool === "claude" ? { claude: on } : { codex: on });

const OTHERS_OPTIONS: readonly SelectOption[] = OTHERS_PER_DAY.map((n) => ({ key: String(n), label: n === 0 ? "None" : String(n) }));

/**
 * Screen 2 "Machine detail" of the Tex machines design (`02-machine-detail`),
 * with screen 9 "Not ready" (no coding tool signed in: the coding tools come
 * first, and there are no limits or sharing yet) and screen 10 "Limit reached"
 * (the day's hours used up, with the one-day raise) as its states. A control
 * is drawn only when it does something.
 */
export function MachinePage(props: ViewProps) {
  const { source, page, chat, go, machine: id } = props;
  const read = useTexMachines(source, chat, page.changes);
  const now = useNow();
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const field = useFieldFont(texPageType.field);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (read === null || read.kind !== "ok") return null;
  const m = read.value.machines.find((x) => x.id === id);
  if (!m) {
    return (
      <SubPage title="Machine not found" lead="It may have been disconnected." testID="tex-machine-missing">
        <ListBox>
          <View style={styles.linkRow}>
            <RowLink label="Your machines" onPress={() => go({ view: "machines" })} testID="tex-machine-back" />
          </View>
        </ListBox>
      </SubPage>
    );
  }

  const set = (values: MachineValues) => void page.act({ type: "machine.set", id: m.id, values });
  const notReady = m.state === "notReady";
  const paused = m.state === "paused";
  const total = m.limitMin + (m.raisedMin ?? 0);
  const fullToday = m.usedMin >= m.limitMin;
  const where = hereOf(m) === "this Mac" ? "the Mac" : "this computer";

  const toolRow = (tool: ToolName) => {
    const state: ToolState = m.tools[tool];
    const title = TOOL_LABEL[tool];
    let right: ReactNode = null;
    if (state === "signedIn" || state === "off") {
      right = (
        <Switch
          value={state === "signedIn"}
          onValueChange={(on) => set(toolValues(tool, on))}
          label={title}
          style={{ alignSelf: "center" }}
          testID={`tex-machine-tool-${tool}-switch`}
        />
      );
    } else {
      const label = state === "installed" ? "How to sign in" : "How to add it";
      right = <RowLink label={label} onPress={() => void Linking.openURL(TOOL_HELP[tool])} testID={`tex-machine-tool-${tool}-link`} />;
    }
    return <ListRow key={tool} title={title} sub={toolLine(state, m)} right={right} testID={`tex-machine-tool-${tool}`} />;
  };

  const codingTools = (
    <Section head="Coding tools">
      <ListBox>{(["claude", "codex"] as const).map(toolRow)}</ListBox>
    </Section>
  );

  const openEditor = () => {
    setDraft(m.folders.join("\n"));
    setEditing((open) => !open);
  };
  const saveFolders = () => {
    set({ folders: draft.split("\n").map((line) => line.trim()).filter((line) => line.length > 0) });
    setEditing(false);
  };

  const canUse = (
    <Section head="Can use">
      <ListBox>
        <View style={styles.row} testID="tex-machine-folders">
          <View style={styles.grow}>
            <T size={14} weight="500">
              Folders
            </T>
            {m.folders.length > 0 ? (
              <T size={12} mono tone="muted" line={1.5}>
                {m.folders.join(" · ")}
              </T>
            ) : (
              <T size={13} tone="muted">
                None yet. Tex asks the first time
              </T>
            )}
          </View>
          <RowLink label={m.folders.length > 0 ? "Change" : "Choose"} onPress={openEditor} testID="tex-machine-folders-edit" />
        </View>
        {editing ? (
          <View style={styles.editor}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              placeholder="One folder per line, like ~/code/context"
              placeholderTextColor={colors.muted}
              accessibilityLabel="Folders Tex may work in"
              style={[pageStyles(colors).input, field, styles.editorInput]}
              testID="tex-machine-folders-input"
            />
            <ButtonRow>
              <Button label="Save" look="outline" onPress={saveFolders} testID="tex-machine-folders-save" />
              <Button label="Cancel" look="outline" onPress={() => setEditing(false)} testID="tex-machine-folders-cancel" />
            </ButtonRow>
          </View>
        ) : null}
        {m.kind === "mac" ? (
          <ListRow
            title="Computer use"
            sub="Tex sees the screen and uses apps, for your own asks only"
            testID="tex-machine-computer-use"
            right={
              <Switch
                value={m.computerUse}
                onValueChange={(on) => set({ computerUse: on })}
                label="Computer use"
                style={{ alignSelf: "center" }}
                testID="tex-machine-computer-use-switch"
              />
            }
          />
        ) : null}
      </ListBox>
    </Section>
  );

  const limits = (
    <Section head="Limits">
      <ListBox>
        <View style={styles.row} testID="tex-machine-used">
          <View style={styles.grow}>
            <View style={styles.usedTop}>
              <T size={14} weight="500">
                Used today
              </T>
              <T size={13} tone={fullToday ? "warn" : "text2"} testID="tex-machine-used-value">
                {`${hm(m.usedMin)} of ${hm(total)}`}
              </T>
            </View>
            <Meter fraction={total > 0 ? m.usedMin / total : 0} full={fullToday} testID="tex-machine-meter" />
            <T size={13} tone="muted" style={{ marginTop: 8 }}>
              Starts again at midnight
            </T>
          </View>
        </View>
        <ListRow
          title="Daily limit"
          sub="Time Claude Code and Codex spend on Tex's jobs"
          testID="tex-machine-limit-row"
          right={
            <TexSelect
              look="sel"
              label="Daily limit"
              options={limitChoices(m.limitMin).map((n) => ({ key: String(n), label: hoursWord(n) }))}
              selected={String(m.limitMin)}
              onPick={(key) => set({ limitMin: Number(key) })}
              testID="tex-machine-limit"
            />
          }
        />
        <ListRow
          title="Jobs others can start a day"
          sub="Across every chat it is in"
          testID="tex-machine-others-row"
          right={
            <TexSelect
              look="sel"
              label="Jobs others can start a day"
              options={OTHERS_OPTIONS}
              selected={String(m.othersPerDay)}
              onPick={(key) => set({ othersPerDay: Number(key) })}
              testID="tex-machine-others"
            />
          }
        />
        <ListRow
          title="Pause near my plan's limit"
          sub="When Claude Code says you are close, new jobs wait or go to the cloud"
          testID="tex-machine-pause-row"
          right={
            <Switch
              value={m.pauseNearPlan}
              onValueChange={(on) => set({ pauseNearPlan: on })}
              label="Pause near my plan's limit"
              style={{ alignSelf: "center" }}
              testID="tex-machine-pause"
            />
          }
        />
      </ListBox>
    </Section>
  );

  const shared = (
    <Section head="Shared with">
      <ListBox>
        {m.chats.map((c) => {
          // Each row opens that chat's settings, where its machine settings live (screen 4).
          return (
            <ListRow
              key={c.key}
              title={c.key === "me" ? "Just you" : c.name}
              sub={sharedLine(c, m)}
              onPress={() => go({ chat: c.key, view: "settings" })}
              testID={`tex-machine-chat-${c.key}`}
              right={<Chevron />}
            />
          );
        })}
      </ListBox>
    </Section>
  );

  return (
    <SubPage title={m.name} testID="tex-machine">
      <View style={styles.status}>
        <DotLine tone={dotOf(m.state)} size={14} testID="tex-machine-status">
          {detailStatus(m, now)}
        </DotLine>
      </View>
      {notReady ? (
        <Notice testID="tex-machine-not-ready">
          {`Sign in to Claude Code or Codex on ${hereOf(m)} and Tex can start running jobs here. This page updates on its own.`}
        </Notice>
      ) : null}
      {paused && m.paused === "limit" ? (
        <Notice
          testID="tex-machine-limit-notice"
          action={
            <Button label="Allow 2 more hours today" look="outline" onPress={() => void page.act({ type: "machine.raise", id: m.id, minutes: 120 })} testID="tex-machine-raise" />
          }
        >
          {`Today's ${hoursWord(m.limitMin)} are used up. New jobs go to Tex's cloud until midnight.`}
        </Notice>
      ) : null}
      {paused && m.paused === "plan" ? (
        <Notice testID="tex-machine-plan-notice">Claude Code says your plan is close to its limit. New jobs go to Tex's cloud until it resets.</Notice>
      ) : null}
      {notReady ? codingTools : null}
      <Section head="Slots">
        <ListBox>
          <ListRow
            title="Jobs at once"
            sub={slotsLine(m)}
            testID="tex-machine-slots-row"
            right={<Stepper value={m.slots} min={1} max={Math.max(1, m.most)} onChange={(next) => set({ slots: next })} label="jobs at once" testID="tex-machine-slots" />}
          />
          {notReady ? null : (
            <ListRow
              title="Running now"
              sub={runningLine(m, now)}
              testID="tex-machine-running-row"
              right={<Pips slots={m.slots} busy={m.running.length} off={paused || m.state === "offline"} testID="tex-machine-pips" />}
            />
          )}
        </ListBox>
      </Section>
      {notReady ? null : codingTools}
      {canUse}
      {notReady ? null : limits}
      {notReady ? null : shared}
      {confirming ? (
        <View style={styles.confirm}>
          <T size={14} testID="tex-machine-disconnect-confirm">
            {`Disconnect ${m.name}? Tex stops using it at once.`}
          </T>
          <ButtonRow>
            <Button
              label="Disconnect"
              look="danger"
              onPress={() => {
                void page.act({ type: "machine.disconnect", id: m.id });
                go({ view: "machines" });
              }}
              testID="tex-machine-disconnect-yes"
            />
            <Button label="Keep it" look="quiet" onPress={() => setConfirming(false)} testID="tex-machine-disconnect-no" />
          </ButtonRow>
        </View>
      ) : (
        <ButtonRow aside={`Tex stops using it at once. Nothing on ${where} is touched.`}>
          <Button label="Disconnect this machine" look="danger" onPress={() => setConfirming(true)} testID="tex-machine-disconnect" />
        </ButtonRow>
      )}
    </SubPage>
  );
}

/** A section: its small capital head, then its rows. */
function Section({ head, children }: { head: string; children: ReactNode }) {
  return (
    <View>
      <SectionHead>{head}</SectionHead>
      {children}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    status: { marginTop: -10 },
    row: { flexDirection: "row", gap: 12, alignItems: "center", paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: colors.line },
    grow: { flex: 1, minWidth: 0, gap: 2 },
    usedTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 10 },
    editor: { gap: 10, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: colors.line },
    editorInput: { minHeight: 88, paddingVertical: 10, textAlignVertical: "top" },
    linkRow: { paddingVertical: 11 },
    confirm: { gap: 10, paddingTop: 4 },
  });
