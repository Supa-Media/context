import { useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../design/components/Button";
import { FormError, TextField } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { useThemedStyles, type Colors } from "../design/theme";
import { useCopy } from "../design/useCopy";
import { SecretInput } from "./SecretInput";
import { ENVS, SINGLE, type RevealedField } from "./vaultFields";
import type { RevealedEntry } from "./vaultLink";

/** What a save sends: only the parts that changed. */
export type VaultEdit = { username?: string; password?: string; fields?: RevealedField[] };

/**
 * One key's values, open in Settings › Vault and changed in place (the owner
 * asked on 2026-10-16). A login's username is shown as it is; its password,
 * and every secret value, is dots until Show. Save sends only what changed,
 * and the server logs it by name ("You changed the password"), never the
 * value. The values live in this component's state and go when it closes.
 */
export function VaultKeyEditor({
  revealed,
  onSave,
}: {
  revealed: RevealedEntry;
  /** Resolves the names of what changed. */
  onSave: (edit: VaultEdit) => Promise<string[]>;
}) {
  const styles = useThemedStyles(makeStyles);
  const login = revealed.type === "login";
  const [saved, setSaved] = useState(() => draftOf(revealed));
  const [draft, setDraft] = useState(() => draftOf(revealed));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const edit = useMemo(() => editBetween(saved, draft), [saved, draft]);
  const dirty = Object.keys(edit).length > 0;
  const blocker = login && draft.password.length === 0 ? "To save, enter the password." : null;

  const change = (next: Draft) => {
    setDraft(next);
    setSaid(null);
    setProblem(null);
  };
  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const changed = await onSave(edit);
      setSaved(draft);
      setSaid(changedLine(changed));
    } catch (error: unknown) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrap} testID="vault-key-editor">
      {login ? (
        <>
          <Row value={draft.username} name="username">
            <TextField
              label="Username"
              value={draft.username}
              onChangeText={(username) => change({ ...draft, username })}
              autoCapitalize="none"
              autoCorrect={false}
              testID="vault-edit-username"
            />
          </Row>
          <Row value={draft.password} name="password">
            <SecretInput
              label="Password"
              revealName="password"
              value={draft.password}
              onChangeText={(password) => change({ ...draft, password })}
              testID="vault-edit-password"
            />
          </Row>
        </>
      ) : null}
      {draft.fields.map((field, fieldIndex) =>
        slotsOf(field).map((slot) => {
          const label = slot === SINGLE ? field.name : `${field.name} · ${slot}`;
          const value = field.values[slot] ?? "";
          return (
            <Row key={`${field.name}-${slot}`} value={value} name={label}>
              <SecretInput
                label={label}
                revealName={label}
                value={value}
                onChangeText={(text) => change(withValue(draft, fieldIndex, slot, text))}
                testID={`vault-edit-field-${fieldIndex}-${slot}`}
              />
            </Row>
          );
        }),
      )}
      {problem !== null ? <FormError headline={problem} /> : null}
      {said !== null ? (
        <Text variant="rowSub" testID="vault-edit-saved">
          {said}
        </Text>
      ) : null}
      {dirty ? (
        <View style={styles.actions}>
          <Button
            label={busy ? "Saving…" : "Save changes"}
            variant="dialogPrimary"
            disabled={busy || blocker !== null}
            onPress={() => void save()}
            testID="vault-edit-save"
          />
          <Button label="Undo" variant="dialog" disabled={busy} onPress={() => change(saved)} testID="vault-edit-undo" />
          {blocker !== null ? <Text variant="hint">{blocker}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

type Draft = { username: string; password: string; fields: RevealedField[] };

function draftOf(revealed: RevealedEntry): Draft {
  return {
    username: revealed.username,
    password: revealed.password,
    fields: revealed.fields.map((field) => ({ ...field, values: { ...field.values } })),
  };
}

/** The value slots a field shows: each environment it has a value in, or its one value. */
function slotsOf(field: RevealedField): string[] {
  if (!field.perEnv) return [SINGLE];
  const set = ENVS.filter((env) => field.values[env] !== undefined);
  return set.length > 0 ? set : [...ENVS];
}

function withValue(draft: Draft, fieldIndex: number, slot: string, text: string): Draft {
  return {
    ...draft,
    fields: draft.fields.map((field, index) => (index === fieldIndex ? { ...field, values: { ...field.values, [slot]: text } } : field)),
  };
}

export function editBetween(before: Draft, after: Draft): VaultEdit {
  const edit: VaultEdit = {};
  if (after.username !== before.username) edit.username = after.username;
  if (after.password !== before.password) edit.password = after.password;
  if (JSON.stringify(after.fields) !== JSON.stringify(before.fields)) edit.fields = after.fields;
  return edit;
}

/** "Saved. You changed the password." */
export function changedLine(changed: string[]): string {
  if (changed.length === 0) return "Nothing to save: it was already like that.";
  const names = changed.map((name) => (name === "username" || name === "password" ? `the ${name}` : name));
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `Saved. You changed ${list}.`;
}

function messageOf(error: unknown): string {
  const data = (error as { data?: { message?: unknown } } | null)?.data;
  return typeof data?.message === "string" ? data.message : "That wasn't saved. Try again.";
}

/** A field and its Copy, side by side. */
function Row({ value, name, children }: { value: string; name: string; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  const { label, copy } = useCopy(value);
  return (
    <View style={styles.row}>
      <View style={styles.field}>{children}</View>
      <Button label={label} variant="mini" disabled={value.length === 0} accessibilityLabel={`Copy ${name}`} onPress={copy} style={styles.copy} />
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    wrap: { gap: 12 },
    row: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
    field: { flex: 1, minWidth: 0 },
    copy: { marginBottom: 8 },
    actions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 },
  });
