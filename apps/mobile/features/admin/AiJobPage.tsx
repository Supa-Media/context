/**
 * A job's page (boards 8-13): what is live, the score over time, the tests on
 * the job, and the candidate setups beside it, with Golden cases, Setups and
 * Runs as its tabs. The Overview is the one place to see the whole loop; the
 * other tabs are the same data in full. See `./AiSection`.
 */

import { useState, type ReactNode } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { Text, space, useThemedStyles, type Colors } from "../design";
import { AiCases } from "./AiCases";
import { AiScoreChart } from "./AiScoreChart";
import { JOB_GROUPS, RUN_TESTS_URL, modelName, setupModels, type AiNoteRow, type ScoreRow } from "./aiCatalog";
import { jobPage, liveScore, liveSince, nextStep, promotedBy, runLabel, scoreHistory, sizeDelta, sizeLabel, type Candidate, type JobPage } from "./aiModel";
import type { JobTab } from "./aiPlace";
import type { AiScreenProps } from "./aiScreen";
import { Box, Cell, Columns, LinkText, NextLine, PageHead, Primary, Quiet, Quietly, StatStrip, StatusPill, TableLine, Head, cents, pct, shortDay, type Column, type Stat } from "./AiKit";

const CANDIDATE_COLUMNS: Column[] = [
  { label: "SETUP", flex: 1.3 },
  { label: "WHAT CHANGED", flex: 2 },
  { label: "SIZE Δ", width: 80, align: "right" },
  { label: "SCORE", width: 70, align: "right" },
  { label: "STATUS", width: 170 },
];

const SETUP_COLUMNS: Column[] = [...CANDIDATE_COLUMNS, { label: "CHANGED", width: 90, align: "right" }];

const RUN_COLUMNS: Column[] = [
  { label: "RUN", width: 90 },
  { label: "DAY", width: 100 },
  { label: "TEST", flex: 1 },
  { label: "LIVE", width: 80, align: "right" },
  { label: "BEST, PASSING EVERY BAR", flex: 1.4 },
  { label: "", width: 60, align: "right" },
];

const TABS: readonly JobTab[] = ["overview", "cases", "setups", "runs"];

/** `2026-10-14` → `Oct 14`; the day as a run's row shows it. */
function dayLabel(day: string | null): string {
  if (day === null) return "";
  const date = new Date(`${day}T00:00:00`);
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** A job's bar as a number of percent: `90` or `"90%"` in the test list's front matter, else 90. */
function barOf(tests: readonly AiNoteRow[]): number {
  const raw = tests[0]?.properties.bar;
  const value = Number(String(raw ?? "").replace("%", ""));
  return Number.isFinite(value) && value > 0 ? value : 90;
}

/** The models a setup names with the effort it runs at, as its MODEL line: `hard texts → Opus 5.5 · effort high`. */
function modelDetail(setup: AiNoteRow | null): string | undefined {
  if (setup === null) return undefined;
  const many = setup.properties.models;
  const map = many !== null && typeof many === "object" && !Array.isArray(many) ? (many as Record<string, unknown>) : {};
  const effortValue = map.effort ?? setup.properties.effort;
  const effort = typeof effortValue === "string" || typeof effortValue === "number" ? String(effortValue).trim() : "";
  const parts = Object.entries(map)
    .filter(([key]) => key !== "effort")
    .flatMap(([key, value]) => (typeof value === "string" && value.trim() !== "" ? [`${key.replace(/_/g, " ")} → ${modelName(value.trim())}`] : []));
  if (effort !== "") parts.push(`effort ${effort}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** The one line under a candidate's name: what it was based on, and who made it. */
function setupSub(candidate: Candidate): string | undefined {
  const parts = [candidate.basedOn ? `based on ${candidate.basedOn}` : null, candidate.madeBy].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * A job's page. Crumbs back to the jobs, the live setup's note and the test
 * run in the head, then the tabs; the Overview draws the stats, the next step,
 * the score chart, the tests and the candidates.
 */
export function AiJobPage(props: AiScreenProps & { job: string; tab: JobTab }) {
  const styles = useThemedStyles(makeStyles);
  const [showHidden, setShowHidden] = useState(false);
  const page = jobPage(props.catalog, props.job, props.reads);
  const goJobs = () => props.go({ view: "jobs", job: null, tab: "overview", compare: null });

  if (page === null) {
    return (
      <View style={styles.page} testID="admin-ai-job-missing">
        <Quietly>{`No job called ${props.job}.`}</Quietly>
        <LinkText label="Back to jobs ›" onPress={goJobs} testID="admin-ai-job-back" />
      </View>
    );
  }

  const { job, row } = page;
  const group = JOB_GROUPS.find((item) => item.key === job.group)?.label;
  const goTab = (tab: JobTab) => props.go({ view: "jobs", job: props.job, tab, compare: null });
  const openCandidate = (candidate: Candidate) =>
    candidate.status === "live" ? props.openInNotes(candidate.row.path) : props.go({ view: "jobs", job: props.job, tab: "setups", compare: candidate.name });

  const bar = barOf(row.tests);
  const barLabel = `${bar}%`;
  const lastRead = [...page.runs].reverse().find((run) => run.read !== null);
  const latestLive = lastRead?.read ? liveScore(lastRead.read, page.live) : null;
  const since = liveSince(row.setup);
  const promoter = promotedBy(row.setup);
  const liveLine = [since ? `since ${since}` : null, promoter ? `promoted by ${promoter}` : null].filter(Boolean).join(" · ");
  const speed = latestLive?.speed ?? null;

  const stats: Stat[] = [
    { label: "LIVE", value: page.live ?? (row.setup ? "production" : "none"), sub: liveLine || undefined },
    { label: "MODEL", value: setupModels(row.setup) ?? job.model ?? "—", sub: modelDetail(row.setup) },
    {
      label: "PROMPT",
      value: sizeLabel(row.setup?.size ?? null) ?? "—",
      sub: row.setup?.size != null ? `${row.setup.size.toLocaleString()} chars` : undefined,
    },
    {
      label: "SCORE",
      value: pct(latestLive?.score ?? null),
      tone: latestLive && !latestLive.gatesPassed ? "warn" : latestLive?.goodEnough ? "ok" : undefined,
      sub: lastRead ? `${lastRead.row.test}, bar ${barLabel}` : `bar ${barLabel}`,
    },
    {
      label: "COST · SPEED",
      value: cents(latestLive?.price ?? null),
      sub: speed !== null ? `per text · ${Number(speed.toFixed(1))} s` : "per text",
    },
  ];

  const step = nextStep(page);
  const next =
    step.kind === "review" && step.candidate
      ? { label: "Compare and promote", onPress: () => props.go({ view: "jobs", job: props.job, tab: "setups", compare: step.candidate! }) }
      : step.kind === "fix" || step.kind === "first-test"
        ? { label: "Open golden cases", onPress: () => goTab("cases") }
        : step.kind === "run"
          ? { label: "Run tests", onPress: () => goTab("runs") }
          : null;

  const hidden = page.candidates.filter((item) => item.status === "lost").length + page.retired.length;
  const shownCandidates = showHidden
    ? [...page.candidates, ...page.retired]
    : page.candidates.filter((item) => item.status !== "lost");
  const setupsToTry = [
    ...(row.setup ? [{ name: page.live ?? "live", path: row.setup.path }] : []),
    ...page.candidates
      .filter((item) => item.status !== "lost" && item.status !== "retired" && item.status !== "live")
      .map((item) => ({ name: item.name, path: item.row.path })),
  ];

  const tabLabel = (tab: JobTab): string => {
    switch (tab) {
      case "overview":
        return "Overview";
      case "cases":
        return `Golden cases · ${row.tests.length}`;
      case "setups":
        return `Setups · ${page.candidates.length}`;
      case "runs":
        return `Runs · ${page.runs.length}`;
    }
  };

  return (
    <View style={styles.page}>
      <PageHead
        crumbs={[{ label: "Jobs", onPress: goJobs }]}
        title={job.label}
        sub={group}
        testID="admin-ai-job-head"
        actions={
          <>
            {row.setup ? <Quiet label="Edit live setup" onPress={() => props.openInNotes(row.setup!.path)} testID="admin-ai-edit-live" /> : null}
            <Primary label="Run tests" onPress={() => goTab("runs")} testID="admin-ai-run-tests" />
          </>
        }
      />

      <View style={styles.tabs} accessibilityRole="tablist">
        {TABS.map((tab) => {
          const selected = props.tab === tab;
          return (
            <Pressable
              key={tab}
              role="tab"
              accessibilityState={{ selected }}
              onPress={() => goTab(tab)}
              style={[styles.tab, selected && styles.tabOn]}
              testID={`admin-ai-jobtab-${tab}`}
            >
              <Text variant="mini" numberOfLines={1} style={selected ? styles.tabLabelOn : styles.tabLabel}>
                {tabLabel(tab)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {props.tab === "overview" ? (
        <>
          <StatStrip stats={stats} testID="admin-ai-stats" />
          <NextLine action={next?.label} onAction={next?.onPress} testID="admin-ai-next">
            {step.label}
          </NextLine>
          <Columns weights={[2, 1]}>
            <Box title="Score over time">
              <AiScoreChart points={scoreHistory(page)} bar={bar} />
            </Box>
            <Box title="Tests on this job" testID="admin-ai-tests">
              {row.tests.length === 0 ? <Quietly>No tests yet.</Quietly> : null}
              {row.tests.map((test, index) => {
                const found = latestRunOf(page, test.name);
                return (
                  <View key={test.path} style={[styles.testRow, index > 0 && styles.ruled]} testID={`admin-ai-test-${test.name}`}>
                    <View style={styles.testMain}>
                      <Text variant="rowTitle" numberOfLines={1}>{test.name}</Text>
                      {test.lede ? <Text variant="meta" numberOfLines={1}>{test.lede}</Text> : null}
                    </View>
                    <View style={styles.figures}>
                      <Text variant="rowTitle" numberOfLines={1}>{pct(found?.score.score ?? null)}</Text>
                      <Text variant="meta" numberOfLines={1}>{dayLabel(found?.run.day ?? null)}</Text>
                    </View>
                  </View>
                );
              })}
            </Box>
          </Columns>
          <Box
            title="Candidates"
            testID="admin-ai-candidates"
            right={
              <LinkText
                label={`Retired and lost: ${hidden} · ${showHidden ? "hide" : "show"}`}
                onPress={() => setShowHidden((value) => !value)}
                testID="admin-ai-toggle-hidden"
              />
            }
          >
            <CandidateTable rows={shownCandidates} columns={CANDIDATE_COLUMNS} onOpen={openCandidate} />
          </Box>
        </>
      ) : null}

      {props.tab === "cases" ? (
        <AiCases
          workspaceId={props.workspaceId}
          job={props.job}
          tests={row.tests}
          setups={setupsToTry}
          reload={props.reload}
          me={props.me}
        />
      ) : null}

      {props.tab === "setups" ? (
        <Box title="Setups" testID="admin-ai-setups">
          <CandidateTable rows={[...page.candidates, ...page.retired]} columns={SETUP_COLUMNS} onOpen={openCandidate} changed />
        </Box>
      ) : null}

      {props.tab === "runs" ? <RunsTab page={page} openInNotes={props.openInNotes} /> : null}
    </View>
  );
}

/** The newest run of a test that was read, with its live score; null when none has been read. */
function latestRunOf(page: JobPage, test: string): { run: ScoreRow; score: { score: number | null } } | null {
  for (const { row, read } of [...page.runs].reverse()) {
    if (row.test !== test || read === null) continue;
    return { run: row, score: { score: liveScore(read, page.live)?.score ?? null } };
  }
  return null;
}

/** A table of candidates: a setup, what changed, its size against what it was based on, its score and its status. */
function CandidateTable({ rows, columns, onOpen, changed = false }: { rows: readonly Candidate[]; columns: readonly Column[]; onOpen: (candidate: Candidate) => void; changed?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  if (rows.length === 0) return <Quietly testID="admin-ai-no-candidates">No setups are being tried yet.</Quietly>;
  return (
    <View style={styles.table}>
      <Head columns={columns} />
      {rows.map((candidate, index) => {
        const delta = sizeDelta(candidate.size, candidate.baseSize) ?? "—";
        const cheaper = (candidate.size ?? 0) < (candidate.baseSize ?? 0);
        const cells: ReactNode[] = [
          <Cell key="setup" title={candidate.name} sub={setupSub(candidate)} strong />,
          <Cell key="what" title={candidate.change ?? "—"} />,
          <Cell key="delta" title={delta} tone={delta.startsWith("−") ? "ok" : undefined} align="right" />,
          <Cell key="score" title={pct(candidate.score?.score ?? null)} align="right" />,
          <StatusPill key="status" status={candidate.status} cheaper={cheaper} />,
        ];
        if (changed) cells.push(<Cell key="changed" title={shortDay(candidate.row.updatedAt)} align="right" />);
        return (
          <TableLine
            key={candidate.row.path}
            columns={columns}
            cells={cells}
            title={candidate.name}
            sub={setupSub(candidate)}
            trailing={<StatusPill status={candidate.status} cheaper={cheaper} />}
            first={index === 0}
            last={index === rows.length - 1}
            onPress={() => onOpen(candidate)}
            testID={`admin-ai-candidate-${candidate.name}`}
          />
        );
      })}
    </View>
  );
}

/** The Runs tab: the Action that runs a round, then every round on the job's tests, newest first. */
function RunsTab({ page, openInNotes }: { page: JobPage; openInNotes: (path: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const runs = [...page.runs].reverse();
  return (
    <>
      <Box title="Run the tests" testID="admin-ai-run-box">
        <Quietly>A run is the AI Benchmark Action on GitHub; it writes its scores note into ai/results/. Ask Claude to run it, or start it from GitHub.</Quietly>
        <View style={styles.actionRow}>
          <Quiet label="Open the Action" onPress={() => void Linking.openURL(RUN_TESTS_URL)} testID="admin-ai-open-action" />
        </View>
      </Box>
      <Box title="Runs" testID="admin-ai-runs">
        {runs.length === 0 ? <Quietly testID="admin-ai-no-runs">No runs yet.</Quietly> : <Head columns={RUN_COLUMNS} />}
        {runs.map((run, index) => {
          const live = run.read ? liveScore(run.read, page.live) : null;
          return (
            <TableLine
              key={run.row.path}
              columns={RUN_COLUMNS}
              cells={[
                <Cell key="run" title={runLabel(run.row)} strong />,
                <Cell key="day" title={dayLabel(run.row.day)} />,
                <Cell key="test" title={run.row.test} />,
                <Cell key="live" title={pct(live?.score ?? null)} align="right" />,
                <Cell key="best" title={run.read === null ? "—" : (run.read.best ?? "none passed every bar")} />,
                <LinkText key="open" label="Open" onPress={() => openInNotes(run.row.path)} testID={`admin-ai-run-open-${index}`} />,
              ]}
              title={runLabel(run.row)}
              sub={[dayLabel(run.row.day), run.row.test].filter(Boolean).join(" · ")}
              trailing={<LinkText label="Open" onPress={() => openInNotes(run.row.path)} testID={`admin-ai-run-open-small-${index}`} />}
              first={index === 0}
              last={index === runs.length - 1}
              testID={`admin-ai-run-${index}`}
            />
          );
        })}
      </Box>
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { gap: space.x4, minWidth: 0 },
    tabs: { flexDirection: "row", gap: space.x5, borderBottomWidth: 1, borderBottomColor: colors.line, flexWrap: "wrap" },
    tab: { paddingVertical: space.x2, borderBottomWidth: 2, borderBottomColor: "transparent", marginBottom: -1 },
    tabOn: { borderBottomColor: colors.accent },
    tabLabel: { color: colors.muted },
    tabLabelOn: { color: colors.text, fontWeight: "700" },
    testRow: { flexDirection: "row", alignItems: "center", gap: space.x3, paddingVertical: space.x2 },
    ruled: { borderTopWidth: 1, borderTopColor: colors.line },
    testMain: { flex: 1, minWidth: 0, gap: 2 },
    figures: { alignItems: "flex-end", gap: 2, flexShrink: 0 },
    table: { minWidth: 0 },
    actionRow: { flexDirection: "row" },
  });
