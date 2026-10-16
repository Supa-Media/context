/**
 * The AI tab: every place AI runs, and the skills, tests, setups and results
 * behind them, all of it notes in `@context-lc`'s `ai/` folder (the owner,
 * 2026-10-16). A row opens its note in the normal editor; writing a skill or
 * a test is writing a note there. Running the tests is the AI Benchmark
 * workflow on GitHub, which always runs the live setup with the live skills
 * and the tests edited here. See `./aiCatalog.ts`.
 */

import { useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { Button, Pill, Text, TextField, space, useThemedStyles } from "../design";
import { noteHref } from "../console/nav";
import { EmptyNote, NoticeLine, Panel, Skeleton } from "./AdminKit";
import { ListRow } from "./AdminTable";
import { Segments } from "./Segments";
import {
  JOBS_SOURCE_URL,
  JOB_GROUPS,
  RUN_TESTS_URL,
  jobQuality,
  matches,
  type AiCatalog,
  type AiNoteRow,
  type JobRow,
  type ScoreRow,
} from "./aiCatalog";
import { AI_PLACES } from "./place";
import { relativeTime } from "./report";
import { useAiCatalog } from "./useAiCatalog";

export type AiView = (typeof AI_PLACES)[number];

const VIEWS: readonly { key: AiView; label: string }[] = [
  { key: "jobs", label: "Jobs" },
  { key: "skills", label: "Skills" },
  { key: "tests", label: "Tests" },
  { key: "setups", label: "Setups" },
  { key: "results", label: "Results" },
  { key: "other", label: "Other" },
];

/** Where "New skill" and "New test" go: the folder, whose own New note makes one. */
const NEW_IN: Partial<Record<AiView, { label: string; folder: string }>> = {
  skills: { label: "New skill", folder: "ai/production/skills" },
  tests: { label: "New test", folder: "ai/tests" },
  setups: { label: "New setup", folder: "ai/setups" },
};

/** A long list draws this many rows; the search box finds the rest. */
const SHOWN = 200;

const open = (url: string) => void Linking.openURL(url).catch(() => {});

export function aiView(sub: string | null): AiView {
  return (AI_PLACES as readonly string[]).includes(sub ?? "") ? (sub as AiView) : "jobs";
}

export function AiSection({ view, onView }: { view: AiView; onView: (view: AiView) => void }) {
  const { state, reload } = useAiCatalog();
  if (state.kind === "loading") return <Skeleton width="100%" height={240} />;
  if (state.kind === "notEditor") {
    return (
      <EmptyNote
        tall
        title="Not yours to edit"
        body="This page is the ai/ folder of @context-lc. It opens for the people who can edit that workspace."
        testID="admin-ai-not-editor"
      />
    );
  }
  if (state.kind === "unavailable" || state.kind === "failed") {
    return (
      <EmptyNote
        tall
        title="The ai/ folder could not be read"
        body={state.kind === "failed" ? state.message : "Its notes are still being read. Try again in a minute."}
        action={<Button label="Try again" onPress={reload} />}
        testID="admin-ai-failed"
      />
    );
  }
  return (
    <>
      {state.missing > 0 || state.truncated ? (
        <NoticeLine mark="!" tone="warn">
          {state.truncated
            ? "Only part of the ai/ folder was read; some notes are not listed."
            : `${state.missing} ${state.missing === 1 ? "note" : "notes"} could not be read this time and are not listed.`}
        </NoticeLine>
      ) : null}
      <Catalog catalog={state.catalog} view={view} onView={onView} />
    </>
  );
}

export function Catalog({ catalog, view, onView }: { catalog: AiCatalog; view: AiView; onView: (view: AiView) => void }) {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const [query, setQuery] = useState("");
  const openNote = (path: string) => router.push(noteHref(PINNED_CONTEXT_SLUG, path));
  const counts: Record<AiView, number> = {
    jobs: catalog.jobs.length,
    skills: catalog.skills.length,
    tests: catalog.tests.length,
    setups: catalog.setups.length,
    results: catalog.results.length,
    other: catalog.other.length,
  };
  const make = NEW_IN[view];
  return (
    <View style={styles.stack} testID="admin-ai">
      <View style={styles.bar}>
        <Segments options={VIEWS} value={view} onChange={onView} counts={(key) => counts[key]} label="AI" testID="admin-ai-view" />
        <View style={styles.actions}>
          {make ? <Button label={make.label} onPress={() => openNote(make.folder)} testID="admin-ai-new" /> : null}
          <Button label="Run tests" variant="accent" onPress={() => open(RUN_TESTS_URL)} testID="admin-ai-run" />
        </View>
      </View>
      {view === "jobs" ? null : (
        <TextField
          label="Find"
          labelHidden
          placeholder={`Find in ${VIEWS.find((item) => item.key === view)?.label.toLowerCase()}`}
          value={query}
          onChangeText={setQuery}
          testID="admin-ai-find"
        />
      )}
      {view === "jobs" ? <Jobs rows={catalog.jobs} onOpen={openNote} /> : null}
      {view === "skills" ? <Notes rows={catalog.skills} query={query} onOpen={openNote} empty="No skills yet." /> : null}
      {view === "tests" ? (
        <Notes rows={catalog.tests} query={query} onOpen={openNote} empty="No test lists here yet. Runs use the repository's copies until one is added." />
      ) : null}
      {view === "setups" ? <Notes rows={catalog.setups} query={query} onOpen={openNote} empty="No setups being tried." /> : null}
      {view === "results" ? <Results rows={catalog.results} query={query} onOpen={openNote} /> : null}
      {view === "other" ? <Notes rows={catalog.other} query={query} onOpen={openNote} empty="Nothing else here." /> : null}
    </View>
  );
}

function Jobs({ rows, onOpen }: { rows: readonly JobRow[]; onOpen: (path: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <>
      {JOB_GROUPS.map((group) => {
        const own = rows.filter((row) => row.job.group === group.key);
        if (own.length === 0) return null;
        return (
          <Panel key={group.key} title={group.label} flush testID={`admin-ai-group-${group.key}`}>
            {own.map((row, index) => {
              const quality = jobQuality(row);
              const tests = row.tests.map((test) => test.name).join(", ");
              const sub = [row.job.where, row.setup ? null : "no setup note", tests ? `tests: ${tests}` : null]
                .filter(Boolean)
                .join(" · ");
              return (
                <Pressable
                  key={row.job.key}
                  role="button"
                  accessibilityLabel={`Open ${row.job.label}'s setup`}
                  disabled={row.setup === null}
                  onPress={() => row.setup && onOpen(row.setup.path)}
                  testID={`admin-ai-job-${row.job.key}`}
                >
                  <ListRow
                    first={index === 0}
                    title={row.job.label}
                    sub={sub}
                    trailing={<Pill tone={quality.tone === "none" ? "neutral" : quality.tone}>{quality.label}</Pill>}
                  />
                </Pressable>
              );
            })}
          </Panel>
        );
      })}
      <Pressable role="link" onPress={() => open(JOBS_SOURCE_URL)} testID="admin-ai-jobs-source">
        <Text variant="meta" style={styles.link}>
          Jobs are added in code, with a setup note and a test list. See the list on GitHub.
        </Text>
      </Pressable>
    </>
  );
}

function Notes({
  rows,
  query,
  onOpen,
  empty,
}: {
  rows: readonly AiNoteRow[];
  query: string;
  onOpen: (path: string) => void;
  empty: string;
}) {
  const found = useMemo(() => rows.filter((row) => matches(row, query)), [rows, query]);
  if (rows.length === 0) return <EmptyNote title={empty} />;
  if (found.length === 0) return <EmptyNote title="Nothing matches." />;
  return (
    <Panel flush title={more(found.length)}>
      {found.slice(0, SHOWN).map((row, index) => (
        <NoteRow key={row.path} row={row} first={index === 0} onOpen={onOpen} />
      ))}
    </Panel>
  );
}

function Results({ rows, query, onOpen }: { rows: readonly ScoreRow[]; query: string; onOpen: (path: string) => void }) {
  const found = useMemo(() => rows.filter((row) => matches(row, query)), [rows, query]);
  if (rows.length === 0) return <EmptyNote title="No rounds scored yet." />;
  if (found.length === 0) return <EmptyNote title="Nothing matches." />;
  return (
    <Panel flush title={more(found.length)}>
      {found.slice(0, SHOWN).map((row, index) => {
        const passed = row.goodEnough === "yes" || row.goodEnough === "true";
        const label = row.score === null ? "Open for scores" : `${row.score}${row.gates ? ` · gates ${row.gates}` : ""}`;
        return (
          <Pressable key={row.path} role="button" onPress={() => onOpen(row.path)} testID={`admin-ai-row-${row.name}`}>
            <ListRow
              first={index === 0}
              title={`${row.test}${row.setup ? `, ${row.setup}` : ""}`}
              sub={row.day ?? undefined}
              trailing={<Pill tone={row.score === null ? "neutral" : passed ? "ok" : "warn"}>{label}</Pill>}
            />
          </Pressable>
        );
      })}
    </Panel>
  );
}

function NoteRow({ row, first, onOpen }: { row: AiNoteRow; first: boolean; onOpen: (path: string) => void }) {
  const where = row.path.split("/").slice(1, -1).join("/");
  const sub = [row.lede, where].filter(Boolean).join(" · ");
  return (
    <Pressable role="button" onPress={() => onOpen(row.path)} testID={`admin-ai-row-${row.name}`}>
      <ListRow
        first={first}
        title={row.title}
        sub={sub || undefined}
        trailing={row.updatedAt === null ? undefined : <Text variant="meta">{relativeTime(row.updatedAt)}</Text>}
      />
    </Pressable>
  );
}

function more(count: number): string {
  if (count > SHOWN) return `First ${SHOWN} of ${count}; find narrows it`;
  return count === 1 ? "1 note" : `${count} notes`;
}

const makeStyles = () =>
  StyleSheet.create({
    stack: { gap: space.x4 },
    bar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.x3 },
    actions: { flexDirection: "row", gap: space.x2 },
    link: { textDecorationLine: "underline" },
  });
