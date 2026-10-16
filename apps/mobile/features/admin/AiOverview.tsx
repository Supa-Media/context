/**
 * The AI tab's overview (board 12, "how the whole system is doing"): five
 * tiles, one per part of the system, each opening its page; then every change
 * tried and whether it helped, and each job's score over time. Every figure is
 * read from the catalog and the scores notes already read (`reads`), so the
 * page makes no request of its own.
 */

import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text, space, useThemedStyles, type Colors } from "../design";
import { provedBy } from "./aiCatalog";
import { AI_HELPERS, jobPage, scoreHistory, type Candidate, type JobPage, type ScorePoint } from "./aiModel";
import { Box, Cell, Columns, Head, PageHead, Quiet, Quietly, StatusPill, TableLine, pct, type Column } from "./AiKit";
import type { AiScreenProps } from "./aiScreen";

/** Rounds to one decimal, so `93.3` against `100` reads `+6.7 pts`, and whole points drop the `.0`. */
export function pointsLabel(delta: number | null): string {
  if (delta === null) return "—";
  const rounded = Math.round(delta * 10) / 10;
  if (rounded === 0) return "0 pts";
  return `${rounded > 0 ? "+" : "−"}${Number(Math.abs(rounded).toFixed(1))} pts`;
}

/** A candidate's points against live in the same round, when both scored. */
function deltaOf(candidate: Candidate): number | null {
  const mine = candidate.score?.score ?? null;
  const theirs = candidate.liveScore?.score ?? null;
  return mine === null || theirs === null ? null : mine - theirs;
}

/** A change that beat live is ok, one that lost is crit, a tie is plain. */
function toneOf(delta: number | null): "ok" | "crit" | undefined {
  if (delta === null || delta === 0) return undefined;
  return delta > 0 ? "ok" : "crit";
}

interface Change {
  jobKey: string;
  jobLabel: string;
  candidate: Candidate;
  /** Points, the candidate's score less live's in the same round; null when live has none. */
  delta: number | null;
}

const CHANGE_COLUMNS: readonly Column[] = [
  { label: "CHANGE", flex: 2 },
  { label: "JOB", flex: 1 },
  { label: "RESULT", width: 80, align: "right" },
  { label: "KEPT?", width: 110 },
];

const JOB_COLUMNS: readonly Column[] = [
  { label: "JOB", flex: 1.4 },
  { label: "LAST RUNS", flex: 1 },
  { label: "NOW", width: 70, align: "right" },
];

/** A job's last few rounds as small bars, oldest left; a round with no score is a flat stub. */
function Spark({ points }: { points: readonly ScorePoint[] }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.spark}>
      {points.map((point, index) => (
        <View
          key={`${point.label}-${index}`}
          style={[styles.bar, { height: 4 + ((point.score ?? 0) / 100) * 18 }, point.score === null && styles.barEmpty]}
        />
      ))}
    </View>
  );
}

/** One of the five figures at the top: a title, the number, and what it means, each part a link to its page. */
function Tile({ label, value, onPress, testID, children }: { label: string; value: string; onPress: () => void; testID: string; children: ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable role="button" accessibilityLabel={label} onPress={onPress} style={styles.tile} testID={testID}>
      <Text variant="rowTitle" numberOfLines={1}>{label}</Text>
      <Text variant="statValue" numberOfLines={1}>{value}</Text>
      {children}
    </Pressable>
  );
}

/**
 * Board 12: the whole AI tab in one view. The five tiles open their pages; the
 * two boxes say what was tried and whether it helped, and how each job's score
 * has moved.
 */
export function AiOverview(props: AiScreenProps) {
  const styles = useThemedStyles(makeStyles);
  const { catalog, reads, go } = props;

  const untested = catalog.jobs.filter((row) => row.tests.length === 0);
  const unproved = catalog.skills.filter((skill) => provedBy(skill, catalog.tests).length === 0);
  const pages = catalog.jobs.flatMap((row) => {
    const page = jobPage(catalog, row.job.key, reads);
    return page === null ? [] : [{ key: row.job.key, page }];
  });

  const changes: Change[] = pages
    .flatMap(({ key, page }) =>
      [...page.candidates, ...page.retired]
        .filter((candidate) => candidate.score !== null)
        .map((candidate) => ({
          jobKey: key,
          jobLabel: page.job.label,
          candidate,
          delta: deltaOf(candidate),
        })),
    )
    .sort((a, b) => (b.candidate.row.updatedAt ?? 0) - (a.candidate.row.updatedAt ?? 0));
  const tried = pages.reduce((count, { page }) => count + page.candidates.length + page.retired.length, 0);

  const openChange = ({ jobKey, candidate }: Change) => go({ view: "jobs", job: jobKey, tab: "setups", compare: candidate.name });
  const jobsPage = () => go({ view: "jobs", job: null, tab: "overview", compare: null });

  return (
    <View style={styles.page}>
      <PageHead
        title="Overview"
        testID="admin-ai-overview-head"
        actions={<Quiet label="Improver: off · drafts only" onPress={() => go({ view: "helpers", helper: "improver" })} testID="admin-ai-improver" />}
      />

      <View style={styles.tiles}>
        <Tile label="Golden cases" value={String(catalog.tests.length)} onPress={() => go({ view: "files", part: "tests" })} testID="admin-ai-tile-cases">
          <Text variant="meta" numberOfLines={2}>test lists of golden cases, set by people.</Text>
          {untested.length > 0 ? (
            <Pressable role="link" onPress={jobsPage} testID="admin-ai-cases-none">
              <Text variant="meta" numberOfLines={1} style={styles.crit}>{`${untested.length} jobs have none ›`}</Text>
            </Pressable>
          ) : null}
        </Tile>
        <Tile label="Jobs" value={String(catalog.jobs.length)} onPress={jobsPage} testID="admin-ai-tile-jobs">
          <Text variant="meta" numberOfLines={2}>
            places AI answers people.
            {untested.length > 0 ? <Text variant="meta" style={styles.crit}>{` ${untested.length} with no cases`}</Text> : null}
          </Text>
        </Tile>
        <Tile label="Helper agents" value={String(AI_HELPERS.length)} onPress={() => go({ view: "helpers", helper: null })} testID="admin-ai-tile-helpers">
          <Text variant="meta" numberOfLines={2}>{AI_HELPERS.map((helper) => helper.label).join(", ")}</Text>
        </Tile>
        <Tile label="Skills" value={String(catalog.skills.length)} onPress={() => go({ view: "skills", skill: null })} testID="admin-ai-tile-skills">
          <Text variant="meta" numberOfLines={2}>
            how-tos a job reads when it needs one.
            {unproved.length > 0 ? <Text variant="meta" style={styles.warn}>{` ${unproved.length} no case proves`}</Text> : null}
          </Text>
        </Tile>
        <Tile label="Setups tried" value={String(catalog.setups.length)} onPress={jobsPage} testID="admin-ai-tile-setups">
          <Text variant="meta" numberOfLines={2}>{`${catalog.retired.length} retired`}</Text>
        </Tile>
      </View>

      <Text variant="meta" style={styles.line}>
        Golden cases judge every setup → a job reads skills and calls tools and helper agents → the improver drafts changes → a person promotes
      </Text>

      <Columns weights={[1, 1]}>
        <Box title="What worked, what didn't" right={<Text variant="meta">{`${tried} changes tried`}</Text>} testID="admin-ai-changes">
          {changes.length === 0 ? (
            <Quietly testID="admin-ai-changes-empty">No change has been measured yet.</Quietly>
          ) : (
            <>
              <Head columns={CHANGE_COLUMNS} />
              {changes.map((item, index) => {
                const { candidate } = item;
                const sub = candidate.madeBy ? `${candidate.name} · ${candidate.madeBy}` : candidate.name;
                const result = pointsLabel(item.delta);
                return (
                  <TableLine
                    key={candidate.row.path}
                    columns={CHANGE_COLUMNS}
                    title={candidate.change ?? candidate.name}
                    sub={sub}
                    trailing={<Text variant="meta">{result}</Text>}
                    first={index === 0}
                    last={index === changes.length - 1}
                    onPress={() => openChange(item)}
                    testID={`admin-ai-change-${candidate.name}`}
                    cells={[
                      <Cell key="change" strong title={candidate.change ?? candidate.name} sub={sub} />,
                      <Cell key="job" title={item.jobLabel} />,
                      <Cell key="result" strong title={result} tone={toneOf(item.delta)} align="right" />,
                      <StatusPill key="kept" status={candidate.status} />,
                    ]}
                  />
                );
              })}
            </>
          )}
        </Box>

        <Box title="Each job over time" right={<Text variant="meta">score on its golden cases</Text>} testID="admin-ai-jobs-over-time">
          <Head columns={JOB_COLUMNS} />
          {pages.map(({ key, page }, index) => (
            <JobLine key={key} page={page} first={index === 0} last={index === pages.length - 1} onPress={() => go({ view: "jobs", job: key, tab: "overview", compare: null })} />
          ))}
        </Box>
      </Columns>
    </View>
  );
}

/** One job's row in "Each job over time": its last rounds as bars, and its latest score. */
function JobLine({ page, first, last, onPress }: { page: JobPage; first: boolean; last: boolean; onPress: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const history = scoreHistory(page);
  const scored = [...history].reverse().find((point) => point.score !== null)?.score ?? null;
  const hasRuns = page.runs.length > 0;
  return (
    <TableLine
      columns={JOB_COLUMNS}
      title={page.job.label}
      first={first}
      last={last}
      onPress={onPress}
      testID={`admin-ai-job-${page.job.key}`}
      trailing={<Text variant="meta">{hasRuns ? pct(scored) : "—"}</Text>}
      cells={[
        <Cell key="job" strong title={page.job.label} />,
        hasRuns ? (
          <Spark key="runs" points={history.slice(-8)} />
        ) : (
          <Text key="runs" variant="meta" numberOfLines={1}>{page.row.tests.length === 0 ? "no cases yet" : "not run yet"}</Text>
        ),
        <Text key="now" variant="meta" numberOfLines={1} style={[styles.right, scored !== null && scored < 100 && styles.warn]}>
          {hasRuns ? pct(scored) : "—"}
        </Text>,
      ]}
    />
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { gap: space.x4, minWidth: 0 },
    tiles: { flexDirection: "row", flexWrap: "wrap", gap: space.x3 },
    tile: {
      flexBasis: 160,
      flexGrow: 1,
      minWidth: 0,
      gap: space.x2,
      padding: space.x4,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 10,
      backgroundColor: colors.surface,
    },
    line: { textAlign: "center", color: colors.muted, paddingVertical: space.x1 },
    crit: { color: colors.critText, fontWeight: "600" },
    warn: { color: colors.warnText, fontWeight: "600" },
    right: { textAlign: "right" },
    spark: { flexDirection: "row", alignItems: "flex-end", gap: 2, height: 22 },
    bar: { width: 5, backgroundColor: colors.accent, borderRadius: 1 },
    barEmpty: { backgroundColor: colors.line },
  });
