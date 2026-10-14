import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";

import { Button, PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { layout, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { PaneHead } from "../ConsoleShell";
import { PersonFace } from "../faces/PersonFace";
import { relativeTime } from "../format";
import {
  groupByDay,
  groupByPerson,
  itemTitle,
  placeLabel,
  sharerLabel,
  type SharedItem,
} from "./sharedInbox";

/**
 * @shared: everything people shared with you by name (Dev2, 2026-10-14,
 * board A2). The account-wide list beside your workspaces, the way Drive's
 * Shared with me sits beside My Drive, so it never repeats inside a tree.
 *
 * A row opens the share's own page — the note in the real editor, read only
 * (board A3) — rather than a copy of it drawn here, so there is one place a
 * shared note is read and one place that decides what its token reaches.
 *
 * Wide, a sidebar of the people who shared with you narrows the list to one of
 * them (board A2's left column). A phone has the list alone, newest first.
 */
export function SharedPane({ onOpen, onClose }: { onOpen: (token: string) => void; onClose: () => void }) {
  const items = useQuery(api.functions.shares.listSharedWithMe) as SharedItem[] | undefined;
  const markSeen = useMutation(api.functions.sharedInbox.markSharedSeen);
  const count = items?.length;

  /*
    Opening the page is reading it, and so is a share arriving while it is
    open: the account menu's dot is for what you have not seen yet.
  */
  useEffect(() => {
    if (count === undefined) return;
    void markSeen({}).catch(() => {
      // A missed mark leaves the dot on until next time; nothing to tell anyone.
    });
  }, [count, markSeen]);

  return <SharedList items={items} onOpen={onOpen} onClose={onClose} now={Date.now()} />;
}

/** The page itself, with no server: what the tests render. */
export function SharedList({
  items,
  onOpen,
  onClose,
  now,
}: {
  /** `undefined` while the list has not arrived. */
  items: readonly SharedItem[] | undefined;
  onOpen: (token: string) => void;
  onClose: () => void;
  now: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const { width } = useWindowDimensions();
  const wide = width >= layout.narrowBreakpoint;
  const [person, setPerson] = useState<string | null>(null);

  const people = useMemo(() => groupByPerson(items ?? []), [items]);
  // A filter on somebody who no longer shares anything is a filter on nobody.
  const chosen = people.some((group) => group.sharedBy === person) ? person : null;
  const shown = useMemo(
    () => (items ?? []).filter((item) => chosen === null || item.sharedBy === chosen),
    [items, chosen],
  );
  const groups = useMemo(() => groupByDay(shown, now), [shown, now]);

  return (
    <View style={styles.pane} testID="shared-pane">
      <PaneHead
        title="@shared"
        description="Notes people shared with you."
        leading={
          <Button
            label="Close"
            leading={<Icon name="close" size={14} />}
            onPress={onClose}
            accessibilityLabel="Close @shared"
            testID="shared-close"
          />
        }
      />

      {items === undefined ? null : items.length === 0 ? (
        <View style={styles.empty} testID="shared-empty">
          <Text variant="rowTitle">Nothing shared with you yet.</Text>
          <Text variant="rowSub" style={styles.muted}>
            When someone shares a note with you, it shows up here, even from a workspace you are not in.
          </Text>
        </View>
      ) : (
        <View style={styles.body}>
          {wide && people.length > 1 ? (
            <View style={styles.people} role="navigation" aria-label="People" testID="shared-people">
              <PressRow
                accessibilityLabel="Everyone"
                selected={chosen === null}
                onPress={() => setPerson(null)}
                radius={radii.sm}
                style={styles.personRow}
                testID="shared-person-everyone"
              >
                <Icon name="people" size={16} />
                <Text variant="tree" numberOfLines={1} style={styles.grow}>
                  Everyone
                </Text>
                <Text variant="treeMeta" style={styles.muted}>
                  {items.length}
                </Text>
              </PressRow>
              {people.map((group) => (
                <PressRow
                  key={group.sharedBy}
                  accessibilityLabel={`Shared by ${group.label}`}
                  selected={chosen === group.sharedBy}
                  onPress={() => setPerson(group.sharedBy)}
                  radius={radii.sm}
                  style={styles.personRow}
                  testID={`shared-person-${group.sharedBy}`}
                >
                  <PersonFace name={group.handle === null ? null : `@${group.handle}`} size={18} />
                  <Text variant="tree" numberOfLines={1} style={styles.grow}>
                    {group.label}
                  </Text>
                  <Text variant="treeMeta" style={styles.muted}>
                    {group.items.length}
                  </Text>
                </PressRow>
              ))}
            </View>
          ) : null}

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} testID="shared-list">
            {groups.map((group) => (
              <View key={group.heading} style={styles.group}>
                <Text variant="listGroup" style={styles.heading}>
                  {group.heading}
                </Text>
                {group.items.map((item) => (
                  <SharedRow key={item.token} item={item} now={now} onOpen={onOpen} />
                ))}
              </View>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

function SharedRow({ item, now, onOpen }: { item: SharedItem; now: number; onOpen: (token: string) => void }) {
  const styles = useThemedStyles(makeStyles);
  const title = itemTitle(item);
  const who = sharerLabel(item);
  const place = placeLabel(item);
  const when = relativeTime(item.createdAt, now);
  const line = [who, place === null ? null : `in ${place}`, when].filter(Boolean).join(" · ");
  return (
    <PressRow
      accessibilityLabel={`${title}, shared by ${who}${place === null ? "" : ` in ${place}`}, ${when}. You can read it.`}
      onPress={() => onOpen(item.token)}
      radius={radii.sm}
      style={styles.row}
      testID={`shared-row-${item.token}`}
    >
      <PersonFace name={item.sharedByHandle === null ? null : `@${item.sharedByHandle}`} size={28} />
      <View style={styles.rowText}>
        <Text variant="rowTitle" numberOfLines={1}>
          {title}
        </Text>
        <Text variant="rowSub" numberOfLines={1} style={styles.muted}>
          {line}
        </Text>
      </View>
      {/* Every share is read-only for now; editing someone else's note comes next. */}
      <Pill>Can read</Pill>
    </PressRow>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    pane: { flex: 1, gap: space.x3 },
    body: { flex: 1, flexDirection: "row", gap: space.x4 },
    people: { width: 200, gap: 2 },
    personRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingHorizontal: space.x2,
      paddingVertical: space.x1,
    },
    grow: { flex: 1, minWidth: 0 },
    scroll: { flex: 1 },
    scrollContent: { gap: space.x4, paddingBottom: space.x6 },
    group: { gap: 2 },
    heading: { paddingHorizontal: space.x2, paddingBottom: space.x1 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingHorizontal: space.x2,
      paddingVertical: space.x2,
    },
    rowText: { flex: 1, minWidth: 0, gap: 2 },
    muted: { color: colors.text2 },
    empty: { paddingVertical: space.x6, gap: space.x2, maxWidth: 420 },
  });
