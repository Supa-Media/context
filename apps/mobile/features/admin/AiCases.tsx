/**
 * The Cases tab of a job's page (boards 13 and 19): the job's case groups (one
 * test list each, `./AiCaseGroups`) with the open group's cases down the left,
 * the picked case as a form in the middle, and a Try it chat on the right
 * whose exchange can be saved as a new case. Every edit changes only the lines it shows; Save writes the whole note
 * back with the version it was read at, so a concurrent edit is refused, not
 * overwritten. The form is in `./AiCaseForm`.
 */

import { useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { Id } from "@context/convex/_generated/dataModel";
import { Text, space, useThemedStyles, type Colors } from "../design";
import { Menu } from "../design/components/Menu";
import { Box, Columns, LinkText, Primary, Quiet, Quietly } from "./AiKit";
import { AiCaseGroups } from "./AiCaseGroups";
import { AiTryIt, type TrySetup } from "./AiTryIt";
import { CaseForm } from "./AiCaseForm";
import { DRAFTED_KEY } from "./aiModel";
import type { AiNoteRow } from "./aiCatalog";
import {
  addCase,
  addRule,
  appendCase,
  caseLines,
  groupTitle,
  parseTestList,
  removeCase,
  removeLine,
  serializeTestList,
  setCaseTitle,
  setDescription,
  setGroupTitle,
  setLineValue,
  type TestList,
} from "./testList";
import { messageOf, useAiNote, useNoteMoves, useNoteWriter } from "./useAiNote";

/** A new test list's first lines, written when a job has none yet. */
function starterFor(job: string): string {
  return `---\njob: ${job}\n---\n\n# ${job}\n\n## 1. What the person texts\n\n- kind: task\n- must: what a good reply does\n`;
}

/** A free note path for a new or copied group: `ai/tests/<base>.md`, then `-2`, `-3`. */
function freeTestPath(base: string, tests: readonly AiNoteRow[]): string {
  const taken = new Set(tests.map((row) => row.path));
  let path = `ai/tests/${base}.md`;
  for (let n = 2; taken.has(path); n += 1) path = `ai/tests/${base}-${n}.md`;
  return path;
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

export function AiCases({
  workspaceId,
  job,
  tests,
  setups,
  reload,
  me,
}: {
  workspaceId: Id<"workspaces">;
  job: string;
  tests: readonly AiNoteRow[];
  setups: readonly TrySetup[];
  reload: () => void;
  me: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const writeNew = useNoteWriter(workspaceId);
  const moves = useNoteMoves(workspaceId);
  const moveRef = useRef<View>(null);
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number } | null>(null);
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

  /** Writes a note the tab does not have open (a new group, a copy, a moved case), then shows it. */
  async function writeOther(target: string, change: (text: string | null) => string | null, open: boolean) {
    setBusy(true);
    setProblem(null);
    try {
      await writeNew(target, change);
      reload();
      if (open) onPick(target);
    } catch (error: unknown) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  function onNewGroup() {
    const target = freeTestPath(`${job}-group`, tests);
    void writeOther(target, (existing) => existing ?? `---\njob: ${job}\n---\n\n# New case group\n\n## 1. What the person texts\n\n- kind: task\n- must: what a good reply does\n`, true);
  }

  function onDuplicateGroup() {
    if (list === null || active === null) return;
    const copy = setGroupTitle(list, `${groupTitle(list) ?? active.title} copy`);
    void writeOther(freeTestPath(`${active.name}-copy`, tests), (existing) => existing ?? serializeTestList(copy), true);
  }

  async function onDeleteGroup() {
    if (path === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await moves.trash(path);
      setEdit(null);
      setPickedPath(tests.find((row) => row.path !== path)?.path ?? null);
      reload();
    } catch (error: unknown) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  /** Moves the open case to another group: written there first, then saved out of here, so a failure loses nothing. */
  async function onMoveCase(target: string) {
    setMoveMenu(null);
    if (list === null || path === null || current === null) return;
    const block = caseLines(list, current.number);
    setBusy(true);
    setProblem(null);
    try {
      await writeNew(target, (text) => (text === null ? null : serializeTestList(appendCase(parseTestList(text), block))));
      await save(path, serializeTestList(removeCase(list, current.number)));
      setEdit(null);
      setCaseNumber(null);
      setShape((was) => was + 1);
      reload();
    } catch (error: unknown) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
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
        <Quietly>No case groups yet for this job.</Quietly>
        <Primary label={busy ? "Starting…" : "Start a test list"} disabled={busy} onPress={() => void onStart()} testID="admin-ai-cases-start" />
        {problem ? (
          <Text variant="meta" style={styles.problem}>
            {problem}
          </Text>
        ) : null}
      </Box>
    );
  }

  const saveDisabled = !dirty || busy || state.kind !== "ready" || state.readOnly;

  const others = tests.filter((row) => row.path !== path);
  const openMoveMenu = () => {
    moveRef.current?.measureInWindow((x, y, _width, height) => setMoveMenu({ x, y: y + height + 4 }));
    setMoveMenu((was) => was ?? { x: 0, y: 0 });
  };

  return (
    <>
      <Columns weights={[1, 1.6, 1.3]}>
        <Box title="Case groups">
          <AiCaseGroups
            tests={tests}
            activePath={path}
            list={list}
            loading={state.kind === "failed" ? state.message : null}
            current={current?.number ?? null}
            busy={busy}
            onPickGroup={onPick}
            onPickCase={setCaseNumber}
            onAddCase={onNew}
            onRename={(title) => apply((base) => setGroupTitle(base, title))}
            onDuplicate={onDuplicateGroup}
            onDelete={() => void onDeleteGroup()}
            onNewGroup={onNewGroup}
          />
        </Box>

        <Box testID="admin-ai-case-box">
          {list === null || path === null ? (
            <Quietly>{state.kind === "failed" ? state.message : "Opening…"}</Quietly>
          ) : current ? (
            <>
              <View style={styles.caseHead}>
                <Text variant="meta" numberOfLines={1} style={styles.caseWhere}>{`${groupTitle(list) ?? active?.title ?? ""} · case ${current.number}`}</Text>
                <LinkText
                  label="Duplicate"
                  onPress={() => {
                    const next = apply((base) => appendCase(base, caseLines(base, current.number)), true);
                    if (next) setCaseNumber(maxCaseNumber(next));
                  }}
                  testID="admin-ai-case-duplicate"
                />
                {others.length > 0 ? (
                  <Pressable ref={moveRef} role="button" onPress={openMoveMenu} hitSlop={4} testID="admin-ai-case-move">
                    <Text variant="meta" style={styles.link}>
                      Move to…
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable
                  role="button"
                  onPress={() => {
                    apply((base) => removeCase(base, current.number), true);
                    setCaseNumber(null);
                  }}
                  hitSlop={4}
                  testID="admin-ai-case-delete"
                >
                  <Text variant="meta" style={styles.delete}>
                    Delete
                  </Text>
                </Pressable>
              </View>
              <CaseForm
                key={`${path}-${current.number}-${shape}`}
                item={current}
                runAs={runAsOf(list)}
                path={path}
                onTitle={(value) => apply((base) => setCaseTitle(base, current.number, value))}
                onLine={(index, value) => apply((base) => setLineValue(base, index, value))}
                onRemove={(index) => apply((base) => removeLine(base, index), true)}
                onAdd={(key) => apply((base) => addRule(base, current.number, key, ""), true)}
                onDescription={(value) => apply((base) => setDescription(base, current.number, value))}
              />
            </>
          ) : (
            <Quietly>No cases yet. Add one with + Add a case.</Quietly>
          )}
          <View style={styles.footer}>
            {problem ? (
              <Text variant="meta" style={styles.problem} testID="admin-ai-cases-problem">
                {problem}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <Quiet label="Discard" disabled={!dirty || busy} onPress={onDiscard} testID="admin-ai-cases-discard" />
              <Primary label={busy ? "Saving…" : "Save"} disabled={saveDisabled} onPress={() => void onSave()} testID="admin-ai-cases-save" />
            </View>
          </View>
        </Box>

        <AiTryIt workspaceId={workspaceId} job={job} setups={setups} testCase={current} runAs={list ? runAsOf(list) : null} onSaveAsCase={onSaveAsCase} />
      </Columns>
      {moveMenu !== null ? (
        <Menu<string>
          items={others.map((row) => ({
            id: row.path,
            label: row.title || row.name,
          }))}
          anchor={moveMenu}
          title="Move this case to"
          onSelect={(target) => void onMoveCase(target)}
          onDismiss={() => setMoveMenu(null)}
        />
      ) : null}
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    caseHead: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      flexWrap: "wrap",
      marginBottom: space.x3,
    },
    caseWhere: { flex: 1, minWidth: 120, color: colors.muted },
    link: { color: colors.accent, fontWeight: "600" },
    delete: { color: colors.critText, fontWeight: "700" },
    strong: { color: colors.text, fontWeight: "600" },
    problem: { color: colors.critText },
    footer: { gap: space.x2, marginTop: space.x3 },
    actions: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: space.x2,
    },
  });
