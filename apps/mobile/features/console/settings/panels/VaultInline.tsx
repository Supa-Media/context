/**
 * New key, and a picked key's values, opened inside Settings › Vault instead
 * of on a page of their own (the owner asked on 2026-10-16: "I don't like
 * that it opens a new page"). A key's values show read-only, quietly; Edit
 * turns the pane into one form for the whole key, and Delete is there too.
 *
 * Each press still mints a fresh vault link and goes through the same
 * server calls as `/vault/<token>` (`useVaultLinkFlow`), so the rules do not
 * change: a value is typed or revealed only on this link, the reveal is
 * recorded, and what was revealed lives in this component's state while it is
 * open and goes with it when it closes. The list itself still never holds a
 * value.
 */

import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";

import { Text } from "../../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { VaultAddForm } from "../../../vault/VaultAddForm";
import { VaultKeyEditor, changedLine } from "../../../vault/VaultKeyEditor";
import { VaultValues, type VaultValuesShape } from "../../../vault/VaultValues";
import type { VaultEntry } from "../../../vault/vaultSettings";
import { resolveVaultLinkView } from "../../../vault/vaultLink";
import { useVaultLinkFlow, type VaultLinkCalls } from "../../../vault/useVaultLinkFlow";

export function VaultInline({
  mode,
  token,
  calls,
  onClose,
  onSaved,
  entry,
  editing = false,
  onEditing,
  onChanged,
  onDeleted,
}: {
  mode: "add" | "view";
  /** Null while the link is being made. */
  token: string | null;
  calls: VaultLinkCalls;
  onClose: () => void;
  /** After New key saves: the name it was saved under. */
  onSaved: (name: string) => void;
  /** View only: the key as the list knows it (name, where it goes), for Edit. */
  entry?: VaultEntry;
  /** View only: Edit is open, in place of the values. */
  editing?: boolean;
  onEditing?: (editing: boolean) => void;
  /** View only: after a save, so the list reads the key again. */
  onChanged?: () => void;
  /** View only: after Delete. */
  onDeleted?: (name: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { described, outcome, onSave, onReveal } = useVaultLinkFlow(token, token !== null, calls);
  const view = resolveVaultLinkView({
    token,
    auth: { isLoading: token === null, isAuthenticated: true },
    prefill: {},
    described,
    outcome,
  });

  // Picking the key was the press: reveal as soon as the link is read, not after a second button.
  const revealed = useRef(false);
  useEffect(() => {
    if (view.kind !== "view" || revealed.current) return;
    revealed.current = true;
    onReveal();
  }, [view.kind, onReveal]);

  // The values as last saved here: the reveal's, then each save's.
  const [values, setValues] = useState<VaultValuesShape | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const opened = view.kind === "view" ? view.revealed : null;
  useEffect(() => {
    if (opened !== null) setValues({ username: opened.username, password: opened.password, fields: opened.fields });
  }, [opened]);

  const saved = view.kind === "saved" ? view.name : null;
  useEffect(() => {
    if (saved !== null) onSaved(saved);
    // Once per save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const body = (() => {
    switch (view.kind) {
      case "wait":
      case "loading":
        return (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.text2} size="small" />
            <Text variant="rowSub">{mode === "add" ? "Opening the form…" : "Opening the key…"}</Text>
          </View>
        );
      case "dead":
        return (
          <View testID="vault-inline-dead">
            <Text variant="rowTitle">{view.headline}</Text>
            <Text variant="rowSub">{view.detail}</Text>
          </View>
        );
      case "add":
        return <VaultAddForm prefill={view.prefill} busy={view.busy} problem={view.problem} onSave={onSave} onType={() => undefined} />;
      case "view":
        if (view.revealed === null || values === null) {
          return view.problem ? (
            <Text variant="error">{view.problem.headline}</Text>
          ) : (
            <View style={styles.loading}>
              <ActivityIndicator color={colors.text2} size="small" />
              <Text variant="rowSub">Opening the key…</Text>
            </View>
          );
        }
        if (editing && entry !== undefined) {
          return (
            <VaultKeyEditor
              entry={entry}
              values={values}
              onCancel={() => onEditing?.(false)}
              onSave={async (edit, after) => {
                if (token === null || calls.edit === undefined) throw new Error("This key can't be changed here.");
                const { changed } = await calls.edit(token, edit);
                setValues(after);
                setSaid(changedLine(changed));
                onEditing?.(false);
                if (changed.length > 0) onChanged?.();
                return changed;
              }}
              onDelete={async () => {
                if (token === null || calls.remove === undefined) throw new Error("This key can't be deleted here.");
                const { name } = await calls.remove(token);
                onDeleted?.(name);
              }}
            />
          );
        }
        return (
          <>
            {said !== null ? (
              <Text variant="rowSub" testID="vault-edit-saved">
                {said}
              </Text>
            ) : null}
            <VaultValues login={view.revealed.type === "login"} card={view.revealed.type === "card"} values={values} />
          </>
        );
      default:
        return null;
    }
  })();

  if (mode === "view") {
    return (
      <View style={styles.section} testID="vault-inline-view">
        {editing ? null : <Text variant="eyebrow">{view.kind === "view" && view.entry.type === "login" ? "Sign-in" : view.kind === "view" && view.entry.type === "card" ? "Card" : "Values"}</Text>}
        {body}
      </View>
    );
  }
  return (
    <View style={styles.add} testID="vault-inline-add">
      <View style={styles.head}>
        <Text variant="paneTitle" style={styles.flex}>
          New key
        </Text>
        <Pressable accessibilityRole="button" onPress={onClose} testID="vault-inline-cancel">
          <Text variant="rowSub">Cancel</Text>
        </Pressable>
      </View>
      {body}
    </View>
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    add: { gap: 14 },
    head: { flexDirection: "row", alignItems: "center", gap: 12 },
    flex: { flex: 1, minWidth: 0 },
    section: { gap: 10 },
    loading: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  });
