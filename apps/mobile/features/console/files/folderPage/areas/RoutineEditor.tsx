/**
 * A routine's editor, in place in the area panel (`PanelRoutines.tsx`): Name, Repeats (the folder), On (`on:`), At
 * (`at:`, several allowed) and the sentence they make, as the approved artboards draw it. Adding, it ends in "Create
 * and write the job", which writes the note and opens it so the job can be typed. Editing, each change is written as
 * it is made, the way every other panel field is, with "Runs on schedule" (`paused:`), "Open the job" and "Done".
 */

import { useState } from "react";
import { Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Icon } from "../../../../design/components/Icon";
import { Switch } from "../../../../design/components/Switch";
import { Text } from "../../../../design/components/Text";
import { useFieldFont } from "../../../../design/fieldFont";
import { fonts, pointerType, radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { MAX_ROUTINE_TIMES } from "@context/shared/src/areaRoutines.cjs";
import { draftWords, readTime, REPEATS, ROUTINE_ZONE_WORDS, withRepeats, type Draft, type Repeats } from "./areaRoutines";
import { Field } from "./panelFields";

const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
/** The steps Every N hours offers. */
const HOURS = [1, 2, 3, 4, 6, 8, 12];

export function RoutineEditor({
  area,
  root,
  draft: initial,
  path,
  onChange,
  onOpen,
  onCreate,
  onDone,
}: {
  area: string;
  root: string;
  draft: Draft;
  /** The routine's note, editing one; absent adding. */
  path?: string;
  /** Writes one change as it is made: null once written, or why not. */
  onChange?: (before: Draft, after: Draft) => Promise<string | null>;
  onOpen?: () => void;
  /** Adding: writes the note and opens it. */
  onCreate?: (draft: Draft) => Promise<string | null>;
  onDone: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const fieldFont = useFieldFont(pointerType.ui);
  const adding = onCreate !== undefined;
  const [draft, setDraft] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [typing, setTyping] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const words = draftWords(area, root, { ...draft, name });

  /** One change: drawn at once, written when editing, taken back if refused. */
  const put = async (next: Draft) => {
    const before = draft;
    setDraft(next);
    setProblem(null);
    if (adding || onChange === undefined) return;
    const why = await onChange(before, next);
    if (why !== null) {
      setDraft(before);
      setProblem(why);
    }
  };
  const commitName = () => {
    const trimmed = name.trim();
    if (adding || trimmed === draft.name.trim()) return;
    if (trimmed === "") return setName(draft.name);
    void put({ ...draft, name: trimmed });
  };
  const toggleDay = (day: number) => {
    const on = draft.days.includes(day);
    if (on && draft.days.length === 1) return;
    void put({ ...draft, days: on ? draft.days.filter((each) => each !== day) : [...draft.days, day].sort((a, b) => a - b) });
  };
  const addTime = () => {
    if (typing === null) return;
    const time = readTime(typing);
    if (typing.trim() === "") return setTyping(null);
    if (time === null) return setProblem("Write a time like 2 pm or 14:00.");
    setTyping(null);
    if (!draft.times.includes(time)) void put({ ...draft, times: sortTimes([...draft.times, time]) });
  };
  const create = async () => {
    if (onCreate === undefined || busy) return;
    setBusy(true);
    const why = await onCreate({ ...draft, name });
    setBusy(false);
    if (why === null) onDone();
    else setProblem(why);
  };
  // The step at or just under the routine's own (an `every-5-hours` folder steps from 4).
  const hours = Math.max(0, HOURS.filter((step) => step <= draft.everyHours).length - 1);

  return (
    <View style={styles.box} testID={adding ? "area-panel-routine-new" : `area-panel-routine-edit-${path ?? ""}`}>
      <Field label="Name">
        <TextInput
          value={name}
          onChangeText={setName}
          onBlur={commitName}
          onSubmitEditing={commitName}
          autoFocus={adding}
          accessibilityLabel="Routine name"
          placeholder="e.g. Pipeline check"
          placeholderTextColor={colors.muted}
          style={[styles.input, fieldFont, !adding && styles.inputQuiet]}
          testID="area-panel-routine-name"
        />
      </Field>
      <Field label="Repeats">
        <View style={styles.chips} role="radiogroup" aria-label="Repeats">
          {REPEATS.map((each: Repeats) => {
            const on = each === draft.repeats;
            return (
              <Pressable key={each} onPress={() => void put(withRepeats(draft, each))} role="radio" aria-checked={on} style={[styles.chip, on && styles.chipOn]} testID={`area-panel-routine-repeats-${each}`}>
                <Text variant="treeMeta" style={on ? styles.chipWordOn : styles.chipWord}>{each}</Text>
              </Pressable>
            );
          })}
        </View>
      </Field>
      {draft.repeats === "Hourly" ? (
        <Field label="Every">
          <View style={styles.inline}>
            <Pressable role="button" accessibilityLabel="Fewer hours" disabled={hours <= 0} onPress={() => void put({ ...draft, everyHours: HOURS[Math.max(0, hours - 1)]! })} style={styles.step} testID="area-panel-routine-hours-less">
              <Icon name="minus" size={11} color={colors.text2} />
            </Pressable>
            <Text variant="tree">{draft.everyHours === 1 ? "1 hour" : `${draft.everyHours} hours`}</Text>
            <Pressable role="button" accessibilityLabel="More hours" disabled={hours >= HOURS.length - 1} onPress={() => void put({ ...draft, everyHours: HOURS[Math.min(HOURS.length - 1, hours + 1)]! })} style={styles.step} testID="area-panel-routine-hours-more">
              <Icon name="plus" size={11} color={colors.text2} />
            </Pressable>
          </View>
          {words === "" ? null : <Text variant="treeMeta" style={styles.muted}>{`${words}.`}</Text>}
        </Field>
      ) : (
        <>
          {draft.repeats === "Monthly" ? null : (
            <Field label="On">
              <View style={styles.days} role="group" aria-label="Days">
                {DAY_LETTERS.map((letter, day) => {
                  const on = draft.days.includes(day);
                  return (
                    <Pressable key={day} onPress={() => toggleDay(day)} role="checkbox" aria-checked={on} accessibilityLabel={DAY_NAMES[day]} style={[styles.day, on && styles.chipOn]} testID={`area-panel-routine-day-${day}`}>
                      <Text variant="treeMeta" style={on ? styles.chipWordOn : styles.chipWord}>{letter}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </Field>
          )}
          <Field label="At">
            <View style={styles.chips}>
              {draft.times.map((time) => (
                <View key={time} style={styles.time}>
                  <Text variant="treeMeta" style={styles.timeWord}>{time}</Text>
                  <Pressable role="button" accessibilityLabel={`Remove ${time}`} hitSlop={6} disabled={draft.times.length === 1} onPress={() => void put({ ...draft, times: draft.times.filter((each) => each !== time) })} testID={`area-panel-routine-time-remove-${time}`}>
                    <Icon name="close" size={10} color={colors.muted} />
                  </Pressable>
                </View>
              ))}
              {typing !== null ? (
                <TextInput
                  value={typing}
                  onChangeText={setTyping}
                  onBlur={addTime}
                  onSubmitEditing={addTime}
                  autoFocus
                  accessibilityLabel="New time"
                  placeholder="2 pm"
                  placeholderTextColor={colors.muted}
                  style={[styles.input, styles.timeInput, fieldFont]}
                  testID="area-panel-routine-time-new"
                />
              ) : draft.times.length < MAX_ROUTINE_TIMES ? (
                <Pressable role="button" onPress={() => setTyping("")} accessibilityLabel="Add a time" style={styles.timeAdd} testID="area-panel-routine-time-add">
                  <Icon name="plus" size={11} color={colors.text2} />
                </Pressable>
              ) : null}
            </View>
            {words === "" ? null : <Text variant="treeMeta" style={styles.muted} testID="area-panel-routine-words">{`${words}, ${ROUTINE_ZONE_WORDS}.`}</Text>}
          </Field>
        </>
      )}
      {adding ? null : (
        <View style={styles.inline}>
          <Switch value={!draft.paused} onValueChange={(runs) => void put({ ...draft, paused: !runs })} label={`Run ${draft.name}`} testID="area-panel-routine-runs" />
          <Text variant="tree">{draft.paused ? "Paused" : "Runs on schedule"}</Text>
        </View>
      )}
      {problem === null ? null : <Text variant="treeMeta" role="alert" style={styles.crit}>{problem}</Text>}
      <View style={styles.foot}>
        {adding ? (
          <>
            <Pressable role="button" onPress={onDone} style={styles.link} testID="area-panel-routine-cancel">
              <Text variant="treeMeta" style={styles.muted}>Cancel</Text>
            </Pressable>
            <Pressable role="button" onPress={() => void create()} disabled={busy || name.trim() === ""} style={[styles.primary, (busy || name.trim() === "") && styles.primaryOff]} testID="area-panel-routine-create">
              <Text variant="treeMeta" style={styles.primaryWord}>Create and write the job</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Pressable role="link" onPress={onOpen} style={styles.link} testID="area-panel-routine-open">
              <Text variant="treeMeta" style={styles.linkWord}>Open the job ›</Text>
            </Pressable>
            <Pressable role="button" onPress={onDone} style={styles.link} testID="area-panel-routine-done">
              <Text variant="treeMeta" style={styles.doneWord}>Done</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

/** "9 am", "1 pm", "5 pm", in the day's order. */
function sortTimes(times: readonly string[]): string[] {
  const minutes = (time: string) => {
    const match = /^(\d{1,2})(?::(\d{2}))? (am|pm)$/.exec(time);
    if (match === null) return 0;
    return ((Number(match[1]) % 12) + (match[3] === "pm" ? 12 : 0)) * 60 + Number(match[2] ?? 0);
  };
  return [...times].sort((a, b) => minutes(a) - minutes(b));
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    muted: { color: colors.muted },
    crit: { color: colors.critText },
    // The attach list's box.
    box: { marginVertical: space.x1, padding: space.x3, gap: space.x3, borderWidth: 1, borderColor: colors.lineStrong, borderRadius: radii.sm, backgroundColor: colors.surface2 },
    inline: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    input: {
      fontFamily: fonts.body,
      color: colors.text,
      height: 28,
      paddingHorizontal: 8,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.sm,
      backgroundColor: colors.surface,
      ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
    },
    inputQuiet: { borderColor: "transparent", backgroundColor: "transparent", paddingHorizontal: 6, marginLeft: -6 },
    // The mode chips.
    chips: { flexDirection: "row", flexWrap: "wrap", gap: space.x1, marginBottom: 2 },
    chip: { paddingVertical: 2, paddingHorizontal: space.x2, borderRadius: radii.pill, borderWidth: 1, borderColor: colors.lineStrong },
    chipOn: { backgroundColor: colors.text, borderColor: colors.text },
    chipWord: { color: colors.text2 },
    chipWordOn: { color: colors.surface },
    days: { flexDirection: "row", gap: 3 },
    day: { width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: 12, borderWidth: 1, borderColor: colors.lineStrong },
    // The goal's pill.
    time: { flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 2, paddingLeft: space.x2, paddingRight: 6, borderRadius: radii.pill, backgroundColor: colors.chipFill, borderWidth: 1, borderColor: colors.line },
    timeWord: { color: colors.text, fontWeight: "600" },
    timeAdd: { width: 24, height: 22, alignItems: "center", justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.lineStrong, borderStyle: "dashed" },
    timeInput: { width: 72, height: 24 },
    step: { width: 24, height: 22, alignItems: "center", justifyContent: "center", borderRadius: radii.pill, borderWidth: 1, borderColor: colors.lineStrong },
    foot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: space.x1 },
    // "Open area"'s button.
    primary: { alignSelf: "flex-start", paddingVertical: space.x1, paddingHorizontal: space.x3, borderRadius: radii.sm, backgroundColor: colors.text },
    primaryOff: { opacity: 0.4 },
    primaryWord: { color: colors.surface, fontWeight: "600" },
    link: { alignSelf: "flex-start", paddingVertical: space.x1 },
    linkWord: { color: colors.accentText, fontWeight: "600" },
    doneWord: { color: colors.text, fontWeight: "600" },
  });
