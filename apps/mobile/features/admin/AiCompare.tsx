/**
 * A candidate setup beside live (board 10, "Compare a candidate with live, then
 * promote"): one verdict line, a pass/fail grid for every test case, and the
 * prompt's actual change with unchanged lines folded. Promote is the only
 * one-way step on the page and waits for a person's yes. See `./AiSection`.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text, space, useThemedStyles, type Colors } from "../design";
import { compact, jobPage, promotedText, promptDiff, tokensOf, withFrontKey, type Candidate, type CaseCell, type CaseRow, type RunRead, type SetupScore } from "./aiModel";
import type { AiScreenProps } from "./aiScreen";
import { Box, Cell, Columns, Head, LinkText, OneWay, PageHead, Primary, Quiet, Quietly, TableLine, cents, pct, type Column } from "./AiKit";
import { messageOf, useNoteText, useNoteWriter } from "./useAiNote";

/** The cases that always show; the rest fold once both setups passed every run in them. */
const FOLD_AFTER = 6;
/** A prompt's diff draws this many lines at most; the rest are a count. */
const MAX_DIFF_LINES = 400;

type Outcome = "pass" | "fail" | null;

/** A setup's result on one case: passed every run, failed one, or not run. */
const outcome = (cell: CaseCell | undefined): Outcome => (cell === undefined ? null : cell.passed === cell.runs ? "pass" : "fail");

/** Live's cell on a case: under its name, else the `production` column a round names when live has no setup file. */
const liveCell = (row: CaseRow, liveName: string): CaseCell | undefined => row.cells[liveName] ?? row.cells.production;

/** `[5]` → `case 5`; `[5, 7, 9]` → `cases 5, 7 and 9`. */
const listCases = (questions: readonly number[]): string =>
  questions.length === 1 ? `case ${questions[0]}` : `cases ${questions.slice(0, -1).join(", ")} and ${questions[questions.length - 1]}`;

/** The cases a candidate fixes (passed every run where live did not) and breaks (the reverse). */
function changedCases(candidate: Candidate, read: RunRead, liveName: string): { fixed: number[]; broke: number[] } {
  if (read.cases === null) {
    // A round scored before the case table: only the failed gates are known.
    const mine = candidate.score?.gatesFailed ?? [];
    const theirs = candidate.liveScore?.gatesFailed ?? [];
    return {
      fixed: theirs.filter((question) => !mine.includes(question)).sort((a, b) => a - b),
      broke: mine.filter((question) => !theirs.includes(question)).sort((a, b) => a - b),
    };
  }
  const fixed: number[] = [];
  const broke: number[] = [];
  for (const row of read.cases) {
    const mine = outcome(row.cells[candidate.name]);
    const theirs = outcome(liveCell(row, liveName));
    if (mine === "pass" && theirs === "fail") fixed.push(row.question);
    if (mine === "fail" && theirs === "pass") broke.push(row.question);
  }
  return { fixed, broke };
}

/** A difference as words, or null when the two are within a tenth of each other or either is unknown. */
function change(mine: number | null, theirs: number | null, words: (diff: number) => string): string | null {
  if (mine === null || theirs === null || Math.abs(mine - theirs) <= Math.abs(theirs) * 0.1) return null;
  return words(mine - theirs);
}

/**
 * The one line on top of the page: what the candidate fixes and breaks against
 * live, then its score, size, cost and speed beside live's. No score yet is a
 * line of its own. `liveName` is the live setup's name, the column the case
 * table names it by.
 */
export function verdict(candidate: Candidate, read: RunRead | null, liveName: string): { lead: string; rest: string } {
  if (read === null || candidate.score === null) return { lead: `${candidate.name} has not been run beside live yet.`, rest: "" };
  const { fixed, broke } = changedCases(candidate, read, liveName);
  const verbs = [fixed.length > 0 ? `fixes ${listCases(fixed)}` : null, broke.length > 0 ? `breaks ${listCases(broke)}` : null].filter(Boolean);
  let lead: string;
  if (verbs.length === 0) lead = `${candidate.name} changes no case.`;
  else if (fixed.length > 0 && broke.length === 0) lead = `${candidate.name} fixes ${listCases(fixed)} and breaks nothing.`;
  else lead = `${candidate.name} ${verbs.join(" and ")}.`;

  const mine = candidate.score;
  const theirs = candidate.liveScore;
  const extra: string[] = [];
  if (candidate.size !== null && candidate.baseSize !== null) {
    const delta = tokensOf(candidate.size) - tokensOf(candidate.baseSize);
    extra.push(delta === 0 ? "same size" : `${compact(Math.abs(delta))} tokens ${delta < 0 ? "shorter" : "longer"}`);
  }
  const cost = change(mine.price, theirs?.price ?? null, (diff) => `costs ${cents(Math.abs(diff))} ${diff > 0 ? "more" : "less"}`);
  const speed = change(mine.speed, theirs?.speed ?? null, (diff) => `${Number(Math.abs(diff).toFixed(1))} s ${diff > 0 ? "slower" : "faster"}`);
  if (cost === null && speed === null) {
    const known = mine.price !== null && theirs?.price != null && mine.speed !== null && theirs?.speed != null;
    if (known) extra.push("same cost and speed");
  } else extra.push(...[cost, speed].filter((item): item is string => item !== null));

  const rest = ` ${pct(mine.score)} vs ${pct(theirs?.score ?? null)} on ${candidate.run?.test ?? "its tests"}${extra.map((item) => ` · ${item}`).join("")}.`;
  return { lead, rest };
}

/** The rule a setup broke on one case, from its "Why gates failed" lines. */
const ruleFor = (setup: SetupScore | null, question: number): string | null => setup?.misses.find((miss) => miss.question === question)?.rule ?? null;

/** One setup's runs on a case: a small square per run, passed in the accent and failed in red. */
function Runs({ cell }: { cell: CaseCell | undefined }) {
  const styles = useThemedStyles(makeStyles);
  if (cell === undefined) return <Text variant="meta">—</Text>;
  return (
    <View style={styles.runs}>
      {Array.from({ length: cell.runs }, (_, index) => (
        <View key={index} style={[styles.run, index < cell.passed ? styles.runPass : styles.runFail]} />
      ))}
    </View>
  );
}

/**
 * A candidate setup beside live: the verdict, the case grid (a failing case
 * opens the reply that broke it), and the prompt's change with a Promote that
 * asks for a yes first. Crumbs back to the job and its tabs in the head.
 */
export function AiCompare(props: AiScreenProps & { job: string; setup: string }) {
  const styles = useThemedStyles(makeStyles);
  const page = jobPage(props.catalog, props.job, props.reads);
  const candidate = page?.candidates.find((item) => item.name === props.setup) ?? page?.retired.find((item) => item.name === props.setup) ?? null;
  const liveRow = page?.row.setup ?? null;
  const liveName = page?.live ?? "live";
  const mineText = useNoteText(props.workspaceId, candidate?.row.path ?? null);
  const liveText = useNoteText(props.workspaceId, liveRow?.path ?? null);
  const write = useNoteWriter(props.workspaceId);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const diff = useMemo(
    () => (liveText === null || mineText === null ? [] : promptDiff(liveText, mineText, showAll ? 100000 : 2)),
    [liveText, mineText, showAll],
  );

  if (page === null || candidate === null) {
    const back = page === null ? () => props.go({ view: "jobs", job: null, tab: "overview", compare: null }) : () => props.go({ view: "jobs", job: props.job, tab: "setups", compare: null });
    return (
      <View style={styles.page} testID="admin-ai-compare-missing">
        <Quietly>{page === null ? `No job called ${props.job}.` : `No setup called ${props.setup} on this job.`}</Quietly>
        <LinkText label={page === null ? "Back to jobs ›" : `Back to ${page.job.label} ›`} onPress={back} testID="admin-ai-compare-back" />
      </View>
    );
  }

  const { job } = page;
  const goJob = (tab: "overview" | "runs") => props.go({ view: "jobs", job: props.job, tab, compare: null });
  const read = candidate.run === null ? null : (props.reads.get(candidate.run.path) ?? null);
  const v = verdict(candidate, read, liveName);
  const test = candidate.run?.test ?? "its tests";
  const cases = read?.cases ?? null;
  const rows = cases ?? [];
  const shown = rows.filter((row, index) => index < FOLD_AFTER || outcome(row.cells[candidate.name]) === "fail" || outcome(liveCell(row, liveName)) === "fail");
  const columns: Column[] = [{ label: "CASE", flex: 1 }, { label: liveName.toUpperCase(), width: 110 }, { label: candidate.name.toUpperCase(), width: 110 }];
  const runsEach = cases === null ? null : Math.max(0, ...cases.flatMap((row) => Object.values(row.cells).map((cell) => cell.runs)));
  const caseMeta = [runsEach !== null ? `${runsEach} runs each` : null, read?.judge ? `judge ${read.judge}` : null].filter(Boolean).join(" · ");
  const run = candidate.run;
  const picked = cases?.find((row) => row.question === open) ?? null;
  const pickedSetup = picked === null ? null : outcome(picked.cells[candidate.name]) === "fail" ? candidate.name : outcome(liveCell(picked, liveName)) === "fail" ? liveName : null;
  const pickedRule = picked === null || pickedSetup === null ? null : ruleFor(pickedSetup === candidate.name ? candidate.score : candidate.liveScore, picked.question);

  const promote = async () => {
    if (liveRow === null || mineText === null) return;
    setBusy(true);
    setError(null);
    try {
      await write(liveRow.path, () => promotedText(mineText, { job: props.job, from: candidate.name, day: new Date().toISOString().slice(0, 10), by: props.me }));
      await write(candidate.row.path, (text) => withFrontKey(text ?? mineText, "status", "live"));
      const was = page.candidates.find((item) => item.name === page.live);
      if (was && was.name !== candidate.name) await write(was.row.path, (text) => withFrontKey(text ?? "", "status", "was live"));
      props.reload();
      goJob("overview");
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  };

  const leftBody: ReactNode =
    read === null ? (
      <Quietly testID="admin-ai-compare-unrun">Not run beside live yet.</Quietly>
    ) : cases === null ? (
      <>
        <Quietly testID="admin-ai-compare-old">This round was scored before the case-by-case table; only failed gates are known.</Quietly>
        {[
          { name: candidate.name, misses: candidate.score?.misses ?? [] },
          { name: liveName, misses: candidate.liveScore?.misses ?? [] },
        ].map((item) => (
          <Text key={item.name} variant="meta" numberOfLines={2}>
            {`${item.name}: ${item.misses.map((miss) => `case ${miss.question} ${miss.rule}`).join("; ") || "no failed gates"}`}
          </Text>
        ))}
      </>
    ) : (
      <>
        <Head columns={columns} />
        {shown.map((row, index) => {
          const mine = outcome(row.cells[candidate.name]);
          const theirs = outcome(liveCell(row, liveName));
          const failing = mine === "fail" || theirs === "fail";
          const failCell = mine === "fail" ? row.cells[candidate.name] : liveCell(row, liveName);
          const sub = failing && failCell ? `${ruleFor(mine === "fail" ? candidate.score : candidate.liveScore, row.question) ?? "failed a gate"} · ${failCell.passed} of ${failCell.runs} runs` : undefined;
          return (
            <TableLine
              key={row.question}
              testID={`admin-ai-compare-case-${row.question}`}
              columns={columns}
              first={index === 0}
              last={index === shown.length - 1}
              title={`${row.question}. ${row.title}`}
              sub={sub}
              selected={open === row.question}
              onPress={failing ? () => setOpen(row.question) : undefined}
              cells={[
                <Cell key="case" title={`${row.question}. ${row.title}`} sub={sub} strong={failing} />,
                <Runs key="live" cell={liveCell(row, liveName)} />,
                <Runs key="mine" cell={row.cells[candidate.name]} />,
              ]}
            />
          );
        })}
        {rows.length > shown.length ? <Quietly testID="admin-ai-compare-folded">{`${rows.length - shown.length} more cases, all passing`}</Quietly> : null}
        {picked !== null && pickedSetup !== null ? (
          <View style={styles.detail} testID="admin-ai-compare-detail">
            <Text variant="meta" numberOfLines={2}>
              <Text variant="meta" style={styles.strong}>{`Case ${picked.question}, ${pickedSetup}: `}</Text>
              {pickedRule ?? "failed a gate"}
            </Text>
            {run ? <LinkText label="Open the scores ›" onPress={() => props.openInNotes(run.path)} testID="admin-ai-compare-open" /> : null}
          </View>
        ) : null}
      </>
    );

  const rightBody: ReactNode =
    liveRow === null ? (
      <Quietly>Nothing is live on this job yet, so there is nothing to compare with.</Quietly>
    ) : liveText === null || mineText === null ? (
      <Quietly>Reading both prompts…</Quietly>
    ) : (
      <>
        <View>
          {diff.slice(0, MAX_DIFF_LINES).map((line, index) =>
            line.kind === "folded" ? (
              <Pressable key={index} role="button" onPress={() => setShowAll(true)} testID="admin-ai-compare-fold">
                <Text variant="mono" style={styles.muted}>{`— ${line.count} lines unchanged ▸`}</Text>
              </Pressable>
            ) : (
              <Text key={index} variant="mono" style={line.kind === "gone" ? styles.gone : line.kind === "added" ? styles.added : styles.same}>
                {line.kind === "gone" ? `- ${line.text}` : line.kind === "added" ? `+ ${line.text}` : line.text}
              </Text>
            ),
          )}
        </View>
        {diff.length > MAX_DIFF_LINES ? <Quietly>{`${diff.length - MAX_DIFF_LINES} more lines not shown.`}</Quietly> : null}
        <LinkText label={showAll ? "Fold unchanged lines" : "Show everything"} onPress={() => setShowAll((was) => !was)} testID="admin-ai-compare-all" />
      </>
    );

  return (
    <View style={styles.page} testID="admin-ai-compare">
      <PageHead
        crumbs={[
          { label: "Jobs", onPress: () => props.go({ view: "jobs", job: null, tab: "overview", compare: null }) },
          { label: job.label, onPress: () => goJob("overview") },
        ]}
        title={`${candidate.name} vs ${liveName}`}
        actions={
          <>
            <Quiet label="Run both again" onPress={() => goJob("runs")} testID="admin-ai-compare-run" />
            <Primary
              label={busy ? "Promoting…" : `Promote ${candidate.name}`}
              onPress={() => setConfirming(true)}
              disabled={candidate.status === "live" || liveRow === null || mineText === null || busy}
              testID="admin-ai-compare-promote"
            />
          </>
        }
        testID="admin-ai-compare-head"
      />
      <View style={styles.verdict} testID="admin-ai-compare-verdict">
        <Text variant="body" style={styles.verdictText}>
          <Text variant="body" style={styles.strong}>{v.lead}</Text>
          {v.rest}
        </Text>
      </View>
      <Columns weights={[1, 1]}>
        {[
          <Box key="cases" title={`${test.charAt(0).toUpperCase()}${test.slice(1)}, case by case`} right={<Text variant="meta" numberOfLines={1}>{caseMeta}</Text>} testID="admin-ai-compare-left">
            {leftBody}
          </Box>,
          <Box
            key="changed"
            title="What changed"
            right={<Text variant="meta" numberOfLines={1}>{`${liveText?.length.toLocaleString() ?? "—"} → ${mineText?.length.toLocaleString() ?? "—"} chars`}</Text>}
            testID="admin-ai-compare-right"
          >
            {rightBody}
            <View style={styles.promote}>
              {confirming ? (
                <>
                  <OneWay testID="admin-ai-compare-warn">
                    {`Promote replaces ${job.label}'s live setup for everyone, from the next message. ${liveName} is kept as the way back, and you can promote it again from the job page.`}
                  </OneWay>
                  <View style={styles.row}>
                    <Quiet tone="crit" label={`Yes, make ${candidate.name} live`} onPress={() => void promote()} disabled={busy} testID="admin-ai-compare-yes" />
                    <Quiet label="Not now" onPress={() => setConfirming(false)} testID="admin-ai-compare-no" />
                  </View>
                </>
              ) : null}
              {error ? <Quietly testID="admin-ai-compare-error">{error}</Quietly> : null}
            </View>
          </Box>,
        ]}
      </Columns>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { gap: space.x4, minWidth: 0 },
    verdict: { borderLeftWidth: 3, borderLeftColor: colors.accent, paddingLeft: space.x3, paddingVertical: space.x1 },
    verdictText: { color: colors.text },
    strong: { color: colors.text, fontWeight: "600" },
    muted: { color: colors.muted },
    same: { color: colors.muted },
    gone: { color: colors.critText, textDecorationLine: "line-through" },
    added: { color: colors.okText },
    runs: { flexDirection: "row", gap: 3 },
    run: { width: 22, height: 14, borderRadius: 3 },
    runPass: { backgroundColor: colors.accentDim },
    runFail: { backgroundColor: colors.critBorder },
    detail: { borderWidth: 1, borderColor: colors.line, borderRadius: 8, padding: space.x3, gap: space.x2, marginTop: space.x2 },
    promote: { gap: space.x3, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space.x3 },
    row: { flexDirection: "row", flexWrap: "wrap", gap: space.x2 },
  });
