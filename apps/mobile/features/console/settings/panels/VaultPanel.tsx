/**
 * Settings › Vault, drawn as vault board 2: the keys this person may use in
 * the open workspace as a list of cards, each with its one website, the AIs
 * that use it and when one last did, and beside the list the picked key's
 * detail: the website in a box, every AI with Cut off (or Allow for one the
 * person said no to), and the last use in a sentence. On a narrow screen the
 * detail takes the list's place, with a way back.
 *
 * Values never reach the list. Show the key and New key make a fresh vault
 * link and open it in place (`VaultInline`), through the same calls as the
 * vault's own page (`/vault/<token>`), so a value is typed or revealed only
 * there and is dropped when it closes.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { useConvex } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";

import { Button } from "../../../design/components/Button";
import { Card } from "../../../design/components/Card";
import { Icon } from "../../../design/components/Icon";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { radii } from "../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../design/theme";
import { AgentFace } from "../../map/live/ui/ActorFace";
import { errorMessageOf } from "../../../vault/vaultLink";
import {
  VAULT_FILTERS,
  inFilter,
  vaultClientLine,
  vaultCountLine,
  vaultLastUsedLine,
  vaultNoClientsLine,
  vaultPinLine,
  vaultRefusedLine,
  vaultRowLine,
  vaultRowPill,
  vaultSavedLine,
  type VaultEntry,
  type VaultFilter,
} from "../../../vault/vaultSettings";
import type { VaultLinkCalls } from "../../../vault/useVaultLinkFlow";
import { PanelHead } from "./PanelHead";
import { VaultInline } from "./VaultInline";

export type VaultActions = {
  list: () => Promise<VaultEntry[]>;
  cutOff: (entryId: string, clientId?: string) => Promise<VaultEntry>;
  allow: (entryId: string, clientId: string) => Promise<VaultEntry>;
  /** A fresh vault link's token, opened in place through `calls`. */
  link: (kind: "add" | "view", entryId?: string) => Promise<string>;
  calls: VaultLinkCalls;
};

type Opened = { mode: "add" } | { mode: "view"; entryId: string };

/** Wide enough for the list and the detail side by side, as the board draws them. */
const SIDE_BY_SIDE = 760;

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
    allow: (entryId, clientId) => client.action(api.functions.vaultSettings.allowVaultAI, { workspaceId: id, entryId, clientId }),
    link: async (kind, entryId) => {
      const { token } = await client.action(api.functions.vaultSettings.startVaultLink, {
        workspaceId: id,
        kind,
        ...(entryId === undefined ? {} : { entryId }),
      });
      return token;
    },
    calls: {
      describe: (token) => client.action(api.functions.vault.describeVaultRequest, { token }),
      save: (token, draft) => client.action(api.functions.vault.saveVaultLogin, { token, ...draft }),
      reveal: (token) => client.action(api.functions.vault.revealVaultEntry, { token }),
    },
  };
  return <VaultList key={workspaceId} actions={actions} />;
}

/** The list and the picked key, drawn from `actions` so a test can hand it fakes. */
export function VaultList({
  actions,
  now,
  layoutWidth,
}: {
  actions: VaultActions;
  now?: Date;
  /** Tests and previews: the width to lay out for, before (or without) a measure. */
  layoutWidth?: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const [picked, setPickedState] = useState<string | null>(null);
  const [opened, setOpened] = useState<{ what: Opened; token: string | null; n: number } | null>(null);
  const [filter, setFilter] = useState<VaultFilter>("all");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [width, setWidth] = useState(layoutWidth ?? 0);
  const { list } = actions;
  const wide = width >= SIDE_BY_SIDE;

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

  // Any other choice closes what was opened in place, and its values with it.
  const setPicked = (entryId: string | null) => {
    setOpened(null);
    setPickedState(entryId);
  };
  const open = (what: Opened) => {
    const n = (opened?.n ?? 0) + 1;
    setOpened({ what, token: null, n });
    void run(async () => {
      try {
        const token = await actions.link(what.mode, what.mode === "view" ? what.entryId : undefined);
        setOpened((now) => (now?.n === n ? { ...now, token } : now));
      } catch (error: unknown) {
        setOpened((now) => (now?.n === n ? null : now));
        throw error;
      }
    });
  };
  const saved = (name: string) =>
    void run(async () => {
      const next = await actions.list();
      setEntries(next);
      const added = next.filter((entry) => entry.name === name).sort((a, b) => b.savedAt - a.savedAt)[0];
      setFilter("all");
      setPicked(added?.entryId ?? null);
    });

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

  /** Put a key the server sent back in place, keeping what only the list read knows (asks waiting). */
  const replace = (next: VaultEntry) =>
    setEntries((now) =>
      (now ?? []).map((entry) =>
        entry.entryId === next.entryId
          ? { ...next, proxy: next.proxy && { ...next.proxy, waiting: entry.proxy?.waiting ?? next.proxy.waiting } }
          : entry,
      ),
    );
  const cutOff = (entryId: string, clientId?: string) => void run(async () => replace(await actions.cutOff(entryId, clientId)));
  const allow = (entryId: string, clientId: string) => void run(async () => replace(await actions.allow(entryId, clientId)));

  const shownEntries = (entries ?? []).filter((entry) => inFilter(entry, filter, now));
  // Side by side, a key is always picked, as on the board; narrow, the list comes first.
  const chosen =
    shownEntries.find((entry) => entry.entryId === picked) ?? (wide && picked === null ? shownEntries[0] ?? null : null);
  const detail =
    chosen === null ? null : (
      <VaultDetail
        entry={chosen}
        busy={busy}
        now={now}
        onCutOff={cutOff}
        onAllow={allow}
        showing={opened?.what.mode === "view" && opened.what.entryId === chosen.entryId}
        onShow={() => (opened?.what.mode === "view" ? setOpened(null) : open({ mode: "view", entryId: chosen.entryId }))}
        keyView={
          opened?.what.mode === "view" && opened.what.entryId === chosen.entryId ? (
            <VaultInline
              key={opened.n}
              mode="view"
              token={opened.token}
              calls={actions.calls}
              onClose={() => setOpened(null)}
              onSaved={() => undefined}
            />
          ) : null
        }
        onBack={wide ? undefined : () => setPicked(null)}
      />
    );

  const adding =
    opened?.what.mode === "add" ? (
      <VaultInline key={opened.n} mode="add" token={opened.token} calls={actions.calls} onClose={() => setOpened(null)} onSaved={saved} />
    ) : null;
  const side = adding ?? detail;

  return (
    <Card style={styles.card}>
      <View style={styles.frame} onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}>
        <View style={styles.head}>
          {entries !== null && entries.length > 0 ? (
            <Pill testID="vault-count">{vaultCountLine(entries)}</Pill>
          ) : (
            <Text variant="rowSub">{entries === null && problem === null ? "Reading…" : ""}</Text>
          )}
          <View style={styles.flex} />
          <Button label="+ New key" variant="dialogPrimary" disabled={busy} testID="vault-new" onPress={() => open({ mode: "add" })} />
        </View>
        {entries !== null && entries.length === 0 && adding === null ? (
          <Text variant="hint">No keys yet. Save one with New key, or ask your AI to send you a link to add one.</Text>
        ) : null}
        {problem !== null ? <Text variant="error">{problem}</Text> : null}
        {entries !== null && (entries.length > 0 || adding !== null) ? (
          <View style={wide ? styles.split : null}>
            {(wide || side === null) && entries.length > 0 ? (
              <View style={wide ? styles.listSide : null}>
                <View style={styles.filters} accessibilityRole="tablist">
                  {VAULT_FILTERS.map((option) => (
                    <Pressable
                      key={option.key}
                      accessibilityRole="tab"
                      accessibilityState={{ selected: filter === option.key }}
                      onPress={() => {
                        setOpened(null);
                        setFilter(option.key);
                      }}
                      style={[styles.chip, filter === option.key && styles.chipOn]}
                      testID={`vault-filter-${option.key}`}
                    >
                      <Text variant="rowSub" style={filter === option.key ? styles.chipOnText : styles.chipText}>
                        {option.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                {shownEntries.length === 0 ? <Text variant="hint">No keys here.</Text> : null}
                {shownEntries.map((entry) => (
                  <VaultRow
                    key={entry.entryId}
                    entry={entry}
                    now={now}
                    selected={adding === null && chosen?.entryId === entry.entryId}
                    onPress={() => setPicked(entry.entryId)}
                  />
                ))}
              </View>
            ) : null}
            {side !== null ? <View style={wide && entries.length > 0 ? styles.detailSide : null}>{side}</View> : null}
          </View>
        ) : null}
      </View>
    </Card>
  );
}

function VaultRow({ entry, now, selected, onPress }: { entry: VaultEntry; now?: Date; selected: boolean; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const pill = vaultRowPill(entry, now);
  const faces = entry.proxy?.clients ?? [];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.row, selected && styles.rowOn, entry.type === "secret" && entry.proxy === null && styles.rowQuiet]}
      testID={`vault-row-${entry.entryId}`}
    >
      <View style={styles.tile}>
        <Icon name={entry.type === "login" ? "lock" : "key"} size={18} color={colors.muted} />
      </View>
      <View style={styles.flex}>
        <Text variant="rowTitle" numberOfLines={1}>
          {entry.name}
        </Text>
        <Text variant="rowSub" numberOfLines={1}>
          {vaultRowLine(entry)}
        </Text>
      </View>
      {faces.length > 0 ? (
        <View style={styles.stack}>
          {faces.slice(0, 4).map((client, index) => (
            <View key={client.id} style={[styles.face, index > 0 && styles.faceOverlap]}>
              <AgentFace name={client.name ?? "AI"} size={22} />
            </View>
          ))}
        </View>
      ) : null}
      {pill !== null ? (
        <Pill tone={pill.tone} testID={`vault-pill-${entry.entryId}`}>
          {pill.text}
        </Pill>
      ) : null}
    </Pressable>
  );
}

function VaultDetail({
  entry,
  busy,
  now,
  onCutOff,
  onAllow,
  onShow,
  showing,
  keyView,
  onBack,
}: {
  entry: VaultEntry;
  busy: boolean;
  now?: Date;
  onCutOff: (entryId: string, clientId?: string) => void;
  onAllow: (entryId: string, clientId: string) => void;
  onShow: () => void;
  /** Whether the key is open below, so the button closes it. */
  showing: boolean;
  /** The key's values, opened in place. */
  keyView: ReactNode;
  /** Narrow screens only: back to the list. */
  onBack?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const proxy = entry.proxy;
  const lastUsed = vaultLastUsedLine(entry, now);
  const refused = (proxy?.refused ?? []).filter((no) => !proxy?.clients.some((client) => client.id === no.id));
  return (
    <View style={styles.detail} testID={`vault-detail-${entry.entryId}`}>
      {onBack ? (
        <Pressable accessibilityRole="button" onPress={onBack} testID="vault-back" style={styles.back}>
          <Text variant="rowSub">‹ All keys</Text>
        </Pressable>
      ) : null}
      <View>
        <Text variant="paneTitle">{entry.name}</Text>
        <Text variant="rowSub">{vaultSavedLine(entry, now)}</Text>
      </View>
      {proxy !== null ? (
        <>
          <View style={styles.section}>
            <Text variant="eyebrow">Only ever sent to</Text>
            <View style={styles.site} testID="vault-site">
              <Text variant="rowTitle" style={styles.flex} numberOfLines={1}>
                {proxy.host}
              </Text>
              <Text variant="rowSub">{vaultPinLine(proxy)}</Text>
            </View>
          </View>
          <View style={styles.section}>
            <Text variant="eyebrow">AIs that can use it</Text>
            {proxy.clients.length === 0 && refused.length === 0 ? <Text variant="hint">{vaultNoClientsLine(proxy)}</Text> : null}
            {proxy.clients.map((client) => (
              <View key={client.id} style={styles.ai}>
                <AgentFace name={client.name ?? "AI"} size={26} />
                <View style={styles.flex}>
                  <Text variant="rowTitle">{client.name ?? "An AI"}</Text>
                  <Text variant="rowSub">{vaultClientLine(client, proxy.uses, now)}</Text>
                </View>
                <CutButton label="Cut off" disabled={busy} testID={`vault-cut-${client.id}`} onPress={() => onCutOff(entry.entryId, client.id)} />
              </View>
            ))}
            {refused.map((no) => (
              <View key={no.id} style={[styles.ai, styles.aiRefused]}>
                <View style={styles.dim}>
                  <AgentFace name={no.name ?? "AI"} size={26} />
                </View>
                <View style={styles.flex}>
                  <Text variant="rowTitle" style={styles.mutedText}>
                    {no.name ?? "An AI"}
                  </Text>
                  <Text variant="rowSub">{vaultRefusedLine(no, now)}</Text>
                </View>
                <Button label="Allow" variant="dialog" disabled={busy} testID={`vault-allow-${no.id}`} onPress={() => onAllow(entry.entryId, no.id)} />
              </View>
            ))}
          </View>
          <View style={styles.section}>
            <Text variant="eyebrow">Last used</Text>
            <Text variant="rowSub" style={styles.sentence} testID="vault-last-used">
              {lastUsed ?? "No AI has used it yet."}
            </Text>
          </View>
        </>
      ) : entry.type === "login" ? (
        <View style={styles.section}>
          <Text variant="eyebrow">Tex fills it on</Text>
          {entry.sites.length === 0 ? <Text variant="hint">No site yet.</Text> : null}
          {entry.sites.map((site) => (
            <View key={site} style={styles.site}>
              <Text variant="rowTitle">{site}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text variant="hint">Not given to AIs. You copy it yourself from Show the key.</Text>
      )}
      <View style={styles.actions}>
        {proxy !== null && proxy.clients.length > 0 ? (
          <CutButton
            label="Cut off every AI"
            disabled={busy}
            testID={`vault-cut-all-${entry.entryId}`}
            onPress={() => onCutOff(entry.entryId)}
          />
        ) : null}
        <Button
          label={showing ? "Hide the key" : "Show the key"}
          variant="dialog"
          disabled={busy && !showing}
          testID={`vault-show-${entry.entryId}`}
          onPress={onShow}
        />
      </View>
      {keyView}
    </View>
  );
}

/** The board's Cut off: red words in a red outline, quieter than a filled button beside each AI. */
function CutButton({ label, disabled, testID, onPress }: { label: string; disabled: boolean; testID: string; onPress: () => void }) {
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
    card: { padding: 0, overflow: "hidden" },
    frame: { gap: 14, padding: 18 },
    head: { flexDirection: "row", alignItems: "center", gap: 10 },
    split: { flexDirection: "row", alignItems: "stretch", gap: 0, marginHorizontal: -18, marginBottom: -18, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong },
    listSide: { flex: 1.5, gap: 10, padding: 18 },
    detailSide: { flex: 1, padding: 18, borderLeftWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong },
    filters: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 4 },
    chip: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: radii.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
    },
    chipOn: { backgroundColor: colors.text, borderColor: colors.text },
    chipText: { color: colors.text },
    chipOnText: { color: colors.surface, fontWeight: "700" },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: 12,
      borderRadius: radii.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
    },
    rowOn: { borderWidth: 2, borderColor: colors.accent, padding: 11, backgroundColor: colors.rowSelected },
    rowQuiet: { opacity: 0.75 },
    tile: {
      width: 36,
      height: 36,
      borderRadius: radii.md,
      backgroundColor: colors.chipFill,
      alignItems: "center",
      justifyContent: "center",
    },
    stack: { flexDirection: "row" },
    face: { borderRadius: 7, borderWidth: 2, borderColor: colors.surface },
    faceOverlap: { marginLeft: -6 },
    detail: { gap: 18 },
    back: { alignSelf: "flex-start", paddingVertical: 4 },
    section: { gap: 8 },
    site: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: radii.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
    },
    ai: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
    },
    aiRefused: {},
    dim: { opacity: 0.45 },
    mutedText: { color: colors.muted },
    sentence: { color: colors.text },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 6 },
    cut: {
      paddingVertical: 6,
      paddingHorizontal: 12,
      borderRadius: radii.md,
      borderWidth: 1,
      borderColor: colors.critBorder,
    },
    cutPressed: { backgroundColor: colors.critWash },
    cutDisabled: { opacity: 0.5 },
    cutText: { color: colors.critText, fontWeight: "600" },
    flex: { flex: 1 },
  });
