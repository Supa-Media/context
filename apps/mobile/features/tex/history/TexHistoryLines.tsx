import type { ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";
import { More, T } from "../page/TexPageParts";
import type { TexPageSource } from "../page/texPageSource";
import { HistoryDayLines } from "./HistoryDayLines";
import { HistoryFilters } from "./HistoryFilters";
import { useHistoryRead, type HistoryRead } from "./useHistoryRead";
import { useSeesTurnTiming } from "./useSeesTurnTiming";

/**
 * A chat's history, one line a message: time, who, words, left-aligned and
 * grouped by day and turn (decided by the owner, 2026-11-02, from the
 * artboard he approved: "go back to the ltr, 1 line slack style"). One row of
 * filters: which day, and Texts, Tool calls, Thinking and Background, thinking off
 * until asked for. A line opens to its entry exactly as kept. Read from the
 * gateway each time, a page at a time; nothing here keeps a copy.
 *
 * Drawn on the Tex page, newest day first. The history file
 * (`tex/history.ledger.json`, or a group home's) opened in the app reads the
 * same way, newest at the bottom (`HistoryFileLines`).
 */
export function TexHistoryLines({ source, chat, group, job }: { source: TexPageSource; chat: string; group: boolean; /** One job's work only: its page. */ job?: string }) {
  const history = useHistoryRead({ source, chat, group, job, timing: useSeesTurnTiming() });
  return (
    <View style={{ gap: 12 }} testID="tex-history-lines">
      <HistoryFilters history={history} />
      <HistoryState history={history}>{history.days.map((d) => <HistoryDayLines key={d.key} day={d} job={job} />)}</HistoryState>
      {history.hasOlder ? (
        <More onPress={() => void history.more()} testID="tex-history-more">
          {history.loadingMore ? "Reading…" : "Show older"}
        </More>
      ) : null}
    </View>
  );
}

/** The lines, or what stands where they would: nothing asked, reading, a failed read, an empty day. */
export function HistoryState({ history, children }: { history: HistoryRead; children: ReactNode }) {
  const { waiting, read, days } = history;
  if (waiting) return null;
  if (read === null) return <ActivityIndicator size="small" />;
  if (read.kind !== "ok")
    return (
      <T size={13} tone="muted" testID="tex-history-failed">
        The history can't be read right now. Try again in a moment.
      </T>
    );
  if (days.length === 0)
    return (
      <T size={13} tone="muted" testID="tex-history-empty">
        Nothing here for that day.
      </T>
    );
  return <>{children}</>;
}
