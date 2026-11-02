import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useThemedStyles, type Colors } from "../../design/theme";
import { useFieldFont } from "../../design/fieldFont";
import { texPageType } from "../../design/tokens";
import { ListBox, ListRow, More, pageStyles, SubPage, T, useNow } from "./TexPageParts";
import { TexSelect } from "./TexSelect";
import { clock } from "./texPageFormat";
import { DAY_FORM, entryLine, KIND_LABEL, SETTING_LABEL, settingValue } from "./texPageLedger";
import type { ViewProps } from "./TexPageBody";
import type { Read } from "./texPageSource";
import { LATEST, LEDGER_KINDS, type LedgerEntry, type LedgerKind, type LedgerPage, type LedgerSees } from "./texPageTypes";

/**
 * The chat's history file: its one ledger, everything said and done in the
 * chat, shown raw with filters, and "What Tex sees", the chat as the next
 * texted turn is shown it with the settings that shaped it (decided by the
 * owner, 2026-11-02; `docs/decisions/texting-assistant/chat-ledger.md`).
 * Newest first. Both are read from the gateway each time; nothing here keeps
 * a copy.
 */

const TABS = [
  { key: "raw", label: "Raw history" },
  { key: "sees", label: "What Tex sees" },
] as const;

const KIND_OPTIONS = [{ key: "all", label: "Everything" }, ...LEDGER_KINDS.map((k) => ({ key: k, label: KIND_LABEL[k] ?? k }))];

export function HistoryPage({ source, chat, group }: ViewProps) {
  const [tab, setTab] = useState<"raw" | "sees">("raw");
  return (
    <SubPage
      title="History"
      lead={group ? `Everything said and done in ${group}, as Tex keeps it.` : "Everything said and done in your chat with Tex, as Tex keeps it."}
      testID="tex-history"
    >
      <TexSelect
        options={TABS}
        selected={tab}
        onPick={(k) => setTab(k === "sees" ? "sees" : "raw")}
        label="Which view of the history"
        testID="tex-history-tab"
      />
      {tab === "raw" ? <RawHistory source={source} chat={chat} /> : <WhatTexSees source={source} chat={chat} />}
    </SubPage>
  );
}

function Quiet({ children, testID }: { children: string; testID?: string }) {
  return (
    <T size={13} tone="muted" testID={testID}>
      {children}
    </T>
  );
}

function RawHistory({ source, chat }: Pick<ViewProps, "source" | "chat">) {
  const styles = useThemedStyles(makeStyles);
  const page = useThemedStyles(pageStyles);
  const field = useFieldFont(texPageType.field);
  const now = useNow();
  const [kind, setKind] = useState<"all" | LedgerKind>("all");
  const [dayText, setDayText] = useState("");
  const [search, setSearch] = useState("");
  const [read, setRead] = useState<Read<LedgerPage> | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Only a whole day is sent; while one is being typed the last read stays.
  const dayAsked = DAY_FORM.test(dayText.trim()) ? dayText.trim() : "";
  const query = useMemo(() => ({ ...(kind !== "all" ? { kinds: [kind] } : {}), ...(dayAsked ? { day: dayAsked } : {}) }), [kind, dayAsked]);

  // A "Show more" still reading when the filter changes is dropped, never added to the new list.
  const asking = useRef(query);
  asking.current = query;

  useEffect(() => {
    let live = true;
    setRead(null);
    void source.ledger(chat, { ...query, before: LATEST }).then((r) => {
      if (!live) return;
      setRead(r);
      setEntries(r.kind === "ok" ? r.value.entries : []);
    });
    return () => {
      live = false;
    };
  }, [source, chat, query]);

  const older = read?.kind === "ok" ? read.value.older : undefined;
  const more = async () => {
    if (older === undefined || loadingMore) return;
    setLoadingMore(true);
    const r = await source.ledger(chat, { ...query, before: older });
    setLoadingMore(false);
    if (r.kind !== "ok" || asking.current !== query) return;
    setRead(r);
    setEntries((was) => [...was, ...r.value.entries]);
  };

  const needle = search.trim().toLowerCase();
  const shown = needle ? entries.filter((e) => JSON.stringify(e).toLowerCase().includes(needle)) : entries;
  const manifest = read?.kind === "ok" ? read.value.manifest : null;

  return (
    <View style={{ gap: 14 }}>
      <View style={styles.filters}>
        <TexSelect options={KIND_OPTIONS} selected={kind} onPick={(k) => setKind(k as "all" | LedgerKind)} label="Show which kind" testID="tex-history-kind" />
        <TextInput
          accessibilityLabel="Day, as YYYY-MM-DD"
          value={dayText}
          onChangeText={setDayText}
          placeholder="Day: YYYY-MM-DD"
          style={[page.input, styles.day, field]}
          testID="tex-history-day"
        />
        <TextInput
          accessibilityLabel="Search these entries"
          value={search}
          onChangeText={setSearch}
          placeholder="Search"
          style={[page.input, styles.search, field]}
          testID="tex-history-search"
        />
      </View>
      {manifest ? (
        <T size={12} mono tone="muted" testID="tex-history-manifest">
          {`${manifest.schema} v${manifest.version} · ${manifest.count.toLocaleString("en-US")} entries${manifest.created ? ` · since ${clock(manifest.created, new Date(now))}` : ""}`}
        </T>
      ) : null}
      {read === null ? (
        <ActivityIndicator size="small" />
      ) : read.kind !== "ok" ? (
        <Quiet testID="tex-history-failed">The history can't be read right now. Try again in a moment.</Quiet>
      ) : shown.length === 0 ? (
        <Quiet testID="tex-history-empty">{entries.length === 0 ? "Nothing kept here yet." : "Nothing here matches that search."}</Quiet>
      ) : (
        <ListBox>
          {shown.map((e) => (
            <View key={e.id}>
              <ListRow
                title={entryLine(e)}
                sub={`${clock(e.at, new Date(now))} · ${KIND_LABEL[e.kind] ?? e.kind}`}
                onPress={() => setOpen((was) => (was === e.id ? null : e.id))}
                testID={`tex-history-entry-${e.id}`}
              />
              {open === e.id ? (
                <ScrollView horizontal style={styles.raw} testID={`tex-history-raw-${e.id}`}>
                  <T size={12} mono line={1.45} tone="text2">
                    {JSON.stringify(e, null, 2)}
                  </T>
                </ScrollView>
              ) : null}
            </View>
          ))}
        </ListBox>
      )}
      {older !== undefined ? (
        <More onPress={() => void more()} testID="tex-history-more">
          {loadingMore ? "Reading…" : "Show older"}
        </More>
      ) : null}
    </View>
  );
}

function WhatTexSees({ source, chat }: Pick<ViewProps, "source" | "chat">) {
  const styles = useThemedStyles(makeStyles);
  const [read, setRead] = useState<Read<LedgerSees> | null>(null);
  const [reread, setReread] = useState(0);
  useEffect(() => {
    let live = true;
    setRead(null);
    void source.sees(chat).then((r) => {
      if (live) setRead(r);
    });
    return () => {
      live = false;
    };
  }, [source, chat, reread]);

  if (read === null) return <ActivityIndicator size="small" />;
  if (read.kind !== "ok") return <Quiet testID="tex-sees-failed">What Tex sees can't be read right now. Try again in a moment.</Quiet>;
  const { settings, text } = read.value;
  return (
    <View style={{ gap: 14 }} testID="tex-sees">
      <T size={14} tone="muted">
        This is the chat exactly as Tex is shown it on the next text, rebuilt from the history.
      </T>
      <ListBox>
        {Object.entries(settings).map(([k, v]) => (
          <ListRow key={k} title={SETTING_LABEL[k] ?? k} right={<T size={13} tone="text2">{settingValue(v)}</T>} testID={`tex-sees-setting-${k}`} />
        ))}
      </ListBox>
      <Pressable accessibilityRole="button" onPress={() => setReread((n) => n + 1)} testID="tex-sees-reread">
        <T size={13} tone="accent">
          Read it again
        </T>
      </Pressable>
      <ScrollView horizontal style={styles.raw}>
        <T size={12} mono line={1.45} tone="text2" testID="tex-sees-text">
          {text === "" ? "(Nothing yet: Tex sees an empty chat.)" : text}
        </T>
      </ScrollView>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    filters: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center", zIndex: 2 },
    day: { width: 150 },
    search: { flexGrow: 1, minWidth: 140 },
    raw: { backgroundColor: colors.surface2, borderRadius: 8, padding: 10, marginBottom: 8 },
  });
