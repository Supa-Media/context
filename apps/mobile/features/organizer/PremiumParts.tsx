import { useEffect, useRef, type ReactNode } from "react";
import { ActivityIndicator, View, useWindowDimensions } from "react-native";
import { densityFor } from "../app/frame";
import { Button } from "../design/components/Button";
import { Card } from "../design/components/Card";
import { Hint } from "../design/components/Field";
import { Icon } from "../design/components/Icon";
import { Switch } from "../design/components/Switch";
import { Text } from "../design/components/Text";
import { useColors, useThemedStyles } from "../design/theme";
import {
  KIND_LABELS,
  includedLine,
  settingsCopy,
  sortCopy,
  sortDone,
  sortRunning,
  sweepCopy,
  sweepCount,
  sweepReadingTitle,
} from "./copy";
import { useOrganizerView } from "./OrganizerContext";
import { relativeTime } from "../console/format";
import { type SortLine, settingsCard, shouldStartSweep, sortLine, sweepPhase } from "./rules";
import { makeStyles } from "./styles";
import { ORGANIZER_KINDS, type OrganizerStatus } from "./types";
import type { OrganizerView } from "./useOrganizer";

/** 01 — the disclosure, at the foot of "What Premium includes". The upgrade is the consent. */
export function IncludedLine() {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.included} testID="organizer-included">
      <View style={styles.includedHead}>
        <Text variant="rowTitle">{includedLine.title}</Text>
        <Text variant="rowSub" style={styles.muted}>
          {includedLine.tag}
        </Text>
      </View>
      <Text variant="rowSub" style={styles.blurb}>
        {includedLine.body}
      </Text>
    </View>
  );
}

/** 02a — the first sweep, above the plan card while it is reading. */
export function SweepCard({ slug, status }: { slug: string; status: OrganizerStatus }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  // A phone stacks the progress under the words.
  const compact = densityFor(useWindowDimensions().width) === "compact";
  const sweep = status.sweep!;
  const progress = (
    <View style={[styles.reading, compact && styles.readingBelow]}>
      <ActivityIndicator size="small" color={colors.muted} />
      <Text variant="rowSub" style={styles.muted}>
        {sweepCount(sweep)}
      </Text>
    </View>
  );
  return (
    <Card style={styles.above} testID="organizer-sweep-reading">
      <View style={styles.head}>
        <View style={styles.mark}>
          <Icon name="sparkle" size={16} color={colors.accent} />
        </View>
        <View style={styles.headText}>
          <Text variant="rowTitle" role="status">
            {sweepReadingTitle(slug)}
          </Text>
          <Text variant="rowSub" style={styles.blurb}>
            {sweepCopy.readingBody}
          </Text>
          {compact ? progress : null}
        </View>
        {!compact ? progress : null}
      </View>
    </Card>
  );
}

/**
 * Whether it is sorting right now, and when it last did, with the press that
 * follows from it. Before this line the switch said On while a workspace that
 * had never seen the notice was never swept, and nothing on screen said so.
 */
export function SortStatus({
  line,
  now,
  onSortNow,
}: {
  line: SortLine;
  now: number;
  onSortNow: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const text =
    line.kind === "running"
      ? sortRunning(line)
      : line.kind === "never"
        ? sortCopy.never
        : line.kind === "failed"
          ? sortCopy.failed(relativeTime(line.at, now), line.why)
          : sortDone(relativeTime(line.at, now));
  return (
    <View style={styles.sort} testID={`organizer-sort-${line.kind}`}>
      {line.kind === "running" ? <ActivityIndicator size="small" color={colors.muted} /> : null}
      <Text variant="rowSub" role="status" style={styles.sortText}>
        {text}
      </Text>
      {line.kind === "running" ? null : (
        <Button
          label={line.kind === "failed" ? sortCopy.tryAgain : sortCopy.sortNow}
          onPress={onSortNow}
          testID="organizer-sort-now"
        />
      )}
    </View>
  );
}

/** 06 — the owner's switches, after the includes card; a member's read-out. */
export function AutoOrganizeSettings({
  status,
  onEnabled,
  onAutopilot,
  onSortNow,
}: {
  status: OrganizerStatus;
  onEnabled: (on: boolean) => void;
  onAutopilot: (kind: (typeof ORGANIZER_KINDS)[number], on: boolean) => void;
  onSortNow?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const member = !status.isOwner;
  const now = Date.now();
  const line = sortLine(status, now);
  return (
    <Card style={styles.card} testID="organizer-settings">
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text variant="rowTitle">{settingsCopy.title}</Text>
          <Text variant="rowSub" style={styles.blurb}>
            {settingsCopy.body}
          </Text>
        </View>
        {member ? (
          <Text variant="rowSub" style={styles.muted}>
            {status.on ? settingsCopy.on : settingsCopy.off}
          </Text>
        ) : (
          <Switch value={status.on} onValueChange={onEnabled} label={settingsCopy.title} testID="organizer-switch" />
        )}
      </View>
      {member ? (
        <Hint style={styles.hint}>
          <Text variant="rowSub">{settingsCopy.memberNote}</Text>
        </Hint>
      ) : (
        <>
          {line !== null && onSortNow !== undefined ? (
            <SortStatus line={line} now={now} onSortNow={onSortNow} />
          ) : null}
          {status.on ? (
            <View style={styles.section}>
              <Text variant="eyebrow">{settingsCopy.withoutAsking}</Text>
              <Text variant="rowSub" style={styles.blurb}>
                {settingsCopy.withoutAskingHint}
              </Text>
              {ORGANIZER_KINDS.map((kind) => (
                <View key={kind} style={styles.kind}>
                  <Text variant="rowSub" style={styles.kindLabel}>
                    {KIND_LABELS[kind]}
                  </Text>
                  <Switch
                    value={status.autopilot[kind]}
                    onValueChange={(on) => onAutopilot(kind, on)}
                    label={KIND_LABELS[kind]}
                    testID={`organizer-autopilot-${kind}`}
                  />
                </View>
              ))}
            </View>
          ) : null}
          <Hint style={styles.hint}>
            <Text variant="rowSub">{settingsCopy.offNote}</Text>
          </Hint>
        </>
      )}
    </Card>
  );
}

export interface PremiumOrganizerSlots {
  top?: ReactNode;
  included?: ReactNode;
  afterIncludes?: ReactNode;
}

/**
 * Auto-organize's three places on Settings › Premium, from the console's view.
 *
 * `undefined` view — the demo, a harness, a build without the backend — is no
 * slots at all, and the panel is exactly what it was.
 */
export function usePremiumOrganizerSlots(returned: string | null): PremiumOrganizerSlots {
  const organizer = useOrganizerView();
  return usePremiumSlotsFor(organizer, returned);
}

export function usePremiumSlotsFor(organizer: OrganizerView | undefined, returned: string | null): PremiumOrganizerSlots {
  const asked = useRef(false);
  const status = organizer?.status ?? null;
  const phase = sweepPhase(status);

  // The payment return asks for the first sweep, once.
  const start = shouldStartSweep(status, { returned, asked: asked.current, now: Date.now() });
  useEffect(() => {
    if (!start || organizer === undefined) return;
    asked.current = true;
    organizer.sweepNow();
  }, [start, organizer]);

  if (organizer === undefined || status === null) return {};
  const card = settingsCard(status);
  return {
    included: <IncludedLine />,
    top: phase === null ? undefined : <SweepCard slug={organizer.slug} status={status} />,
    afterIncludes:
      card === null ? undefined : (
        <AutoOrganizeSettings
          status={status}
          onEnabled={organizer.setEnabled}
          onAutopilot={organizer.setAutopilot}
          onSortNow={organizer.sweepNow}
        />
      ),
  };
}
