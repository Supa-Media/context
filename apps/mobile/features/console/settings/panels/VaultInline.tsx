/**
 * New key and Show the key, opened inside Settings › Vault instead of on a
 * page of their own (the owner asked on 2026-10-16: "I don't like that it
 * opens a new page").
 *
 * Each press still mints a fresh vault link and goes through the same
 * server calls as `/vault/<token>` (`useVaultLinkFlow`), so the rules do not
 * change: a value is typed or revealed only on this link, the reveal is
 * recorded, and what was revealed lives in this component's state while it is
 * open and goes with it when it closes. The list itself still never holds a
 * value.
 */

import { useEffect, useRef } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";

import { Text } from "../../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { VaultAddForm } from "../../../vault/VaultAddForm";
import { VaultViewPage } from "../../../vault/VaultViewPage";
import { resolveVaultLinkView } from "../../../vault/vaultLink";
import { useVaultLinkFlow, type VaultLinkCalls } from "../../../vault/useVaultLinkFlow";

export function VaultInline({
  mode,
  token,
  calls,
  onClose,
  onSaved,
}: {
  mode: "add" | "view";
  /** Null while the link is being made. */
  token: string | null;
  calls: VaultLinkCalls;
  onClose: () => void;
  /** After New key saves: the name it was saved under. */
  onSaved: (name: string) => void;
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

  // Show the key was the press: reveal as soon as the link is read, not after a second button.
  const revealed = useRef(false);
  useEffect(() => {
    if (view.kind !== "view" || revealed.current) return;
    revealed.current = true;
    onReveal();
  }, [view.kind, onReveal]);

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
        return <VaultViewPage view={view} titleSize={0} onReveal={onReveal} inline />;
      default:
        return null;
    }
  })();

  if (mode === "view") {
    return (
      <View style={styles.section} testID="vault-inline-view">
        <Text variant="eyebrow">The key</Text>
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
    section: { gap: 8 },
    loading: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  });
