/**
 * Settings › Vault (vault board 2): the keys this person may use in the open
 * workspace, the one website each is sent to, the AIs they said yes to, and
 * Cut off.
 *
 * Values never reach this page. Show the key and New key make a fresh link to
 * the vault's own pages (`/vault/<token>`), where the value is typed or
 * revealed, so the console holds names, websites and yeses only.
 */

import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useConvex } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";

import { Button } from "../../../design/components/Button";
import { Card } from "../../../design/components/Card";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { errorMessageOf } from "../../../vault/vaultLink";
import {
  vaultClientLine,
  vaultNoClientsLine,
  vaultPinLine,
  vaultRowLine,
  type VaultEntry,
} from "../../../vault/vaultSettings";
import { PanelHead } from "./PanelHead";

export type VaultActions = {
  list: () => Promise<VaultEntry[]>;
  cutOff: (entryId: string, clientId?: string) => Promise<VaultEntry>;
  link: (kind: "add" | "view", entryId?: string) => Promise<void>;
};

export function VaultPanel({ sectioned, workspaceId }: { sectioned: boolean; workspaceId: string | null }) {
  // No provider in the landing page's demo or the render tests.
  const client = useConvex();
  return (
    <>
      <PanelHead section="vault" sectioned={sectioned}>
        Keys your AIs can use without ever seeing them. Context adds the key on the way to the one website
        it is for.
      </PanelHead>
      {client === undefined || workspaceId === null ? (
        <Card>
          <Text variant="hint">No workspace is open.</Text>
        </Card>
      ) : (
        <LiveVault workspaceId={workspaceId} />
      )}
    </>
  );
}

function LiveVault({ workspaceId }: { workspaceId: string }) {
  const client = useConvex();
  const id = workspaceId as Id<"workspaces">;
  const actions: VaultActions = {
    list: () => client.action(api.functions.vaultSettings.listVaultEntries, { workspaceId: id }),
    cutOff: (entryId, clientId) =>
      client.action(api.functions.vaultSettings.cutOffVaultAI, {
        workspaceId: id,
        entryId,
        ...(clientId === undefined ? {} : { clientId }),
      }),
    link: async (kind, entryId) => {
      const { token } = await client.action(api.functions.vaultSettings.startVaultLink, {
        workspaceId: id,
        kind,
        ...(entryId === undefined ? {} : { entryId }),
      });
      /*
        Loaded on press: a leaf that imports `expo-router` needs a router
        mocked in every suite that mounts Settings (`PremiumPanel` says why).
      */
      const { router } = await import("expo-router");
      router.push(`/vault/${token}`);
    },
  };
  return <VaultList key={workspaceId} actions={actions} />;
}

/** The list and its open key, drawn from `actions` so a test can hand it fakes. */
export function VaultList({ actions }: { actions: VaultActions }) {
  const styles = useThemedStyles(makeStyles);
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { list } = actions;

  useEffect(() => {
    let live = true;
    list().then(
      (next) => live && setEntries(next),
      (error: unknown) => live && setProblem(errorMessageOf(error) ?? "Your keys couldn't be read. Try again."),
    );
    return () => {
      live = false;
    };
    // `actions` is rebuilt each render; one read per mounted list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (error: unknown) {
      setProblem(errorMessageOf(error) ?? "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  }, []);

  const cutOff = (entryId: string, clientId?: string) =>
    void run(async () => {
      const next = await actions.cutOff(entryId, clientId);
      setEntries((now) => (now ?? []).map((entry) => (entry.entryId === entryId ? next : entry)));
    });

  const shown = entries?.find((entry) => entry.entryId === open) ?? null;
  return (
    <Card style={styles.card}>
      <View style={styles.head}>
        <Text variant="rowSub" style={styles.flex}>
          {entries === null ? (problem === null ? "Reading…" : "") : entries.length === 1 ? "1 key" : `${entries.length} keys`}
        </Text>
        <Button label="New key" variant="dialogPrimary" disabled={busy} testID="vault-new" onPress={() => void run(() => actions.link("add"))} />
      </View>
      {entries !== null && entries.length === 0 ? (
        <Text variant="hint">No keys yet. Save one with New key, or ask your AI to send you a link to add one.</Text>
      ) : null}
      {(entries ?? []).map((entry) => (
        <View key={entry.entryId} style={styles.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open === entry.entryId }}
            testID={`vault-row-${entry.entryId}`}
            onPress={() => setOpen(open === entry.entryId ? null : entry.entryId)}
          >
            <Text variant="rowTitle">{entry.name}</Text>
            <Text variant="rowSub">{vaultRowLine(entry)}</Text>
          </Pressable>
          {shown?.entryId === entry.entryId ? (
            <VaultDetail entry={shown} busy={busy} onCutOff={cutOff} onShow={() => void run(() => actions.link("view", entry.entryId))} />
          ) : null}
        </View>
      ))}
      {problem !== null ? <Text variant="error">{problem}</Text> : null}
    </Card>
  );
}

function VaultDetail({
  entry,
  busy,
  onCutOff,
  onShow,
}: {
  entry: VaultEntry;
  busy: boolean;
  onCutOff: (entryId: string, clientId?: string) => void;
  onShow: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const proxy = entry.proxy;
  return (
    <View style={styles.detail}>
      {proxy === null ? null : (
        <>
          <Text variant="rowSub">{vaultPinLine(proxy)}</Text>
          <Text variant="eyebrow" style={styles.label}>
            AIs that can use it
          </Text>
          {proxy.clients.length === 0 ? (
            <Text variant="hint">{vaultNoClientsLine(proxy)}</Text>
          ) : (
            proxy.clients.map((client) => (
              <View key={client.id} style={styles.client}>
                <Text variant="rowSub" style={styles.flex}>
                  {vaultClientLine(client)}
                </Text>
                <Button
                  label="Cut off"
                  variant="dialogDanger"
                  disabled={busy}
                  testID={`vault-cut-${client.id}`}
                  onPress={() => onCutOff(entry.entryId, client.id)}
                />
              </View>
            ))
          )}
        </>
      )}
      <View style={styles.actions}>
        <Button label="Show the key" variant="dialog" disabled={busy} testID={`vault-show-${entry.entryId}`} onPress={onShow} />
        {proxy !== null && proxy.clients.length > 0 ? (
          <Button
            label="Cut off every AI"
            variant="dialogDanger"
            disabled={busy}
            testID={`vault-cut-all-${entry.entryId}`}
            onPress={() => onCutOff(entry.entryId)}
          />
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { gap: 10 },
    head: { flexDirection: "row", alignItems: "center", gap: 10 },
    row: {
      gap: 8,
      paddingVertical: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
    },
    detail: { gap: 8, paddingLeft: 12 },
    label: { marginTop: 4 },
    client: { flexDirection: "row", alignItems: "center", gap: 10 },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 4 },
    flex: { flex: 1 },
  });
