/**
 * An experiment beside live (boards 10 and 20): how sure the difference is,
 * what it still needs before it can go live, the replies where the two
 * differ, a pass/fail grid for every case with live's own history beside it,
 * and the prompt's actual change with unchanged lines folded. Make it live is
 * the only one-way step on the page; it stays off until every gate holds and
 * then waits for a person's yes. See `./AiSection`.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text, space, useThemedStyles, type Colors } from "../design";
import { compact, jobPage, promotedText, promptDiff, tokensOf, withFrontKey, type Candidate, type RunRead } from "./aiModel";
import type { AiScreenProps } from "./aiScreen";
import { Box, Columns, LinkText, OneWay, PageHead, Primary, Quiet, Quietly, cents, pct } from "./AiKit";
import { messageOf, useNoteText, useNoteWriter } from "./useAiNote";
import { gapLabel, setupTitle } from "./aiExperiments";
import { goLiveGates, liveHistory } from "./aiCompareModel";
import { AiCompareCases, liveCell, outcome } from "./AiCompareCases";
import { AiCompareReplies } from "./AiCompareReplies";

/** A prompt's diff draws this many lines at most; the rest are a count. */
const MAX_DIFF_LINES = 400;

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
export function verdict(
  candidate: Candidate,
  read: RunRead | null,
  liveName: string,
  label = candidate.name,
  groupOf: (test: string) => string = (test) => test,
): { lead: string; rest: string } {
  if (read === null || candidate.score === null) return { lead: `${label} has not been run beside live yet.`, rest: "" };
  // Over every case group's round when it ran in more than one, each case named with its group.
  const several = candidate.rounds.length > 1;
  const named = several
    ? candidate.rounds.map((round) => ({ group: groupOf(round.run.test), ...changedCases(candidate, round.read, liveName) }))
    : [{ group: "", ...changedCases(candidate, read, liveName) }];
  const say = (pick: "fixed" | "broke"): string | null => {
    const parts = named.filter((item) => item[pick].length > 0).map((item) => (several ? `${item.group} ${listCases(item[pick])}` : listCases(item[pick])));
    return parts.length === 0 ? null : parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  };
  const fixed = say("fixed");
  const broke = say("broke");
  let lead: string;
  if (fixed === null && broke === null) lead = `${label} changes no case.`;
  else if (fixed !== null && broke === null) lead = `${label} fixes ${fixed} and breaks nothing.`;
  else lead = `${label} ${[fixed ? `fixes ${fixed}` : null, broke ? `breaks ${broke}` : null].filter(Boolean).join(" and ")}.`;

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

  // With runs passed over every group, "How sure" carries the score; one group's percentage would only repeat part of it.
  const score = candidate.livePassed !== null ? [] : [`${pct(mine.score)} vs ${pct(theirs?.score ?? null)} on ${candidate.run ? groupOf(candidate.run.test) : "its tests"}`];
  const said = [...score, ...extra];
  const rest = said.length === 0 ? "" : ` ${said.join(" · ").replace(/^./, (first) => first.toUpperCase())}.`;
  return { lead, rest };
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
  const v = verdict(candidate, read, liveName, setupTitle(candidate), (test) => page.row.tests.find((item) => item.name === test)?.title || test);
  const title = setupTitle(candidate);
  const historyIn = (test: string, until: string) => (question: number) => liveHistory(page, test, question, liveName, until);
  const groupTitleOf = (test: string) => page.row.tests.find((item) => item.name === test)?.title || test;
  const gates = goLiveGates(page, candidate);
  const ready = gates.every((gate) => gate.ok);
  const sure = candidate.gap === null || candidate.passed === null || candidate.livePassed === null
    ? null
    : {
        word: candidate.gap.verdict === "better" ? "Better than live" : candidate.gap.verdict === "worse" ? "Worse than live" : "Too close to call",
        tone: candidate.gap.verdict === "better" ? styles.ok : candidate.gap.verdict === "worse" ? styles.crit : styles.warn,
        line: `${candidate.passed.passed} of ${candidate.passed.runs} runs vs ${candidate.livePassed.passed} of ${candidate.livePassed.runs} · ${gapLabel(candidate.gap)}`,
        note: candidate.gap.verdict === "too close" ? "The gap is inside what live moves by on its own from one round to the next, so it could be luck." : null,
      };
  const promote = async () => {
    if (liveRow === null || mineText === null) return;
    setBusy(true);
    setError(null);
    try {
      await write(liveRow.path, () => promotedText(mineText, { job: props.job, from: candidate.name, day: new Date().toISOString().slice(0, 10), by: props.me }));
      await write(candidate.row.path, (text) => withFrontKey(text ?? mineText, "status", "live"));
      const was = page.candidates.find((item) => item.name === page.live);
      if (was && was.name !== candidate.name) await write(was.row.path, (text) => (text === null ? null : withFrontKey(text, "status", "retired")));
      props.reload();
      goJob("overview");
    } catch (failure) {
      setError(messageOf(failure));
      setBusy(false);
    }
  };

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
        title={`${title} vs live`}
        actions={
          <>
            <Quiet label="Run both again" onPress={() => goJob("runs")} testID="admin-ai-compare-run" />
            <Primary
              label={busy ? "Making it live…" : "Make it live"}
              onPress={() => setConfirming(true)}
              disabled={!ready || candidate.status === "live" || liveRow === null || mineText === null || busy}
              testID="admin-ai-compare-promote"
            />
          </>
        }
        testID="admin-ai-compare-head"
      />
      <Columns weights={[1, 1]}>
        {[
          <Box key="sure" title="How sure" testID="admin-ai-compare-sure">
            {sure !== null ? (
              <>
                <Text variant="rowTitle" style={sure.tone} testID="admin-ai-compare-sure-word">{sure.word}</Text>
                <Text variant="meta">{sure.line}</Text>
                {sure.note ? <Text variant="meta" style={styles.muted}>{sure.note}</Text> : null}
              </>
            ) : null}
            <View style={styles.verdict} testID="admin-ai-compare-verdict">
              <Text variant="body" style={styles.verdictText}>
                <Text variant="body" style={styles.strong}>{v.lead}</Text>
                {v.rest}
              </Text>
            </View>
          </Box>,
          <Box key="gates" title="Before it can go live" testID="admin-ai-compare-gates">
            {gates.map((gate) => (
              <View key={gate.label} style={styles.gate}>
                <Text variant="meta" style={gate.ok ? styles.ok : styles.crit}>{gate.ok ? "✓" : "✗"}</Text>
                <Text variant="meta" style={styles.gateText}>{gate.label}</Text>
                {gate.note ? <Text variant="meta" style={styles.muted}>{gate.note}</Text> : null}
              </View>
            ))}
            <View style={styles.promote}>
              {confirming ? (
                <>
                  <OneWay testID="admin-ai-compare-warn">
                    {`Making it live changes what everyone using ${job.label} gets, from the next message. Today's live is kept as the way back, and you can make it live again from here.`}
                  </OneWay>
                  <View style={styles.row}>
                    <Quiet tone="crit" label={`Yes, make ${title} live`} onPress={() => void promote()} disabled={busy} testID="admin-ai-compare-yes" />
                    <Quiet label="Not now" onPress={() => setConfirming(false)} testID="admin-ai-compare-no" />
                  </View>
                </>
              ) : (
                <Text variant="meta" style={styles.muted}>{ready ? "Every gate holds. Make it live asks once more before it changes anything." : "Make it live turns on when every line above is ticked. Run tests runs the groups not yet run."}</Text>
              )}
              {error ? <Quietly testID="admin-ai-compare-error">{error}</Quietly> : null}
            </View>
          </Box>,
        ]}
      </Columns>
      <AiCompareReplies
        workspaceId={props.workspaceId}
        rounds={candidate.rounds.map((round) => ({ scoresPath: round.run.path, group: groupTitleOf(round.run.test), history: historyIn(round.run.test, round.run.path) }))}
        setup={candidate.name}
        setupLabel={title}
        liveName={liveName}
        testID="admin-ai-compare-replies"
      />
      {candidate.rounds.length === 0 ? (
        <Box title="Case by case" testID="admin-ai-compare-left">
          <Quietly testID="admin-ai-compare-unrun">Not run beside live yet.</Quietly>
        </Box>
      ) : (
        candidate.rounds.map((round) => (
          <AiCompareCases
            key={round.run.path}
            setup={candidate.name}
            liveName={liveName}
            groupTitle={groupTitleOf(round.run.test)}
            run={round.run}
            read={round.read}
            history={historyIn(round.run.test, round.run.path)}
            openInNotes={props.openInNotes}
          />
        ))
      )}
      <Box
        title="What changed"
        right={<Text variant="meta" numberOfLines={1}>{`${liveText?.length.toLocaleString() ?? "—"} → ${mineText?.length.toLocaleString() ?? "—"} chars`}</Text>}
        testID="admin-ai-compare-right"
      >
        {rightBody}
      </Box>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { gap: space.x4, minWidth: 0 },
    verdict: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: space.x3, marginTop: space.x2 },
    ok: { color: colors.okText, fontWeight: "600" },
    crit: { color: colors.critText, fontWeight: "600" },
    warn: { color: colors.warnText, fontWeight: "600" },
    gate: { flexDirection: "row", alignItems: "baseline", gap: space.x2, paddingVertical: 3 },
    gateText: { flex: 1, minWidth: 0, color: colors.text },
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
