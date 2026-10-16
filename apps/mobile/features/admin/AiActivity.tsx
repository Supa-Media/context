/**
 * The AI tab's Activity (board 11, "the AI working on its own, ready to
 * audit"): every change the notes record, from the improver, the test bench,
 * AIs and people, in one feed that filters by job and by who did it. A plain
 * "Last day" line says what ran on its own, and each line links to the setup,
 * run or note it came from. Read from the catalog and reads the other screens
 * already hold, so the feed makes no request of its own.
 */

import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Pill, Text, space, useThemedStyles, type Colors, type PillTone } from "../design";
import { baseName } from "../console/files/paths";
import { NOT_RECORDED, activity, setupJob, type ActivityItem, type ActivityWho } from "./aiModel";
import { Box, Cell, Head, LinkText, PageHead, Quietly, TableLine, shortDay, type Column } from "./AiKit";
import type { AiScreenProps } from "./aiScreen";

const DAY = 86_400_000;
const LAST_DAY = "Last day: ";

const plural = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`;

/** `a`, `a and b`, `a, b, and c`: the clauses of one sentence, joined as English joins them. */
function listOf(parts: readonly string[]): string {
  if (parts.length <= 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/**
 * The one line above the feed: what ran on its own in the last day. Agents
 * and people are named by who did it, setups drafted or retired are counted
 * as setups, the bench's runs as runs, and what waits on a person is said
 * last. It never says anything went live: nothing does without a person.
 */
export function lastNight(items: readonly ActivityItem[], now = Date.now()): string {
  const recent = items.filter((item) => now - item.at < DAY);
  if (recent.length === 0) return "Nothing ran on its own in the last day.";

  const clauses: string[] = [];
  const byWho = new Map<string, ActivityItem[]>();
  for (const item of recent) {
    if (item.kind === "bench") continue;
    byWho.set(item.who, [...(byWho.get(item.who) ?? []), item]);
  }
  for (const [who, mine] of byWho) {
    const name = who === "Improver" ? "the improver" : who === NOT_RECORDED ? "someone" : who;
    const drafted = mine.filter((item) => item.what.startsWith("Drafted")).length;
    const retired = mine.filter((item) => item.what.startsWith("Retired")).length;
    const other = mine.length - drafted - retired;
    if (drafted > 0) clauses.push(`${name} drafted ${plural(drafted, "setup")}`);
    if (retired > 0) clauses.push(`${name} retired ${plural(retired, "setup")}`);
    if (other > 0) clauses.push(`${name} made ${plural(other, "change")}`);
  }

  const runs = recent.filter((item) => item.kind === "bench").length;
  if (runs > 0) clauses.push(`the test bench ran ${runs === 1 ? "once" : `${runs} times`}`);
  const waiting = recent.filter((item) => item.needsPerson).length;
  if (waiting > 0) clauses.push(`left ${plural(waiting, "thing")} for a person`);

  if (clauses.length === 0) return "Nothing ran on its own in the last day.";
  return `${LAST_DAY}${listOf(clauses)}. Nothing went live without a person.`;
}

/** The filter's choices, in the order the button cycles them. */
type WhoFilter = "all" | "agents" | "people" | "bench";

const WHO_OPTIONS: readonly { key: WhoFilter; label: string; kinds: readonly ActivityWho[] }[] = [
  { key: "all", label: "Agents and people", kinds: ["improver", "bench", "person", "ai"] },
  { key: "agents", label: "Agents", kinds: ["improver", "ai"] },
  { key: "people", label: "People", kinds: ["person"] },
  { key: "bench", label: "Test bench", kinds: ["bench"] },
];

const COLUMNS: readonly Column[] = [
  { label: "WHEN", width: 90 },
  { label: "WHO", width: 130 },
  { label: "JOB", width: 140 },
  { label: "WHAT HAPPENED", flex: 1 },
  { label: "", width: 130, align: "right" },
];

/** The next option after `current`, wrapping to the first. */
function cycle<T>(options: readonly T[], current: T): T {
  return options[(options.indexOf(current) + 1) % options.length]!;
}

/** Improver is the one agent the team watches closely: its tone is a warning, not a plain chip. */
function toneOf(kind: ActivityWho): PillTone {
  if (kind === "improver") return "warn";
  if (kind === "ai") return "ok";
  return "neutral";
}

/** A setup opens beside live as a comparison; a run or any other note opens in the notes app. */
function linkOf(item: ActivityItem, props: AiScreenProps): { label: string; onPress: () => void } {
  if (item.path.startsWith("ai/setups/")) {
    const compare = baseName(item.path).replace(/\.md$/, "");
    return { label: "See the change ›", onPress: () => props.go({ view: "jobs", job: setupJob(item.path) ?? "", tab: "setups", compare }) };
  }
  return { label: item.path.startsWith("ai/results/") ? "The run ›" : "The note ›", onPress: () => props.openInNotes(item.path) };
}

function FilterButton({ label, active = false, onPress, testID }: { label: string; active?: boolean; onPress: () => void; testID: string }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable role="button" accessibilityLabel={label} accessibilityState={{ selected: active }} onPress={onPress} style={[styles.filter, active && styles.filterOn]} testID={testID}>
      <Text variant="mini" numberOfLines={1} style={styles.strong}>{label}</Text>
    </Pressable>
  );
}

/**
 * Board 11: the feed of changes. The three buttons filter it; the summary
 * line says what ran on its own; a row's link opens the change where it was
 * written. Every row is one line, or two on a phone.
 */
export function AiActivity(props: AiScreenProps) {
  const styles = useThemedStyles(makeStyles);
  const { catalog, reads } = props;
  const items = useMemo(() => activity(catalog, reads), [catalog, reads]);
  const summary = useMemo(() => lastNight(items), [items]);
  const jobs = useMemo(() => [...new Set(items.map((item) => item.job).filter((name): name is string => name !== null))].sort(), [items]);
  const jobOptions = useMemo<(string | null)[]>(() => [null, ...jobs], [jobs]);

  const [job, setJob] = useState<string | null>(null);
  const [who, setWho] = useState<WhoFilter>("all");
  const [needs, setNeeds] = useState(false);

  const whoOption = WHO_OPTIONS.find((option) => option.key === who)!;
  const waiting = items.filter((item) => item.needsPerson).length;
  const shown = items.filter(
    (item) => (job === null || item.job === job) && whoOption.kinds.includes(item.kind) && (!needs || item.needsPerson),
  );
  const lead = summary.startsWith(LAST_DAY) ? LAST_DAY : null;

  return (
    <View style={styles.page}>
      <PageHead
        title="Activity"
        testID="admin-ai-activity-head"
        actions={
          <View style={styles.filters}>
            <FilterButton
              label={`${job ?? "All jobs"} ▾`}
              active={job !== null}
              onPress={() => setJob(cycle(jobOptions, job))}
              testID="admin-ai-activity-filter-job"
            />
            <FilterButton
              label={`${whoOption.label} ▾`}
              active={who !== "all"}
              onPress={() => setWho(cycle(WHO_OPTIONS.map((option) => option.key), who))}
              testID="admin-ai-activity-filter-who"
            />
            <FilterButton
              label={`Needs a person (${waiting})`}
              active={needs}
              onPress={() => setNeeds((on) => !on)}
              testID="admin-ai-activity-filter-needs"
            />
          </View>
        }
      />

      <Box testID="admin-ai-activity-summary">
        <Text variant="meta">
          {lead !== null ? <Text variant="meta" style={styles.strong}>{lead}</Text> : null}
          {lead !== null ? summary.slice(lead.length) : summary}
        </Text>
      </Box>

      <View style={styles.table}>
        {items.length === 0 ? (
          <View style={styles.empty}>
            <Quietly testID="admin-ai-activity-empty">Nothing recorded yet. Setups drafted, runs and promotions show here as they land in ai/.</Quietly>
          </View>
        ) : shown.length === 0 ? (
          <View style={styles.empty}>
            <Quietly testID="admin-ai-activity-none">Nothing matches these filters.</Quietly>
          </View>
        ) : (
          <>
            <Head columns={COLUMNS} />
            {shown.map((item, index) => {
              const link = linkOf(item, props);
              const last = index === shown.length - 1;
              return (
                <TableLine
                  key={`${item.path}-${item.at}-${index}`}
                  columns={COLUMNS}
                  title={item.what}
                  sub={[item.who === NOT_RECORDED ? null : item.who, shortDay(item.at), item.needsPerson ? "needs a person" : null].filter(Boolean).join(" · ")}
                  trailing={<LinkText label={link.label} onPress={link.onPress} testID={`admin-ai-activity-link-${index}`} />}
                  first={index === 0}
                  last={last}
                  testID={`admin-ai-activity-row-${index}`}
                  cells={[
                    <Cell key="when" title={shortDay(item.at)} />,
                    item.who === NOT_RECORDED ? (
                      <Cell key="who" title={NOT_RECORDED} />
                    ) : (
                      <Pill key="who" tone={toneOf(item.kind)}>{item.who}</Pill>
                    ),
                    <Cell key="job" title={item.job ?? ""} />,
                    <Cell key="what" title={item.what} sub={item.detail} strong />,
                    <View key="link" style={styles.end}>
                      {item.needsPerson ? <Text variant="meta" numberOfLines={1} style={styles.crit}>needs a person</Text> : null}
                      <LinkText label={link.label} onPress={link.onPress} testID={`admin-ai-activity-open-${index}`} />
                    </View>,
                  ]}
                />
              );
            })}
          </>
        )}
      </View>

      <Quietly testID="admin-ai-activity-footer">
        Everything here is read from the notes in @context-lc ai/: what Claude, the improver and people write there shows under their own name.
      </Quietly>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { gap: space.x4, minWidth: 0 },
    filters: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2 },
    filter: { borderRadius: 8, borderWidth: 1, borderColor: colors.line, paddingVertical: 7, paddingHorizontal: 12, backgroundColor: colors.surface },
    filterOn: { backgroundColor: colors.chipFill, borderColor: colors.accent },
    strong: { color: colors.text, fontWeight: "600" },
    crit: { color: colors.critText, fontWeight: "700" },
    table: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, backgroundColor: colors.surface, overflow: "hidden", minWidth: 0 },
    empty: { paddingHorizontal: space.x5, paddingVertical: space.x3 },
    end: { alignItems: "flex-end", gap: 2 },
  });
