/**
 * The AI tab's tables: what needs attention, the jobs, the skills, the scored
 * rounds, and the plain lists of tests, setups and everything else. Each row
 * opens its note in place (`AiNoteEditor`, `AiTestEditor`). See `./AiSection`.
 */

import { useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Pill, Text, TextField, space, useThemedStyles, type Colors } from "../design";
import { Panel, useCompact } from "./AdminKit";
import { ListRow, TableHead, TableRow, type Column } from "./AdminTable";
import {
  COST_FEATURE,
  JOB_GROUPS,
  jobQuality,
  matches,
  provedBy,
  reachOf,
  setupModels,
  skillFolder,
  type AiNoteRow,
  type Attention,
  type JobRow,
  type ScoreRow,
  type ScoresRead,
} from "./aiCatalog";
import type { AiView } from "./AiSection";
import { mergeFeatures } from "./aiCosts";
import { useAiCostsData } from "./aiCostsData";
import { relativeTime } from "./report";

/** A long list draws this many rows; the search box finds the rest. */
const SHOWN = 200;

const changed = (row: AiNoteRow) => (row.updatedAt === null ? "" : relativeTime(row.updatedAt));

// -- shared pieces ------------------------------------------------------------

/** The page's one filled button size: the console's mini, in the accent. */
export function Primary({ label, onPress, disabled = false, testID }: { label: string; onPress: () => void; disabled?: boolean; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable role="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={[styles.primary, disabled && styles.primaryOff]} testID={testID}>
      <Text variant="mini" style={styles.primaryLabel}>{label}</Text>
    </Pressable>
  );
}

function Find({ noun, count, value, onChange, action }: { noun: string; count: number; value: string; onChange: (value: string) => void; action?: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.findRow}>
      <TextField
        label="Find"
        labelHidden
        placeholder={`Search ${count} ${noun} by name or what they're for…`}
        value={value}
        onChangeText={onChange}
        containerStyle={styles.find}
        testID="admin-ai-find"
      />
      {action}
    </View>
  );
}

function Tile({ value, label, tone = "neutral", onPress, testID }: { value: number; label: string; tone?: "crit" | "neutral"; onPress?: () => void; testID?: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable role={onPress ? "button" : undefined} onPress={onPress} style={[styles.tile, tone === "crit" && value > 0 && styles.tileCrit]} testID={testID}>
      <Text variant="statValue">{value}</Text>
      <Text variant="meta">{label}</Text>
    </Pressable>
  );
}

function Tiles({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.tiles}>{children}</View>;
}

/** A row that opens its note: a table row on a pointer, a two-line row on a phone. */
function Row({ columns, cells, title, sub, trailing, first, last, onPress, testID }: {
  columns: readonly Column[];
  cells: readonly ReactNode[];
  title: string;
  sub?: string;
  trailing?: ReactNode;
  first: boolean;
  last: boolean;
  onPress?: () => void;
  testID: string;
}) {
  const compact = useCompact();
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable role="button" disabled={!onPress} onPress={onPress} style={(state) => ((state as { hovered?: boolean }).hovered && onPress ? styles.hover : null)} testID={testID}>
      {compact ? <ListRow first={first} title={title} sub={sub} trailing={trailing} /> : <TableRow columns={columns} cells={cells} last={last} />}
    </Pressable>
  );
}

function Name({ title, sub }: { title: string; sub?: string }) {
  return (
    <View style={{ gap: 2, minWidth: 0 }}>
      <Text variant="rowTitle" numberOfLines={1}>{title}</Text>
      {sub ? <Text variant="meta" numberOfLines={1}>{sub}</Text> : null}
    </View>
  );
}

function Group({ label }: { label: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.group}>
      <Text variant="eyebrow">{label}</Text>
    </View>
  );
}

function Reach({ row }: { row: AiNoteRow }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.pills}>
      {reachOf(row).map((who) => (
        <Pill key={who} tone="neutral">{who === "tex" ? "Tex" : "Every AI"}</Pill>
      ))}
    </View>
  );
}

function Proved({ tests }: { tests: readonly AiNoteRow[] }) {
  const styles = useThemedStyles(makeStyles);
  if (tests.length === 0) return <Text variant="meta">no test</Text>;
  return <Text variant="meta" style={styles.ok} numberOfLines={1}>{tests.map((test) => test.name).join(", ")}</Text>;
}

function Quality({ row, read }: { row: JobRow; read?: ScoresRead }) {
  const quality = jobQuality(row, read);
  return <Pill tone={quality.tone === "none" ? "neutral" : quality.tone}>{quality.label}</Pill>;
}

// -- Needs attention ------------------------------------------------------------

export function AttentionView({ needs, scores, onOpen, onView }: {
  needs: Attention;
  scores: ReadonlyMap<string, ScoresRead>;
  onOpen: (row: AiNoteRow) => void;
  onView: (view: AiView) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const columns: Column[] = [{ label: "What", flex: 3 }, { label: "Why", flex: 3 }, { label: "", width: 160, align: "right" }];
  const items: { key: string; title: string; why: string; trailing: ReactNode; onPress?: () => void }[] = [
    ...needs.failing.map((row) => {
      const read = row.latest ? scores.get(row.latest.path) : undefined;
      const miss = read?.misses[0];
      return {
        key: `failing-${row.job.key}`,
        title: row.job.label,
        why: miss ? `Last round failed q${miss.question}: ${miss.rule} (${miss.runs})` : "Last round did not pass every bar",
        trailing: <Quality row={row} read={read} />,
        onPress: row.latest ? () => onOpen(row.latest!) : undefined,
      };
    }),
    ...needs.untested.map((row) => ({
      key: `untested-${row.job.key}`,
      title: row.job.label,
      why: "No test list grades this job",
      trailing: <Pill tone="neutral">No test yet</Pill>,
      onPress: () => onView("tests"),
    })),
    ...needs.noSetup.map((row) => ({
      key: `nosetup-${row.job.key}`,
      title: row.job.label,
      why: `No setup note at ai/production/${row.job.key}.md`,
      trailing: <Pill tone="neutral">No setup</Pill>,
    })),
    ...needs.unproved.map((skill) => ({
      key: `unproved-${skill.path}`,
      title: skill.title,
      why: "No test list covers this skill",
      trailing: <Pill tone="neutral">Skill</Pill>,
      onPress: () => onOpen(skill),
    })),
  ];
  return (
    <>
      <Tiles>
        <Tile value={needs.failing.length} label="jobs failing a test" tone="crit" testID="admin-ai-tile-failing" />
        <Tile value={needs.untested.length} label="jobs with no test" onPress={() => onView("jobs")} />
        <Tile value={needs.unproved.length} label="skills no test covers" onPress={() => onView("skills")} />
        <Tile value={needs.noSetup.length} label="jobs with no setup note" onPress={() => onView("jobs")} />
      </Tiles>
      <Panel flush>
        {items.length === 0 ? (
          <Text variant="meta" style={styles.empty}>Nothing needs attention.</Text>
        ) : (
          <>
            {compact ? null : <TableHead columns={columns} />}
            {items.map((item, index) => (
              <Row
                key={item.key}
                columns={columns}
                cells={[<Name key="n" title={item.title} />, <Text key="w" variant="meta" numberOfLines={2}>{item.why}</Text>, item.trailing]}
                title={item.title}
                sub={item.why}
                trailing={item.trailing}
                first={index === 0}
                last={index === items.length - 1}
                onPress={item.onPress}
                testID={`admin-ai-attention-${item.key}`}
              />
            ))}
          </>
        )}
      </Panel>
    </>
  );
}

// -- Jobs -----------------------------------------------------------------------

const JOB_COLUMNS: Column[] = [
  { label: "Job", flex: 3 },
  { label: "Who sees it", flex: 2 },
  { label: "Model", flex: 2 },
  { label: "Quality", flex: 2 },
  { label: "Uses", width: 80, align: "right", hint: "In the console's window, from AI costs" },
  { label: "Cost", width: 80, align: "right", hint: "In the console's window, from AI costs" },
];

export function JobsTable({ rows, scores, days, onOpen }: { rows: readonly JobRow[]; scores: ReadonlyMap<string, ScoresRead>; days: number; onOpen: (row: AiNoteRow) => void }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const { report, cloudflare } = useAiCostsData(days);
  const usage = useMemo(() => new Map(mergeFeatures(report?.features ?? [], cloudflare).map((feature) => [feature.feature, feature])), [report, cloudflare]);
  return (
    <>
      <Panel flush testID="admin-ai-jobs">
        {compact ? null : <TableHead columns={JOB_COLUMNS} />}
        {JOB_GROUPS.map((group) => {
          const own = rows.filter((row) => row.job.group === group.key);
          return (
            <View key={group.key} testID={`admin-ai-group-${group.key}`}>
              <Group label={group.label} />
              {own.map((row, index) => {
                const feature = COST_FEATURE[row.job.key];
                const used = feature ? usage.get(feature) : undefined;
                const read = row.latest ? scores.get(row.latest.path) : undefined;
                const tests = row.tests.map((test) => test.name).join(" · ");
                const model = setupModels(row.setup) ?? (row.job.key === "connected-ais" ? "theirs" : "—");
                return (
                  <Row
                    key={row.job.key}
                    columns={JOB_COLUMNS}
                    cells={[
                      <Name key="n" title={row.job.label} sub={tests || (row.setup ? undefined : "no setup note")} />,
                      <Text key="w" variant="meta" numberOfLines={2}>{row.job.where}</Text>,
                      <Text key="m" variant="meta" numberOfLines={1}>{model}</Text>,
                      <Quality key="q" row={row} read={read} />,
                      <Text key="u" variant="meta" style={styles.num}>{used ? used.uses.toLocaleString() : "—"}</Text>,
                      <Text key="c" variant="meta" style={styles.num}>{used ? `$${used.costUsd.toFixed(2)}` : "—"}</Text>,
                    ]}
                    title={row.job.label}
                    sub={[model, tests].filter(Boolean).join(" · ")}
                    trailing={<Quality row={row} read={read} />}
                    first={index === 0}
                    last={false}
                    onPress={row.setup ? () => onOpen(row.setup!) : undefined}
                    testID={`admin-ai-job-${row.job.key}`}
                  />
                );
              })}
            </View>
          );
        })}
      </Panel>
      <Text variant="meta">
        A row opens the job's live setup. Jobs are added in code with a setup note and a test list, never from this page. Tex by text and the app assistant share one cost line.
      </Text>
    </>
  );
}

// -- Skills ---------------------------------------------------------------------

const SKILL_COLUMNS: Column[] = [
  { label: "Skill", flex: 4 },
  { label: "Who gets it", flex: 2 },
  { label: "Proved by", flex: 2 },
  { label: "Changed", width: 90, align: "right" },
];

export function SkillsTable({ rows, tests, query, onQuery, onOpen, onNew }: {
  rows: readonly AiNoteRow[];
  tests: readonly AiNoteRow[];
  query: string;
  onQuery: (query: string) => void;
  onOpen: (row: AiNoteRow) => void;
  onNew: () => void;
}) {
  const compact = useCompact();
  const found = useMemo(() => rows.filter((row) => matches(row, query)), [rows, query]);
  const groups = useMemo(() => {
    const by = new Map<string, AiNoteRow[]>();
    for (const row of found.slice(0, SHOWN)) {
      const folder = skillFolder(row);
      by.set(folder, [...(by.get(folder) ?? []), row]);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [found]);
  const unproved = rows.filter((row) => provedBy(row, tests).length === 0).length;
  const everyAi = rows.filter((row) => reachOf(row).includes("mcp")).length;
  return (
    <>
      <Find noun="skills" count={rows.length} value={query} onChange={onQuery} action={<Primary label="New skill" onPress={onNew} testID="admin-ai-new" />} />
      <Tiles>
        <Tile value={rows.length} label="skills" />
        <Tile value={unproved} label="no test covers them" tone="crit" />
        <Tile value={everyAi} label="given to every AI" />
      </Tiles>
      <Panel flush testID="admin-ai-skills">
        {compact ? null : <TableHead columns={SKILL_COLUMNS} />}
        {found.length === 0 ? <Group label={rows.length === 0 ? "No skills yet" : "Nothing matches"} /> : null}
        {groups.map(([folder, own]) => (
          <View key={folder || "top"}>
            {groups.length > 1 || folder !== "" ? <Group label={`${folder || "skills"} · ${own.length}`} /> : null}
            {own.map((row, index) => (
              <Row
                key={row.path}
                columns={SKILL_COLUMNS}
                cells={[<Name key="n" title={row.title} sub={row.lede} />, <Reach key="r" row={row} />, <Proved key="p" tests={provedBy(row, tests)} />, <Text key="c" variant="meta">{changed(row)}</Text>]}
                title={row.title}
                sub={row.lede}
                trailing={<Reach row={row} />}
                first={index === 0}
                last={false}
                onPress={() => onOpen(row)}
                testID={`admin-ai-row-${row.name}`}
              />
            ))}
          </View>
        ))}
        {found.length > SHOWN ? <Group label={`First ${SHOWN} of ${found.length}; search narrows it`} /> : null}
      </Panel>
    </>
  );
}

// -- Tests, setups, everything else -------------------------------------------------

const NOTE_COLUMNS: Column[] = [{ label: "Note", flex: 4 }, { label: "Where", flex: 2 }, { label: "Changed", width: 90, align: "right" }];

export function NotesTable({ noun, rows, query, onQuery, onOpen, newLabel, onNew }: {
  noun: string;
  rows: readonly AiNoteRow[];
  query: string;
  onQuery: (query: string) => void;
  onOpen: (row: AiNoteRow) => void;
  newLabel?: string;
  onNew?: () => void;
}) {
  const compact = useCompact();
  const found = useMemo(() => rows.filter((row) => matches(row, query)), [rows, query]);
  return (
    <>
      <Find noun={noun} count={rows.length} value={query} onChange={onQuery} action={newLabel && onNew ? <Primary label={newLabel} onPress={onNew} testID="admin-ai-new" /> : undefined} />
      <Panel flush testID={`admin-ai-${noun.replace(/\W+/g, "-")}`}>
        {compact ? null : <TableHead columns={NOTE_COLUMNS} />}
        {found.length === 0 ? <Group label={rows.length === 0 ? "Nothing here yet" : "Nothing matches"} /> : null}
        {found.slice(0, SHOWN).map((row, index) => {
          const where = row.path.split("/").slice(1, -1).join("/");
          return (
            <Row
              key={row.path}
              columns={NOTE_COLUMNS}
              cells={[<Name key="n" title={row.title} sub={row.lede} />, <Text key="w" variant="meta" numberOfLines={1}>{where}</Text>, <Text key="c" variant="meta">{changed(row)}</Text>]}
              title={row.title}
              sub={row.lede || where}
              first={index === 0}
              last={index === Math.min(found.length, SHOWN) - 1}
              onPress={() => onOpen(row)}
              testID={`admin-ai-row-${row.name}`}
            />
          );
        })}
      </Panel>
    </>
  );
}

// -- Results --------------------------------------------------------------------

const RESULT_COLUMNS: Column[] = [{ label: "Round", flex: 3 }, { label: "Setup", flex: 2 }, { label: "Score", flex: 2 }, { label: "Day", width: 100, align: "right" }];

export function ResultsTable({ rows, query, onQuery, onOpen }: { rows: readonly ScoreRow[]; query: string; onQuery: (query: string) => void; onOpen: (row: AiNoteRow) => void }) {
  const compact = useCompact();
  const found = useMemo(() => rows.filter((row) => matches(row, query)), [rows, query]);
  return (
    <>
      <Find noun="rounds" count={rows.length} value={query} onChange={onQuery} />
      <Panel flush testID="admin-ai-results">
        {compact ? null : <TableHead columns={RESULT_COLUMNS} />}
        {found.length === 0 ? <Group label={rows.length === 0 ? "No rounds scored yet" : "Nothing matches"} /> : null}
        {found.slice(0, SHOWN).map((row, index) => {
          const passed = row.goodEnough === "yes" || row.goodEnough === "true";
          const score = row.score === null ? <Text variant="meta">in the note</Text> : <Pill tone={passed ? "ok" : "warn"}>{`${row.score}${row.gates ? ` · gates ${row.gates}` : ""}`}</Pill>;
          return (
            <Row
              key={row.path}
              columns={RESULT_COLUMNS}
              cells={[<Name key="n" title={row.test} sub={row.name} />, <Text key="s" variant="meta">{row.setup ?? "—"}</Text>, score, <Text key="d" variant="meta">{row.day ?? ""}</Text>]}
              title={`${row.test}${row.setup ? `, ${row.setup}` : ""}`}
              sub={row.day ?? undefined}
              trailing={score}
              first={index === 0}
              last={index === Math.min(found.length, SHOWN) - 1}
              onPress={() => onOpen(row)}
              testID={`admin-ai-row-${row.name}`}
            />
          );
        })}
      </Panel>
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    primary: { backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14, alignItems: "center", justifyContent: "center" },
    primaryOff: { opacity: 0.4 },
    primaryLabel: { color: colors.ink, fontWeight: "700" },
    findRow: { flexDirection: "row", alignItems: "center", gap: space.x3 },
    find: { flex: 1 },
    tiles: { flexDirection: "row", flexWrap: "wrap", gap: space.x3 },
    tile: {
      flexGrow: 1,
      flexBasis: 160,
      gap: 2,
      paddingVertical: space.x3,
      paddingHorizontal: space.x4,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
    },
    tileCrit: { borderColor: colors.critBorder, backgroundColor: colors.critWash },
    group: { paddingHorizontal: space.x5, paddingVertical: space.x2, backgroundColor: colors.chipFill, borderBottomWidth: 1, borderBottomColor: colors.line },
    pills: { flexDirection: "row", flexWrap: "wrap", gap: space.x1 },
    ok: { color: colors.okText },
    num: { fontVariant: ["tabular-nums"] },
    hover: { backgroundColor: colors.chipFill },
    empty: { padding: space.x5 },
  });
