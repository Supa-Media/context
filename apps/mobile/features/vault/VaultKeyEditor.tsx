import { useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../design/components/Button";
import { FormError, TextField } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { TextLink } from "../design/components/TextLink";
import { useThemedStyles, type Colors } from "../design/theme";
import { SecretInput } from "./SecretInput";
import { SuggestionList } from "./SuggestionList";
import { VaultProxyFields } from "./VaultProxyFields";
import { suggestSites } from "./apiHostSuggest";
import { ENVS, ENV_LABEL, SINGLE, isEnv, type RevealedField } from "./vaultFields";
import { proxyDraft, proxyFormOf, proxyProblem, type ProxyFormState, type ProxyPinDraft } from "./vaultProxy";
import type { VaultEntry } from "./vaultSettings";
import type { VaultValuesShape } from "./VaultValues";

/** What a save sends: only the parts that changed. */
export type VaultEdit = {
  name?: string;
  site?: string;
  /** The website it is only ever sent to, or null to stop AIs using it. */
  proxy?: ProxyPinDraft | null;
  username?: string;
  password?: string;
  fields?: RevealedField[];
};

/**
 * Edit, on a picked key in Settings › Vault (board 2's Edit; the owner asked
 * on 2026-10-16 to change things in place, the website included, and to
 * delete a key). One form in the key's own pane: its name, where it goes and
 * how, and its values. Save sends only what changed, and the server logs it
 * by name ("You changed the website"), never a value. Delete is the one-way
 * door: said in bold red, and asked once more inline before it happens.
 */
export function VaultKeyEditor({
  entry,
  values,
  onSave,
  onCancel,
  onDelete,
}: {
  entry: VaultEntry;
  values: VaultValuesShape;
  /** Resolves the names of what changed. */
  onSave: (edit: VaultEdit, after: VaultValuesShape) => Promise<string[]>;
  onCancel: () => void;
  onDelete: () => Promise<void>;
}) {
  const styles = useThemedStyles(makeStyles);
  const login = entry.type === "login";
  const card = entry.type === "card";
  const start = useMemo(() => draftOf(entry, values), [entry, values]);
  const [draft, setDraft] = useState(start);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const edit = useMemo(() => editBetween(entry, start, draft), [entry, start, draft]);
  const dirty = Object.keys(edit).length > 0;
  const blocker =
    draft.name.trim() === ""
      ? "To save, give it a name."
      : login && draft.password.length === 0
        ? "To save, enter the password."
        : login || card
          ? null
          : proxyProblem(draft.proxy);
  const change = (patch: Partial<Draft>) => {
    setDraft((now) => ({ ...now, ...patch }));
    setProblem(null);
  };
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (error: unknown) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      await onSave(edit, { username: draft.username, password: draft.password, fields: draft.fields });
    });

  return (
    <View style={styles.form} testID="vault-key-editor">
      <TextField label="Name" value={draft.name} onChangeText={(name) => change({ name })} editable={!busy} testID="vault-edit-name" />
      {card ? (
        <>
          <TextField
            label="Pays on"
            optional
            hint="One shop, or blank for any checkout. Tex asks you each time either way."
            value={draft.site}
            onChangeText={(site) => change({ site })}
            placeholder="e.g. amazon.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            inputMode="url"
            editable={!busy}
            testID="vault-edit-site"
          />
          <Text variant="rowSub" testID="vault-edit-card-note">
            A card's number and details can't be changed here. For a new card, delete this one and save the new one.
          </Text>
        </>
      ) : login ? (
        <>
          <TextField
            label="Tex fills it on"
            value={draft.site}
            onChangeText={(site) => change({ site })}
            placeholder="e.g. netflix.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            inputMode="url"
            editable={!busy}
            testID="vault-edit-site"
          />
          <TextField
            label="Username"
            value={draft.username}
            onChangeText={(username) => change({ username })}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            testID="vault-edit-username"
          />
          <SecretInput
            label="Password"
            revealName="password"
            value={draft.password}
            onChangeText={(password) => change({ password })}
            editable={!busy}
            testID="vault-edit-password"
          />
        </>
      ) : (
        <>
          <VaultProxyFields state={draft.proxy} onChange={(proxy) => change({ proxy })} entryName={draft.name} entrySite={draft.site} busy={busy} />
          <TextField
            label="Fills on"
            optional
            hint="A site where Tex may paste these for you."
            value={draft.site}
            onChangeText={(site) => change({ site })}
            placeholder="e.g. dashboard.stripe.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            inputMode="url"
            editable={!busy}
            testID="vault-edit-site"
          />
          <SuggestionList
            items={suggestSites(draft.site).map((one) => ({ value: one.site, name: one.name }))}
            onPick={(site) => change({ site })}
            disabled={busy}
            testID="vault-edit-site-suggestions"
          />
        </>
      )}
      {card ? null : draft.fields.map((field, fieldIndex) => (
        <View key={field.name} style={styles.field}>
          <Text variant="mono" style={styles.fieldName} numberOfLines={1} ellipsizeMode="middle">
            {field.name}
          </Text>
          {slotsOf(field).map((slot) => (
            <SecretInput
              key={slot}
              label={slot === SINGLE ? "Value" : isEnv(slot) ? ENV_LABEL[slot] : slot}
              revealName={slot === SINGLE ? field.name : `${field.name} for ${slot}`}
              value={field.values[slot] ?? ""}
              onChangeText={(text) => change({ fields: withValue(draft.fields, fieldIndex, slot, text) })}
              editable={!busy}
              testID={`vault-edit-field-${fieldIndex}-${slot}`}
            />
          ))}
        </View>
      ))}
      {problem !== null ? <FormError headline={problem} /> : null}
      <View style={styles.actions}>
        <Button
          label={busy && !confirming ? "Saving…" : "Save changes"}
          variant="dialogPrimary"
          disabled={busy || !dirty || blocker !== null}
          onPress={() => void save()}
          testID="vault-edit-save"
        />
        <Button label="Cancel" variant="dialog" disabled={busy} onPress={onCancel} testID="vault-edit-cancel" />
        {dirty && blocker !== null ? <Text variant="hint">{blocker}</Text> : null}
      </View>
      <View style={styles.danger}>
        {confirming ? (
          <>
            <Text variant="rowSub" style={styles.dangerText} testID="vault-delete-ask">
              Delete “{entry.name}”? Every AI loses it at once, and it can't be brought back.
            </Text>
            <View style={styles.actions}>
              <Button
                label={busy ? "Deleting…" : card ? "Delete card" : "Delete key"}
                variant="dialogDanger"
                disabled={busy}
                onPress={() => void act(onDelete)}
                testID="vault-delete-confirm"
              />
              <Button label="Keep it" variant="dialog" disabled={busy} onPress={() => setConfirming(false)} testID="vault-delete-keep" />
            </View>
          </>
        ) : (
          <TextLink label={card ? "Delete card" : "Delete key"} style={styles.dangerText} disabled={busy} onPress={() => setConfirming(true)} testID="vault-delete" />
        )}
      </View>
    </View>
  );
}

type Draft = VaultValuesShape & { name: string; site: string; proxy: ProxyFormState };

function draftOf(entry: VaultEntry, values: VaultValuesShape): Draft {
  return {
    name: entry.name,
    site: entry.sites[0] ?? "",
    proxy: proxyFormOf(entry.proxy),
    username: values.username,
    password: values.password,
    fields: values.fields.map((field) => ({ ...field, values: { ...field.values } })),
  };
}

/** The value slots a field shows: each environment it has a value in, or its one value. */
function slotsOf(field: RevealedField): string[] {
  if (!field.perEnv) return [SINGLE];
  const set = ENVS.filter((env) => field.values[env] !== undefined);
  return set.length > 0 ? set : [...ENVS];
}

function withValue(fields: RevealedField[], fieldIndex: number, slot: string, text: string): RevealedField[] {
  return fields.map((field, index) => (index === fieldIndex ? { ...field, values: { ...field.values, [slot]: text } } : field));
}

const pinKey = (pin: ProxyPinDraft | undefined) => (pin ? JSON.stringify([pin.host, pin.style, pin.name ?? "", pin.prefix ?? "", pin.ask]) : "");

/** Only what differs from the key as it was opened. */
export function editBetween(entry: VaultEntry, before: Draft, after: Draft): VaultEdit {
  const edit: VaultEdit = {};
  if (after.name.trim() !== before.name) edit.name = after.name.trim();
  if (after.site.trim() !== before.site) edit.site = after.site.trim();
  if (entry.type === "secret") {
    const was = proxyDraft(before.proxy);
    const now = proxyDraft(after.proxy);
    if (pinKey(was) !== pinKey(now)) edit.proxy = now ?? null;
  }
  // A card's details are saved whole or not at all (`apps/convex/functions/lib/vaultEdit.ts`).
  if (entry.type === "card") return edit;
  if (after.username !== before.username) edit.username = after.username;
  if (after.password !== before.password) edit.password = after.password;
  if (JSON.stringify(after.fields) !== JSON.stringify(before.fields)) edit.fields = after.fields;
  return edit;
}

/** "Saved. You changed the website and the password." */
export function changedLine(changed: string[]): string {
  if (changed.length === 0) return "Nothing to save: it was already like that.";
  const words: Record<string, string> = {
    name: "the name",
    site: "the site",
    website: "the website",
    "how it is sent": "how it is sent",
    "first-use ask": "the first-use ask",
    "AI use": "whether AIs can use it",
    username: "the username",
    password: "the password",
  };
  const names = changed.map((name) => words[name] ?? name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `Saved. You changed ${list}.`;
}

function messageOf(error: unknown): string {
  const data = (error as { data?: { message?: unknown } } | null)?.data;
  return typeof data?.message === "string" ? data.message : "That didn't go through. Try again.";
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    form: { gap: 14 },
    field: { gap: 8 },
    fieldName: { color: colors.text, fontWeight: "600" },
    actions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 },
    danger: { gap: 10, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
    dangerText: { color: colors.critText, fontWeight: "700" },
  });
