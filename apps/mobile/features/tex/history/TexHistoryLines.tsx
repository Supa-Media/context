import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useThemedStyles, type Colors } from "../../design/theme";
import { useFieldFont } from "../../design/fieldFont";
import { texPageType } from "../../design/tokens";
import { More, pageStyles, T, useNow } from "../page/TexPageParts";
import { TexSelect } from "../page/TexSelect";
import { DAY_LABEL, DEFAULT_SHOWN, dayAsked, historyDays, kindsFor, SHOW_LABEL, SHOWS, type DayChoice, type HistoryLine, type Show } from "./historyLines";
import type { Read, TexPageSource } from "../page/texPageSource";
import { LATEST, type LedgerEntry, type LedgerPage } from "../page/texPageTypes";

/**
 * A chat's history, one line a message: time, who, words, left-aligned and
 * grouped by day and turn (decided by the owner, 2026-11-02, from the
 * artboard he approved: "go back to the ltr, 1 line slack style"). One row of
 * filters: which day, and Texts, Tool calls, Thinking and Notes, thinking off
 * until asked for. A line opens to its entry exactly as kept. Read from the
 * gateway each time, a page at a time; nothing here keeps a copy.
 *
 * Drawn on the Tex page and when the history file
 * (`tex/history.ledger.json`, or a group home's) is opened in the app.
 */

const DAY_OPTIONS = (["today", "yesterday", "all", "pick"] as const).map((key) => ({ key, label: DAY_LABEL[key] }));

export function TexHistoryLines({ source, chat, group }: { source: TexPageSource; chat: string; group: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const page = useThemedStyles(pageStyles);
  const field = useFieldFont(texPageType.field);
  const [day, setDay] = useState<DayChoice>("today");
  const [picked, setPicked] = useState("");
  const [shown, setShown] = useState<Record<Show, boolean>>(DEFAULT_SHOWN);
  const [read, setRead] = useState<Read<LedgerPage> | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const now = new Date(useNow());
  const asked = dayAsked(day, picked, now);
  const kinds = kindsFor(shown);
  const kindsKey = kinds.join(",");
  // Nothing is asked while a day is still being typed, or with every kind off.
  const waiting = (day === "pick" && asked === undefined) || kinds.length === 0;
  const query = useMemo(() => ({ kinds: kindsKey.split(",").filter(Boolean) as typeof kinds, ...(asked ? { day: asked } : {}) }), [kindsKey, asked]);

  // A "Show older" still reading when a filter changes is dropped, never added to the new list.
  const asking = useRef(query);
  asking.current = query;

  useEffect(() => {
    let live = true;
    setRead(null);
    setEntries([]);
    if (waiting) return;
    void source.ledger(chat, { ...query, before: LATEST }).then((r) => {
      if (!live) return;
      setRead(r);
      setEntries(r.kind === "ok" ? r.value.entries : []);
    });
    return () => {
      live = false;
    };
  }, [source, chat, query, waiting]);

  const older = read?.kind === "ok" ? read.value.older : undefined;
  const more = async () => {
    if (older === undefined || loadingMore) return;
    setLoadingMore(true);
    const asked = query;
    const r = await source.ledger(chat, { ...query, before: older });
    setLoadingMore(false);
    if (r.kind !== "ok" || asking.current !== asked) return;
    setRead(r);
    setEntries((was) => [...was, ...r.value.entries]);
  };

  const days = historyDays(entries, now, { group });

  return (
    <View style={{ gap: 12 }} testID="tex-history-lines">
      <View style={styles.filters}>
        <TexSelect
          options={DAY_OPTIONS}
          selected={day}
          onPick={(k) => setDay(k as DayChoice)}
          label="Which day"
          look="pick"
          testID="tex-history-day-choice"
        />
        {SHOWS.map((s) => (
          <Pressable
            key={s}
            accessibilityRole="button"
            accessibilityState={{ selected: shown[s] }}
            onPress={() => setShown((was) => ({ ...was, [s]: !was[s] }))}
            style={styles.toggle}
            testID={`tex-history-show-${s}`}
          >
            <T size={14} weight={shown[s] ? "600" : "400"} tone={shown[s] ? "text" : "muted"} style={shown[s] ? null : styles.off}>
              {SHOW_LABEL[s]}
            </T>
          </Pressable>
        ))}
      </View>
      {day === "pick" ? (
        <TextInput
          accessibilityLabel="Day, as YYYY-MM-DD"
          value={picked}
          onChangeText={setPicked}
          placeholder="YYYY-MM-DD"
          style={[page.input, styles.day, field]}
          testID="tex-history-day"
        />
      ) : null}
      {waiting ? null : read === null ? (
        <ActivityIndicator size="small" />
      ) : read.kind !== "ok" ? (
        <T size={13} tone="muted" testID="tex-history-failed">
          The history can't be read right now. Try again in a moment.
        </T>
      ) : days.length === 0 ? (
        <T size={13} tone="muted" testID="tex-history-empty">
          Nothing here for that day.
        </T>
      ) : (
        days.map((d) => (
          <View key={d.key} testID={`tex-history-day-${d.key}`}>
            <T size={15} weight="600" style={styles.dayTitle}>
              {d.title}
            </T>
            {d.turns.map((turn) => (
              <View key={turn.id} style={styles.turn}>
                {turn.lines.map((line) => (
                  <Line key={line.id} line={line} open={open === line.id} onPress={() => setOpen((was) => (was === line.id ? null : line.id))} />
                ))}
              </View>
            ))}
          </View>
        ))
      )}
      {older !== undefined && !waiting ? (
        <More onPress={() => void more()} testID="tex-history-more">
          {loadingMore ? "Reading…" : "Show older"}
        </More>
      ) : null}
    </View>
  );
}

function Line({ line, open, onPress }: { line: HistoryLine; open: boolean; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const quiet = line.tone === "quiet" || line.tone === "thinking";
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityLabel={`${line.who || "Note"} ${line.time}: ${line.text}`} onPress={onPress} style={styles.line} testID={`tex-history-entry-${line.id}`}>
        <T size={13} tone="muted" style={styles.time}>
          {line.time}
        </T>
        <T size={14} weight="500" tone={line.tone === "tex" ? "accent" : "text"} style={styles.who} numberOfLines={1}>
          {line.who}
        </T>
        <View style={styles.words}>
          {line.replyTo ? (
            <T size={13} tone="muted">
              {`↳ ${line.replyTo}`}
            </T>
          ) : null}
          <T size={quiet ? 13 : 15} line={1.5} tone={quiet ? "muted" : "text"} style={line.tone === "thinking" ? styles.thinking : null}>
            {line.text}
          </T>
        </View>
      </Pressable>
      {open ? (
        <ScrollView horizontal style={styles.raw} testID={`tex-history-raw-${line.id}`}>
          <T size={12} mono line={1.45} tone="text2">
            {JSON.stringify(line.entry, null, 2)}
          </T>
        </ScrollView>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    filters: { flexDirection: "row", flexWrap: "nowrap", gap: 6, alignItems: "center", zIndex: 2 },
    toggle: { paddingVertical: 10, paddingHorizontal: 6 },
    off: { textDecorationLine: "line-through" },
    day: { width: 150 },
    dayTitle: { marginTop: 12, marginBottom: 4 },
    turn: { paddingTop: 6, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
    line: { flexDirection: "row", gap: 12, alignItems: "baseline", paddingVertical: 4 },
    time: { width: 64 },
    who: { width: 56 },
    words: { flex: 1, minWidth: 0, gap: 2 },
    thinking: { fontStyle: "italic" },
    raw: { backgroundColor: colors.surface2, borderRadius: 8, padding: 10, marginBottom: 8 },
  });
