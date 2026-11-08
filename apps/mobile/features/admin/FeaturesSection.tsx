/**
 * The Features tab: every feature flag, who has it, and the tester groups (decided by the owner, 2026-11-08;
 * `docs/decisions/app-and-console/feature-flags.md`). A flag is off, on for the people and groups on its list, or on
 * for everyone. Each one shows when it expires: past that day CI fails until it is launched or removed. The flags
 * and their words are `packages/shared/src/flags.cjs`, read through the server (`functions/featureFlags.ts`).
 */

import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { Button, Pill, Text, space, useThemedStyles } from "../design";
import { EmptyNote, Panel, Skeleton } from "./AdminKit";
import { messageFor } from "./SecretDialogs";
import { relativeTime } from "./report";
import { AddByName, PersonChips, TesterGroupsPanel, useAct } from "./FeatureGroups";

type Mode = "off" | "people" | "everyone";
const MODES: { mode: Mode; label: string }[] = [
  { mode: "off", label: "Off" },
  { mode: "people", label: "Testers" },
  { mode: "everyone", label: "Everyone" },
];

/** "Expires in 12 days", "Expires today", "Expired 3 days ago". */
export function expiryLine(daysLeft: number, expires: string): string {
  if (daysLeft > 1) return `Expires in ${daysLeft} days (${expires})`;
  if (daysLeft === 1) return `Expires tomorrow (${expires})`;
  if (daysLeft === 0) return `Expires today (${expires})`;
  return `Expired ${-daysLeft === 1 ? "yesterday" : `${-daysLeft} days ago`} (${expires}): launch it or remove it`;
}

export function FeaturesSection() {
  const listed = useQuery(api.functions.featureFlags.listFlags, {});
  if (listed === undefined) {
    return (
      <Panel title="Features">
        <Skeleton width="100%" height={56} />
      </Panel>
    );
  }
  return (
    <>
      <Panel
        title="Features"
        help="Each unfinished feature has its own flag: off, on for its testers, or on for everyone. Every flag expires; launch it or remove it before then."
      >
        {listed.flags.length === 0 ? (
          <EmptyNote title="No flags yet" body="A flag is added in code, in packages/shared/src/flags.cjs, with the day it expires." testID="admin-flags-empty" />
        ) : (
          listed.flags.map((flag) => <FlagRow key={flag.id} flag={flag} groups={listed.groups} />)
        )}
      </Panel>
      <TesterGroupsPanel groups={listed.groups} />
      {listed.retired.length === 0 ? null : <RetiredPanel retired={listed.retired} />}
    </>
  );
}

type Listed = FunctionReturnType<typeof api.functions.featureFlags.listFlags>;

function FlagRow({ flag, groups }: { flag: Listed["flags"][number]; groups: Listed["groups"] }) {
  const styles = useThemedStyles(makeStyles);
  const setMode = useMutation(api.functions.featureFlags.setFlagMode);
  const addPerson = useMutation(api.functions.featureFlags.addFlagPerson);
  const removePerson = useMutation(api.functions.featureFlags.removeFlagPerson);
  const addGroup = useMutation(api.functions.featureFlags.addFlagGroup);
  const removeGroup = useMutation(api.functions.featureFlags.removeFlagGroup);
  const { busy, problem, act } = useAct();
  const unlisted = groups.filter((g) => !flag.groups.some((on) => on.groupId === g.groupId));
  return (
    <View style={styles.flag} testID={`admin-flag-${flag.id}`}>
      <View style={styles.head}>
        <View style={styles.words}>
          <Text variant="rowTitle">{flag.label}</Text>
          <Text variant="meta">{flag.description}</Text>
          <Text variant="meta">{flag.id}</Text>
        </View>
        <Pill tone={flag.daysLeft < 0 ? "crit" : flag.due ? "warn" : "neutral"} testID={`admin-flag-${flag.id}-expiry`}>
          {expiryLine(flag.daysLeft, flag.expires)}
        </Pill>
      </View>
      <View style={styles.modes} role="radiogroup" aria-label={`Who has ${flag.label}`}>
        {MODES.map(({ mode, label }) => (
          <Button
            key={mode}
            label={label}
            variant={flag.mode === mode ? "accent" : "mini"}
            disabled={busy}
            onPress={() => void act(() => setMode({ flagId: flag.id, mode }), "That did not change. Try again.")}
            testID={`admin-flag-${flag.id}-${mode}`}
          />
        ))}
        {flag.updatedAt === null ? null : <Text variant="meta">Changed {relativeTime(flag.updatedAt)}</Text>}
      </View>
      {flag.mode === "everyone" ? (
        <Text variant="meta">On for everyone. The list below is kept for when you switch back.</Text>
      ) : flag.mode === "off" ? (
        <Text variant="meta">Off for everyone, the testers below included.</Text>
      ) : null}
      <PersonChips
        people={[
          ...flag.groups.map((g) => ({ key: g.groupId, name: `${g.name} (${g.size})`, onRemove: () => removeGroup({ flagId: flag.id, groupId: g.groupId }) })),
          ...flag.people.map((p) => ({ key: p.userId, name: p.name, onRemove: () => removePerson({ flagId: flag.id, userId: p.userId }) })),
        ]}
        empty="No testers yet."
        act={act}
        busy={busy}
        testID={`admin-flag-${flag.id}-list`}
      />
      {unlisted.length === 0 ? null : (
        <View style={styles.modes}>
          {unlisted.map((g) => (
            <Button
              key={g.groupId}
              label={`Add ${g.name}`}
              disabled={busy}
              onPress={() => void act(() => addGroup({ flagId: flag.id, groupId: g.groupId as Id<"testerGroups"> }), "That group was not added. Try again.")}
              testID={`admin-flag-${flag.id}-add-group-${g.name}`}
            />
          ))}
        </View>
      )}
      <AddByName label={`Add a tester to ${flag.label}`} busy={busy} onAdd={(who) => act(() => addPerson({ flagId: flag.id, who }), "Nobody was added.")} testID={`admin-flag-${flag.id}-add`} />
      {problem === null ? null : <Text variant="meta">{problem}</Text>}
    </View>
  );
}

function RetiredPanel({ retired }: { retired: Listed["retired"] }) {
  const styles = useThemedStyles(makeStyles);
  const clear = useMutation(api.functions.featureFlags.clearRetiredFlag);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Panel title="Launched or removed" help="Flags no longer in code that still have a mode or a list here. Clearing deletes those rows.">
      {retired.map((r) => (
        <View key={r.id} style={styles.head} testID={`admin-flag-retired-${r.id}`}>
          <Text variant="rowTitle">{r.id}</Text>
          <Button
            label="Clear"
            onPress={() => void clear({ flagId: r.id }).then(() => setProblem(null), (error: unknown) => setProblem(messageFor(error, "That did not clear. Try again.")))}
            testID={`admin-flag-retired-${r.id}-clear`}
          />
        </View>
      ))}
      {problem === null ? null : <Text variant="meta">{problem}</Text>}
    </Panel>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    flag: { gap: space.x2, paddingVertical: space.x3 },
    head: { flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: space.x2 },
    words: { flexShrink: 1, minWidth: 0, gap: 2 },
    modes: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.x2 },
  });
