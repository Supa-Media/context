import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Text } from "../../design/components/Text";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { layout, radii, space } from "../../design/tokens";
import { useRoutineHost } from "./RoutineHost";
import { pauseEdit, routineBarView, type RoutineBarView } from "./model";

/**
 * Changes the whole note through the editor's own change path, so a pause
 * saves, merges into a collaborator's typing and undoes exactly like typing.
 * Answers a sentence when the change can't be made, else `null`.
 */
export type NoteEdit = (change: (current: string) => { text: string } | { error: string }) => string | null;

/** How often "Last ran 4 minutes ago" is worked out again while the note is open. */
const TICK_MS = 60_000;

/**
 * The run bar at the top of a routine note (board r2): the schedule in words,
 * when it last ran, and Run now and Pause. A note under `routines/` that will
 * never run gets one quiet line saying why instead. Draws nothing for any
 * other note, or where there is no control plane to ask (the landing page).
 */
export function NoteRoutineBar({
  text,
  onEdit,
  gutter,
}: {
  /** The note as it is in the editor now, front matter included. */
  text: string;
  /** Absent for someone who can't edit the note. */
  onEdit?: NoteEdit;
  gutter: number;
}) {
  const host = useRoutineHost();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (host === null) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [host === null]); // eslint-disable-line react-hooks/exhaustive-deps
  if (host === null) return null;
  const view = routineBarView({ path: host.path, text, row: host.row, now });
  return (
    <RoutineBar
      view={view}
      gutter={gutter}
      onRunNow={host.canEdit ? host.runNow : undefined}
      onPause={
        host.canEdit && onEdit !== undefined
          ? (pause) => onEdit((current) => pauseEdit(current, pause))
          : undefined
      }
    />
  );
}

/** The bar itself, drawn from a `RoutineBarView`. Exported for its test. */
export function RoutineBar({
  view,
  gutter,
  onRunNow,
  onPause,
}: {
  view: RoutineBarView;
  gutter: number;
  /** Absent for someone who can't run it. */
  onRunNow?: () => Promise<string | null>;
  /** Absent for someone who can't edit the note. */
  onPause?: (pause: boolean) => string | null;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [said, setSaid] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  if (view.kind === "none") return null;
  const pad = { paddingLeft: gutter, paddingRight: gutter };
  if (view.kind === "unscheduled") {
    return (
      <View style={[styles.wrap, pad]} testID="routine-bar">
        <Text variant="meta" style={styles.quiet} testID="routine-quiet">
          {view.line}
        </Text>
      </View>
    );
  }
  const quiet = said ?? (view.problems.length > 0 ? view.problems.join(" ") : null);
  return (
    <View style={[styles.wrap, pad]} testID="routine-bar">
      <View style={styles.bar}>
        <View style={styles.when}>
          <Icon name="clock" size={15} color={colors.text2} />
          <Text variant="rowSub" style={styles.schedule} testID="routine-schedule">
            {view.schedule}
          </Text>
        </View>
        {view.last === "" ? null : (
          <View style={styles.last}>
            <Text variant="rowSub" style={styles.lastText} testID="routine-last">
              {view.last}
            </Text>
            {view.mark === null ? null : (
              <View testID={`routine-mark-${view.mark}`} aria-label={view.mark === "ok" ? "went well" : "didn't go well"}>
                <Icon
                  name={view.mark === "ok" ? "check" : "close"}
                  size={13}
                  color={view.mark === "ok" ? colors.ok : colors.crit}
                />
              </View>
            )}
          </View>
        )}
        <View style={styles.actions}>
          {onRunNow === undefined ? null : (
            <Button
              label={queued ? "Starting…" : "Run now"}
              variant="mini"
              disabled={!view.canRun || queued}
              testID="routine-run-now"
              onPress={() => {
                setQueued(true);
                setSaid(null);
                void onRunNow().then((problem) => {
                  setQueued(false);
                  setSaid(problem);
                });
              }}
            />
          )}
          {onPause === undefined ? null : (
            <Button
              label={view.paused ? "Resume" : "Pause"}
              variant="mini"
              testID="routine-pause"
              onPress={() => setSaid(onPause(!view.paused))}
            />
          )}
        </View>
      </View>
      {quiet === null ? null : (
        <Text variant="meta" style={styles.quiet} testID="routine-quiet">
          {quiet}
        </Text>
      )}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { paddingTop: space.x1, paddingBottom: space.x2, gap: 6 },
    bar: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: space.x3,
      minHeight: 40,
      paddingVertical: 6,
      paddingHorizontal: space.x3,
      marginHorizontal: -(layout.readingMargin - space.x4),
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface2,
    },
    when: { flexDirection: "row", alignItems: "center", gap: 8 },
    schedule: { color: colors.text, fontWeight: "600" },
    last: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingLeft: space.x3,
      borderLeftWidth: 1,
      borderLeftColor: colors.lineStrong,
      flexShrink: 1,
    },
    lastText: { color: colors.text2, flexShrink: 1 },
    actions: { flexDirection: "row", gap: 8, marginLeft: "auto" },
    quiet: { color: colors.muted },
  });
