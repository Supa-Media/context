import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Button, PressRow } from "../design/components/Button";
import { Icon } from "../design/components/Icon";
import { Text } from "../design/components/Text";
import { radii, space } from "../design/tokens";
import { makeStyles as explorerStyles } from "../console/files/explorer/styles";
import { type Colors, useColors, useThemedStyles } from "../design/theme";
import { relativeTime } from "../console/format";
import { ChangeCards } from "./Changes";
import { changesCopy } from "./changeCopy";
import { TeamCards, TeamNotePreview, TeamSettings } from "./TeamNotes";
import { teamsCopy } from "./teamCopy";
import type { RouteCard } from "./types";
import type { OrganizerView } from "./useOrganizer";

/**
 * What changed, as a page: board 1 of the "Organizing from what's coming in"
 * canvas, which Dev2 asked for by name (2026-10-05) — not a list in a popover.
 *
 * Drawn where a note would be (`BrowseDocument`), so the tree stays beside it
 * and opening a note from there leaves it. A heading that says where the
 * cards come from and when the inbox was last read, Check now, then the
 * cards waiting, each with its source, its quote and its ticked steps.
 *
 * In a personal workspace, notes for the owner's teams follow (boards 5–7):
 * Add opens the note as the team would read it, in place of the page.
 */
export function WhatChangedPage({
  organizer,
  compact,
  now,
  onOpenSource,
}: {
  organizer: OrganizerView;
  compact: boolean;
  now: number;
  onOpenSource: (path: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { loadSuggestions } = organizer;
  // Read on the way in: the cards are a read of the bucket, not a subscription.
  useEffect(() => {
    loadSuggestions();
  }, [loadSuggestions]);

  const { changes, routes, teams, keep, loading, failed, busy } = organizer.suggestions;
  const cards = changes ?? [];
  const forTeams = routes ?? [];
  const [sending, setSending] = useState<RouteCard | null>(null);
  // A card answered elsewhere (another device, Keep it here) closes its preview.
  const open = sending !== null && forTeams.some((card) => card.id === sending.id) ? sending : null;
  const sweep = organizer.status?.sweep ?? null;
  const running = sweep?.state === "running";
  const checked = sweep?.finishedAt ?? null;

  if (open) {
    return (
      <TeamNotePreview
        key={open.id}
        card={open}
        pending={busy.has(open.id)}
        touch={compact}
        onCancel={() => setSending(null)}
        onSend={(title, body) => {
          void organizer.sendRoute(open, title, body).then((sent) => {
            if (sent) setSending(null);
          });
        }}
      />
    );
  }

  return (
    <View style={styles.page} testID="what-changed-page">
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text variant="paneTitle" role="heading" aria-level={1}>
            {changesCopy.heading}
          </Text>
          <Text variant="hint" style={styles.lede}>
            {changesCopy.lede}
            {checked !== null ? ` ${changesCopy.lastChecked(relativeTime(checked, now))}` : ""}
          </Text>
        </View>
        <View style={styles.headActs}>
          <Button
            label={running ? changesCopy.checking : changesCopy.checkNow}
            onPress={organizer.sweepNow}
            disabled={running}
            variant="dialog"
            testID="what-changed-check"
          />
          <Pressable
            role="button"
            accessibilityLabel={changesCopy.close}
            onPress={organizer.closePage}
            style={styles.close}
            testID="what-changed-close"
          >
            <Icon name="close" size={16} color={colors.chromeMuted} />
          </Pressable>
        </View>
      </View>

      {cards.length > 0 || forTeams.length > 0 ? (
        <>
          {cards.length > 0 ? (
            <>
              <Text variant="eyebrow" style={styles.eyebrow} testID="what-changed-waiting">
                {changesCopy.waiting(cards.length)}
              </Text>
              <ChangeCards
                cards={cards}
                busy={busy}
                touch={compact}
                onResolve={organizer.resolveChange}
                onOpenSource={onOpenSource}
              />
            </>
          ) : null}
          {forTeams.length > 0 ? (
            <>
              <Text variant="eyebrow" style={styles.eyebrow} testID="what-changed-teams">
                {teamsCopy.section(forTeams.length)}
              </Text>
              <TeamCards
                routes={forTeams}
                busy={busy}
                touch={compact}
                onPreview={setSending}
                onKeep={organizer.dismissRoute}
                onOpenSource={onOpenSource}
              />
            </>
          ) : null}
        </>
      ) : (
        <View style={styles.empty} testID="what-changed-empty">
          {loading ? <ActivityIndicator size="small" color={colors.muted} /> : null}
          <Text variant="body" style={styles.emptyText}>
            {loading ? changesCopy.loading : failed ? changesCopy.failedToLoad : changesCopy.empty}
          </Text>
        </View>
      )}
      <TeamSettings teams={teams} keep={keep} onToggle={organizer.setTeamOn} onKeep={organizer.setKeep} />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    page: { paddingTop: space.x8, paddingBottom: space.x8, gap: space.x4 },
    head: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: space.x4, flexWrap: "wrap" },
    headText: { flex: 1, minWidth: 240, gap: space.x2 },
    lede: { color: colors.chromeMuted },
    headActs: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    close: { width: 36, height: 36, alignItems: "center", justifyContent: "center", borderRadius: 8 },
    eyebrow: { color: colors.chromeMuted, marginTop: space.x2 },
    empty: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      padding: space.x6,
      borderRadius: 10,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.line,
    },
    emptyText: { color: colors.text2, flexShrink: 1 },
  });

/**
 * The tree's entry to the page, above "11 suggestions": the board's sidebar
 * item, "What changed" with the number of cards waiting. Drawn even at none,
 * so the page can be found before anything has arrived.
 */
export function WhatChangedLine({ count, open, onPress }: { count: number; open: boolean; onPress: () => void }) {
  const colors = useColors();
  const ex = useThemedStyles(explorerStyles);
  const styles = useThemedStyles(makeLineStyles);
  return (
    <PressRow
      accessibilityLabel={count > 0 ? `${changesCopy.entry}, ${count} waiting` : changesCopy.entry}
      onPress={onPress}
      selected={open}
      radius={radii.sm}
      style={StyleSheet.flatten([ex.foot, ex.footPress])}
      hoverStyle={ex.matchHover}
      selectedStyle={ex.matchHover}
      testID="explorer-what-changed"
    >
      <Icon name="sparkle" size={12} color={colors.accent} />
      <Text variant="treeMeta" numberOfLines={1} style={ex.footGrow}>
        {changesCopy.entry}
      </Text>
      {count > 0 ? (
        <View style={styles.badge}>
          <Text variant="treeMeta" style={styles.badgeText}>
            {String(count)}
          </Text>
        </View>
      ) : null}
    </PressRow>
  );
}

const makeLineStyles = (colors: Colors) =>
  StyleSheet.create({
    badge: { minWidth: 18, paddingHorizontal: 6, borderRadius: radii.pill, backgroundColor: colors.accent, alignItems: "center" },
    badgeText: { color: colors.ground, fontWeight: "600" },
  });
