import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useConvex } from "convex/react";
import type { Id } from "@context/convex/_generated/dataModel";

import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { ChoiceGroup, TextField } from "../../../design/components/Input";
import { Switch } from "../../../design/components/Switch";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { useConsoleGrant } from "../../../agent/useConsoleGrant";
import { MCP_ENDPOINT } from "../../placeholderData";
import { gatewaySource, type TexPageSource } from "../../../tex/page/texPageSource";
import type { HabitKey, PingLevel, TexHabits as Habits } from "../../../tex/page/texPageTypes";
import { settingsSectionLabel } from "../sections";

/**
 * Settings › Check-ins, quiet hours and more (Dev2, 2026-11-13: the settings
 * Tex changes by text get switches in the app too). Each row writes the same
 * note a text does, through the Tex page's `setting.set`
 * (`apps/mcp/src/agent/settingsTools.js` `settingSet`), so the app and the
 * chat can't disagree. Personal only: these are the person's own Tex.
 */

export const PING_OPTIONS: ReadonlyArray<{ value: PingLevel; label: string; detail: string }> = [
  { value: "emergencies", label: "Emergencies only", detail: "Only what can't wait" },
  { value: "strict", label: "Important", detail: "Emergencies and what you asked to hear" },
  { value: "relaxed", label: "Anything useful", detail: "Whatever they think you'd want" },
  { value: "off", label: "Off", detail: "None" },
];

const pingLabel = (level: PingLevel | null) => PING_OPTIONS.find((option) => option.value === level)?.label ?? "Unknown";

type Field = keyof Habits;
/** Every `setting` switch the gateway has, and the field it reads back as; a test holds the keys to `TEX_SETTINGS`. */
export const FIELD_OF: Record<HabitKey, Field> = { checkins: "checkins", quiet_hours: "quietHours", pings: "pings", overnight: "overnight", tidy: "tidy" };

/** Reads and writes through the gateway for the signed-in person's own Tex. */
export function TexHabits({ workspaceId, handle }: { workspaceId: string | null; handle: string | null }) {
  const styles = useThemedStyles(makeStyles);
  const live = useConvex() !== undefined;
  return (
    <View>
      <Text variant="paneTitle" role="heading" aria-level={2} style={styles.head}>
        {settingsSectionLabel("texHabits")}
      </Text>
      {workspaceId === null || handle === null ? (
        <Text variant="paneSub">These are your own Tex's, set from a workspace of your own, which this account does not have.</Text>
      ) : live ? (
        <TexHabitsLive workspaceId={workspaceId} handle={handle} />
      ) : null}
    </View>
  );
}

function TexHabitsLive({ workspaceId, handle }: { workspaceId: string; handle: string }) {
  const mint = useConsoleGrant();
  const minting = useRef(mint);
  minting.current = mint;
  const source = useMemo(() => {
    const token = async (refresh: boolean | { rejected: string }) => (await minting.current({ workspaceId: workspaceId as Id<"workspaces"> }, refresh)).accessToken;
    return gatewaySource({ endpoint: MCP_ENDPOINT, handle, token });
  }, [handle, workspaceId]);
  return <TexHabitsFrom source={source} />;
}

/** Reads the person's own chat's settings from `source` and sends each change back; a refused change is put back. */
export function TexHabitsFrom({ source }: { source: TexPageSource }) {
  const [habits, setHabits] = useState<Habits | null | "failed">(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    void source.list("me", "settings").then((read) => {
      if (gone) return;
      setHabits(read.kind === "ok" && read.value.habits ? read.value.habits : "failed");
    });
    return () => {
      gone = true;
    };
  }, [source]);

  if (habits === null) return null;
  if (habits === "failed") return <Text variant="paneSub" testID="tex-habits-failed">Couldn't read these right now. Try again in a minute, or text Tex.</Text>;

  const set = async (key: HabitKey, value: boolean | string) => {
    const field = FIELD_OF[key];
    const before = habits[field];
    setProblem(null);
    setHabits({ ...habits, [field]: key === "quiet_hours" && value === "off" ? "" : value } as Habits);
    const answer = await source.act("me", { type: "setting.set", key, value });
    if (answer.ok) return;
    setHabits((now) => (now && now !== "failed" ? ({ ...now, [field]: before } as Habits) : now));
    setProblem(key === "quiet_hours" && answer.error === "invalid" ? 'Tex couldn\'t read that time. Try "11 pm to 7 am".' : "Not saved. Try again.");
  };
  return <TexHabitsView habits={habits} problem={problem} onSet={(key, value) => void set(key, value)} />;
}

/** What the page draws, with no client behind it. */
export function TexHabitsView({
  habits,
  problem,
  onSet,
}: {
  habits: Habits;
  problem: string | null;
  onSet: (key: HabitKey, value: boolean | string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState<"quiet" | "pings" | null>(null);
  const [quiet, setQuiet] = useState(habits.quietHours ?? "");
  const toggle = (which: "quiet" | "pings") => setOpen((now) => (now === which ? null : which));

  return (
    <Card testID="tex-habits">
      <SwitchRow title="Check-ins" line="Tex texts you at 10, 2 and 6 if something needs you" value={habits.checkins} onChange={(on) => onSet("checkins", on)} id="checkins" />
      <Divider />
      <Row>
        <Grow>
          <Text variant="rowTitle">Quiet hours</Text>
          <Text variant="rowSub" testID="tex-habit-quiet-value">{habits.quietHours ? habits.quietHours : habits.quietHours === null ? "Unknown" : "None"}</Text>
        </Grow>
        <Button label="Change" variant="dialog" onPress={() => toggle("quiet")} testID="tex-habit-quiet-change" />
      </Row>
      {open === "quiet" ? (
        <View style={styles.open}>
          <TextField label="Quiet from" value={quiet} onChangeText={setQuiet} placeholder="11 pm to 7 am" testID="tex-habit-quiet-field" />
          <View style={styles.actions}>
            <Button
              label="Save"
              disabled={quiet.trim() === ""}
              onPress={() => {
                onSet("quiet_hours", quiet.trim());
                setOpen(null);
              }}
              testID="tex-habit-quiet-save"
            />
            {habits.quietHours ? (
              <Button
                label="Turn off"
                variant="dialog"
                onPress={() => {
                  onSet("quiet_hours", "off");
                  setQuiet("");
                  setOpen(null);
                }}
                testID="tex-habit-quiet-off"
              />
            ) : null}
          </View>
        </View>
      ) : null}
      <Divider />
      <Row>
        <Grow>
          <Text variant="rowTitle">Texts from your other AIs</Text>
          <Text variant="rowSub" testID="tex-habit-pings-value">{pingLabel(habits.pings)}</Text>
        </Grow>
        <Button label="Change" variant="dialog" onPress={() => toggle("pings")} testID="tex-habit-pings-change" />
      </Row>
      {open === "pings" ? (
        <ChoiceGroup
          label="Let them text you"
          options={PING_OPTIONS}
          value={habits.pings}
          onChange={(level) => {
            onSet("pings", level);
            setOpen(null);
          }}
          style={styles.open}
          testID="tex-habit-pings"
        />
      ) : null}
      <Divider />
      <SwitchRow title="Update About me overnight" line="From what you texted that day" value={habits.overnight} onChange={(on) => onSet("overnight", on)} id="overnight" />
      <Divider />
      <SwitchRow title="Tidy my notes" line="Once a day, each change undoable" value={habits.tidy} onChange={(on) => onSet("tidy", on)} id="tidy" />
      {problem ? (
        <Text variant="hint" style={styles.problem} testID="tex-habits-unsaved">
          {problem}
        </Text>
      ) : null}
    </Card>
  );
}

function SwitchRow({ title, line, value, onChange, id }: { title: string; line: string; value: boolean | null; onChange: (on: boolean) => void; id: string }) {
  return (
    <Row>
      <Grow>
        <Text variant="rowTitle">{title}</Text>
        <Text variant="rowSub">{value === null ? "Couldn't read this one" : line}</Text>
      </Grow>
      {value === null ? null : <Switch value={value} label={title} onValueChange={onChange} testID={`tex-habit-${id}`} />}
    </Row>
  );
}

function Divider() {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.divider} />;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { marginBottom: space.x3 },
    open: { marginTop: space.x3 },
    actions: { flexDirection: "row", gap: space.x2, marginTop: space.x3, alignItems: "center" },
    problem: { marginTop: space.x3 },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: space.x3 },
  });
