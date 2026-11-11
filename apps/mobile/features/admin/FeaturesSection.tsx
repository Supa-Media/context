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
import { Text, fonts, space, useThemedStyles, type Colors } from "../design";
import { useCompact, Skeleton } from "./AdminKit";
import { messageFor } from "./SecretDialogs";
import { relativeTime } from "./report";
import { TesterGroupsPanel } from "./FeatureGroups";
import { ChipLine, LinkButton, ModeSwitch, Row, Section, useAct } from "./FeatureKit";

type Mode = "off" | "people" | "everyone";
const MODES: { value: Mode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "people", label: "Testers" },
  { value: "everyone", label: "Everyone" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2027-02-06" as "Feb 6, 2027"; anything else as it came. */
export function dayWords(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (m === null) return day;
  return `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${Number(m[3])}, ${m[1]}`;
}

/** "Expires Feb 6, 2027, in 12 days", "Expires today", "Expired 3 days ago, Nov 5, 2026: launch it or remove it". */
export function expiryLine(daysLeft: number, expires: string): string {
  const day = dayWords(expires);
  if (daysLeft > 1) return `Expires ${day}, in ${daysLeft} days`;
  if (daysLeft === 1) return `Expires tomorrow, ${day}`;
  if (daysLeft === 0) return `Expires today, ${day}`;
  return `Expired ${-daysLeft === 1 ? "yesterday" : `${-daysLeft} days ago`}, ${day}: launch it or remove it`;
}

export function FeaturesSection() {
  const listed = useQuery(api.functions.featureFlags.listFlags, {});
  if (listed === undefined) {
    return (
      <Section title="Features">
        <Row>
          <Skeleton width="100%" height={56} />
        </Row>
      </Section>
    );
  }
  return <FeaturesView listed={listed} />;
}

/** The tab on a list already in hand; the fixture draws it on invented flags. */
export function FeaturesView({ listed }: { listed: Listed }) {
  return (
    <View>
      <Section title="Features" aside="Every flag expires. Launch it or remove it before then." testID="admin-flags">
        {listed.flags.length === 0 ? (
          <Row testID="admin-flags-empty">
            <Text variant="meta">No flags yet. A flag is added in code, in packages/shared/src/flags.cjs, with the day it expires.</Text>
          </Row>
        ) : (
          listed.flags.map((flag) => <FlagRow key={flag.id} flag={flag} groups={listed.groups} />)
        )}
      </Section>
      <TesterGroupsPanel groups={listed.groups} />
      {listed.retired.length === 0 ? null : <RetiredPanel retired={listed.retired} />}
    </View>
  );
}

type Listed = FunctionReturnType<typeof api.functions.featureFlags.listFlags>;

function FlagRow({ flag, groups }: { flag: Listed["flags"][number]; groups: Listed["groups"] }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const setMode = useMutation(api.functions.featureFlags.setFlagMode);
  const addPerson = useMutation(api.functions.featureFlags.addFlagPerson);
  const removePerson = useMutation(api.functions.featureFlags.removeFlagPerson);
  const addGroup = useMutation(api.functions.featureFlags.addFlagGroup);
  const removeGroup = useMutation(api.functions.featureFlags.removeFlagGroup);
  const { busy, problem, act } = useAct();
  const unlisted = groups.filter((g) => !flag.groups.some((on) => on.groupId === g.groupId));
  const testers = flag.people.length + flag.groups.reduce((n, g) => n + g.size, 0);
  const expiryTone = flag.daysLeft < 0 ? styles.crit : flag.due ? styles.warn : null;
  return (
    <Row testID={`admin-flag-${flag.id}`}>
      <View style={compact ? styles.headStack : styles.head}>
        <View style={styles.words}>
          <Text variant="rowTitle">{flag.label}</Text>
          <Text variant="check">{flag.description}</Text>
          <Text variant="meta" style={styles.facts}>
            <Text variant="meta" style={styles.mono}>
              {flag.id}
            </Text>
            {" · "}
            <Text variant="meta" style={expiryTone} testID={`admin-flag-${flag.id}-expiry`}>
              {expiryLine(flag.daysLeft, flag.expires)}
            </Text>
            {flag.updatedAt === null ? null : ` · Changed ${relativeTime(flag.updatedAt)}`}
          </Text>
        </View>
        <ModeSwitch
          label={`Who has ${flag.label}`}
          options={MODES}
          value={flag.mode as Mode}
          onChange={(mode) => void act(() => setMode({ flagId: flag.id, mode }), "That did not change. Try again.")}
          disabled={busy}
          testID={`admin-flag-${flag.id}`}
        />
      </View>
      {flag.mode === "everyone" ? (
        <Text variant="meta">
          On for everyone.
          {testers === 0 ? "" : ` Its testers, ${testers === 1 ? "1 person" : `${testers} people`}, are kept for if you switch back.`}
        </Text>
      ) : (
        <ChipLine
          label={flag.mode === "off" ? "Testers, once on" : "Testers"}
          chips={[
            ...flag.groups.map((g) => ({ key: g.groupId, name: g.name, count: g.size, onRemove: () => removeGroup({ flagId: flag.id, groupId: g.groupId }) })),
            ...flag.people.map((p) => ({ key: p.userId, name: p.name, onRemove: () => removePerson({ flagId: flag.id, userId: p.userId }) })),
          ]}
          suggestions={unlisted.map((g) => ({
            key: g.groupId,
            name: g.name,
            note: `group · ${g.people.length}`,
            onPick: () => addGroup({ flagId: flag.id, groupId: g.groupId as Id<"testerGroups"> }),
          }))}
          addLabel={`Add a tester to ${flag.label}`}
          placeholder={unlisted.length === 0 ? "@handle, email or phone" : "@handle, email, phone or group"}
          onAdd={(who) => act(() => addPerson({ flagId: flag.id, who }), "Nobody was added.")}
          act={act}
          busy={busy}
          testID={`admin-flag-${flag.id}-list`}
        />
      )}
      {problem === null ? null : <Text variant="meta" style={styles.crit}>{problem}</Text>}
    </Row>
  );
}

function RetiredPanel({ retired }: { retired: Listed["retired"] }) {
  const styles = useThemedStyles(makeStyles);
  const clear = useMutation(api.functions.featureFlags.clearRetiredFlag);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Section title="Launched or removed" aside="No longer in code. Clearing deletes their saved lists.">
      {retired.map((r) => (
        <Row key={r.id} testID={`admin-flag-retired-${r.id}`}>
          <View style={styles.head}>
            <Text variant="meta" style={styles.mono}>
              {r.id}
            </Text>
            <LinkButton
              label="Clear"
              onPress={() => void clear({ flagId: r.id }).then(() => setProblem(null), (error: unknown) => setProblem(messageFor(error, "That did not clear. Try again.")))}
              testID={`admin-flag-retired-${r.id}-clear`}
            />
          </View>
        </Row>
      ))}
      {problem === null ? null : <Text variant="meta" style={styles.crit}>{problem}</Text>}
    </Section>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: space.x5 * 1.5 },
    headStack: { gap: space.x3 },
    words: { flex: 1, minWidth: 0, gap: 2 },
    facts: { marginTop: 4, color: colors.muted },
    mono: { fontFamily: fonts.mono, color: colors.muted },
    warn: { color: colors.warnText, fontWeight: "600" },
    crit: { color: colors.critText, fontWeight: "600" },
  });
