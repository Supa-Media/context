/**
 * The middle of a job's Overview (board 21): what waits on a person, when
 * each case group last ran on the setup that is live today, and the live
 * prompt's health (`./aiHealth`). It replaces the old "Tests on this job"
 * box, whose percentages hid which group had not run since live changed.
 */

import { StyleSheet, View } from "react-native";
import type { Id } from "@context/convex/_generated/dataModel";
import { Pill, Text, space, useThemedStyles, type Colors } from "../design";
import { Box, Columns, LinkText, Quietly } from "./AiKit";
import { archivedSetup, passedRange, runsPassed, setupTitle } from "./aiExperiments";
import { caseGroupTitle, casesInPrompt, draftedCases, groupsOnLive, repeatedRules } from "./aiHealth";
import { sizeLabel, type JobPage } from "./aiModel";
import { useNoteText, useNoteTexts } from "./useAiNote";

interface Need {
  key: string;
  who: string;
  text: string;
  action: string;
  onPress: () => void;
}

export function AiJobOverview({ page, workspaceId, liveSince, now, openInNotes, goCases, goRuns, openCompare }: {
  page: JobPage;
  workspaceId: Id<"workspaces">;
  liveSince: string | null;
  now: number;
  openInNotes: (path: string) => void;
  goCases: () => void;
  goRuns: () => void;
  openCompare: (setup: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const groupTexts = useNoteTexts(workspaceId, page.row.tests.map((test) => test.path));
  const prompt = useNoteText(workspaceId, page.row.setup?.path ?? null);
  const groups = page.row.tests.map((test) => ({ title: caseGroupTitle(groupTexts.get(test.path) ?? undefined, test.title || test.name), text: groupTexts.get(test.path) ?? "" }));
  const titleOf = (path: string, fallback: string) => caseGroupTitle(groupTexts.get(path) ?? undefined, fallback);
  const onLive = groupsOnLive(page, liveSince);

  const needs: Need[] = [];
  for (const setup of page.candidates) {
    if (setup.status === "draft") needs.push({ key: `check-${setup.name}`, who: "Improver", text: `${setupTitle(setup)}: check it before it runs`, action: "Check", onPress: () => openInNotes(setup.row.path) });
  }
  for (const item of draftedCases(groups)) {
    needs.push({ key: `cases-${item.group}`, who: "Improver", text: `${item.count} drafted ${item.count === 1 ? "case" : "cases"} in ${item.group}`, action: "Review", onPress: goCases });
  }
  for (const group of onLive) {
    if (!group.onLive) needs.push({ key: `run-${group.name}`, who: "Tests", text: `${titleOf(group.path, group.name)} ${group.day === null ? "has never run" : "hasn't run on this live"}`, action: "Run", onPress: goRuns });
  }
  for (const setup of page.candidates) {
    if (setup.status === "beat live" && !archivedSetup(setup, now)) needs.push({ key: `win-${setup.name}`, who: "Setups", text: `${setupTitle(setup)} is better than live`, action: "Compare", onPress: () => openCompare(setup.name) });
  }

  const repeated = prompt === null ? [] : repeatedRules(prompt);
  const answered = prompt === null ? [] : casesInPrompt(prompt, groups.filter((group) => group.text !== ""));
  const size = page.row.setup?.size ?? null;
  // One line per sentence found, naming every case that carries it.
  const answeredByText: { found: string; cases: string[] }[] = [];
  for (const item of answered) {
    const line = answeredByText.find((entry) => entry.found === item.found);
    if (line) line.cases.push(`${item.group} ${item.number}`);
    else answeredByText.push({ found: item.found, cases: [`${item.group} ${item.number}`] });
  }

  return (
    <Columns weights={[1, 1]}>
      {[
        <Box key="needs" title={`Needs you · ${needs.length}`} testID="admin-ai-needs">
          {needs.length === 0 ? <Quietly testID="admin-ai-needs-none">Nothing is waiting on a person.</Quietly> : null}
          {needs.map((need) => (
            <View key={need.key} style={styles.need} testID={`admin-ai-need-${need.key}`}>
              <Pill>{need.who}</Pill>
              <Text variant="meta" numberOfLines={2} style={styles.needText}>{need.text}</Text>
              <LinkText label={need.action} onPress={need.onPress} />
            </View>
          ))}
          <Text variant="rowTitle" style={styles.sub}>Case groups on today's live</Text>
          {onLive.length === 0 ? <Quietly>No case groups yet.</Quietly> : null}
          {onLive.map((group) => (
            <View key={group.path} style={styles.groupRow} testID={`admin-ai-onlive-${group.name}`}>
              <Text variant="meta" numberOfLines={1} style={styles.groupName}>{titleOf(group.path, group.name)}</Text>
              <Text variant="meta" numberOfLines={2} style={[styles.groupDay, !group.onLive && styles.crit]}>
                {group.day === null ? "never run" : group.onLive ? group.day : `${group.day}, before this live`}
              </Text>
              <Text variant="meta" numberOfLines={1} style={[styles.groupPassed, !group.onLive && styles.muted]}>
                {group.passed === null ? "—" : `${group.passed.passed} of ${group.passed.runs}`}
              </Text>
            </View>
          ))}
        </Box>,
        <Box key="health" title="Prompt health" testID="admin-ai-health">
          {prompt === null ? (
            <Quietly>{page.row.setup === null ? "Nothing is live on this job yet." : "Reading the live prompt…"}</Quietly>
          ) : (
            <>
              <View style={styles.healthRow}>
                <Text variant="meta" style={styles.healthKey}>Size</Text>
                <Text variant="meta" style={styles.healthValue}>{size === null ? "—" : `${sizeLabel(size)}, sent with every message`}</Text>
              </View>
              <View style={styles.healthRow} testID="admin-ai-health-repeated">
                <Text variant="meta" style={styles.healthKey}>Said twice</Text>
                <View style={styles.healthValue}>
                  {repeated.length === 0 ? <Text variant="meta" style={styles.ok}>No sentence is written twice.</Text> : null}
                  {repeated.slice(0, 4).map((item) => (
                    <Text key={item.text} variant="meta" numberOfLines={2} style={styles.warn}>{`${item.times}×  “${item.text}”`}</Text>
                  ))}
                  {repeated.length > 4 ? <Text variant="meta" style={styles.muted}>{`${repeated.length - 4} more`}</Text> : null}
                </View>
              </View>
              <View style={styles.healthRow} testID="admin-ai-health-answered">
                <Text variant="meta" style={styles.healthKey}>Answers in the prompt</Text>
                <View style={styles.healthValue}>
                  {answered.length === 0 ? <Text variant="meta" style={styles.ok}>No case's answer is written into the prompt.</Text> : null}
                  {answeredByText.slice(0, 4).map((item) => (
                    <Text key={item.found} variant="meta" numberOfLines={3} style={styles.crit}>
                      {`“${item.found}” is in the prompt, so ${item.cases.join(", ")} ${item.cases.length === 1 ? "passes" : "pass"} by reading it`}
                    </Text>
                  ))}
                  {answeredByText.length > 4 ? <Text variant="meta" style={styles.muted}>{`${answeredByText.length - 4} more`}</Text> : null}
                </View>
              </View>
              <Text variant="meta" style={styles.muted}>Text matches only: they point at what to read. Rules that contradict each other need a person.</Text>
            </>
          )}
        </Box>,
      ]}
    </Columns>
  );
}

/** The PASSED stat: runs passed with its likely range, or null for a round without a case table. */
export function passedStat(page: JobPage): { value: string; sub: string } | null {
  const live = page.candidates.find((item) => item.status === "live");
  if (!live || live.rounds.length === 0) return null;
  // Live's own runs in the newest round of each case group, summed.
  let passed = 0;
  let runs = 0;
  for (const round of live.rounds) {
    const counted = runsPassed(round.read, live.name) ?? runsPassed(round.read, "production");
    if (counted === null) continue;
    passed += counted.passed;
    runs += counted.runs;
  }
  if (runs === 0) return null;
  const groups = live.rounds.length;
  return { value: `${passed} of ${runs} runs`, sub: `${passedRange({ passed, runs })} · ${groups} case ${groups === 1 ? "group" : "groups"}` };
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    need: { flexDirection: "row", alignItems: "center", gap: space.x2, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.line, minWidth: 0 },
    needText: { flex: 1, minWidth: 0, color: colors.text },
    sub: { marginTop: space.x3, color: colors.text },
    groupRow: { flexDirection: "row", gap: space.x2, paddingVertical: 5, minWidth: 0 },
    groupName: { flex: 1, minWidth: 90, color: colors.text, fontWeight: "600" },
    groupDay: { flexShrink: 1, textAlign: "right" },
    groupPassed: { width: 64, textAlign: "right", color: colors.text },
    healthRow: { flexDirection: "row", gap: space.x3, paddingVertical: space.x2, borderBottomWidth: 1, borderBottomColor: colors.line, minWidth: 0 },
    healthKey: { width: 110, color: colors.muted },
    healthValue: { flex: 1, minWidth: 0, gap: 2 },
    ok: { color: colors.okText },
    warn: { color: colors.warnText },
    crit: { color: colors.critText, fontWeight: "600" },
    muted: { color: colors.muted },
  });
