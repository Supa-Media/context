import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Card } from "../../../design/components/Card";
import { Icon } from "../../../design/components/Icon";
import { FormError } from "../../../design/components/Input";
import { Switch } from "../../../design/components/Switch";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { FaceView } from "../../faces/PersonFace";
import { useFace } from "../../faces/useFace";
import {
  ACTIVITY_FILTERS,
  buildActivity,
  type ActivityFilter,
  type ActivityRow,
} from "../../advanced/auditActivity";
import type { AuditView } from "../../advanced/advanced";
import type { ConsoleMember } from "../../members/members";
import { PanelHead } from "./PanelHead";

/**
 * Settings › Activity: who changed what in this workspace.
 *
 * Its own section rather than a block under "Advanced", because it is the
 * one screen there somebody opens with a question ("who moved my note?").
 * `auditActivity.ts` holds how the trail becomes sentences; this only draws them.
 */
export function ActivityPanel({
  view,
  members,
  sectioned,
}: {
  view: AuditView;
  /** This workspace's members, so rows say "Seyi" rather than an email. */
  members: readonly ConsoleMember[] | undefined;
  sectioned: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const names = useMemo(() => {
    const byId = new Map<string, string>();
    for (const member of Array.isArray(members) ? members : []) {
      const name = member.name?.trim();
      if (name) byId.set(member.userId, name);
    }
    return byId;
  }, [members]);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [showRoutine, setShowRoutine] = useState(false);
  // Not memoised: "4 minutes ago" has to be read against now on every draw,
  // and 200 events are cheap to walk.
  const page = buildActivity(view.events, { filter, showRoutine, now: Date.now(), names });

  return (
    <View>
      <PanelHead section="activity" sectioned={sectioned}>
        Who changed what in this workspace, including AI apps. Only owners see this,
        because it can name private notes.
      </PanelHead>

      {view.failure ? (
        <View testID="audit-failure">
          <FormError
            headline={view.failure.headline}
            next={[view.failure.next, view.failure.detail].filter(Boolean).join(" ")}
          />
        </View>
      ) : view.events.length === 0 ? (
        <Card>
          <Text variant="rowSub">
            {view.loading ? "Loading…" : (view.readOnlyReason ?? "Nothing has happened here yet.")}
          </Text>
        </Card>
      ) : (
        <>
          <View style={styles.filters} role="group" aria-label="Show">
            {ACTIVITY_FILTERS.map((option) => (
              <Chip
                key={option.key}
                label={option.label}
                on={filter === option.key}
                onPress={() => setFilter(option.key)}
                testID={`activity-filter-${option.key}`}
              />
            ))}
          </View>

          {page.days.length === 0 ? (
            <Card>
              <Text variant="rowSub">Nothing of this kind in the recent activity.</Text>
            </Card>
          ) : (
            page.days.map((day) => (
              <View key={day.label}>
                <Text variant="eyebrow" style={styles.day}>
                  {day.label}
                </Text>
                <View style={styles.card}>
                  {day.rows.map((row, index) => (
                    <ActivityRowView key={row.key} row={row} first={index === 0} />
                  ))}
                </View>
              </View>
            ))
          )}

          {page.hiddenRoutine > 0 || showRoutine ? (
            <View style={styles.routine}>
              <Switch
                value={showRoutine}
                onValueChange={setShowRoutine}
                label="Show routine sign-ins"
                testID="activity-show-routine"
              />
              <Text variant="rowSub" style={styles.routineText}>
                {showRoutine
                  ? "Showing routine sign-ins"
                  : `Show routine sign-ins (${page.hiddenRoutine} hidden)`}
              </Text>
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

function Chip({
  label,
  on,
  onPress,
  testID,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      role="button"
      aria-pressed={on}
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={[styles.chip, on ? styles.chipOn : null]}
      testID={testID}
    >
      <Text variant="rowSub" style={on ? styles.chipTextOn : styles.chipText}>
        {label}
      </Text>
    </Pressable>
  );
}

function ActivityRowView({ row, first }: { row: ActivityRow; first: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const { actor, verb, subject, rest } = row.sentence;
  return (
    <View style={[styles.row, first ? null : styles.rowDivided]} testID="audit-row">
      <Who name={row.actor.name} isAgent={row.actor.isAgent} />
      <View style={styles.rowBody}>
        <Text variant="body" style={styles.sentence}>
          {/*
            Every name here is somebody else's text: a member's display name,
            an app's name, a note path out of a bucket. Each is isolated so a
            bidi control inside one cannot reorder the words around it.
          */}
          {actor === null ? null : <Text style={styles.bold}>{isolateForDisplay(actor)}</Text>}
          {actor === null ? verb : ` ${verb}`}
          {subject === null ? null : (
            <>
              {" "}
              <Text style={styles.bold}>{isolateForDisplay(subject)}</Text>
            </>
          )}
          {rest ?? null}
        </Text>
        {row.detail === null ? null : (
          <Text
            variant="rowSub"
            style={styles.detail}
            numberOfLines={1}
            testID={`audit-detail-${row.key}`}
          >
            {isolateForDisplay(row.detail)}
          </Text>
        )}
      </View>
      <Text variant="rowSub" style={styles.when}>
        {row.when}
      </Text>
    </View>
  );
}

/** A face for a person, a robot for an AI app: the rule the presence pile follows. */
function Who({ name, isAgent }: { name: string; isAgent: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const face = useFace(isAgent ? null : name);
  if (isAgent) {
    return (
      <View style={styles.robot} aria-hidden>
        <Icon name="robot" size={17} color={styles.robotInk.color} />
      </View>
    );
  }
  return <FaceView face={face} name={name} size={FACE} />;
}

const FACE = 30;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    filters: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 6 },
    chip: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.line,
    },
    chipOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
    chipText: { color: colors.text2 },
    chipTextOn: { color: colors.accent, fontWeight: "600" },
    day: { marginTop: 22, marginBottom: 8 },
    card: {
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 14,
      backgroundColor: colors.surface2,
    },
    row: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
    rowDivided: { borderTopWidth: 1, borderTopColor: colors.line },
    rowBody: { flex: 1, minWidth: 0 },
    sentence: { flexShrink: 1 },
    bold: { fontWeight: "600" },
    detail: { marginTop: 2 },
    when: { color: colors.muted, flexShrink: 0, marginTop: 2 },
    robot: {
      width: FACE,
      height: FACE,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.well,
    },
    robotInk: { color: colors.text2 },
    routine: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 18 },
    routineText: { color: colors.text2 },
  });
