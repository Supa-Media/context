/**
 * A key's People section on Settings › Vault (vault sharing boards 1 and 2):
 * whoever has it, each with their own AIs nested under them, how much they
 * get ("Their AIs use it" or "They can see it too"), and Take back, which
 * says once in bold red what it does. Under them, the Give field: type a
 * name, pick a person, a group or everyone in the workspace, and Give.
 *
 * Drawn for somebody who may manage the key only; everyone else sees their
 * own AIs in the panel's "AIs that can use it" list.
 */

import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Button } from "../../../design/components/Button";
import { TextField } from "../../../design/components/Input";
import { Text } from "../../../design/components/Text";
import { radii } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { AgentFace } from "../../map/live/ui/ActorFace";
import { Segmented } from "../../../vault/Segmented";
import {
  LEVEL_OPTIONS,
  aisByPerson,
  giveSuggestions,
  initialsOf,
  levelLabel,
  shareRowLine,
  takeBackLine,
  type VaultShareChoices,
} from "../../../vault/vaultPeople";
import { vaultClientLine, type VaultClient, type VaultEntry, type VaultLevel, type VaultShareRow } from "../../../vault/vaultSettings";

export function VaultPeople({
  entry,
  choices,
  busy,
  now,
  onGive,
  onTakeBack,
  onCutOff,
}: {
  entry: VaultEntry;
  /** Who the key can be given to; null while it is read. */
  choices: VaultShareChoices | null;
  busy: boolean;
  now?: Date;
  onGive: (to: string, level: VaultLevel) => Promise<boolean>;
  onTakeBack: (to: string) => void;
  onCutOff: (clientId: string, by?: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const rows = entry.people ?? [];
  const { rows: ais, others } = aisByPerson(entry);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [picked, setPicked] = useState<{ to: string; title: string } | null>(null);
  const [level, setLevel] = useState<VaultLevel>("use");
  const shared = choices?.workspace.kind === "shared";
  const suggestions = choices !== null && picked === null && typed.trim() !== "" ? giveSuggestions(choices, typed, entry) : [];

  const give = async () => {
    if (picked === null) return;
    if (await onGive(picked.to, level)) {
      setPicked(null);
      setTyped("");
    }
  };
  const aiRows = (clients: VaultClient[]) =>
    clients.map((client) => (
      <View key={`${client.by ?? ""}-${client.id}`} style={styles.ai}>
        <AgentFace name={client.name ?? "AI"} size={20} />
        <Text variant="rowSub" style={styles.flex} numberOfLines={2}>
          <Text variant="rowTitle">{client.name ?? "An AI"}</Text>
          {` · ${vaultClientLine(client, entry.proxy?.uses, now)}`}
        </Text>
        <CutButton label="Cut off" disabled={busy} testID={`vault-cut-${client.by ?? "you"}-${client.id}`} onPress={() => onCutOff(client.id, client.by)} />
      </View>
    ));

  return (
    <View style={styles.section} testID="vault-people">
      <Text variant="eyebrow">{entry.proxy !== null ? "People and their AIs" : "People"}</Text>
      {rows.map((row, index) => (
        <View key={row.to} style={styles.person} testID={`vault-person-${row.to}`}>
          <View style={styles.personRow}>
            <Face name={row.kind === "everyone" ? choices?.workspace.handle ?? "*" : row.isYou ? row.handle ?? row.name : row.name} square={row.kind !== "person"} />
            <View style={styles.who}>
              <Text variant="rowTitle" numberOfLines={1}>
                {row.isYou ? "You" : row.name}
              </Text>
              <Text variant="rowSub" numberOfLines={2}>
                {shareRowLine(row, index === 0, now)}
              </Text>
            </View>
            {index === 0 || confirming === row.to ? null : (
              <View style={styles.controls}>
                <LevelMenu row={row} busy={busy} onChange={(next) => void onGive(row.to, next)} />
                <CutButton label="Take back" disabled={busy} testID={`vault-take-${row.to}`} onPress={() => setConfirming(row.to)} />
              </View>
            )}
          </View>
          {confirming === row.to ? (
            <View style={styles.confirm}>
              <Text variant="rowTitle" style={styles.oneWay}>
                {takeBackLine(row)}
              </Text>
              <View style={styles.confirmButtons}>
                <Button
                  label="Take back"
                  variant="dialogDanger"
                  disabled={busy}
                  testID={`vault-take-yes-${row.to}`}
                  onPress={() => {
                    setConfirming(null);
                    onTakeBack(row.to);
                  }}
                />
                <Button label="Keep" variant="dialog" disabled={busy} onPress={() => setConfirming(null)} testID={`vault-take-keep-${row.to}`} />
              </View>
            </View>
          ) : null}
          {entry.proxy !== null ? <View style={styles.nested}>{aiRows(ais.get(row.to) ?? [])}</View> : null}
        </View>
      ))}
      {others.map((other) => (
        <View key={other.by} style={styles.person}>
          <View style={styles.personRow}>
            <Face name={other.name} />
            <View style={styles.flex}>
              <Text variant="rowTitle" numberOfLines={1}>
                {other.name}
              </Text>
              <Text variant="rowSub">Has it through a group or everyone</Text>
            </View>
          </View>
          <View style={styles.nested}>{aiRows(other.clients)}</View>
        </View>
      ))}
      {choices === null ? null : !shared ? (
        <Text variant="hint" testID="vault-give-personal">
          Keys in your personal workspace stay yours. To give this one to people, save it in a shared workspace.
        </Text>
      ) : (
        <View style={styles.give}>
          <Segmented label="How much they get" options={LEVEL_OPTIONS} value={level} onChange={setLevel} disabled={busy} testID="vault-give-level" />
          <View style={styles.giveRow}>
            <TextField
              label="Give to a teammate or a group"
              labelHidden
              placeholder="Give to a teammate or a group"
              value={picked?.title ?? typed}
              onChangeText={(text) => {
                setPicked(null);
                setTyped(text);
              }}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
              containerStyle={styles.flex}
              testID="vault-give-input"
            />
            <Button label="Give" variant={picked ? "dialogPrimary" : "dialog"} disabled={busy || picked === null} onPress={() => void give()} testID="vault-give" />
          </View>
          {suggestions.length > 0 ? (
            <View style={styles.list} testID="vault-give-suggestions">
              {suggestions.map((one, index) => (
                <Pressable
                  key={one.to}
                  accessibilityRole="button"
                  onPress={() => setPicked({ to: one.to, title: one.title })}
                  style={({ pressed }) => [styles.option, index > 0 && styles.divided, pressed && styles.pressed]}
                  testID={`vault-give-to-${one.to}`}
                >
                  <Face name={one.kind === "everyone" ? choices.workspace.handle : one.title} square={one.kind !== "person"} />
                  <View style={styles.flex}>
                    <Text variant="rowTitle" numberOfLines={1}>
                      {one.title}
                    </Text>
                    <Text variant="rowSub" numberOfLines={1}>
                      {one.sub}
                    </Text>
                  </View>
                </Pressable>
              ))}
              <Text variant="rowSub" style={styles.foot}>
                Only people in @{choices.workspace.handle}. Their AIs never see the value either way.
              </Text>
            </View>
          ) : typed.trim() !== "" && picked === null ? (
            <Text variant="hint">Nobody in @{choices.workspace.handle} by that name.</Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

/** "Their AIs use it ▾": opens the two choices in place. */
function LevelMenu({ row, busy, onChange }: { row: VaultShareRow; busy: boolean; onChange: (level: VaultLevel) => void }) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <View style={styles.levels}>
        {LEVEL_OPTIONS.map((option) => (
          <Pressable
            key={option.value}
            accessibilityRole="button"
            accessibilityState={{ selected: option.value === row.level }}
            disabled={busy}
            onPress={() => {
              setOpen(false);
              if (option.value !== row.level) onChange(option.value);
            }}
            style={[styles.level, option.value === row.level && styles.levelOn]}
            testID={`vault-level-${row.to}-${option.value}`}
          >
            <Text variant="mini">{option.label}</Text>
          </Pressable>
        ))}
      </View>
    );
  }
  return (
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => setOpen(true)} style={styles.level} testID={`vault-level-${row.to}`}>
      <Text variant="mini">{levelLabel(row.level)} ▾</Text>
    </Pressable>
  );
}

function Face({ name, square = false }: { name: string; square?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.face, square && styles.faceSquare]}>
      <Text variant="mini" style={[styles.faceText, square && styles.faceSquareText]}>
        {initialsOf(name)}
      </Text>
    </View>
  );
}

/** The board's Cut off and Take back: red words in a red outline, quieter than a filled button. */
export function CutButton({ label, disabled, testID, onPress }: { label: string; disabled: boolean; testID: string; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.cut, pressed && styles.cutPressed, disabled && styles.cutDisabled]}
      testID={testID}
    >
      <Text variant="mini" style={styles.cutText}>
        {label}
      </Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    section: { gap: 8 },
    person: { gap: 6, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
    personRow: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" },
    // The name keeps a readable width; on a phone the controls wrap under it.
    who: { flexGrow: 1, flexShrink: 1, flexBasis: 150, minWidth: 0 },
    controls: { flexDirection: "row", alignItems: "center", gap: 8, marginLeft: "auto" },
    nested: { paddingLeft: 46, gap: 2 },
    ai: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
    confirm: { gap: 8, paddingLeft: 46 },
    confirmButtons: { flexDirection: "row", gap: 8 },
    oneWay: { color: colors.critText, fontWeight: "700" },
    levels: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
    level: {
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
    },
    levelOn: { borderColor: colors.text, borderWidth: 1 },
    face: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.chipFill, alignItems: "center", justifyContent: "center" },
    faceSquare: { borderRadius: radii.md, backgroundColor: colors.text },
    faceText: { color: colors.muted, fontWeight: "700" },
    faceSquareText: { color: colors.surface },
    give: { gap: 8, marginTop: 6 },
    giveRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    list: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      backgroundColor: colors.surface,
      overflow: "hidden",
    },
    option: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 12, minHeight: 48 },
    divided: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
    pressed: { backgroundColor: colors.rowSelected },
    foot: { paddingVertical: 8, paddingHorizontal: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
    cut: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: radii.md, borderWidth: 1, borderColor: colors.critBorder },
    cutPressed: { backgroundColor: colors.critWash },
    cutDisabled: { opacity: 0.5 },
    cutText: { color: colors.critText, fontWeight: "600" },
    flex: { flex: 1, minWidth: 0 },
  });
