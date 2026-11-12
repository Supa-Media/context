import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Text } from "../design/components/Text";
import { radii } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { shareChoices, type ChatPerson, type ShareChoice, type VaultChat, type VaultWorkspace } from "./vaultLink";

/**
 * "Who can use it" on an add link (Dev2, 2026-11-12): the people in the chat
 * the link was texted in, picked already when there is one; everyone in a
 * shared workspace, with who in the chat is a member and "Add" beside who
 * isn't; or only the person saving it. Nothing is sent by picking: "Add"
 * invites one person, on its own tap.
 */
export function VaultWhoCanUse({
  chat,
  workspace,
  value,
  onChange,
  onInvite,
  busy,
}: {
  chat: VaultChat | null;
  workspace: VaultWorkspace;
  value: ShareChoice;
  onChange: (next: ShareChoice) => void;
  /** Invites one person in the chat to the workspace, by handle; absent where the page can't. */
  onInvite?: (handle: string) => Promise<"invited" | "already">;
  busy: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const choices = shareChoices(chat, workspace);
  if (choices.length < 2) return null;
  const others = chat?.people.filter((person) => person.status !== "you") ?? [];
  return (
    <View style={styles.box} accessibilityRole="radiogroup" testID="vault-who">
      <Text variant="listGroup">Who can use it</Text>
      {choices.map((choice) => (
        <Option
          key={choice}
          choice={choice}
          on={value === choice}
          disabled={busy}
          onPress={() => onChange(choice)}
          title={
            choice === "chat"
              ? `People in ${chat?.label ?? "this chat"}`
              : choice === "workspace"
                ? `Everyone in @${workspace.handle}`
                : "Only me"
          }
          detail={
            choice === "chat"
              ? "Tex can sign in for anyone in this chat. Nobody sees the password."
              : choice === "workspace"
                ? "Every member's Tex and every chat on this workspace, including people who join later."
                : chat === null
                  ? "Tex uses it only when you ask."
                  : "Tex uses it only when you ask, in any chat, this one included."
          }
        >
          {choice === "chat" && others.length > 0 ? (
            <View style={styles.faces}>
              {chat?.people.map((person, index) => (
                <Text key={`${person.name}-${index}`} variant="rowSub" style={styles.face}>
                  {person.name}
                </Text>
              ))}
            </View>
          ) : null}
          {choice === "workspace" && value === "workspace" && chat !== null ? (
            <Members chat={chat} onInvite={chat.canInvite ? onInvite : undefined} busy={busy} />
          ) : null}
        </Option>
      ))}
    </View>
  );
}

function Option({
  choice,
  on,
  disabled,
  onPress,
  title,
  detail,
  children,
}: {
  choice: ShareChoice;
  on: boolean;
  disabled: boolean;
  onPress: () => void;
  title: string;
  detail: string;
  children?: React.ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: on, disabled }}
      aria-checked={on}
      accessibilityLabel={title}
      disabled={disabled}
      onPress={onPress}
      style={[styles.option, on && styles.optionOn]}
      testID={`vault-who-${choice}`}
    >
      <View style={[styles.dot, on && styles.dotOn]}>{on ? <View style={styles.dotInner} /> : null}</View>
      <View style={styles.grow}>
        <Text variant="rowTitle">{title}</Text>
        <Text variant="rowSub">{detail}</Text>
        {children}
      </View>
    </Pressable>
  );
}

/** Each person in the chat, whether they are in the workspace, and "Add" beside who isn't. */
function Members({ chat, onInvite, busy }: { chat: VaultChat; onInvite?: (handle: string) => Promise<"invited" | "already">; busy: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const [sent, setSent] = useState<Record<string, "sending" | "invited" | "failed">>({});
  const missing = chat.people.filter((person) => person.status === "not_member" || person.status === "invited");
  const invite = (handle: string) => {
    if (onInvite === undefined) return;
    setSent((now) => ({ ...now, [handle]: "sending" }));
    onInvite(handle).then(
      () => setSent((now) => ({ ...now, [handle]: "invited" })),
      () => setSent((now) => ({ ...now, [handle]: "failed" })),
    );
  };
  return (
    <View style={styles.members} testID="vault-who-members">
      {chat.people.map((person, index) => {
        const state = person.handle === null ? undefined : sent[person.handle];
        return (
          <View key={`${person.name}-${index}`} style={styles.member}>
            <Text variant="rowSub" style={styles.grow}>
              {person.name}
            </Text>
            <Text variant="rowSub" style={inWorkspace(person) ? styles.in : undefined}>
              {statusWords(person, state)}
            </Text>
            {person.status === "not_member" && person.handle !== null && onInvite !== undefined && state !== "invited" ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Add ${person.name} to the workspace`}
                disabled={busy || state === "sending"}
                onPress={() => invite(person.handle as string)}
                style={styles.add}
                testID={`vault-who-add-${person.handle}`}
              >
                {state === "sending" ? <ActivityIndicator size="small" color={colors.accent} /> : <Text variant="rowSub" style={styles.addText}>Add</Text>}
              </Pressable>
            ) : null}
          </View>
        );
      })}
      {missing.length > 0 ? (
        <Text variant="rowSub" testID="vault-who-missing">
          {missingLine(missing, onInvite !== undefined)}
        </Text>
      ) : null}
    </View>
  );
}

function inWorkspace(person: ChatPerson): boolean {
  return person.status === "you" || person.status === "member";
}

function statusWords(person: ChatPerson, sent: "sending" | "invited" | "failed" | undefined): string {
  if (sent === "invited") return "Invite sent";
  if (sent === "failed") return "Didn't send";
  if (inWorkspace(person)) return "✓ In workspace";
  return person.status === "invited" ? "Invited to the chat" : "Not in workspace";
}

/** The line under the list: who can't be covered yet, and what Add does. */
export function missingLine(missing: ChatPerson[], canInvite: boolean): string {
  const names = missing.map((person) => person.name);
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const verb = names.length === 1 ? "is" : "are";
  const tail = canInvite ? " Add invites them to join." : " An owner of the workspace can add them.";
  return `${who} ${verb} in this chat but not the workspace, so Tex can't use it for them yet.${tail}`;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    box: { gap: 10, paddingTop: 4 },
    option: {
      flexDirection: "row",
      gap: 12,
      alignItems: "flex-start",
      padding: 12,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
    },
    optionOn: { borderColor: colors.accent, backgroundColor: colors.rowSelected },
    grow: { flex: 1, gap: 2 },
    dot: {
      width: 18,
      height: 18,
      marginTop: 2,
      borderRadius: 9,
      borderWidth: 1.5,
      borderColor: colors.lineStrong,
      alignItems: "center",
      justifyContent: "center",
    },
    dotOn: { borderColor: colors.accent },
    dotInner: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.accent },
    faces: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6 },
    face: { paddingHorizontal: 8, paddingVertical: 1, borderRadius: radii.pill, backgroundColor: colors.chipFill },
    members: { gap: 6, marginTop: 8 },
    member: { flexDirection: "row", alignItems: "center", gap: 8 },
    in: { color: colors.okText },
    add: { paddingHorizontal: 10, paddingVertical: 2, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.accent },
    addText: { color: colors.accentText, fontWeight: "600" },
  });
