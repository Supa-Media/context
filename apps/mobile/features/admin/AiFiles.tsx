/**
 * The AI tab's Files view: `@context-lc`'s `ai/` folder drawn as a library
 * (boards 5-7 of the AI tools plan, the owner, 2026-10-16), kept behind the
 * rail's quiet "Files" link since boards 8-16 put jobs first. The tree is the
 * folder's parts; the right is a table of the part picked, and a row opens
 * in place, where a skill or a setup is edited as Markdown and a test list
 * as a form or as Markdown, saved back to the same note. Whoever can edit
 * `@context-lc` can change anything here, and nothing else is a store: see
 * `./aiCatalog.ts`.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { Text, space, useThemedStyles, type Colors } from "../design";
import { noteHref } from "../console/nav";
import { useCompact } from "./AdminKit";
import { AiNoteEditor } from "./AiNoteEditor";
import { AiTestEditor } from "./AiTestEditor";
import { AttentionView, JobsTable, NotesTable, Primary, ResultsTable, SkillsTable } from "./AiViews";
import { RUN_TESTS_URL, attention, type AiCatalog, type AiNoteRow } from "./aiCatalog";
import { FILE_PARTS } from "./aiPlace";
import { Segments } from "./Segments";
import { useScores } from "./useAiNote";
import type { Id } from "@context/convex/_generated/dataModel";

export type AiView = (typeof FILE_PARTS)[number];

/** The tree's rows, in the order of the boards. */
const PARTS: readonly { key: AiView; label: string; folder: string | null }[] = [
  { key: "attention", label: "Needs attention", folder: null },
  { key: "jobs", label: "jobs", folder: "ai/production" },
  { key: "skills", label: "skills", folder: "ai/production/skills" },
  { key: "tests", label: "tests", folder: "ai/tests" },
  { key: "setups", label: "setups", folder: "ai/setups" },
  { key: "results", label: "results", folder: "ai/results" },
  { key: "other", label: "everything else", folder: "ai" },
];

const open = (url: string) => void Linking.openURL(url).catch(() => {});


/** What the right side shows over the table: a note opened in place, or a new one. */
type Opened = { kind: "note"; row: AiNoteRow } | { kind: "new"; folder: string } | null;

export function Library({
  workspaceId,
  catalog,
  view,
  onView,
  onSaved,
  days,
  initialOpen,
}: {
  days: number;
  /** A path to open in place on first draw, for the browser fixture. */
  initialOpen?: string;
  workspaceId: Id<"workspaces">;
  catalog: AiCatalog;
  view: AiView;
  onView: (view: AiView) => void;
  onSaved: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const router = useRouter();
  const [opened, setOpened] = useState<Opened>(() => {
    const all = [...catalog.skills, ...catalog.tests, ...catalog.setups, ...catalog.results, ...catalog.other];
    const row = initialOpen ? all.find((item) => item.path === initialOpen) : undefined;
    return row ? { kind: "note", row } : null;
  });
  const [query, setQuery] = useState("");
  const latest = useMemo(
    () => catalog.jobs.map((row) => row.latest?.path).filter((path): path is string => path !== undefined),
    [catalog],
  );
  const scores = useScores(workspaceId, latest);
  const needs = useMemo(() => attention(catalog, scores), [catalog, scores]);
  const counts: Record<AiView, number> = {
    attention: needs.failing.length + needs.untested.length + needs.unproved.length + needs.noSetup.length,
    jobs: catalog.jobs.length,
    skills: catalog.skills.length,
    tests: catalog.tests.length,
    setups: catalog.setups.length,
    results: catalog.results.length,
    other: catalog.other.length,
  };
  const go = (next: AiView) => {
    setOpened(null);
    setQuery("");
    onView(next);
  };
  const openRow = (row: AiNoteRow) => setOpened({ kind: "note", row });
  const openInNotes = (path: string) => router.push(noteHref(PINNED_CONTEXT_SLUG, path));
  const part = PARTS.find((item) => item.key === view)!;
  const closeAndRefresh = (saved: boolean) => {
    setOpened(null);
    if (saved) onSaved();
  };

  let body: ReactNode;
  if (opened !== null) {
    const path = opened.kind === "note" ? opened.row.path : null;
    const isTest = opened.kind === "note" ? opened.row.path.startsWith("ai/tests/") : opened.folder === "ai/tests";
    const lastRound = isTest && opened.kind === "note" ? catalog.results.find((result) => result.test === opened.row.name) ?? null : null;
    body = isTest ? (
      <AiTestEditor
        workspaceId={workspaceId}
        path={path}
        folder="ai/tests"
        lastRound={lastRound}
        onClose={closeAndRefresh}
        onOpenInNotes={openInNotes}
      />
    ) : (
      <AiNoteEditor
        workspaceId={workspaceId}
        path={path}
        folder={opened.kind === "new" ? opened.folder : part.folder ?? "ai"}
        crumb={part.label}
        row={opened.kind === "note" ? opened.row : null}
        tests={catalog.tests}
        onClose={closeAndRefresh}
        onOpenInNotes={openInNotes}
      />
    );
  } else if (view === "attention") {
    body = <AttentionView needs={needs} scores={scores} onOpen={openRow} onView={go} />;
  } else if (view === "jobs") {
    body = <JobsTable rows={catalog.jobs} scores={scores} days={days} onOpen={openRow} />;
  } else if (view === "skills") {
    body = <SkillsTable rows={catalog.skills} tests={catalog.tests} query={query} onQuery={setQuery} onOpen={openRow} onNew={() => setOpened({ kind: "new", folder: "ai/production/skills" })} />;
  } else if (view === "results") {
    body = <ResultsTable rows={catalog.results} query={query} onQuery={setQuery} onOpen={openRow} />;
  } else {
    const rows = view === "tests" ? catalog.tests : view === "setups" ? catalog.setups : catalog.other;
    const make = view === "tests" ? { label: "New test", folder: "ai/tests" } : view === "setups" ? { label: "New setup", folder: "ai/setups/texting-assistant" } : null;
    body = (
      <NotesTable
        noun={part.label}
        rows={rows}
        query={query}
        onQuery={setQuery}
        onOpen={openRow}
        newLabel={make?.label}
        onNew={make ? () => setOpened({ kind: "new", folder: make.folder }) : undefined}
      />
    );
  }

  return (
    <View style={[styles.frame, compact && styles.frameCompact]} testID="admin-ai">
      {compact ? (
        <Segments
          options={PARTS.map((item) => ({ key: item.key, label: item.key === "attention" ? "Attention" : item.label }))}
          value={view}
          onChange={go}
          counts={(key) => counts[key]}
          label="AI"
          testID="admin-ai-view"
        />
      ) : (
        <View style={styles.tree} role="tablist" aria-label="AI">
          {PARTS.map((item, index) => (
            <View key={item.key}>
              {index === 1 ? <Text variant="eyebrow" style={styles.treeHead}>ai/</Text> : null}
              <TreeRow label={item.label} count={counts[item.key]} on={item.key === view} alert={item.key === "attention" && counts.attention > 0} indent={index > 0} onPress={() => go(item.key)} testID={`admin-ai-view-${item.key}`} />
            </View>
          ))}
        </View>
      )}
      <View style={styles.main}>
        <View style={styles.showing}>
          <Text variant="meta" style={styles.showingText} numberOfLines={2}>
            Showing <Text variant="meta" style={styles.strong}>@context-lc {part.folder ?? "ai"}/</Text> · Everyone who can edit @context-lc can edit here
          </Text>
          <View style={styles.showingActions}>
            {part.folder ? (
              <Pressable role="link" onPress={() => openInNotes(part.folder!)} testID="admin-ai-open-folder">
                <Text variant="meta" style={styles.link}>Open in notes</Text>
              </Pressable>
            ) : null}
            <Primary label="Run tests" onPress={() => open(RUN_TESTS_URL)} testID="admin-ai-run" />
          </View>
        </View>
        {body}
      </View>
    </View>
  );
}

function TreeRow({
  label,
  count,
  on,
  alert,
  indent,
  onPress,
  testID,
}: {
  label: string;
  count: number;
  on: boolean;
  alert: boolean;
  indent: boolean;
  onPress: () => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable role="tab" aria-selected={on} onPress={onPress} style={[styles.treeRow, indent && styles.treeIndent, on && styles.treeOn]} testID={testID}>
      <Text variant="tree" style={on ? styles.strong : null}>{label}</Text>
      <Text variant="treeMeta" style={alert ? styles.alert : null}>{count}</Text>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    frame: { flexDirection: "row", gap: space.x5, alignItems: "flex-start" },
    frameCompact: { flexDirection: "column", gap: space.x3, alignItems: "stretch" },
    tree: { width: 220, flexShrink: 0, gap: 2, paddingTop: space.x1 },
    treeHead: { marginTop: space.x3, marginBottom: space.x1, paddingHorizontal: space.x3 },
    treeRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 7, paddingHorizontal: space.x3, borderRadius: 8 },
    treeIndent: { paddingLeft: space.x4 },
    treeOn: { backgroundColor: colors.rowSelected },
    alert: { color: colors.crit, fontWeight: "700" },
    main: { flex: 1, minWidth: 0, gap: space.x4 },
    showing: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      justifyContent: "space-between",
      gap: space.x3,
      paddingVertical: space.x2,
      paddingHorizontal: space.x4,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    showingText: { flexShrink: 1 },
    showingActions: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    strong: { color: colors.text, fontWeight: "600" },
    link: { color: colors.accentText },
  });
