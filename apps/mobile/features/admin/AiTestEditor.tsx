/**
 * A test list edited in place (board 6 of the AI tools plan): its cases down
 * the left, the picked case as a form in the middle (what the person texts,
 * how they answer when asked, and the rules), and how the last round did on
 * it on the right. Form and Markdown edit the same note text; the form changes
 * only the lines it shows, so everything else in the note stays as written.
 * See `./testList.ts` for the reading and the edits.
 */

import { useEffect, useMemo, useState } from "react";
import { Linking, Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button, Text, TextField, space, useThemedStyles, type Colors } from "../design";
import { pointerType } from "../design/tokens";
import { useFieldFont } from "../design/fieldFont";
import { baseName, displayName } from "../console/files/paths";
import { Panel, useCompact } from "./AdminKit";
import { Primary } from "./AiViews";
import { RUN_TESTS_URL, type ScoreRow } from "./aiCatalog";
import { slugFor } from "./AiNoteEditor";
import { Segments } from "./Segments";
import {
  addCase,
  addRule,
  parseTestList,
  removeLine,
  ruleLabel,
  ruleTone,
  serializeTestList,
  setCaseTitle,
  setLineValue,
  type CaseLine,
  type RuleTone,
  type TestCase,
} from "./testList";
import { messageOf, useAiNote, useScores } from "./useAiNote";

type Mode = "form" | "markdown";

/** The rules "+ Add a rule" offers. Any other line can still be typed in Markdown. */
const NEW_RULES = ["must", "must not", "may", "must call", "must write", "must reach"] as const;

const STARTER = `---\njob: texting-assistant\nrun_as: Maya\ntoday: 2026-10-08\njudge: claude-haiku-5-5\nruns: 3\ngood_enough:\n  score: 100%\n---\n\n# New test\n\nWhat this list proves, in a line.\n\n## 1. What the person texts\n\n- kind: task\n- must: what the answer must do\n`;

export function AiTestEditor({
  workspaceId,
  path,
  folder,
  lastRound,
  onClose,
  onOpenInNotes,
}: {
  workspaceId: Id<"workspaces">;
  path: string | null;
  folder: string;
  lastRound: ScoreRow | null;
  onClose: (saved: boolean) => void;
  onOpenInNotes: (path: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont(pointerType.ui);
  const compact = useCompact();
  const [target, setTarget] = useState(path);
  const { state, save, reload } = useAiNote(workspaceId, path);
  const [text, setText] = useState<string | null>(path === null ? STARTER : null);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<Mode>("form");
  const [picked, setPicked] = useState(1);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);
  // Bumped when lines are added or removed, so the form's fields re-read their lines.
  const [shape, setShape] = useState(0);
  const scores = useScores(workspaceId, lastRound ? [lastRound.path] : []);
  const round = lastRound ? scores.get(lastRound.path) : undefined;

  useEffect(() => {
    if (state.kind === "ready" && text === null) setText(state.text);
  }, [state, text]);

  const list = useMemo(() => (text === null ? null : parseTestList(text)), [text]);
  const isNew = target === null;
  const dirty = state.kind === "ready" && text !== null && (isNew ? name.trim() !== "" : text !== state.text);
  const current = list?.cases.find((item) => item.number === picked) ?? list?.cases[0] ?? null;
  const title = displayName(baseName(target ?? ""));
  const failedOn = (n: number) => round?.misses.filter((miss) => miss.question === n) ?? [];

  async function onSave() {
    if (text === null) return;
    setProblem(null);
    if (isNew && slugFor(name) === "") {
      setProblem("Give the test list a name first.");
      return;
    }
    const where = target ?? `${folder}/${slugFor(name)}.md`;
    setBusy(true);
    try {
      await save(where, text);
      setTarget(where);
      setSavedOnce(true);
    } catch (error: unknown) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  const edit = (next: ReturnType<typeof parseTestList>) => setText(serializeTestList(next));
  const reshape = (next: ReturnType<typeof parseTestList>) => {
    edit(next);
    setShape((was) => was + 1);
  };

  return (
    <View style={styles.stack} testID="admin-ai-test-editor">
      <View style={styles.head}>
        <View style={styles.titleRow}>
          <Pressable role="link" onPress={() => onClose(savedOnce)} testID="admin-ai-editor-back">
            <Text variant="meta" style={styles.muted}>tests ›</Text>
          </Pressable>
          {isNew ? (
            <TextField label="Name" labelHidden placeholder="Name the test list, e.g. Sending email" value={name} onChangeText={setName} containerStyle={styles.nameField} testID="admin-ai-editor-name" />
          ) : (
            <Text variant="paneTitle" numberOfLines={1}>{title}</Text>
          )}
        </View>
        <View style={styles.actions}>
          <Segments options={[{ key: "form", label: "Form" }, { key: "markdown", label: "Markdown" }]} value={mode} onChange={setMode} label="Edit as" testID="admin-ai-test-mode" />
          {target !== null ? <Button label="Open in notes" onPress={() => onOpenInNotes(target)} /> : null}
          <Button label="Run tests" onPress={() => void Linking.openURL(RUN_TESTS_URL).catch(() => {})} testID="admin-ai-test-run" />
          <Button label={savedOnce && !dirty ? "Done" : "Cancel"} onPress={() => onClose(savedOnce)} testID="admin-ai-editor-cancel" />
          <Primary label={busy ? "Saving…" : "Save"} disabled={!dirty || busy || state.kind !== "ready" || state.readOnly} onPress={() => void onSave()} testID="admin-ai-editor-save" />
        </View>
      </View>
      {problem ? (
        <Text variant="meta" style={styles.problem} testID="admin-ai-editor-problem">
          {problem}{" "}
          {problem.startsWith("Somebody") ? <Text variant="meta" style={styles.link} onPress={() => { setText(null); reload(); }}>Reload</Text> : null}
        </Text>
      ) : null}
      {savedOnce && !dirty ? <Text variant="meta" style={styles.saved}>Saved. The next round of AI Benchmark runs this list.</Text> : null}

      {state.kind === "loading" || list === null ? (
        <Panel><Text variant="meta">Opening…</Text></Panel>
      ) : state.kind === "failed" ? (
        <Panel><Text variant="meta">{state.message}</Text></Panel>
      ) : mode === "markdown" ? (
        <Panel flush>
          <TextInput multiline value={text ?? ""} onChangeText={setText} style={[styles.markdown, fieldFont]} textAlignVertical="top" autoCapitalize="none" autoCorrect={false} spellCheck={false} accessibilityLabel="The test list as Markdown" testID="admin-ai-test-markdown" />
        </Panel>
      ) : (
        <View style={[styles.columns, compact && styles.columnsCompact]}>
          <View style={[styles.cases, compact && styles.casesCompact]}>
            <Text variant="eyebrow">{list.cases.length} cases</Text>
            {list.cases.map((item) => {
              const failed = failedOn(item.number).length > 0;
              return (
                <Pressable key={item.headingIndex} role="tab" aria-selected={item.number === current?.number} onPress={() => setPicked(item.number)} style={[styles.caseRow, item.number === current?.number && styles.caseOn]} testID={`admin-ai-case-${item.number}`}>
                  <Text variant="tree" numberOfLines={1} style={styles.caseTitle}>{item.number}. {item.title}</Text>
                  {failed ? <Text variant="treeMeta" style={styles.bad}>failed</Text> : null}
                </Pressable>
              );
            })}
            <Pressable role="button" onPress={() => { const next = addCase(list, "What the person texts"); reshape(next); setPicked(next.cases[next.cases.length - 1]?.number ?? 1); }} testID="admin-ai-add-case">
              <Text variant="meta" style={styles.link}>+ Add a case</Text>
            </Pressable>
          </View>
          {current ? (
            <CaseForm key={`${current.headingIndex}-${shape}-${mode}`} item={current} onTitle={(value) => edit(setCaseTitle(list, current.number, value))} onLine={(index, value) => edit(setLineValue(list, index, value))} onRemove={(index) => reshape(removeLine(list, index))} onAdd={(key) => reshape(addRule(list, current.number, key, ""))} />
          ) : (
            <Text variant="meta" style={styles.center}>No cases yet. Add one on the left.</Text>
          )}
          <View style={[styles.last, compact && styles.lastCompact]} testID="admin-ai-last-run">
            <Text variant="rowTitle">Last round{lastRound?.day ? ` · ${lastRound.day}` : ""}</Text>
            {lastRound === null ? (
              <Text variant="meta">This list has not been run yet. Run tests runs it with the live setup and live skills.</Text>
            ) : round === undefined ? (
              <Text variant="meta">Reading the round's scores…</Text>
            ) : (
              <>
                <Text variant="meta">{round.setup}: {round.score}, gates {round.gates}{round.goodEnough ? ", good enough" : ""}</Text>
                {current && failedOn(current.number).length > 0 ? (
                  failedOn(current.number).map((miss) => (
                    <View key={miss.rule} style={styles.miss}>
                      <Text variant="meta" style={styles.bad}>{miss.rule}</Text>
                      <Text variant="meta">failed {miss.runs}</Text>
                    </View>
                  ))
                ) : (
                  <Text variant="meta" style={styles.okText}>No gate failed on this case.</Text>
                )}
                <Pressable role="link" onPress={() => onOpenInNotes(lastRound.path)}>
                  <Text variant="meta" style={styles.link}>Open the round's scores</Text>
                </Pressable>
              </>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

function CaseForm({ item, onTitle, onLine, onRemove, onAdd }: {
  item: TestCase;
  onTitle: (value: string) => void;
  onLine: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  onAdd: (key: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [adding, setAdding] = useState(false);
  // Held here as typed: the note reads a heading with its trailing space trimmed.
  const [title, setTitle] = useState(item.title);
  return (
    <View style={styles.form} testID="admin-ai-case-form">
      <Text variant="eyebrow">The person texts</Text>
      <TextField label="The person texts" labelHidden multiline value={title} onChangeText={(value) => { setTitle(value); onTitle(value); }} testID="admin-ai-case-title" />
      {item.description ? <Text variant="meta">{item.description}</Text> : null}
      {item.person ? <LineField line={item.person} label="as" onLine={onLine} /> : null}
      <Text variant="eyebrow" style={styles.section}>When the AI asks, the person answers</Text>
      {item.replies.length === 0 ? <Text variant="meta">Nothing scripted; the person is played by a model.</Text> : null}
      {item.replies.map((line) => <LineField key={line.index} line={line} label={line.key} onLine={onLine} onRemove={onRemove} />)}
      <Text variant="eyebrow" style={styles.section}>Rules</Text>
      {item.rules.map((line) => <LineField key={line.index} line={line} tone={ruleTone(line.key)} label={ruleLabel(line.key)} onLine={onLine} onRemove={onRemove} />)}
      {adding ? (
        <View style={styles.addRow}>
          {NEW_RULES.map((key) => (
            <Pressable key={key} role="button" onPress={() => { onAdd(key); setAdding(false); }} style={[styles.chip, toneStyle(styles, ruleTone(key))]} testID={`admin-ai-add-rule-${key.replace(/ /g, "-")}`}>
              <Text variant="mini" style={toneText(styles, ruleTone(key))}>{key}</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <Pressable role="button" onPress={() => setAdding(true)} testID="admin-ai-add-rule">
          <Text variant="meta" style={styles.link}>+ Add a rule</Text>
        </Pressable>
      )}
      {item.other.length > 0 ? (
        <>
          <Text variant="eyebrow" style={styles.section}>Also</Text>
          {item.other.map((line) => <LineField key={line.index} line={line} label={line.key} onLine={onLine} onRemove={onRemove} />)}
        </>
      ) : null}
      <Text variant="meta" style={styles.section}>
        Purple rules are checked from what actually happened (calls, pages reached, notes written). Green and red rules are read by the judge. A test says what must happen, never how; the skill says how.
      </Text>
    </View>
  );
}

function LineField({ line, label, tone, onLine, onRemove }: {
  line: CaseLine;
  label: string;
  tone?: RuleTone;
  onLine: (index: number, value: string) => void;
  onRemove?: (index: number) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont(pointerType.ui);
  const [value, setValue] = useState(line.value);
  // Grows with what is typed, so a long rule reads whole instead of scrolling inside one line.
  const [height, setHeight] = useState<number | null>(null);
  return (
    <View style={styles.line} testID={`admin-ai-line-${line.index}`}>
      <View style={[styles.chip, tone ? toneStyle(styles, tone) : styles.chipPlain]}>
        <Text variant="mini" style={tone ? toneText(styles, tone) : styles.muted} numberOfLines={1}>{label}</Text>
      </View>
      <TextInput multiline numberOfLines={1} value={value} onChangeText={(next) => { setValue(next); onLine(line.index, next); }} onContentSizeChange={(event) => setHeight(event.nativeEvent.contentSize.height)} style={[styles.lineInput, fieldFont, height !== null && { height: Math.max(32, height) }]} accessibilityLabel={label} testID={`admin-ai-line-${line.index}-value`} />
      {onRemove ? (
        <Pressable role="button" accessibilityLabel={`Remove this ${label} line`} onPress={() => onRemove(line.index)} hitSlop={8} testID={`admin-ai-line-${line.index}-remove`}>
          <Text variant="meta" style={styles.muted}>×</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

type Styles = ReturnType<typeof makeStyles>;
const toneStyle = (styles: Styles, tone: RuleTone) => (tone === "checked" ? styles.chipChecked : tone === "mustNot" ? styles.chipNot : tone === "must" ? styles.chipMust : styles.chipPlain);
const toneText = (styles: Styles, tone: RuleTone) => (tone === "checked" ? styles.checkedText : tone === "mustNot" ? styles.bad : tone === "must" ? styles.okText : styles.muted);

const mono = Platform.select({ web: "ui-monospace, SFMono-Regular, Menlo, monospace", ios: "Menlo", default: "monospace" });

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    stack: { gap: space.x3 },
    head: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.x3 },
    titleRow: { flexDirection: "row", alignItems: "center", gap: space.x2, flexShrink: 1 },
    nameField: { minWidth: 260 },
    actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2 },
    columns: { flexDirection: "row", alignItems: "flex-start", borderWidth: 1, borderColor: colors.line, borderRadius: 12, backgroundColor: colors.surface, overflow: "hidden" },
    columnsCompact: { flexDirection: "column", alignItems: "stretch" },
    cases: { width: 230, gap: 2, padding: space.x4, borderRightWidth: 1, borderRightColor: colors.line, alignSelf: "stretch" },
    casesCompact: { width: "auto", borderRightWidth: 0, borderBottomWidth: 1, borderBottomColor: colors.line },
    caseRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.x2, paddingVertical: 7, paddingHorizontal: space.x2, borderRadius: 8 },
    caseOn: { backgroundColor: colors.rowSelected },
    caseTitle: { flexShrink: 1 },
    form: { flex: 1, minWidth: 380, gap: space.x2, padding: space.x5 },
    center: { flex: 1, padding: space.x5 },
    section: { marginTop: space.x3 },
    line: { flexDirection: "row", alignItems: "center", gap: space.x2, borderWidth: 1, borderColor: colors.line, borderRadius: 8, paddingHorizontal: space.x2, paddingVertical: 4, backgroundColor: colors.ground },
    lineInput: { flex: 1, minWidth: 0, color: colors.text, fontSize: pointerType.ui, paddingVertical: 6, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null) },
    chip: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, maxWidth: 220 },
    chipPlain: { backgroundColor: colors.chipFill },
    chipMust: { backgroundColor: colors.okWash },
    chipNot: { backgroundColor: colors.critWash },
    chipChecked: { backgroundColor: colors.sharedWash },
    checkedText: { color: colors.sharedText, fontWeight: "600" },
    addRow: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
    last: { width: 280, gap: space.x2, padding: space.x5, borderLeftWidth: 1, borderLeftColor: colors.line, alignSelf: "stretch" },
    lastCompact: { width: "auto", borderLeftWidth: 0, borderTopWidth: 1, borderTopColor: colors.line },
    miss: { gap: 2, padding: space.x2, borderRadius: 8, backgroundColor: colors.critWash },
    markdown: { minHeight: 560, padding: space.x5, color: colors.text, fontFamily: mono, fontSize: pointerType.ui, lineHeight: 20, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null) },
    muted: { color: colors.muted },
    bad: { color: colors.critText, fontWeight: "600" },
    okText: { color: colors.okText, fontWeight: "600" },
    problem: { color: colors.critText },
    saved: { color: colors.okText },
    link: { color: colors.accentText },
  });
