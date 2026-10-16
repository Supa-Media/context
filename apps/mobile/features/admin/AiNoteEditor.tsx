/**
 * A skill, a setup or any other `ai/` note, edited in place on the AI tab: the
 * whole note as Markdown, front matter included, saved back to the same note
 * with the version it was read at. A new one asks for its name first. "Open in
 * notes" is still there for the full editor; nothing here needs it.
 */

import { useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button, Pill, Text, TextField, space, useColors, useThemedStyles, type Colors } from "../design";
import { Panel, useCompact } from "./AdminKit";
import { Primary } from "./AiViews";
import { provedBy, reachOf, type AiNoteRow } from "./aiCatalog";
import { messageOf, useAiNote } from "./useAiNote";

/** What a new note starts as, by the folder it goes in. */
export function starterFor(folder: string, title: string): string {
  const name = title.trim() || "New note";
  if (folder.startsWith("ai/production/skills")) {
    return `---\nreach: [tex]\n---\n\n# ${name}\n\nWhen this applies, in one line.\n\n- What to do first.\n- What never to do.\n`;
  }
  if (folder.startsWith("ai/setups/")) {
    return `---\njob: ${folder.split("/")[2] ?? ""}\nmodels:\n  main: anthropic/claude-haiku-5-5\nwhy: What this setup tries.\n---\n\n# ${name}\n`;
  }
  return `# ${name}\n`;
}

/** A file name from what somebody typed: lowercase words joined by hyphens. */
export function slugFor(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

export function AiNoteEditor({
  workspaceId,
  path,
  folder,
  crumb,
  row,
  tests,
  onClose,
  onOpenInNotes,
}: {
  workspaceId: Id<"workspaces">;
  /** null: a new note in `folder`. */
  path: string | null;
  folder: string;
  crumb: string;
  row: AiNoteRow | null;
  tests: readonly AiNoteRow[];
  onClose: (saved: boolean) => void;
  onOpenInNotes: (path: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const compact = useCompact();
  const [target, setTarget] = useState(path);
  const { state, save, reload } = useAiNote(workspaceId, path);
  const [draft, setDraft] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);

  useEffect(() => {
    // A fresh read replaces the draft only when nothing was typed over it.
    if (state.kind === "ready" && draft === null && path !== null) setDraft(state.text);
  }, [state, draft, path]);

  const isNew = target === null;
  const text = draft ?? (isNew ? starterFor(folder, title) : "");
  const dirty = state.kind === "ready" && (isNew ? title.trim() !== "" : draft !== null && draft !== state.text);

  async function onSave() {
    setProblem(null);
    const where = target ?? `${folder}/${slugFor(title)}.md`;
    if (isNew && slugFor(title) === "") {
      setProblem("Give it a name first.");
      return;
    }
    setBusy(true);
    try {
      await save(where, text);
      setTarget(where);
      setDraft(text);
      setSavedOnce(true);
    } catch (error: unknown) {
      setProblem(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  const name = row?.title ?? (isNew ? "" : target?.split("/").pop()?.replace(/\.md$/, "") ?? "");
  const proved = row ? provedBy(row, tests) : [];
  const isSkill = folder.startsWith("ai/production/skills") || (target ?? "").startsWith("ai/production/skills/");

  return (
    <View style={styles.stack} testID="admin-ai-editor">
      <View style={[styles.head, compact && styles.headCompact]}>
        <View style={styles.titleRow}>
          <Pressable role="link" onPress={() => onClose(savedOnce)} testID="admin-ai-editor-back">
            <Text variant="meta" style={styles.crumb}>{crumb} ›</Text>
          </Pressable>
          {isNew ? (
            <TextField
              label="Name"
              labelHidden
              placeholder={isSkill ? "Name the skill, e.g. Reply to an email" : "Name it"}
              value={title}
              onChangeText={setTitle}
              containerStyle={styles.nameField}
              testID="admin-ai-editor-name"
            />
          ) : (
            <Text variant="paneTitle" numberOfLines={1} style={styles.title}>{name}</Text>
          )}
          {isSkill && row ? reachOf(row).map((who) => <Pill key={who} tone="neutral">{who === "tex" ? "Tex" : "Every AI"}</Pill>) : null}
          {isSkill && row ? <Pill tone={proved.length > 0 ? "ok" : "neutral"}>{proved.length > 0 ? `proved by ${proved.map((test) => test.name).join(", ")}` : "no test covers it"}</Pill> : null}
        </View>
        <View style={styles.actions}>
          {target !== null ? <Button label="Open in notes" onPress={() => onOpenInNotes(target)} testID="admin-ai-editor-open" /> : null}
          <Button label={savedOnce && !dirty ? "Done" : "Cancel"} onPress={() => onClose(savedOnce)} testID="admin-ai-editor-cancel" />
          <Primary label={busy ? "Saving…" : "Save"} disabled={!dirty || busy || state.kind !== "ready" || state.readOnly} onPress={() => void onSave()} testID="admin-ai-editor-save" />
        </View>
      </View>
      {problem ? (
        <Text variant="meta" style={styles.problem} testID="admin-ai-editor-problem">
          {problem} {problem.startsWith("Somebody") ? <Text variant="meta" style={styles.link} onPress={() => { setDraft(null); reload(); }}>Reload</Text> : null}
        </Text>
      ) : null}
      {savedOnce && !dirty ? <Text variant="meta" style={styles.saved}>Saved to {target}</Text> : null}
      <Panel flush>
        {state.kind === "loading" ? (
          <Text variant="meta" style={styles.pad}>Opening…</Text>
        ) : state.kind === "failed" ? (
          <Text variant="meta" style={styles.pad}>{state.message}</Text>
        ) : (
          <TextInput
            multiline
            value={text}
            onChangeText={setDraft}
            editable={!state.readOnly}
            placeholderTextColor={colors.muted}
            style={styles.editor}
            textAlignVertical="top"
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            accessibilityLabel={`${name || "New note"}, as Markdown`}
            testID="admin-ai-editor-text"
          />
        )}
      </Panel>
      <Text variant="meta">
        {isSkill
          ? "The whole skill as Markdown. Tex reads it from this note the next time a text needs it; the next test round runs it too."
          : "The whole note as Markdown, front matter included."}
      </Text>
    </View>
  );
}

const mono = Platform.select({ web: "ui-monospace, SFMono-Regular, Menlo, monospace", ios: "Menlo", default: "monospace" });

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    stack: { gap: space.x3 },
    head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.x3, flexWrap: "wrap" },
    headCompact: { alignItems: "flex-start" },
    titleRow: { flexDirection: "row", alignItems: "center", gap: space.x2, flexShrink: 1, flexWrap: "wrap" },
    crumb: { color: colors.muted },
    title: { flexShrink: 1 },
    nameField: { minWidth: 260, flexGrow: 1 },
    actions: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    editor: {
      minHeight: 520,
      padding: space.x5,
      color: colors.text,
      fontFamily: mono,
      fontSize: 13,
      lineHeight: 20,
      ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null),
    },
    pad: { padding: space.x5 },
    problem: { color: colors.critText },
    saved: { color: colors.okText },
    link: { color: colors.accentText, textDecorationLine: "underline" },
  });
