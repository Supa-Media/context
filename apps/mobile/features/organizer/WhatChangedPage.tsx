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
import { TeamChecklist } from "./TeamChecklist";
import { TeamNotePreview, TeamSettings } from "./TeamNotes";
import { TidyUp } from "./TidyUp";
import { tidyCopy } from "./tidyCopy";
import { changesCount, footCount } from "./rules";
import { teamsCopy } from "./teamCopy";
import type { RouteCard } from "./types";
import type { OrganizerView, WhatChangedTab } from "./useOrganizer";

/**
 * What changed, as a page: board 1 of the "Organizing from what's coming in"
 * canvas, which Dev2 asked for by name (2026-10-05) — not a list in a popover.
 *
 * Drawn where a note would be (`BrowseDocument`), so the tree stays beside it
 * and opening a note from there leaves it. A heading that says where the
 * cards come from and when the inbox was last read, Check now, then the
 * cards waiting, each with its source, its quote and its ticked steps.
 *
 * In a personal workspace, notes for the owner's teams follow as one list to
 * tick and add (board 9); Edit the note opens a note as the team would read
 * it, in place of the page.
 *
 * Two tabs since boards 10 and 11 (2026-10-07): "From your inbox" is all of
 * the above, and "Tidy up" is the suggestions about notes the owner already
 * has, which used to be a second line in the sidebar of their own.
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

  const { changes, routes, teams, keep, loading, failed, busy, list } = organizer.suggestions;
  const cards = changes ?? [];
  const forTeams = routes ?? [];
  const [sending, setSending] = useState<RouteCard | null>(null);
  // A card answered elsewhere (another device, Don't add) closes its preview.
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

  // Counted from what was read once it has been, from the status before then.
  const inboxCount = changes === null ? (changesCount(organizer.status) ?? 0) : cards.length + forTeams.length;
  const tidyCount = list === null ? (footCount(organizer.status) ?? 0) : list.length;
  const tab = organizer.tab;

  return (
    <View style={styles.page} testID="what-changed-page">
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text variant="paneTitle" role="heading" aria-level={1}>
            {changesCopy.heading}
          </Text>
          <Text variant="hint" style={styles.lede}>
            {tidyCopy.lede}
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

      <View style={[styles.tabs, compact && styles.tabsTouch]} role="tablist">
        <Tab label={tidyCopy.tabInbox} count={inboxCount} on={tab === "inbox"} compact={compact} onPress={() => organizer.setTab("inbox")} id="inbox" />
        <Tab label={tidyCopy.tabTidy} count={tidyCount} on={tab === "tidy"} compact={compact} onPress={() => organizer.setTab("tidy")} id="tidy" />
      </View>

      {tab === "tidy" ? (
        <TidyUp key={organizer.slug} organizer={organizer} touch={compact} onOpenNote={onOpenSource} />
      ) : cards.length > 0 || forTeams.length > 0 ? (
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
              <TeamChecklist
                routes={forTeams}
                busy={busy}
                touch={compact}
                onAdd={organizer.sendRoutes}
                onEdit={setSending}
                onKeep={organizer.dismissRoute}
                onSkip={organizer.dismissRoutes}
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
      {tab !== "tidy" ? <TeamSettings teams={teams} keep={keep} onToggle={organizer.setTeamOn} onKeep={organizer.setKeep} /> : null}
    </View>
  );
}

/** One of the page's two tabs: a segment that says how many wait behind it. */
function Tab({
  label,
  count,
  on,
  compact,
  onPress,
  id,
}: {
  label: string;
  count: number;
  on: boolean;
  compact: boolean;
  onPress: () => void;
  id: WhatChangedTab;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      role="tab"
      aria-selected={on}
      accessibilityState={{ selected: on }}
      accessibilityLabel={count > 0 ? `${label}, ${count} waiting` : label}
      onPress={onPress}
      style={[styles.tab, compact && styles.tabTouch, on && styles.tabOn]}
      testID={`what-changed-tab-${id}`}
    >
      <Text variant="rowTitle" style={on ? styles.tabTextOn : styles.tabText}>
        {label}
      </Text>
      {count > 0 ? (
        <Text variant="rowTitle" style={on ? styles.tabCountOn : styles.tabText}>
          {String(count)}
        </Text>
      ) : null}
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    tabs: { flexDirection: "row", alignSelf: "flex-start", gap: 4, padding: 4, borderRadius: 12, backgroundColor: colors.surface3 },
    tabsTouch: { alignSelf: "stretch" },
    tab: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 7, paddingHorizontal: 14, borderRadius: 9 },
    tabTouch: { flex: 1 },
    tabOn: { backgroundColor: colors.surface },
    tabText: { color: colors.text2, fontWeight: "500" },
    tabTextOn: { color: colors.text },
    tabCountOn: { color: colors.accentText },
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
