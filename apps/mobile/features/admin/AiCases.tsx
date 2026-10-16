/**
 * The Golden cases tab of a job's page (board 13): the job's test lists, the
 * cases of the picked list down the left, the picked case as a form in the
 * middle, and a Try it chat on the right whose exchange can be saved as a new
 * case. Every edit changes only the lines it shows; Save writes the whole note
 * back with the version it was read at, so a concurrent edit is refused, not
 * overwritten. The form is in `./AiCaseForm`.
 */

import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { Id } from "@context/convex/_generated/dataModel";
import { Pill, Text, space, useThemedStyles, type Colors } from "../design";
import { Box, Columns, LinkText, Primary, Quiet, Quietly } from "./AiKit";
import { AiTryIt } from "./AiTryIt";
import { CaseForm } from "./AiCaseForm";
import { DRAFTED_KEY } from "./aiModel";
import type { AiNoteRow } from "./aiCatalog";
import { addCase, addRule, parseTestList, removeLine, serializeTestList, setCaseTitle, setLineValue, type TestList } from "./testList";
import { messageOf, useAiNote, useNoteWriter } from "./useAiNote";

/** A new test list's first lines, written when a job has none yet. */
function starterFor(job: string): string {
  return `---\njob: ${job}\n---\n\n# ${job}\n\n## 1. What the person texts\n\n- kind: task\n- must: what a good reply does\n`;
}

/** `run_as:` from the list's front matter, the person the AI plays. */
function runAsOf(list: TestList): string | null {
  for (const line of list.lines.slice(0, list.frontEnd)) {
    const match = line.match(/^run_as:\s*(.+)$/);
    if (match) return match[1].trim();
  }
  return null;
}

function maxCaseNumber(list: TestList): number {
  return list.cases.reduce((max, item) => Math.max(max, item.number), 0);
}

/** A question or answer as one line: a case title and a bullet cannot span lines. */
function oneLine(text: string): string {
  return text.replace(/\s*\r?\n\s*/g, " ").trim();
}

export function AiCases({ workspaceId, job, tests, setups, reload, me }: {
  workspaceId: Id<"workspaces">;
  job: string;
  tests: readonly AiNoteRow[];
  setups: readonly { name: string; path: string }[];
  reload: () => void;
  me: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const writeNew = useNoteWriter(workspaceId);
  const [pickedPath, setPickedPath] = useState<string | null>(tests[0]?.path ?? null);
  const [caseNumber, setCaseNumber] = useState<number | null>(null);
  // Edits not yet saved, for the list at `path`. Null: the note as read.
  const [edit, setEdit] = useState<{ path: string; text: string } | null>(null);
  // Bumped when lines are added, removed or discarded, so the form's fields re-read their lines.
  const [shape, setShape] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const active = tests.find((row) => row.path === pickedPath) ?? tests[0] ?? null;
  const path = active?.path ?? null;
  const { state, save } = useAiNote(workspaceId, path);

  const text = state.kind === "ready" ? (edit !== null && edit.path === path ? edit.text : state.text) : null;
  const list = useMemo(() => (text === null ? null : parseTestList(text)), [text]);
  const dirty = state.kind === "ready" && edit !== null && edit.path === path && edit.text !== state.text;
  const current = list?.cases.find((item) => item.number === caseNumber) ?? list?.cases[0] ?? null;

  /** Applies an edit to the picked list and holds it until Save; a refused edit is shown, not thrown. */
  function apply(make: (base: TestList) => TestList, reshaped = false): TestList | null {
    if (path === null || list === null) return null;
    setProblem(null);
    try {
      const next = make(list);
      setEdit({ path, text: serializeTestList(next) });
      if (reshaped) setShape((was) => was + 1);
      return next;
    } catch (error: unknown) {
      setProblem(messageOf(error));
      return null;
    }
  }

  async function onSave() {
    if (path === null || list === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await save(path, serializeTestList(list));
      reload();
    } catch (error: unknown) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  function onDiscard() {
    setEdit(null);
    setShape((was) => was + 1);
    setProblem(null);
  }

  function onPick(next: string) {
    setPickedPath(next);
    setCaseNumber(null);
  }

  function onNew() {
    const next = apply((base) => addCase(base, "What the person texts"), true);
    if (next) setCaseNumber(maxCaseNumber(next));
  }

  function onSaveAsCase({ question, answer }: { question: string; answer: string }) {
    const next = apply((base) => {
      let made = addCase(base, oneLine(question));
      const number = maxCaseNumber(made);
      made = addRule(made, number, "must", "");
      made = addRule(made, number, "example", oneLine(answer));
      return addRule(made, number, DRAFTED_KEY, oneLine(me));
    }, true);
    if (next) setCaseNumber(maxCaseNumber(next));
  }

  async function onStart() {
    setBusy(true);
    setProblem(null);
    try {
      await writeNew(`ai/tests/${job}.md`, (existing) => existing ?? starterFor(job));
      reload();
    } catch (error: unknown) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  if (tests.length === 0) {
    return (
      <Box title="Cases" testID="admin-ai-cases-empty">
        <Quietly>No golden cases yet for this job.</Quietly>
        <Primary label={busy ? "Starting…" : "Start a test list"} disabled={busy} onPress={() => void onStart()} testID="admin-ai-cases-start" />
        {problem ? <Text variant="meta" style={styles.problem}>{problem}</Text> : null}
      </Box>
    );
  }

  const saveDisabled = !dirty || busy || state.kind !== "ready" || state.readOnly;

  return (
    <Columns weights={[1, 1.6, 1.3]}>
      <Box
        title="Cases"
        right={<LinkText label="+ New" onPress={onNew} testID="admin-ai-case-new" />}
        testID="admin-ai-cases"
      >
        {tests.length > 1 ? (
          <View style={styles.picker}>
            {tests.map((row) => {
              const on = row.path === path;
              return (
                <Pressable key={row.path} role="tab" aria-selected={on} onPress={() => onPick(row.path)} style={[styles.pick, on && styles.pickOn]} testID={`admin-ai-test-pick-${row.name}`}>
                  <Text variant="meta" numberOfLines={1}>{row.title}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {state.kind === "loading" || list === null ? (
          <Quietly>{state.kind === "failed" ? state.message : "Opening…"}</Quietly>
        ) : (
          list.cases.map((item) => {
            const selected = item.number === current?.number;
            const drafted = item.other.some((line) => line.key === DRAFTED_KEY);
            return (
              <Pressable key={item.headingIndex} role="tab" aria-selected={selected} onPress={() => setCaseNumber(item.number)} style={[styles.caseRow, selected && styles.caseOn]} testID={`admin-ai-case-row-${item.number}`}>
                <Text variant="meta" style={drafted ? styles.muted : styles.okText}>{drafted ? "○" : "✓"}</Text>
                <Text variant="tree" numberOfLines={1} style={[styles.caseTitle, drafted && styles.muted]}>{`${item.number}. ${item.title}`}</Text>
                {drafted ? <Pill>drafted</Pill> : null}
              </Pressable>
            );
          })
        )}
      </Box>

      <Box testID="admin-ai-case-box">
        {list === null || path === null ? (
          <Quietly>{state.kind === "failed" ? state.message : "Opening…"}</Quietly>
        ) : current ? (
          <CaseForm
            key={`${path}-${current.number}-${shape}`}
            item={current}
            runAs={runAsOf(list)}
            path={path}
            onTitle={(value) => apply((base) => setCaseTitle(base, current.number, value))}
            onLine={(index, value) => apply((base) => setLineValue(base, index, value))}
            onRemove={(index) => apply((base) => removeLine(base, index), true)}
            onAdd={(key) => apply((base) => addRule(base, current.number, key, ""), true)}
          />
        ) : (
          <Quietly>No cases yet. Add one with + New.</Quietly>
        )}
        <View style={styles.footer}>
          {problem ? <Text variant="meta" style={styles.problem} testID="admin-ai-cases-problem">{problem}</Text> : null}
          <View style={styles.actions}>
            <Quiet label="Discard" disabled={!dirty || busy} onPress={onDiscard} testID="admin-ai-cases-discard" />
            <Primary label={busy ? "Saving…" : "Save"} disabled={saveDisabled} onPress={() => void onSave()} testID="admin-ai-cases-save" />
          </View>
        </View>
      </Box>

      <AiTryIt
        workspaceId={workspaceId}
        job={job}
        setups={setups}
        testCase={current}
        onSaveAsCase={onSaveAsCase}
      />
    </Columns>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    picker: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    pick: { paddingVertical: 4, paddingHorizontal: space.x2, borderRadius: 6, borderWidth: 1, borderColor: colors.line, maxWidth: "100%" },
    pickOn: { backgroundColor: colors.rowSelected },
    caseRow: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingVertical: 7, paddingHorizontal: space.x2, borderRadius: 8, minWidth: 0 },
    caseOn: { backgroundColor: colors.rowSelected },
    caseTitle: { flex: 1, minWidth: 0, color: colors.text },
    muted: { color: colors.muted },
    okText: { color: colors.okText, fontWeight: "600" },
    problem: { color: colors.critText },
    footer: { gap: space.x2, marginTop: space.x3 },
    actions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: space.x2 },
  });
