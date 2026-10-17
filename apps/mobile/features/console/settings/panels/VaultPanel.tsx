/**
 * Settings › Vault, drawn as vault board 2: the keys this person may use in
 * the open workspace as a list of cards, each with its one website, the AIs
 * that use it and when one last did, and beside the list the picked key's
 * detail: the website in a box, every AI with Cut off (or Allow for one the
 * person said no to), and the last use in a sentence. On a narrow screen the
 * detail takes the list's place, with a way back.
 *
 * Values never reach the list. Picking a key, and New key, make a fresh vault
 * link and open it in place (`VaultInline`), through the same calls as the
 * vault's own page (`/vault/<token>`): the picked key's username shows, its
 * password and values are dots until Show. Edit, beside its name as on the
 * board, turns the pane into one form for the whole key (name, the website
 * and how it is sent, the values) and holds Delete. Each opening is a
 * recorded reveal, each save a logged change, and the values go when another
 * key is picked or the page closes.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
  mayManage,
  whoseAI,
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
  type VaultLevel,
} from "../../../vault/vaultSettings";
import type { VaultShareChoices } from "../../../vault/vaultPeople";
import type { VaultLinkCalls } from "../../../vault/useVaultLinkFlow";
import { PanelHead } from "./PanelHead";
import { VaultInline } from "./VaultInline";
import { CutButton, VaultPeople } from "./VaultPeople";

export type VaultActions = {
  list: () => Promise<VaultEntry[]>;
  /** `by`: whose AI, for somebody who manages the key; without it, the reader's own (or all, for a manager). */
  cutOff: (entryId: string, clientId?: string, by?: string) => Promise<VaultEntry>;
  allow: (entryId: string, clientId: string) => Promise<VaultEntry>;
  /** A fresh vault link's token, opened in place through `calls`. */
  link: (kind: "add" | "view", entryId?: string) => Promise<string>;
  calls: VaultLinkCalls;
  /** Who a key can be given to here. */
  choices?: () => Promise<VaultShareChoices | null>;
  give?: (entryId: string, to: string, level: VaultLevel) => Promise<VaultEntry>;
  /** Take a key back; null when the reader handed it back and no longer has it. */
  takeBack?: (entryId: string, to: string) => Promise<VaultEntry | null>;
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
    cutOff: (entryId, clientId, by) =>
      client.action(api.functions.vaultSettings.cutOffVaultAI, {
        workspaceId: id,
        entryId,
        ...(clientId === undefined ? {} : { clientId }),
        ...(by === undefined ? {} : { by }),
      }),
    // Async, so a client without queries (the demo, render tests) rejects into the catch rather than throwing.
    choices: async () => client.query(api.functions.vaultPeople.vaultShareChoices, { workspaceId: id }),
    give: (entryId, to, level) => client.action(api.functions.vaultSettings.giveVaultKey, { workspaceId: id, entryId, to, level }),
    takeBack: (entryId, to) => client.action(api.functions.vaultSettings.takeBackVaultKey, { workspaceId: id, entryId, to }),
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
      edit: (token, edit) => client.action(api.functions.vaultSettings.editVaultEntry, { token, ...edit }),
      remove: (token) => client.action(api.functions.vaultSettings.deleteVaultEntry, { token }),
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
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [width, setWidth] = useState(layoutWidth ?? 0);
  const [choices, setChoices] = useState<VaultShareChoices | null>(null);
  const { list } = actions;
  const wide = width >= SIDE_BY_SIDE;

  useEffect(() => {
    let live = true;
    list().then(
      (next) => live && setEntries(next),
      (error: unknown) => live && setProblem(errorMessageOf(error) ?? "Your keys couldn't be read. Try again."),
    );
    // Who a key can be given to is only needed to give one; a failure leaves Give out.
    actions.choices?.().then(
      (next) => live && setChoices(next),
      () => undefined,
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
    setEditing(false);
    setNotice(null);
    setPickedState(entryId);
  };
  // After a save: read the list again, the key staying picked and open.
  const changed = () =>
    void run(async () => {
      setEntries(await actions.list());
    });
  const deleted = (name: string) =>
    void run(async () => {
      setPicked(null);
      setEntries(await actions.list());
      setNotice(`Deleted “${name}”. No AI can use it now.`);
    });
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
  const cutOff = (entryId: string, clientId?: string, by?: string) => void run(async () => replace(await actions.cutOff(entryId, clientId, by)));
  const give = async (entryId: string, to: string, level: VaultLevel) => {
    let done = false;
    await run(async () => {
      if (actions.give === undefined) return;
      replace(await actions.give(entryId, to, level));
      done = true;
    });
    return done;
  };
  const takeBack = (entryId: string, to: string) =>
    void run(async () => {
      if (actions.takeBack === undefined) return;
      const next = await actions.takeBack(entryId, to);
      if (next !== null) return replace(next);
      // Handed back: it is no longer the reader's to list.
      setPicked(null);
      setEntries((now) => (now ?? []).filter((entry) => entry.entryId !== entryId));
      setNotice("Handed back. Your AIs can't use it now.");
    });
  const allow = (entryId: string, clientId: string) => void run(async () => replace(await actions.allow(entryId, clientId)));

  const shownEntries = (entries ?? []).filter((entry) => inFilter(entry, filter, now));
  // Side by side, a key is always picked, as on the board; narrow, the list comes first.
  const chosen =
    shownEntries.find((entry) => entry.entryId === picked) ?? (wide && picked === null ? shownEntries[0] ?? null : null);
  // A picked key opens its values at once (username shown, password as dots
  // until Show), once per pick: a failure is said, not retried in a loop.
  const autoOpened = useRef<string | null>(null);
  // A key given for AIs only has nothing to show its reader: no link is made.
  const chosenId = chosen !== null && chosen.level !== "use" ? chosen.entryId : null;
  const addingNow = opened?.what.mode === "add";
  useEffect(() => {
    if (chosenId === null || addingNow) {
      autoOpened.current = null;
      return;
    }
    if (autoOpened.current === chosenId) return;
    autoOpened.current = chosenId;
    open({ mode: "view", entryId: chosenId });
    // `open` is rebuilt each render; the pick is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenId, addingNow, opened === null]);
  // Handing back names the reader, whose id only the share choices carry.
  const me = choices?.people.find((person) => person.isMe)?.userId ?? null;
  const handBack = chosen?.givenToYou && actions.takeBack !== undefined ? me : null;
  const detail =
    chosen === null ? null : (
      <VaultDetail
        entry={chosen}
        busy={busy}
        now={now}
        onCutOff={cutOff}
        onAllow={allow}
        people={
          mayManage(chosen) && actions.give !== undefined ? (
            <VaultPeople
              entry={chosen}
              choices={choices}
              busy={busy}
              now={now}
              onGive={(to, level) => give(chosen.entryId, to, level)}
              onTakeBack={(to) => takeBack(chosen.entryId, to)}
              onCutOff={(clientId, by) => cutOff(chosen.entryId, clientId, by)}
            />
          ) : null
        }
        onHandBack={handBack === null ? undefined : () => takeBack(chosen.entryId, handBack)}
        editing={editing}
        onEdit={() => setEditing(true)}
        keyView={
          opened?.what.mode === "view" && opened.what.entryId === chosen.entryId ? (
            <VaultInline
              key={opened.n}
              mode="view"
              token={opened.token}
              calls={actions.calls}
              onClose={() => setOpened(null)}
              onSaved={() => undefined}
              entry={chosen}
              editing={editing}
              onEditing={setEditing}
              onChanged={changed}
              onDeleted={deleted}
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
        {notice !== null ? (
          <Text variant="rowSub" testID="vault-notice">
            {notice}
          </Text>
        ) : null}
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
                      onPress={() => setFilter(option.key)}
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
  editing,
  onEdit,
  keyView,
  people,
  onHandBack,
  onBack,
}: {
  entry: VaultEntry;
  busy: boolean;
  now?: Date;
  onCutOff: (entryId: string, clientId?: string, by?: string) => void;
  onAllow: (entryId: string, clientId: string) => void;
  /** Edit is open: the pane is the key's form, and nothing else. */
  editing: boolean;
  onEdit: () => void;
  /** The key's values, opened in place and editable. */
  keyView: ReactNode;
  /** The People section, for somebody who may manage the key. */
  people: ReactNode;
  /** Hand back a key given to the reader by name. */
  onHandBack?: () => void;
  /** Narrow screens only: back to the list. */
  onBack?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [handingBack, setHandingBack] = useState(false);
  const proxy = entry.proxy;
  const manage = mayManage(entry);
  const lastUsed = vaultLastUsedLine(entry, now);
  const refused = (proxy?.refused ?? []).filter((no) => !proxy?.clients.some((client) => client.id === no.id));
  // The values keep one place among these children, so opening Edit never
  // re-opens the key (another reveal) or loses what was typed.
  const values = (
    <View key="values" style={styles.section}>
      {keyView}
    </View>
  );
  return (
    <View style={styles.detail} testID={`vault-detail-${entry.entryId}`}>
      {onBack ? (
        <Pressable key="back" accessibilityRole="button" onPress={onBack} testID="vault-back" style={styles.back}>
          <Text variant="rowSub">‹ All keys</Text>
        </Pressable>
      ) : null}
      <View key="head" style={styles.titleRow}>
        <View style={styles.flex}>
          <Text variant="paneTitle" numberOfLines={2}>
            {editing ? `Edit ${entry.name}` : entry.name}
          </Text>
          <Text variant="rowSub">{vaultSavedLine(entry, now)}</Text>
        </View>
        {editing || !manage ? null : <Button label="Edit" variant="dialog" disabled={busy} onPress={onEdit} testID="vault-edit" />}
      </View>
      {editing ? null : proxy !== null ? (
        <View key="site" style={styles.section}>
          <Text variant="eyebrow">Only ever sent to</Text>
          <View style={styles.site} testID="vault-site">
            <Text variant="rowTitle" style={styles.flex} numberOfLines={1}>
              {proxy.host}
            </Text>
            <Text variant="rowSub" numberOfLines={1}>
              {vaultPinLine(proxy)}
            </Text>
          </View>
        </View>
      ) : entry.type === "login" ? (
        <View key="site" style={styles.section}>
          <Text variant="eyebrow">Tex fills it on</Text>
          {entry.sites.length === 0 ? <Text variant="hint">No site yet.</Text> : null}
          {entry.sites.map((site) => (
            <View key={site} style={styles.site}>
              <Text variant="rowTitle">{site}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text key="site" variant="hint">
          Not given to AIs. You copy it yourself from here.
        </Text>
      )}
      {entry.level === "use" && !editing ? (
        <Text key="use-only" variant="hint" testID="vault-use-only">
          Your AIs can use it through Context. You can't see the value; ask {entry.givenBy ?? "whoever saved it"} if you need to.
        </Text>
      ) : null}
      {values}
      {editing || people === null ? null : <View key="people">{people}</View>}
      {editing || proxy === null || (people !== null && refused.length === 0) ? null : (
        <View key="ais" style={styles.section}>
          <Text variant="eyebrow">{people !== null ? "AIs told no" : "AIs that can use it"}</Text>
          {people === null && proxy.clients.length === 0 && refused.length === 0 ? <Text variant="hint">{vaultNoClientsLine(proxy)}</Text> : null}
          {(people !== null ? [] : proxy.clients).map((client) => (
            <View key={`${client.by ?? ""}-${client.id}`} style={styles.ai}>
              <AgentFace name={client.name ?? "AI"} size={26} />
              <View style={styles.flex}>
                <Text variant="rowTitle">{client.name ?? "An AI"}</Text>
                <Text variant="rowSub">{vaultClientLine(client, proxy.uses, now)}</Text>
              </View>
              <CutButton label="Cut off" disabled={busy} testID={`vault-cut-${client.id}`} onPress={() => onCutOff(entry.entryId, client.id)} />
            </View>
          ))}
          {refused.map((no) => (
            <View key={`${no.by ?? ""}-${no.id}`} style={styles.ai}>
              <View style={styles.dim}>
                <AgentFace name={no.name ?? "AI"} size={26} />
              </View>
              <View style={styles.flex}>
                <Text variant="rowTitle" style={styles.mutedText}>
                  {whoseAI(no)}
                </Text>
                <Text variant="rowSub">{vaultRefusedLine(no, now)}</Text>
              </View>
              {no.mine === false ? null : (
                <Button label="Allow" variant="dialog" disabled={busy} testID={`vault-allow-${no.id}`} onPress={() => onAllow(entry.entryId, no.id)} />
              )}
            </View>
          ))}
        </View>
      )}
      {editing || proxy === null ? null : (
        <View key="last" style={styles.section}>
          <Text variant="eyebrow">Last used</Text>
          <Text variant="rowSub" style={styles.sentence} testID="vault-last-used">
            {lastUsed ?? "No AI has used it yet."}
          </Text>
        </View>
      )}
      {!editing && proxy !== null && proxy.clients.length > 0 ? (
        <View key="cut" style={styles.actions}>
          <CutButton
            label={manage ? "Cut off every AI" : "Cut off all your AIs"}
            disabled={busy}
            testID={`vault-cut-all-${entry.entryId}`}
            onPress={() => onCutOff(entry.entryId)}
          />
        </View>
      ) : null}
      {editing || onHandBack === undefined ? null : handingBack ? (
        <View key="hand-back" style={styles.section}>
          <Text variant="rowTitle" style={styles.oneWay}>
            You and your AIs lose the key now. Only {entry.givenBy ?? "whoever saved it"} can give it to you again.
          </Text>
          <View style={styles.actions}>
            <Button label="Give it back" variant="dialogDanger" disabled={busy} testID="vault-hand-back-yes" onPress={onHandBack} />
            <Button label="Keep" variant="dialog" disabled={busy} onPress={() => setHandingBack(false)} />
          </View>
        </View>
      ) : (
        <View key="hand-back" style={styles.actions}>
          <CutButton label="Give it back" disabled={busy} testID="vault-hand-back" onPress={() => setHandingBack(true)} />
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: { padding: 0, overflow: "hidden" },
    frame: { gap: 14, padding: 18 },
    head: { flexDirection: "row", alignItems: "center", gap: 10 },
    split: { flexDirection: "row", alignItems: "stretch", gap: 0, marginHorizontal: -18, marginBottom: -18, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong },
    listSide: { flex: 1, gap: 10, padding: 18 },
    detailSide: { flex: 1.15, padding: 20, borderLeftWidth: StyleSheet.hairlineWidth, borderColor: colors.lineStrong },
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
    titleRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
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
    dim: { opacity: 0.45 },
    mutedText: { color: colors.muted },
    sentence: { color: colors.text },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 6 },
    oneWay: { color: colors.critText, fontWeight: "700" },
    flex: { flex: 1 },
  });
