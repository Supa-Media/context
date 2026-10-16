/**
 * One case group's round on Compare (boards 10 and 20): live's runs and the
 * experiment's on every case, with live's own history beside each, so a case
 * that flips on live reads as one. A failing case opens the rule that broke
 * it. Compare draws one of these for each case group that ran the experiment.
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Text, space, useThemedStyles, type Colors } from "../design";
import { Box, Cell, Head, LinkText, Quietly, TableLine, type Column } from "./AiKit";
import { historyLabel } from "./aiCompareModel";
import type { ScoreRow } from "./aiCatalog";
import type { CaseCell, CaseRow, RunRead, SetupScore } from "./aiModel";

/** The cases that always show; the rest fold once both setups passed every run in them. */
const FOLD_AFTER = 6;

const COLUMNS: readonly Column[] = [{ label: "CASE", flex: 1 }, { label: "LIVE", width: 90 }, { label: "EXPERIMENT", width: 100 }, { label: "LIVE BEFORE", width: 170 }];

export type Outcome = "pass" | "fail" | null;

/** A setup's result on one case: passed every run, failed one, or not run. */
export const outcome = (cell: CaseCell | undefined): Outcome => (cell === undefined ? null : cell.passed === cell.runs ? "pass" : "fail");

/** Live's cell on a case: under its name, else the `production` column a round names when live has no setup file. */
export const liveCell = (row: CaseRow, liveName: string): CaseCell | undefined => row.cells[liveName] ?? row.cells.production;

/** The rule a setup broke on one case, from its "Why gates failed" lines. */
const ruleFor = (setup: SetupScore | undefined, question: number): string | null => setup?.misses.find((miss) => miss.question === question)?.rule ?? null;

/** One setup's runs on a case: a small square per run, passed in the accent and failed in red. */
function Runs({ cell }: { cell: CaseCell | undefined }) {
  const styles = useThemedStyles(makeStyles);
  if (cell === undefined) return <Text variant="meta">—</Text>;
  return (
    <View style={styles.runs} accessibilityLabel={`${cell.passed} of ${cell.runs} runs passed`}>
      {Array.from({ length: cell.runs }, (_, index) => (
        <View key={index} style={[styles.run, index < cell.passed ? styles.runPass : styles.runFail]} />
      ))}
    </View>
  );
}

export function AiCompareCases({ setup, liveName, groupTitle, run, read, history, openInNotes }: {
  setup: string;
  liveName: string;
  groupTitle: string;
  run: ScoreRow;
  read: RunRead;
  /** Live's earlier rounds on a case of this group. */
  history: (question: number) => readonly CaseCell[];
  openInNotes: (path: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState<number | null>(null);
  const mineScore = read.setups.find((item) => item.setup === setup);
  const liveScore = read.setups.find((item) => item.setup === liveName) ?? read.setups.find((item) => item.setup === "production");
  const cases = read.cases;
  const runsEach = cases === null ? null : Math.max(0, ...cases.flatMap((row) => Object.values(row.cells).map((cell) => cell.runs)));
  const meta = [run.day, runsEach !== null ? `${runsEach} runs each` : null].filter(Boolean).join(" · ");
  const counts = (row: CaseRow) => {
    const live = liveCell(row, liveName);
    const mine = row.cells[setup];
    return `live ${live ? `${live.passed}/${live.runs}` : "—"}, experiment ${mine ? `${mine.passed}/${mine.runs}` : "—"}`;
  };
  const testID = `admin-ai-compare-cases-${run.test}`;

  if (cases === null) {
    return (
      <Box title={`${groupTitle}, case by case`} right={<Text variant="meta" numberOfLines={1}>{meta}</Text>} testID={testID}>
        <Quietly testID="admin-ai-compare-old">This round was scored before the case-by-case table; only failed gates are known.</Quietly>
        {[
          { name: "Experiment", misses: mineScore?.misses ?? [] },
          { name: "Live", misses: liveScore?.misses ?? [] },
        ].map((item) => (
          <Text key={item.name} variant="meta" numberOfLines={2}>
            {`${item.name}: ${item.misses.map((miss) => `case ${miss.question} ${miss.rule}`).join("; ") || "no failed gates"}`}
          </Text>
        ))}
      </Box>
    );
  }

  const shown = cases.filter((row, index) => index < FOLD_AFTER || outcome(row.cells[setup]) === "fail" || outcome(liveCell(row, liveName)) === "fail");
  const picked = cases.find((row) => row.question === open) ?? null;
  const pickedMine = picked !== null && outcome(picked.cells[setup]) === "fail";
  const pickedRule = picked === null ? null : ruleFor(pickedMine ? mineScore : liveScore, picked.question);
  return (
    <Box title={`${groupTitle}, case by case`} right={<Text variant="meta" numberOfLines={1}>{meta}</Text>} testID={testID}>
      <Head columns={COLUMNS} />
      {shown.map((row, index) => {
        const mine = outcome(row.cells[setup]);
        const theirs = outcome(liveCell(row, liveName));
        const failing = mine === "fail" || theirs === "fail";
        const failCell = mine === "fail" ? row.cells[setup] : liveCell(row, liveName);
        const sub = failing && failCell ? `${ruleFor(mine === "fail" ? mineScore : liveScore, row.question) ?? "failed a gate"} · ${failCell.passed} of ${failCell.runs} runs` : undefined;
        const before = historyLabel(history(row.question));
        return (
          <TableLine
            key={row.question}
            testID={`admin-ai-compare-case-${run.test}-${row.question}`}
            columns={COLUMNS}
            first={index === 0}
            last={index === shown.length - 1}
            title={`${row.question}. ${row.title}`}
            sub={[counts(row), sub, `live before: ${before}`].filter(Boolean).join(" · ")}
            selected={open === row.question}
            onPress={failing ? () => setOpen(row.question) : undefined}
            cells={[
              <Cell key="case" title={`${row.question}. ${row.title}`} sub={sub} strong={failing} />,
              <Runs key="live" cell={liveCell(row, liveName)} />,
              <Runs key="mine" cell={row.cells[setup]} />,
              <Text key="before" variant="meta" numberOfLines={1} style={styles.muted}>{before}</Text>,
            ]}
          />
        );
      })}
      {cases.length > shown.length ? <Quietly testID="admin-ai-compare-folded">{`${cases.length - shown.length} more cases, all passing`}</Quietly> : null}
      {picked !== null ? (
        <View style={styles.detail} testID="admin-ai-compare-detail">
          <Text variant="meta" numberOfLines={2}>
            <Text variant="meta" style={styles.strong}>{`Case ${picked.question}, ${pickedMine ? "the experiment" : "live"}: `}</Text>
            {pickedRule ?? "failed a gate"}
          </Text>
          <LinkText label="Open the scores ›" onPress={() => openInNotes(run.path)} testID="admin-ai-compare-open" />
        </View>
      ) : null}
    </Box>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    strong: { color: colors.text, fontWeight: "600" },
    muted: { color: colors.muted },
    runs: { flexDirection: "row", gap: 2 },
    run: { width: 12, height: 14, borderRadius: 3 },
    runPass: { backgroundColor: colors.accent },
    runFail: { backgroundColor: colors.critBorder },
    detail: { borderWidth: 1, borderColor: colors.line, borderRadius: 8, padding: space.x3, gap: space.x2, marginTop: space.x2 },
  });
