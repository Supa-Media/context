import { useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../design/components/Button";
import { Icon, type IconName } from "../design/components/Icon";
import { Reveal } from "../design/components/Reveal";
import { Text } from "../design/components/Text";
import { TextLink } from "../design/components/TextLink";
import { radii, space } from "../design/tokens";
import { type Colors, useColors, useThemedStyles } from "../design/theme";
import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { handled, moveTo, skipped, TIDY_GROUPS, tidyCopy, type TidyGroup } from "./tidyCopy";
import type { OrganizerSuggestion, UndoToken } from "./types";
import type { OrganizerView } from "./useOrganizer";

/** Rows a group shows before "N more". */
const FIRST = 3;

const GROUP_ICON: Record<TidyGroup["kind"], IconName> = { done: "check", file: "arrowRight", archive: "archive" };

/** A row answered on this visit: it stays where it was, as a line with its Undo. */
interface Answered {
  item: OrganizerSuggestion;
  decision: "accept" | "dismiss";
  undo: UndoToken | null;
  /** Undo pressed: the suggestion is back, and shows again on the next read. */
  back: boolean;
}

/**
 * Tidy up: the What changed page's second tab, boards 10 and 11 of the What
 * changed canvas (2026-10-07). It replaced the "11 suggestions" row and its
 * popover, which Dev2 found confusing beside What changed and called ugly.
 *
 * The suggestions about notes the owner already has, grouped by what they
 * would do: Looks finished, Belongs somewhere else, Quiet for a while. A row
 * is the note (a link to it), why, and one button that says what it does,
 * with Skip beside it; each group can be answered at once. An answered row
 * stays in place as one line with its Undo, and a bar fills as they go, so
 * clearing the list feels like getting somewhere. When nothing is left it
 * says so, rather than showing an empty page.
 */
export function TidyUp({
  organizer,
  touch,
  onOpenNote,
}: {
  organizer: OrganizerView;
  touch: boolean;
  onOpenNote: (path: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const { list, loading, failed, busy } = organizer.suggestions;
  const [answered, setAnswered] = useState<ReadonlyMap<string, Answered>>(new Map());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // Where each suggestion first stood, so an answered one keeps its place.
  const order = useRef(new Map<string, number>());
  for (const item of list ?? []) if (!order.current.has(item.id)) order.current.set(item.id, order.current.size);

  const remember = (entries: Answered[]) =>
    setAnswered((current) => {
      const next = new Map(current);
      for (const entry of entries) next.set(entry.item.id, entry);
      return next;
    });
  const answer = (item: OrganizerSuggestion, decision: "accept" | "dismiss") => {
    void organizer.resolve(item, decision).then((result) => {
      if (result?.applied) remember([{ item, decision, undo: result.undo ?? null, back: false }]);
    });
  };
  const answerAll = (items: readonly OrganizerSuggestion[]) => {
    void organizer.resolveMany(items, "accept").then((results) => {
      remember(items.filter((item) => results.has(item.id)).map((item) => ({ item, decision: "accept" as const, undo: results.get(item.id)?.undo ?? null, back: false })));
    });
  };
  const putBack = (entry: Answered) => {
    if (entry.undo === null) return;
    void organizer.undo(entry.undo).then((ok) => {
      if (!ok) return;
      remember([{ ...entry, back: true }]);
      // It is a suggestion again: read the list so it comes back as a row.
      organizer.loadSuggestions();
    });
  };

  const done = [...answered.values()].filter((entry) => !entry.back);
  // An answered one is gone the moment it is answered, whether or not the list has caught up.
  const waiting = (list ?? []).filter((item) => !done.some((entry) => entry.item.id === item.id));
  const all = waiting.length + done.length;

  if (list === null || (waiting.length === 0 && done.length === 0)) {
    return (
      <View style={styles.empty} testID={list === null || loading || failed ? "tidy-note" : "tidy-all-done"}>
        {list === null || loading ? (
          <>
            <ActivityIndicator size="small" color={colors.muted} />
            <Text variant="body" style={styles.muted}>
              {tidyCopy.loading}
            </Text>
          </>
        ) : failed ? (
          <Text variant="body" style={styles.muted}>
            {tidyCopy.failed}
          </Text>
        ) : (
          <AllTidy />
        )}
      </View>
    );
  }

  return (
    <View style={styles.tab} testID="tidy-up">
      <View style={styles.hero} testID="tidy-progress">
        <View style={[styles.heroHead, touch && styles.heroHeadTouch]}>
          <Text variant="rowTitle" style={styles.heroTitle}>
            {tidyCopy.heroTitle}
          </Text>
          <Text variant="rowTitle" style={styles.count}>
            {tidyCopy.progress(done.length, all)}
          </Text>
        </View>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${all === 0 ? 0 : Math.round((done.length / all) * 100)}%` }]} />
        </View>
        <Text variant="treeMeta" style={styles.muted}>
          {tidyCopy.heroLede}
        </Text>
      </View>

      {waiting.length === 0 ? <AllTidy appear /> : null}

      {TIDY_GROUPS.map((group) => {
        const left = waiting.filter((item) => item.kind === group.kind);
        const gone = [...answered.values()].filter((entry) => entry.item.kind === group.kind && !left.some((item) => item.id === entry.item.id));
        if (left.length === 0 && gone.length === 0) return null;
        const rows = [...left.map((item) => ({ item, entry: null as Answered | null })), ...gone.map((entry) => ({ item: entry.item, entry }))].sort(
          (a, b) => (order.current.get(a.item.id) ?? 0) - (order.current.get(b.item.id) ?? 0),
        );
        const showAll = open.has(group.kind);
        const shown = showAll ? rows : rows.slice(0, FIRST);
        const groupBusy = left.some((item) => busy.has(item.id));
        return (
          <View key={group.kind} style={styles.group} role="group" aria-label={group.title} testID={`tidy-group-${group.kind}`}>
            <View style={[styles.groupHead, touch && styles.groupHeadTouch]}>
              <View style={styles.groupTitle}>
                <View style={[styles.tile, styles[`tile_${group.kind}`]]} aria-hidden>
                  <Icon name={GROUP_ICON[group.kind]} size={14} color={group.kind === "done" ? colors.accent : colors.text2} />
                </View>
                <View style={styles.grow}>
                  <Text variant="rowTitle">{`${group.title} · ${left.length}`}</Text>
                  <Text variant="treeMeta" style={styles.muted}>
                    {group.lede}
                  </Text>
                </View>
              </View>
              {left.length > 1 ? (
                <Button
                  label={group.all(left.length)}
                  onPress={() => answerAll(left)}
                  disabled={groupBusy}
                  variant="dialog"
                  testID={`tidy-all-${group.kind}`}
                />
              ) : null}
            </View>
            {shown.map(({ item, entry }) =>
              entry === null ? (
                <TidyRow
                  key={item.id}
                  item={item}
                  group={group}
                  touch={touch}
                  pending={busy.has(item.id)}
                  onOpen={() => onOpenNote(item.path)}
                  onAnswer={(decision) => answer(item, decision)}
                />
              ) : (
                <AnsweredRow key={item.id} entry={entry} onUndo={() => putBack(entry)} />
              ),
            )}
            {rows.length > FIRST ? (
              <View style={styles.moreRow}>
                <TextLink
                  label={showAll ? tidyCopy.less : tidyCopy.more(rows.length - FIRST)}
                  onPress={() =>
                    setOpen((current) => {
                      const next = new Set(current);
                      if (showAll) next.delete(group.kind);
                      else next.add(group.kind);
                      return next;
                    })
                  }
                  testID={`tidy-more-${group.kind}`}
                />
              </View>
            ) : null}
          </View>
        );
      })}

      <View style={styles.foot}>
        <TextLink label={tidyCopy.settings} onPress={organizer.openSettings} testID="tidy-settings" />
      </View>
    </View>
  );
}

function TidyRow({
  item,
  group,
  touch,
  pending,
  onOpen,
  onAnswer,
}: {
  item: OrganizerSuggestion;
  group: TidyGroup;
  touch: boolean;
  pending: boolean;
  onOpen: () => void;
  onAnswer: (decision: "accept" | "dismiss") => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const to = moveTo(item);
  return (
    <View style={[styles.row, touch && styles.rowTouch]} testID={`tidy-row-${item.id}`}>
      <View style={styles.rowText}>
        {/* The note's name opens the note: plain type, so the row's one loud thing is its button. */}
        <Text
          variant="rowTitle"
          role="link"
          accessibilityLabel={`Open ${item.title}`}
          onPress={onOpen}
          style={styles.title}
          testID={`tidy-open-${item.id}`}
        >
          {isolateForDisplay(item.title)}
        </Text>
        {to !== null ? (
          <View style={styles.moveLine}>
            <Text variant="treeMeta" style={styles.muted}>
              Move to
            </Text>
            <View style={styles.chip}>
              <Text variant="treeMeta" style={styles.chipText}>
                {to}
              </Text>
            </View>
          </View>
        ) : null}
        {item.reason ? (
          <Text variant="treeMeta" style={styles.muted}>
            {isolateForDisplay(item.reason)}
          </Text>
        ) : null}
      </View>
      <View style={[styles.acts, touch && styles.actsTouch]}>
        <Button
          label={tidyCopy.skip}
          accessibilityLabel={`${tidyCopy.skip}: ${item.title}`}
          onPress={() => onAnswer("dismiss")}
          disabled={pending}
          variant="dialog"
          style={touch ? styles.grow : undefined}
          testID={`tidy-skip-${item.id}`}
        />
        <Button
          label={group.one}
          accessibilityLabel={`${group.one}: ${item.title}`}
          onPress={() => onAnswer("accept")}
          disabled={pending}
          variant="dialogPrimary"
          style={touch ? styles.grow : undefined}
          testID={`tidy-do-${item.id}`}
        />
      </View>
    </View>
  );
}

function AnsweredRow({ entry, onUndo }: { entry: Answered; onUndo: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const accepted = entry.decision === "accept";
  return (
    <Reveal open appear>
      <View style={[styles.row, styles.answered]} testID={`tidy-answered-${entry.item.id}`}>
        <View style={styles.answeredText}>
          {accepted && !entry.back ? <Icon name="check" size={14} color={colors.accent} /> : null}
          <Text variant="treeMeta" style={styles.answeredLine}>
            {entry.back ? `${isolateForDisplay(entry.item.title)}: ${tidyCopy.undone}` : accepted ? handled(entry.item) : skipped(entry.item)}
          </Text>
        </View>
        {accepted && !entry.back && entry.undo !== null ? (
          <TextLink label={tidyCopy.undo} onPress={onUndo} testID={`tidy-undo-${entry.item.id}`} />
        ) : null}
      </View>
    </Reveal>
  );
}

/** The tab with nothing left: a check, said plainly. */
function AllTidy({ appear = false }: { appear?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <Reveal open appear={appear}>
      <View style={styles.allTidy} testID="tidy-all-tidy">
        <View style={styles.badge}>
          <Icon name="check" size={28} color={colors.accent} />
        </View>
        <Text variant="paneTitle">{tidyCopy.allTidy}</Text>
        <Text variant="body" style={[styles.muted, styles.center]}>
          {tidyCopy.allTidyLede}
        </Text>
      </View>
    </Reveal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    tab: { gap: space.x4 },
    muted: { color: colors.chromeMuted },
    center: { textAlign: "center" },
    grow: { flex: 1, minWidth: 0 },
    empty: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.x3, padding: space.x6 },
    hero: { gap: space.x2, padding: space.x5, borderRadius: radii.card, backgroundColor: colors.accentDim },
    heroHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: space.x3 },
    heroHeadTouch: { flexDirection: "column", alignItems: "flex-start", gap: 2 },
    heroTitle: { color: colors.text, flexShrink: 1 },
    count: { color: colors.accentText },
    track: { height: 8, borderRadius: radii.pill, backgroundColor: colors.surface, overflow: "hidden" },
    fill: { height: "100%", borderRadius: radii.pill, backgroundColor: colors.accent },
    group: { borderRadius: radii.card, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface, overflow: "hidden" },
    groupHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.x3, padding: space.x4 },
    groupHeadTouch: { flexDirection: "column", alignItems: "stretch" },
    groupTitle: { flexDirection: "row", alignItems: "center", gap: space.x3, flex: 1, minWidth: 0 },
    tile: { width: 30, height: 30, borderRadius: 9, alignItems: "center", justifyContent: "center" },
    tile_done: { backgroundColor: colors.accentDim },
    tile_file: { backgroundColor: colors.chipFill },
    tile_archive: { backgroundColor: colors.surface3 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingVertical: space.x3,
      paddingHorizontal: space.x4,
      borderTopWidth: 1,
      borderTopColor: colors.line,
    },
    rowTouch: { flexDirection: "column", alignItems: "stretch" },
    rowText: { flex: 1, minWidth: 0, gap: 4 },
    title: { alignSelf: "flex-start", color: colors.text },
    moveLine: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
    chip: { paddingVertical: 2, paddingHorizontal: 8, borderRadius: radii.pill, backgroundColor: colors.accentDim },
    chipText: { color: colors.accentText, fontWeight: "600" },
    acts: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    actsTouch: { alignSelf: "stretch" },
    answered: { backgroundColor: colors.surface2, justifyContent: "space-between" },
    answeredText: { flexDirection: "row", alignItems: "center", gap: space.x2, flex: 1, minWidth: 0 },
    answeredLine: { color: colors.text2, flexShrink: 1 },
    moreRow: { alignItems: "center", paddingVertical: space.x3, borderTopWidth: 1, borderTopColor: colors.line },
    foot: { alignItems: "flex-start" },
    allTidy: { alignItems: "center", gap: space.x3, paddingVertical: space.x8, paddingHorizontal: space.x5 },
    badge: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center", backgroundColor: colors.accentDim },
  });
