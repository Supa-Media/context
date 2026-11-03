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
export function HistoryDayLines({ day, job, look = "page" }: { day: HistoryDay; job?: string; /** `file`: the history file's, as its approved artboard draws it; `phone` the same on a phone. */ look?: Look }) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <View testID={`tex-history-day-${day.key}`}>
      {look === "page" ? (
        <T size={15} weight="600" style={styles.dayTitle}>
          {day.title}
        </T>
      ) : (
        <View style={styles.dayRule}>
          <T size={look === "phone" ? 14 : 13} weight="600">
            {dayHeading(day)}
          </T>
          <View style={styles.rule} />
        </View>
      )}
      {day.turns.map((turn) => (
        <View key={turn.id} style={look === "page" ? styles.turn : styles.turnFile}>
          {turn.lines.map((line) => (
            <Line key={line.id} look={look} line={job !== undefined ? { ...line, job: undefined } : line} open={open === line.id} onPress={() => setOpen((was) => (was === line.id ? null : line.id))} />
          ))}
        </View>
      ))}
    </View>
  );
}

type Look = "page" | "file" | "phone";

/** `Today · Mon, Nov 2`: the day as the artboard heads it; a day already written out keeps its words. */
export function dayHeading(day: HistoryDay): string {
  if (day.title !== "Today" && day.title !== "Yesterday") return day.title;
  const [y, m, d] = day.key.split("-").map(Number);
  return `${day.title} · ${new Date(y!, m! - 1, d!).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`;
}

function Line({ line: given, open, onPress, look = "page" }: { line: HistoryLine; open: boolean; onPress: () => void; look?: Look }) {
  // The file's artboard names a turn's tool calls "Tools" where the page leaves the name blank.
  const line = look !== "page" && given.calls && !given.who ? { ...given, who: "Tools", tone: "quiet" as const } : given;
  const styles = useThemedStyles(makeStyles);
  const [openCall, setOpenCall] = useState<string | null>(null);
  const quiet = line.tone === "quiet" || line.tone === "thinking";
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${line.who || "Note"} ${line.time}: ${line.text}`}
        onPress={onPress}
        style={look === "phone" ? styles.stacked : styles.line}
        testID={`tex-history-entry-${line.id}`}
      >
        {look === "phone" ? (
          <View style={styles.whoTime}>
            <T size={13} weight="600" tone={whoTone(line, look)} numberOfLines={1}>
              {line.who}
            </T>
            <T size={13} tone="muted">
              {line.time}
            </T>
          </View>
        ) : (
          <>
            <T size={13} tone="muted" style={look === "file" ? styles.timeFile : styles.time}>
              {line.time}
            </T>
            <T size={look === "file" ? 13 : 14} weight="500" tone={whoTone(line, look)} style={look === "file" ? styles.whoFile : styles.who} numberOfLines={1}>
              {line.who}
            </T>
          </>
        )}
        <View style={look === "phone" ? styles.wordsStacked : styles.words}>
          {line.replyTo ? (
            <T size={13} tone="muted">
              {`↳ ${line.replyTo}`}
            </T>
          ) : null}
          <T size={quiet ? (look === "page" ? 13 : 14) : 15} line={1.45} tone={quiet ? "muted" : "text"} style={line.tone === "thinking" ? styles.thinking : null}>
            {line.job ? `${line.job} · ` : ""}
            {line.calls ? `${open ? "▾" : "▸"} ${line.text}` : line.text}
          </T>
          {line.reactions ? (
            <T size={12} tone="muted" style={look === "page" ? null : styles.pill} testID={`tex-history-reactions-${line.id}`}>
              {line.reactions}
            </T>
          ) : null}
        </View>
      </Pressable>
      {open && line.calls ? (
        <View testID={`tex-history-calls-${line.id}`}>
          {line.calls.map((call) => (
            <Line key={call.id} look={look} line={call} open={openCall === call.id} onPress={() => setOpenCall((was) => (was === call.id ? null : call.id))} />
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

/** Tex's name: the page's blue, or the artboard's warm ink in the file. */
function whoTone(line: HistoryLine, look: Look) {
  if (line.tone !== "tex") return line.tone === "quiet" ? ("muted" as const) : ("text" as const);
  return look === "page" ? ("accent" as const) : ("warn" as const);
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    dayTitle: { marginTop: 12, marginBottom: 4 },
    turn: { paddingTop: 6, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
    line: { flexDirection: "row", gap: 12, alignItems: "baseline", paddingVertical: 4 },
    time: { width: 64 },
    who: { width: 56 },
    words: { flex: 1, minWidth: 0, gap: 2 },
    wordsStacked: { gap: 2 },
    dayRule: { flexDirection: "row", alignItems: "center", gap: 12, paddingTop: 14, paddingBottom: 6 },
    rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
    turnFile: { paddingVertical: 2 },
    timeFile: { width: 72 },
    whoFile: { width: 128 },
    stacked: { paddingVertical: 7, gap: 2 },
    whoTime: { flexDirection: "row", gap: 8, alignItems: "baseline" },
    pill: { alignSelf: "flex-start", marginTop: 2, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: "hidden" },
    thinking: { fontStyle: "italic" },
    raw: { backgroundColor: colors.surface2, borderRadius: 8, padding: 10, marginBottom: 8 },
  });
