import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useThemedStyles, type Colors } from "../../design/theme";
import { T } from "../page/TexPageParts";
import type { HistoryDay, HistoryLine } from "./historyLines";

/**
 * One day of a chat's history, its turns one line a message: time, who,
 * words. A line opens to its entry exactly as kept; a turn's tool calls open
 * to the calls.
 */
export function HistoryDayLines({ day, job }: { day: HistoryDay; job?: string }) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <View testID={`tex-history-day-${day.key}`}>
      <T size={15} weight="600" style={styles.dayTitle}>
        {day.title}
      </T>
      {day.turns.map((turn) => (
        <View key={turn.id} style={styles.turn}>
          {turn.lines.map((line) => (
            <Line key={line.id} line={job !== undefined ? { ...line, job: undefined } : line} open={open === line.id} onPress={() => setOpen((was) => (was === line.id ? null : line.id))} />
          ))}
        </View>
      ))}
    </View>
  );
}

function Line({ line, open, onPress }: { line: HistoryLine; open: boolean; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const [openCall, setOpenCall] = useState<string | null>(null);
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
            {line.job ? `${line.job} · ` : ""}
            {line.calls ? `${open ? "▾" : "▸"} ${line.text}` : line.text}
          </T>
          {line.reactions ? (
            <T size={13} tone="muted" testID={`tex-history-reactions-${line.id}`}>
              {line.reactions}
            </T>
          ) : null}
        </View>
      </Pressable>
      {open && line.calls ? (
        <View testID={`tex-history-calls-${line.id}`}>
          {line.calls.map((call) => (
            <Line key={call.id} line={call} open={openCall === call.id} onPress={() => setOpenCall((was) => (was === call.id ? null : call.id))} />
          ))}
        </View>
      ) : open ? (
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
    dayTitle: { marginTop: 12, marginBottom: 4 },
    turn: { paddingTop: 6, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
    line: { flexDirection: "row", gap: 12, alignItems: "baseline", paddingVertical: 4 },
    time: { width: 64 },
    who: { width: 56 },
    words: { flex: 1, minWidth: 0, gap: 2 },
    thinking: { fontStyle: "italic" },
    raw: { backgroundColor: colors.surface2, borderRadius: 8, padding: 10, marginBottom: 8 },
  });
