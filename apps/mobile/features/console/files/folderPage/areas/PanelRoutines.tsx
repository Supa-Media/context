/**
 * The area panel's Routines section, as the approved artboards draw it (Dev, 2026-11-27: "please build end to end").
 *
 * One row per note in `<area>/routines/<how often>/`: its name, the schedule in words (`areaRoutineWhen`), when it
 * runs next, and its last run's outcome from the workspace object's state (sent → answered / not answered yet, held,
 * not listed, no bot, failed), or the problem that stops it. Above the rows, the bot's share of its week spent here.
 * A row opens its editor in place (the panel edits everything inline: the owner, 2026-11-24); the job itself is the
 * note's text, so "Open the job" opens it. "Add routine" is the same editor, empty. An area with none offers "Turn
 * on pulse checks", which writes the templates `manage area { pulse: true }` writes (`areaRoutines.ts` `pulsePlan`).
 *
 * Built only from what the panel already uses: Text tree / treeMeta, Icon, Switch, the mode chips' shape, the
 * projects list's row and hover, "+ Attach a project"'s link, the attach list's box, and "Open area"'s button.
 */

import { useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { blankDraft, clockAt, type Draft, type Outcome, type RoutineBudget, type RoutineRow } from "./areaRoutines";
import { RoutineEditor } from "./RoutineEditor";

export interface PanelRoutinesTools {
  /** The area's folder and the Areas folder, for the editor's sentence. */
  readonly area: string;
  readonly root: string;
  readonly areaName: string;
  readonly routines: readonly RoutineRow[];
  /** The bot routines go to and its week here; null when no bot holds the area; undefined while the state loads. */
  readonly budget: RoutineBudget | null | undefined;
  /** What pulse checks would write for this area's modes, by title, for the empty state. */
  readonly pulse: readonly string[];
  readonly canEdit: boolean;
  readonly now: number;
  /** A routine's draft as its note is now. */
  readonly draftOf: (path: string) => Draft | null;
  /** Writes a new routine's note and opens it: null once written, or why not. Absent for a reader. */
  readonly create?: (draft: Draft) => Promise<string | null>;
  /** Writes one change to a routine (its front matter, or its folder): its path after, or why not. Absent for a reader. */
  readonly change?: (path: string, before: Draft, after: Draft) => Promise<{ path: string } | { problem: string }>;
  /** Turns on pulse checks: null once written, or why not. Absent for a reader. */
  readonly pulseOn?: () => Promise<string | null>;
  /** Opens a routine's note. */
  readonly open: (path: string) => void;
}

interface HoverState {
  readonly hovered?: boolean;
  readonly pressed: boolean;
}

export function PanelRoutines({ tools }: { tools: PanelRoutinesTools }) {
  const styles = useThemedStyles(makeStyles);
  // The routine being edited, and its draft as last written, for the moment after a move before the notes say so.
  // `opened` names one editing session, so a move (which changes the path) keeps the editor and its draft.
  const [editingAt, setEditingAt] = useState<{ path: string; draft: Draft | null; opened: number } | null>(null);
  const editing = editingAt?.path ?? null;
  // Where the routine is now, set the moment a move lands, before the next render: a queued change writes there.
  const livePath = useRef<string | null>(null);
  const setEditing = (path: string | null) => {
    livePath.current = path;
    setEditingAt(path === null ? null : { path, draft: null, opened: Date.now() });
  };
  const moved = (path: string, draft: Draft) => {
    livePath.current = path;
    setEditingAt((now) => (now === null ? null : { ...now, path, draft }));
  };
  const [adding, setAdding] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  // A second tap before the first render after it would write the pulse notes twice.
  const turning = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { routines, canEdit } = tools;
  const writes = canEdit && tools.change !== undefined;
  const botName = tools.budget?.bot ?? null;
  const editingRow = editing === null ? undefined : routines.find((routine) => routine.path === editing);
  const editingDraft = editing === null ? null : (tools.draftOf(editing) ?? editingAt?.draft ?? null);
  const turnOn = async () => {
    if (tools.pulseOn === undefined || turning.current) return;
    turning.current = true;
    setBusy(true);
    try {
      setProblem(await tools.pulseOn());
    } finally {
      turning.current = false;
      setBusy(false);
    }
  };
  const editor = (path: string, draft: Draft) => (
    <RoutineEditor
      key={`edit:${editingAt?.opened ?? path}`}
      area={tools.area}
      root={tools.root}
      draft={draft}
      path={path}
      onChange={async (before, after) => {
        if (tools.change === undefined) return null;
        const from = livePath.current ?? path;
        const done = await tools.change(from, before, after);
        if ("problem" in done) return done.problem;
        if (done.path !== from) moved(done.path, after);
        return null;
      }}
      onOpen={() => tools.open(path)}
      onDone={() => setEditing(null)}
    />
  );

  return (
    <View style={styles.list} testID="area-panel-routines">
      <BudgetLine tools={tools} />
      {routines.length === 0 && adding === null ? (
        <View style={styles.empty}>
          <Text variant="treeMeta" style={styles.muted}>
            {botName === null
              ? "No routines yet. A routine is a job Context sends this area's bot on a schedule."
              : `No routines yet. Context sends each one to ${botName} on time, and the answer comes back in Mail.`}
          </Text>
          {canEdit && tools.create !== undefined ? (
            <>
              <View style={styles.emptyActions}>
                {tools.pulseOn === undefined ? null : (
                  <Pressable hitSlop={8} role="button" onPress={() => void turnOn()} disabled={busy} style={[styles.primary, busy && styles.primaryOff]} testID="area-panel-pulse">
                    <Text variant="treeMeta" style={styles.primaryWord}>Turn on pulse checks</Text>
                  </Pressable>
                )}
                <Pressable hitSlop={8} role="button" onPress={() => setAdding(blankDraft())} style={styles.add} testID="area-panel-routine-add">
                  <Text variant="treeMeta" style={styles.addWord}>+ Add routine</Text>
                </Pressable>
              </View>
              {tools.pulseOn === undefined ? null : <Text variant="treeMeta" style={styles.muted}>{pulseLine(tools.pulse, tools.areaName)}</Text>}
            </>
          ) : null}
        </View>
      ) : null}
      {routines.map((routine) =>
        editing === routine.path && editingDraft !== null ? (
          editor(routine.path, editingDraft)
        ) : (
          <Row key={routine.path} routine={routine} tools={tools} onPress={writes ? () => setEditing(routine.path) : undefined} />
        ),
      )}
      {/* A routine just moved to another folder, before the notes say where it went. */}
      {editing !== null && editingRow === undefined && editingDraft !== null ? editor(editing, editingDraft) : null}
      {adding !== null && tools.create !== undefined ? (
        <RoutineEditor key="add" area={tools.area} root={tools.root} draft={adding} onCreate={tools.create} onDone={() => setAdding(null)} />
      ) : routines.length > 0 && canEdit && tools.create !== undefined ? (
        <Pressable hitSlop={8} role="button" onPress={() => setAdding(blankDraft())} style={styles.add} testID="area-panel-routine-add">
          <Text variant="treeMeta" style={styles.addWord}>+ Add routine</Text>
        </Pressable>
      ) : null}
      {problem === null ? null : <Text variant="treeMeta" role="alert" style={styles.crit}>{problem}</Text>}
    </View>
  );
}

/** "Adds Improve your metric and Manager loop, from Finance's modes. Each is a note you can change." */
export function pulseLine(pulse: readonly string[], area: string): string {
  if (pulse.length <= 1) return `Adds ${pulse[0] ?? "Improve your metric"}. It's a note you can change.`;
  const list = `${pulse.slice(0, -1).join(", ")} and ${pulse[pulse.length - 1]}`;
  return `Adds ${list}, from ${area}'s modes. Each is a note you can change.`;
}

/** The bot's week here: a line, and a hairline meter under it when the area has a cap. */
function BudgetLine({ tools }: { tools: PanelRoutinesTools }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { budget } = tools;
  if (tools.routines.length === 0) return null;
  if (budget === undefined) {
    return (
      <View style={styles.budget} testID="area-panel-routines-budget-loading">
        <View style={[styles.skeleton, { width: "62%" }]} />
        <View style={[styles.meter, styles.meterTrack]} />
      </View>
    );
  }
  if (budget === null) {
    return <Text variant="treeMeta" style={[styles.warn, styles.budget]} testID="area-panel-routines-budget">No bot holds this area, so its routines aren't sent. Pick a delegate under Owner.</Text>;
  }
  if (!budget.listed) {
    return <Text variant="treeMeta" style={styles.warn} testID="area-panel-routines-budget">{`${budget.bot}'s card doesn't list ${tools.areaName}, so nothing is sent here. Its person adds it on the card.`}</Text>;
  }
  // Nothing known of its week: no line rather than one that guesses.
  if (budget.used === null) return null;
  const spent = budget.cap !== null && budget.used >= budget.cap;
  const line =
    budget.cap === null
      ? `${budget.bot} · ${budget.used}% of its week here this week, no cap`
      : spent
        ? `${budget.bot} has spent its ${budget.cap}% here this week. Routines wait until Monday.`
        : `${budget.bot} · ${budget.used}% of its ${budget.cap}% here this week`;
  return (
    <View style={styles.budget} testID="area-panel-routines-budget">
      <Text variant="treeMeta" style={spent ? styles.warn : styles.muted}>{line}</Text>
      {budget.cap === null ? null : (
        <View style={[styles.meter, styles.meterTrack]} aria-hidden>
          <View style={[styles.meter, { width: `${Math.min(100, (budget.used / Math.max(1, budget.cap)) * 100)}%`, backgroundColor: spent ? colors.warn : colors.muted }]} />
        </View>
      )}
    </View>
  );
}

function Row({ routine, tools, onPress }: { routine: RoutineRow; tools: PanelRoutinesTools; onPress: (() => void) | undefined }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const glyph = routine.problem !== null ? { name: "info" as const, color: colors.crit } : routine.paused ? { name: "pause" as const, color: colors.muted } : { name: "clock" as const, color: colors.muted };
  const next = routine.next == null ? null : clockAt(routine.next, tools.now);
  const sub = `${routine.when}${routine.paused ? " · paused" : next === null ? "" : ` · next ${next}`}`;
  return (
    <Pressable
      onPress={onPress}
      disabled={onPress === undefined}
      role={onPress === undefined ? undefined : "button"}
      accessibilityLabel={rowLabel(routine, next, tools.budget?.bot ?? null, tools.now)}
      style={({ hovered }: HoverState) => [styles.row, hovered && onPress !== undefined && styles.hover]}
      testID={`area-panel-routine-${routine.path}`}
    >
      <View style={styles.glyph}>
        <Icon name={glyph.name} size={14} color={glyph.color} />
      </View>
      <View style={styles.rowText}>
        <View style={styles.rowHead}>
          <Text variant="tree" style={[styles.name, routine.paused && styles.muted]} numberOfLines={1}>{routine.title}</Text>
          {routine.mode === null ? null : <Text variant="treeMeta" style={styles.muted} numberOfLines={1}>{routine.mode}</Text>}
        </View>
        {routine.problem !== null ? (
          <Text variant="treeMeta" style={styles.crit}>{`Won't run: ${routine.problem}`}</Text>
        ) : (
          <Text variant="treeMeta" style={styles.muted} numberOfLines={1}>{sub}</Text>
        )}
        {routine.problem !== null || routine.last === null ? null : routine.last === undefined ? (
          <View style={[styles.skeleton, styles.lastSkeleton]} />
        ) : (
          <Last last={routine.last} bot={tools.budget?.bot ?? null} now={tools.now} />
        )}
      </View>
    </Pressable>
  );
}

/** What a screen reader says for a row: everything the row shows, in the order it shows it. */
function rowLabel(routine: RoutineRow, next: string | null, bot: string | null, now: number): string {
  const parts = [routine.title];
  if (routine.mode !== null) parts.push(`for the ${routine.mode}`);
  if (routine.problem !== null) return [...parts, `won't run: ${routine.problem}`].join(", ");
  parts.push(routine.when || "no schedule");
  if (routine.paused) parts.push("paused");
  else if (next !== null) parts.push(`next ${next}`);
  if (routine.last) {
    const [word, rest] = lastWords(routine.last, bot, now);
    parts.push(`last run: ${word}${rest ? `, ${rest}` : ""}`);
  }
  return parts.join(", ");
}

/** A last run as words: the outcome and what follows it. */
function lastWords(last: NonNullable<RoutineRow["last"]>, bot: string | null, now: number): [string, string, "ok" | "muted" | "warn" | "crit"] {
  if (last.at === null || last.outcome === null) return ["Hasn't run yet", "", "muted"];
  const at = clockAt(last.at, now);
  const said: Record<Outcome, [string, string, "ok" | "muted" | "warn" | "crit"]> = {
    sent: last.answeredAt !== null ? ["Answered", clockAt(last.answeredAt, now), "ok"] : ["Not answered yet", `sent ${at}`, "muted"],
    held: ["Held", `${at}, sends again Monday`, "warn"],
    not_listed: ["Not sent", at, "warn"],
    no_bot: ["Not sent", "no bot holds this area", "warn"],
    failed: [`Didn't reach ${bot ?? "the bot"}`, at, "crit"],
  };
  return said[last.outcome];
}

/** The last run, its outcome first and in its tone, then when. The word carries the meaning, never the colour alone. */
function Last({ last, bot, now }: { last: NonNullable<RoutineRow["last"]>; bot: string | null; now: number }) {
  const styles = useThemedStyles(makeStyles);
  if (last.at === null || last.outcome === null) return <Text variant="treeMeta" style={styles.muted}>Hasn't run yet</Text>;
  const [word, rest, tone] = lastWords(last, bot, now);
  const ink = tone === "ok" ? styles.ok : tone === "warn" ? styles.warn : tone === "crit" ? styles.crit : styles.muted;
  return (
    <Text variant="treeMeta" style={styles.muted} numberOfLines={2}>
      <Text variant="treeMeta" style={[ink, styles.strong]}>{word}</Text>
      {` · ${rest}`}
    </Text>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    list: { gap: 2 },
    muted: { color: colors.muted },
    ok: { color: colors.okText },
    warn: { color: colors.warnText },
    crit: { color: colors.critText },
    strong: { fontWeight: "600" },
    empty: { gap: space.x2 },
    emptyActions: { flexDirection: "row", alignItems: "center", gap: space.x3, flexWrap: "wrap" },
    // "Open area"'s button.
    primary: { alignSelf: "flex-start", paddingVertical: space.x1, paddingHorizontal: space.x3, borderRadius: radii.sm, backgroundColor: colors.text },
    primaryOff: { opacity: 0.4 },
    primaryWord: { color: colors.surface, fontWeight: "600" },
    // "+ Attach a project".
    add: { alignSelf: "flex-start", paddingVertical: space.x1 },
    addWord: { color: colors.accentText, fontWeight: "600" },
    budget: { gap: 6, paddingBottom: space.x2 },
    meter: { height: 3, borderRadius: 2 },
    meterTrack: { backgroundColor: colors.line, overflow: "hidden" },
    skeleton: { height: 10, borderRadius: 3, backgroundColor: colors.chipFill },
    lastSkeleton: { width: "48%", marginTop: 4 },
    // The projects list's row, three lines tall.
    row: { flexDirection: "row", alignItems: "flex-start", gap: space.x2, paddingVertical: 6, paddingHorizontal: space.x1, marginHorizontal: -space.x1, borderRadius: radii.sm },
    hover: { backgroundColor: colors.chipFill },
    glyph: { width: 16, alignItems: "center", paddingTop: 3 },
    rowText: { flexGrow: 1, flexShrink: 1, minWidth: 0, gap: 1 },
    rowHead: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    name: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  });
