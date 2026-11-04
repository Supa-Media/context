import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useThemedStyles, type Colors } from "../../design/theme";
import { T } from "../page/TexPageParts";
import { jobCount, type HistoryDay, type HistoryLine } from "./historyLines";
import { TimingPill, TurnTiming, timingFor } from "./TurnTiming";

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
          {turn.lines.map((line) =>
            line.run ? (
              <JobLine key={line.id} line={line} look={look} />
            ) : (
            <Line key={line.id} look={look} line={job !== undefined ? { ...line, job: undefined } : line} open={open === line.id} onPress={() => setOpen((was) => (was === line.id ? null : line.id))} />
            ),
          )}
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

/**
 * A background job as one line, `Tex · Minion N`, its state and how much it
 * did beside it, and its work under it behind a rule, a failure in red; open
 * until the job is done (the Jobs artboard, approved by Dev on 2026-11-03).
 */
function JobLine({ line, look }: { line: HistoryLine; look: Look }) {
  const run = line.run!;
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(run.state !== "done");
  const [openStep, setOpenStep] = useState<string | null>(null);
  const stuck = run.state === "stuck";
  const head = (
    <View style={styles.jobHead}>
      <T size={look === "page" ? 14 : 15} weight="500">{`${open ? "▾" : "▸"} ${line.text}`}</T>
      {run.state ? (
        <T size={12} tone={stuck ? "crit" : "muted"} style={[styles.state, stuck ? styles.stateStuck : null]} testID={`tex-history-job-state-${run.key}`}>
          {run.state}
        </T>
      ) : null}
      <T size={13} tone="muted">
        {jobCount(run)}
      </T>
    </View>
  );
  return (
    <View testID={`tex-history-job-${run.key}`}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${line.who}: ${line.text}`} onPress={() => setOpen((was) => !was)} style={look === "phone" ? styles.stacked : styles.line} testID={`tex-history-entry-${line.id}`}>
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
            <T size={13} weight="500" tone={whoTone(line, look)} style={look === "file" ? styles.whoFile : styles.whoJob} numberOfLines={1}>
              {line.who}
            </T>
          </>
        )}
        <View style={look === "phone" ? styles.wordsStacked : styles.words}>{head}</View>
      </Pressable>
      {open ? (
        <View style={[styles.steps, look === "file" ? styles.stepsFile : look === "page" ? styles.stepsPage : null]} testID={`tex-history-job-steps-${run.key}`}>
          {run.steps.map((step) => (
            <Line key={step.id} look={look} step line={step} open={openStep === step.id} onPress={() => setOpenStep((was) => (was === step.id ? null : step.id))} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Line({ line: given, open, onPress, look = "page", step = false }: { line: HistoryLine; open: boolean; onPress: () => void; look?: Look; /** A job's step, under its line: the words alone, a failure in red. */ step?: boolean }) {
  // The file's artboard names a turn's tool calls "Tools" where the page leaves the name blank.
  const line = look !== "page" && given.calls && !given.who ? { ...given, who: "Tools", tone: "quiet" as const } : given;
  const styles = useThemedStyles(makeStyles);
  const [openCall, setOpenCall] = useState<string | null>(null);
  const quiet = line.tone === "quiet" || line.tone === "thinking";
  const failed = step && line.entry.kind === "tool" && line.entry.ok === false && line.calls === undefined;
  // Staff only: where this turn's time went, from its first text out (`turnTiming.ts`).
  const timing = useMemo(() => timingFor(line.timing), [line.timing]);
  const [timingOpen, setTimingOpen] = useState(false);
  const pill = timing === null ? null : <TimingPill view={timing} open={timingOpen} onPress={() => setTimingOpen((was) => !was)} id={line.id} />;
  return (
    <View>
      <View style={pill !== null ? (look === "phone" ? styles.withPillPhone : styles.withPill) : null}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${line.who || "Note"} ${line.time}: ${line.text}`}
        onPress={onPress}
        style={[step ? styles.stepLine : look === "phone" ? styles.stacked : styles.line, pill !== null ? styles.shrink : null]}
        testID={`tex-history-entry-${line.id}`}
      >
        {step ? null : look === "phone" ? (
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
        <View style={step || look === "phone" ? styles.wordsStacked : styles.words}>
          {line.replyTo ? (
            <T size={13} tone="muted">
              {`↳ ${line.replyTo}`}
            </T>
          ) : null}
          <T size={quiet ? (look === "page" ? 13 : 14) : 15} line={1.45} tone={failed ? "crit" : quiet ? "muted" : "text"} style={line.tone === "thinking" ? styles.thinking : null}>
            {failed ? "✕ " : ""}
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
      {pill !== null ? <View style={look === "phone" ? styles.pillPhone : styles.pillBeside}>{pill}</View> : null}
      </View>
      {timing !== null && timingOpen ? <TurnTiming view={timing} look={look} id={line.id} /> : null}
      {open && line.calls ? (
        <View testID={`tex-history-calls-${line.id}`}>
          {line.calls.map((call) => (
            <Line key={call.id} look={look} step={step} line={call} open={openCall === call.id} onPress={() => setOpenCall((was) => (was === call.id ? null : call.id))} />
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
    // The wait sits beside the line, never inside it: a button in a button is neither valid nor reachable.
    withPill: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
    withPillPhone: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
    shrink: { flexShrink: 1 },
    pillBeside: { paddingTop: 6 },
    pillPhone: { paddingTop: 7 },
    whoJob: { width: 104 },
    jobHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 10, rowGap: 2 },
    state: { paddingHorizontal: 8, paddingVertical: 1, borderRadius: 999, borderWidth: 1, borderColor: colors.muted, overflow: "hidden" },
    stateStuck: { borderColor: colors.crit },
    steps: { borderLeftWidth: 2, borderLeftColor: colors.line, paddingLeft: 14, marginBottom: 4 },
    // Under the words, past the time and who columns.
    stepsFile: { marginLeft: 72 + 12 + 128 + 12 },
    stepsPage: { marginLeft: 64 + 12 + 104 + 12 },
    stepLine: { paddingVertical: 3 },
    raw: { backgroundColor: colors.surface2, borderRadius: 8, padding: 10, marginBottom: 8 },
  });
