/**
 * The AI tab's home (board 8, "every job, and the one next step for each"):
 * one row per job in the catalog, with what is live, how it scores, how big
 * its prompt is and the one thing to do next. On the right, the candidates
 * that beat live and wait for a person's yes, and what ran overnight. A row
 * opens the job's page; nothing here promotes anything.
 */

import { useMemo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text, space, useThemedStyles, type Colors } from "../design";
import { Box, Cell, Columns, Head, LinkText, PageHead, Quiet, Quietly, TableLine, pct, shortDay, type Column } from "./AiKit";
import { setupModels } from "./aiCatalog";
import { activity, jobPage, liveScore, liveSince, nextStep, sizeDelta, sizeLabel, type JobPage, type NextStep, type SetupScore } from "./aiModel";
import type { AiPlace } from "./aiPlace";
import type { AiScreenProps } from "./aiScreen";

const COLUMNS: readonly Column[] = [
  { label: "JOB", flex: 2 },
  { label: "LIVE SETUP", flex: 1.2 },
  { label: "SCORE", width: 80, align: "right" },
  { label: "PROMPT", width: 80, align: "right" },
  { label: "NEXT STEP", flex: 1.4 },
];

export function AiJobsHome(props: AiScreenProps) {
  const { catalog, reads, go } = props;
  const styles = useThemedStyles(makeStyles);
  const pages = useMemo(
    () =>
      catalog.jobs.flatMap((row) => {
        const page = jobPage(catalog, row.job.key, reads);
        return page === null ? [] : [page];
      }),
    [catalog, reads],
  );
  const waiting = useMemo(
    () => pages.flatMap((page) => page.candidates.filter((item) => item.status === "beat live").map((candidate) => ({ page, candidate }))),
    [pages],
  );
  const overnight = useMemo(() => activity(catalog, reads).slice(0, 4), [catalog, reads]);

  return (
    <View style={styles.wrap} testID="admin-ai-jobs">
      <PageHead
        title="Jobs"
        sub="One row per place AI runs. Jobs come from code."
        actions={<Quiet label="Improver: off · drafts only" onPress={() => go({ view: "helpers", helper: "improver" })} testID="admin-ai-improver" />}
        testID="admin-ai-jobs-head"
      />
      <Columns weights={[2, 1]}>
        <View style={styles.table} testID="admin-ai-jobs-table">
          <Head columns={COLUMNS} />
          {pages.map((page, index) => (
            <JobLine key={page.job.key} page={page} first={index === 0} last={index === pages.length - 1} go={go} />
          ))}
        </View>
        <View style={styles.side}>
          <Box
            title="Needs your yes"
            right={<Text variant="meta" testID="admin-ai-yes-count">{String(waiting.length)}</Text>}
            testID="admin-ai-needs-yes"
          >
            {waiting.length === 0 ? <Quietly testID="admin-ai-yes-none">Nothing is waiting for a person.</Quietly> : null}
            {waiting.map(({ page, candidate }) => {
              const delta = sizeDelta(candidate.size, candidate.baseSize);
              const head = `${pct(candidate.score?.score ?? null)} vs ${pct(candidate.liveScore?.score ?? null)} on ${candidate.run?.test ?? "its tests"}`;
              return (
                <View key={`${page.job.key}/${candidate.name}`} style={styles.card} testID={`admin-ai-yes-${candidate.name}`}>
                  <Text variant="rowTitle" numberOfLines={1}>{`${page.job.label}: ${candidate.name} beats ${page.live ?? "live"}`}</Text>
                  <Text variant="meta" numberOfLines={2}>{delta === null ? head : `${head}, ${delta} tokens`}</Text>
                  <LinkText
                    label="Compare and promote ›"
                    onPress={() => go({ view: "jobs", job: page.job.key, tab: "setups", compare: candidate.name })}
                    testID={`admin-ai-yes-${candidate.name}-compare`}
                  />
                </View>
              );
            })}
          </Box>
          <Box
            title="Overnight"
            right={<LinkText label="Activity ›" onPress={() => go({ view: "activity" })} testID="admin-ai-overnight-link" />}
            testID="admin-ai-overnight"
          >
            {overnight.length === 0 ? <Quietly testID="admin-ai-overnight-none">Nothing ran on its own yet.</Quietly> : null}
            {overnight.map((item, index) => (
              <View key={`${item.path}/${index}`} style={[styles.item, index > 0 && styles.itemRule]}>
                <Text variant="meta" numberOfLines={2}>
                  <Text variant="meta" style={styles.strong}>{item.who}</Text>
                  {` ${item.what}`}
                </Text>
                <Text variant="meta" numberOfLines={1}>{[shortDay(item.at), item.job].filter(Boolean).join(" · ")}</Text>
              </View>
            ))}
          </Box>
        </View>
      </Columns>
    </View>
  );
}

/** One job's row: the table line on a pointer, a two-line row on a phone. */
function JobLine({ page, first, last, go }: { page: JobPage; first: boolean; last: boolean; go: (place: AiPlace) => void }) {
  const { job, row } = page;
  const step = nextStep(page);
  const latest = page.runs.at(-1)?.read ?? null;
  const live = latest === null ? null : liveScore(latest, page.live);
  const failed = live?.gatesFailed.length ?? 0;
  const tokens = sizeLabel(row.setup?.size ?? null)?.replace(/ tokens$/, "") ?? null;
  const model = setupModels(row.setup) ?? job.model ?? null;
  const tests = row.tests.map((test) => test.name).join(", ");
  const sub = [model, tests].filter(Boolean).join(" · ") || null;
  const since = liveSince(row.setup);
  const liveName = page.live ?? liveNoPrompt(job.home, row.setup !== null);
  const next = (
    <NextCell
      key="next"
      step={step}
      testID={`admin-ai-job-${job.key}-next`}
      onPress={() => go(stepPlace(job.key, step))}
    />
  );
  return (
    <TableLine
      columns={COLUMNS}
      cells={[
        <Cell key="job" title={job.label} sub={sub} strong />,
        <Cell key="live" title={liveName} sub={since ? `since ${since}` : null} />,
        <Cell key="score" title={pct(live?.score ?? null)} sub={failed > 0 ? `${failed} case${failed === 1 ? "" : "s"} fell` : null} tone={scoreTone(live)} strong align="right" />,
        <Cell key="prompt" title={tokens ?? "—"} sub={tokens === null ? null : "tokens"} align="right" />,
        next,
      ]}
      title={job.label}
      sub={sub ?? undefined}
      trailing={next}
      first={first}
      last={last}
      onPress={() => go({ view: "jobs", job: job.key, tab: "overview", compare: null })}
      testID={`admin-ai-job-${job.key}`}
    />
  );
}

/** What a job with no live setup note says in its live column. */
function liveNoPrompt(home: JobPage["job"]["home"], hasSetup: boolean): string {
  if (home === "note") return hasSetup ? "production" : "no note";
  if (home === "code") return "in code";
  if (home === "none") return "no prompt";
  return "their own";
}

/** Red for a live setup whose gates broke, green when it is good enough. */
function scoreTone(live: SetupScore | null): "ok" | "warn" | undefined {
  if (live === null) return undefined;
  if (!live.gatesPassed) return "warn";
  return live.goodEnough ? "ok" : undefined;
}

/** The step a row's link opens: a job tab, or the comparison of a candidate. */
function stepPlace(job: string, step: NextStep): AiPlace {
  switch (step.kind) {
    case "review":
      return { view: "jobs", job, tab: "setups", compare: step.candidate ?? null };
    case "first-test":
      return { view: "jobs", job, tab: "cases", compare: null };
    case "run":
      return { view: "jobs", job, tab: "runs", compare: null };
    case "fix":
      return { view: "jobs", job, tab: "cases", compare: null };
    case "move-prompt":
    case "none":
      return { view: "jobs", job, tab: "overview", compare: null };
  }
}

/** The next step as a link, or plain text when there is nothing to do. */
function NextCell({ step, testID, onPress }: { step: NextStep; testID: string; onPress: () => void }) {
  if (step.kind === "none") return <Text variant="meta" numberOfLines={1}>{step.label}</Text>;
  return <LinkText label={step.label} onPress={onPress} testID={testID} />;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { gap: space.x4, minWidth: 0 },
    table: { minWidth: 0 },
    side: { gap: space.x4, minWidth: 0 },
    strong: { color: colors.text, fontWeight: "600" },
    card: { gap: space.x1, borderWidth: 1, borderColor: colors.line, borderRadius: 8, padding: space.x3, minWidth: 0 },
    item: { gap: space.x1, paddingVertical: space.x2, minWidth: 0 },
    itemRule: { borderTopWidth: 1, borderTopColor: colors.line },
  });
