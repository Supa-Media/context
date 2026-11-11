import { useEffect, useState } from "react";
import { Image, Pressable, TextInput, View } from "react-native";
import { writeClipboard } from "../../design/clipboard";
import { useColors } from "../../design/theme";
import { texPageType } from "../../design/tokens";
import { useFieldFont } from "../../design/fieldFont";
import type { TexComputerState } from "../useTexComputer";
import type { ViewProps } from "./TexPageBody";
import { ListBox, ListRow, SubPage, T, pageStyles } from "./TexPageParts";
import { useTexList, useTexMachines } from "./useTexPage";
import { GroupMachines } from "./TexGroupMachines";
import { Switch } from "../../design/components/Switch";
import { thisMacLine, useThisMac } from "./useThisMac";
import { Chevron } from "./TexMachineParts";
import type { MachinesPage } from "./texMachineTypes";

/** The control plane's limit on the text (`apps/convex/functions/lib/texInstructions.ts` `MAX_INSTRUCTIONS`). */
const MAX_INSTRUCTIONS = 1_500;

/**
 * How Tex talks, in their own words (Dev2, 2026-11-01; custom-instructions.md): the text as the list read gave it,
 * saved when the box loses focus and only when it changed. It is the same text Tex changes when asked in a text;
 * the quick picks that added lines to it are retired (Dev2, 2026-11-11; retire-settings.md).
 */
function Instructions({ text, save, testID }: { text: string; save: (values: Record<string, string>) => void; testID: string }) {
  const colors = useColors();
  const field = useFieldFont(texPageType.field);
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  return (
    <ListBox>
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onBlur={() => (draft.trim() !== text.trim() ? save({ instructions: draft }) : undefined)}
        multiline
        maxLength={MAX_INSTRUCTIONS}
        placeholder="How should Tex talk?"
        placeholderTextColor={colors.muted}
        accessibilityLabel="How Tex talks"
        style={[pageStyles(colors).input, field, { minHeight: 88, paddingVertical: 10 }]}
        testID={`${testID}-instructions`}
      />
    </ListBox>
  );
}

/** Settings › Tex: how Tex talks to this person, its number, and the websites it is signed in to. */
export function SettingsPage({ source, page, chat, go }: ViewProps) {
  const colors = useColors();
  const { read } = useTexList(source, chat, "settings", page.changes);
  // Only a gateway that knows machines answers; any other draws no row.
  const machines = useTexMachines(source, chat, page.changes);
  // Only inside the Mac app; and only the person's own Tex settings, never a group's.
  const thisMac = useThisMac();
  const value = read?.kind === "ok" ? read.value : undefined;
  const number = value?.number;
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  return (
    <SubPage title="Tex settings" lead="How Tex talks to you, or just tell Tex in a text. Changes apply to the next text." testID="tex-settings">
      <Instructions text={value?.instructions ?? ""} save={(values) => void page.act({ type: "settings", values })} testID="tex-settings" />
      <ListBox>
        {number ? (
          <ListRow
            title="Tex's number"
            sub={`${number} · text or iMessage`}
            testID="tex-settings-number"
            right={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Copy Tex's number"
                onPress={() => {
                  void writeClipboard(number).then((ok) => {
                    if (ok) setCopied(true);
                  });
                }}
                testID="tex-settings-copy"
              >
                <T size={13} tone="text2" numberOfLines={1}>
                  {copied ? "Copied" : "Copy"}
                </T>
              </Pressable>
            }
          />
        ) : null}
        {thisMac ? (
          <ListRow
            title="Let Tex use this Mac"
            sub={thisMacLine(thisMac.status)}
            testID="tex-settings-this-mac"
            right={
              thisMac.status.available ? (
                <Switch
                  value={thisMac.status.enabled}
                  onValueChange={thisMac.setEnabled}
                  label="Let Tex use this Mac"
                  style={{ alignSelf: "center" }}
                  testID="tex-settings-this-mac-switch"
                />
              ) : null
            }
          />
        ) : null}
        {machines?.kind === "ok" ? (
          <ListRow
            title="Your machines"
            sub={machinesSub(machines.value)}
            onPress={() => go({ view: "machines" })}
            testID="tex-settings-machines"
            right={<Chevron />}
          />
        ) : null}
        <ListRow
          title="Sign Tex out of websites"
          sub="Clears the sign-ins Tex keeps"
          testID="tex-settings-signout-row"
          right={
            <Pressable accessibilityRole="button" accessibilityLabel="Sign Tex out of websites" onPress={() => setConfirming(true)} testID="tex-settings-signout">
              <T size={13} tone="crit" numberOfLines={1}>
                Sign out
              </T>
            </Pressable>
          }
        />
        {confirming ? (
          <View style={{ paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: colors.line }}>
            <T size={13} tone="text2" testID="tex-settings-signout-confirm">
              {"Text Tex “sign out of websites” and it clears them."}
            </T>
          </View>
        ) : null}
      </ListBox>
    </SubPage>
  );
}

/** Group settings: how Tex behaves in one group chat. Changed here, not in the person's own chat. */
export function GroupSettingsPage({ source, page, chat, group, go }: ViewProps) {
  const { read } = useTexList(source, chat, "settings", page.changes);
  const value = read?.kind === "ok" ? read.value : undefined;
  const approver = value?.approver;
  const people = value?.people ?? [];
  const save = (values: Record<string, string>) => void page.act({ type: "group.settings", values });

  return (
    <SubPage title="Group settings" lead={`How Tex behaves in ${group ?? "this chat"}.`} testID="tex-group-settings">
      <ListBox>
        <ListRow
          title="Who approves sends"
          sub="Emails and invites wait for their yes"
          testID="tex-group-row-approver"
          right={
            approver ? (
              <T size={13} tone="text2" numberOfLines={1}>
                {approver}
              </T>
            ) : null
          }
        />
      </ListBox>
      <Instructions text={value?.instructions ?? ""} save={save} testID="tex-group" />
      <GroupMachines source={source} page={page} chat={chat} group={group} go={go} />
      <ListBox>
        <ListRow
          title="People here"
          sub={people.length > 0 ? people.join(", ") : undefined}
          testID="tex-group-people"
          right={
            <T size={13} tone="text2" numberOfLines={1}>
              {String(people.length)}
            </T>
          }
        />
      </ListBox>
    </SubPage>
  );
}

/** Tex's computer: the browser Tex drives, watched live, and taken over from here. */
export function ComputerPage({
  computer,
  openComputer,
  go,
}: ViewProps & { computer: TexComputerState | null; openComputer: () => void }) {
  const colors = useColors();
  const frame = computer?.frame ?? null;
  const live = frame !== null && frame.running && computer?.phase === "live" ? frame : null;

  let lead: string;
  if (computer === null || computer.phase === "loading") {
    lead = "Looking for Tex's browser…";
  } else if (live !== null) {
    lead = "Live. Watching doesn't interrupt Tex.";
  } else if (computer.phase === "failed" || computer.phase === "notYours") {
    lead = "Tex's browser can't be reached right now.";
  } else {
    lead = "Nothing running right now. When Tex needs you to sign in somewhere, it texts you this page.";
  }

  return (
    <SubPage title="Tex's computer" lead={lead} testID="tex-computer">
      {live !== null ? (
        <>
          <View style={{ borderRadius: 10, overflow: "hidden", backgroundColor: colors.appSurface }}>
            <T size={11} mono numberOfLines={1} style={{ color: colors.appMuted, paddingVertical: 6, paddingHorizontal: 10 }}>
              {addressOf(live.url, live.title)}
            </T>
            <Pressable accessibilityRole="button" accessibilityLabel="Open Tex's browser" onPress={openComputer} testID="tex-computer-frame">
              <Image
                source={{ uri: `data:image/jpeg;base64,${live.frame}` }}
                resizeMode="contain"
                style={{ width: "100%", aspectRatio: live.width / live.height }}
              />
            </Pressable>
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <SteerButton label="Take over" onPress={openComputer} testID="tex-take-over" />
            <SteerButton label="Sign-ins Tex keeps" onPress={() => go({ view: "settings" })} testID="tex-computer-signins" />
          </View>
        </>
      ) : null}
    </SubPage>
  );
}

/** `.steer button`: a 36-high outlined button beside its sibling. */
function SteerButton({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      testID={testID}
      style={{
        height: 36,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.lineStrong,
        backgroundColor: colors.surface,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <T size={13} weight="500" line={1}>
        {label}
      </T>
    </Pressable>
  );
}

/** The address bar's text: the host and path of the page, or its title when it has no address yet. */
function addressOf(url: string, title: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url.length > 0 ? url : title;
  }
}

/** "2 machines · 6 slots", or how to start when there are none. */
function machinesSub(page: MachinesPage): string {
  const mine = page.machines.filter((m) => m.state !== "pending");
  if (mine.length === 0) return "Run coding jobs on your own computer";
  const slots = mine.reduce((n, m) => n + m.slots, 0);
  return `${mine.length} machine${mine.length === 1 ? "" : "s"} · ${slots} slot${slots === 1 ? "" : "s"}`;
}
