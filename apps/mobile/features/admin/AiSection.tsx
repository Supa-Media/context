/**
 * The AI tab (boards 8-16 of the AI tools plan, the owner, 2026-10-16: "I
 * want to be able to see it, change the workflow, see how things are doing
 * … also being able to drill down and edit things"). A rail of the system's
 * parts (Overview, Jobs, Helper agents, Skills, Activity) and, behind a quiet
 * link at its foot, the raw `ai/` folder (`./AiFiles`).
 *
 * Everything drawn is `@context-lc`'s `ai/` notes (`./aiCatalog`,
 * `./aiModel`); whoever can edit that workspace can change anything here,
 * and Claude or any connected AI changes the same notes the same way.
 */

import { useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { Button, Text, space, useThemedStyles, type Colors } from "../design";
import { noteHref } from "../console/nav";
import { EmptyNote, NoticeLine, Skeleton, useCompact } from "./AdminKit";
import { AiActivity } from "./AiActivity";
import { AiCompare } from "./AiCompare";
import { Library } from "./AiFiles";
import { AiHelpers } from "./AiHelpers";
import { AiJobPage } from "./AiJobPage";
import { AiJobsHome } from "./AiJobsHome";
import { AiOverview } from "./AiOverview";
import { AiPhonePicker } from "./AiPhonePicker";
import { AiSkills } from "./AiSkills";
import { type AiCatalog } from "./aiCatalog";
import { AI_HELPERS, activity } from "./aiModel";
import { aiSub, parseAiPlace, type AiPlace, type AiViewKey } from "./aiPlace";
import type { AiScreenProps } from "./aiScreen";
import { useAiCatalog } from "./useAiCatalog";
import { useRuns } from "./useAiNote";
import type { Id } from "@context/convex/_generated/dataModel";

const RAIL: readonly { key: Exclude<AiViewKey, "files">; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "jobs", label: "Jobs" },
  { key: "helpers", label: "Helper agents" },
  { key: "skills", label: "Skills" },
  { key: "activity", label: "Activity" },
];

/** The place a tab address names, the overview for one it does not. */
export function aiPlaceOf(sub: string | null): AiPlace {
  return parseAiPlace(sub) ?? { view: "overview" };
}

export function AiSection({ place, onPlace, days }: { place: AiPlace; onPlace: (sub: string | null) => void; days: number }) {
  const { state, reload } = useAiCatalog();
  if (state.kind === "loading") return <Skeleton width="100%" height={320} />;
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
      <AiTab workspaceId={state.workspaceId} catalog={state.catalog} me={state.me} place={place} onPlace={onPlace} reload={reload} days={days} />
    </>
  );
}

export function AiTab({
  workspaceId,
  catalog,
  me,
  place,
  onPlace,
  reload,
  days,
}: {
  workspaceId: Id<"workspaces">;
  catalog: AiCatalog;
  me: string;
  place: AiPlace;
  onPlace: (sub: string | null) => void;
  reload: () => void;
  days: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const router = useRouter();
  const paths = useMemo(() => catalog.results.map((result) => result.path), [catalog]);
  const reads = useRuns(workspaceId, paths);
  const waiting = useMemo(() => activity(catalog, reads).filter((item) => item.needsPerson).length, [catalog, reads]);
  const go = (next: AiPlace) => onPlace(aiSub(next));
  const screen: AiScreenProps = {
    workspaceId,
    catalog,
    reads,
    go,
    reload,
    openInNotes: (path) => router.push(noteHref(PINNED_CONTEXT_SLUG, path)),
    me,
  };
  const counts: Record<string, number | null> = {
    overview: null,
    jobs: catalog.jobs.length,
    helpers: AI_HELPERS.length,
    skills: catalog.skills.length,
    // What waits on a person; nothing waiting draws no number rather than a 0.
    activity: waiting > 0 ? waiting : null,
  };

  let body: ReactNode;
  switch (place.view) {
    case "overview":
      body = <AiOverview {...screen} />;
      break;
    case "jobs":
      if (place.job === null) body = <AiJobsHome {...screen} />;
      else if (place.compare !== null) body = <AiCompare {...screen} job={place.job} setup={place.compare} />;
      else body = <AiJobPage {...screen} job={place.job} tab={place.tab} />;
      break;
    case "helpers":
      body = <AiHelpers {...screen} helper={place.helper} />;
      break;
    case "skills":
      body = <AiSkills {...screen} skill={place.skill} />;
      break;
    case "activity":
      body = <AiActivity {...screen} />;
      break;
    case "files":
      body = (
        <Library
          workspaceId={workspaceId}
          catalog={catalog}
          view={place.part}
          onView={(part) => go({ view: "files", part })}
          onSaved={reload}
          days={days}
        />
      );
      break;
  }

  const current = place.view;
  return (
    <View style={[styles.frame, compact && styles.frameCompact]} testID="admin-ai">
      {compact ? (
        <AiPhonePicker
          place={place}
          jobs={catalog.jobs.map((row) => row.job)}
          rail={RAIL}
          counts={counts}
          onView={(key) => go(railPlace(key))}
          onJob={(job) => go({ view: "jobs", job, tab: "overview", compare: null })}
        />
      ) : (
        <View style={styles.rail} role="tablist" aria-label="AI">
          {RAIL.map((item) => (
            <RailRow
              key={item.key}
              label={item.label}
              count={counts[item.key] ?? null}
              alert={item.key === "activity" && waiting > 0}
              on={current === item.key}
              onPress={() => go(railPlace(item.key))}
              testID={`admin-ai-view-${item.key}`}
            />
          ))}
          <Pressable role="link" onPress={() => go({ view: "files", part: "attention" })} style={styles.files} testID="admin-ai-view-files">
            <Text variant="meta" style={current === "files" ? styles.strong : null}>Files: the ai/ folder ›</Text>
          </Pressable>
        </View>
      )}
      <View style={styles.main}>{body}</View>
    </View>
  );
}

function railPlace(key: AiViewKey): AiPlace {
  switch (key) {
    case "jobs":
      return { view: "jobs", job: null, tab: "overview", compare: null };
    case "helpers":
      return { view: "helpers", helper: null };
    case "skills":
      return { view: "skills", skill: null };
    case "files":
      return { view: "files", part: "attention" };
    default:
      return { view: key };
  }
}

function RailRow({ label, count, on, alert, onPress, testID }: {
  label: string;
  count: number | null;
  on: boolean;
  alert: boolean;
  onPress: () => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable role="tab" aria-selected={on} onPress={onPress} style={[styles.railRow, on && styles.railOn]} testID={testID}>
      <Text variant="tree" numberOfLines={1} style={on ? styles.strong : null}>{label}</Text>
      {count === null ? null : <Text variant="treeMeta" style={alert ? styles.alert : null}>{count}</Text>}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    frame: { flexDirection: "row", gap: space.x5, alignItems: "flex-start" },
    frameCompact: { flexDirection: "column", gap: space.x3, alignItems: "stretch" },
    rail: { width: 200, flexShrink: 0, gap: 2, paddingTop: space.x1 },
    railRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 7, paddingHorizontal: space.x3, borderRadius: 8 },
    railOn: { backgroundColor: colors.rowSelected },
    files: { marginTop: space.x5, paddingHorizontal: space.x3 },
    alert: { color: colors.crit, fontWeight: "700" },
    strong: { color: colors.text, fontWeight: "600" },
    main: { flex: 1, minWidth: 0, gap: space.x4 },
  });
