import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";

import { ScreenScroll } from "../../app/Screen";
import { PressRow } from "../../design/components/Button";
import { Icon } from "../../design/components/Icon";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { pointerType as t, radii, space } from "../../design/tokens";
import { useThemedStyles, type Colors } from "../../design/theme";
import { PersonFace } from "../faces/PersonFace";
import { atName } from "../format";
import { ReportLink } from "../../report/ReportLink";
import { SharedNoteView } from "./SharedNoteView";
import { SharedGrantView } from "./SharedGrantView";
import { openKeyOf, type GrantTarget } from "./sharedGrant";
import {
  groupByDay,
  itemTitle,
  placeLabel,
  sharedItemHref,
  sharedItemKey,
  sharerFace,
  sharerLabel,
  reportPersonOf,
  reportTargetOf,
  shortWhen,
  type SharedItem,
} from "./sharedInbox";

/** The list's column, the width of a note's own: board A2 centres it in the page. */
export const SHARED_MEASURE = 760;

/**
 * @shared's page: the list of everything people shared with you by name
 * (board A2), or one of those notes open in place (board A3). An open note is
 * `?note=<token>` for a share, or `?grant=…` for a row you hold a grant on
 * (`./sharedGrant.ts`). The sidebar beside it is `SharedSidebar`, drawn in the
 * tree's column by `ConsoleFrame`.
 */
export function SharedPane({
  note,
  grant,
  phone,
  me,
  onOpen,
  onList,
  onBack,
  onGo,
}: {
  /** The open share's token, from the address; `null` when none is open. */
  note: string | null;
  /** The open grant, from the address; `null` when none is open. */
  grant: GrantTarget | null;
  phone: boolean;
  /** The reader's own `@name`, for the empty page's "shared with @seyi". */
  me: string | null;
  /** Open a row: the href it lives at. */
  onOpen: (href: string) => void;
  /** Back to the list, from an open note. */
  onList: () => void;
  /** Off @shared altogether: a phone's ‹, which has no sidebar to leave by. */
  onBack: () => void;
  /** Go to another address: a link inside an open note follows the share's own page. */
  onGo: (href: string) => void;
}) {
  const items = useQuery(api.functions.shares.listSharedWithMe) as SharedItem[] | undefined;
  const seenAt = useQuery(api.functions.sharedInbox.sharedSeenAt) as number | null | undefined;
  const markSeen = useMutation(api.functions.sharedInbox.markSharedSeen);
  const count = items?.length;

  /*
    The dots are for what you have not seen. They stay drawn while you are
    here, against the time you arrived, and clear on your next visit; the
    account menu's dot clears at once.
  */
  const [arrivedSeenAt, setArrivedSeenAt] = useState<number | null | undefined>(undefined);
  useEffect(() => {
    if (arrivedSeenAt === undefined && seenAt !== undefined) setArrivedSeenAt(seenAt);
  }, [arrivedSeenAt, seenAt]);
  useEffect(() => {
    if (count === undefined) return;
    void markSeen({}).catch(() => {
      // A missed mark leaves the dot on until next time; nothing to tell anyone.
    });
  }, [count, markSeen]);

  if (grant !== null) {
    const key = openKeyOf(grant);
    const item = key === null ? null : (items?.find((candidate) => sharedItemKey(candidate) === key) ?? null);
    return <SharedGrantView target={grant} item={item} phone={phone} now={Date.now()} onList={onList} onGo={onGo} />;
  }
  if (note !== null) {
    const item = items?.find((candidate) => candidate.kind !== "grant" && candidate.token === note) ?? null;
    return <SharedNoteView token={note} item={item} phone={phone} now={Date.now()} onList={onList} onGo={onGo} />;
  }
  return (
    <SharedList
      items={items}
      seenAt={arrivedSeenAt}
      now={Date.now()}
      phone={phone}
      me={me}
      onOpen={(key) => {
        const item = items?.find((candidate) => sharedItemKey(candidate) === key);
        if (item !== undefined) onOpen(sharedItemHref(item));
      }}
      onBack={onBack}
    />
  );
}

type Filter = "all" | "edit";

/** The list itself, with no server: what the tests render. */
export function SharedList({
  items,
  seenAt,
  now,
  phone,
  me,
  onOpen,
  onBack,
}: {
  /** `undefined` while the list has not arrived. */
  items: readonly SharedItem[] | undefined;
  seenAt: number | null | undefined;
  now: number;
  phone: boolean;
  me: string | null;
  /** A row was pressed: its key (`sharedItemKey`), a token for a share. */
  onOpen: (key: string) => void;
  onBack: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const [filter, setFilter] = useState<Filter>("all");
  /*
    Every share reads today: editing somebody else's note is not built yet, so
    Can edit is honestly empty rather than missing — it is where those will
    be, and the board's one filter.
  */
  const shown = useMemo(() => (filter === "all" ? (items ?? []) : []), [items, filter]);
  // A phone's list is one column with no day headings (board A6), so one group.
  const groups = useMemo(
    () => (phone ? [{ heading: "All", items: groupByDay(shown, now).flatMap((group) => group.items) }] : groupByDay(shown, now)),
    [shown, now, phone],
  );
  const isNew = (item: SharedItem) => seenAt !== undefined && (seenAt === null || item.createdAt > seenAt);

  return (
    <ScreenScroll
      chrome={phone ? PHONE_GUTTER : POINTER_GUTTER}
      contentContainerStyle={[styles.content, phone && styles.contentPhone]}
      testID="shared-pane"
    >
      <View style={styles.measure}>
        {phone ? (
          <PressRow
            accessibilityLabel="Back"
            onPress={onBack}
            radius={radii.pill}
            style={styles.back}
            testID="shared-back"
          >
            <Icon name="chevronLeft" size={16} />
          </PressRow>
        ) : null}
        {items?.length === 0 && !phone ? null : <View style={styles.head}>
          <Text variant={phone ? "paneTitle" : "rowTitle"} style={!phone && styles.title}>
            Shared with me
          </Text>
          <Text variant="rowSub">
            {phone
              ? "From people, across their workspaces"
              : "Notes people shared with you. They live in their workspace, and you see the latest version."}
          </Text>
        </View>}

        {items === undefined ? null : items.length === 0 ? (
          <View style={styles.empty} testID="shared-empty">
            <Icon name="tray" size={28} />
            <Text variant="rowTitle" style={styles.emptyTitle}>
              Nothing shared with you yet
            </Text>
            <Text variant="rowSub" style={styles.emptyText}>
              When someone shares a note with {me ?? "you"}, it shows up here, even if you are not in their workspace.
            </Text>
          </View>
        ) : (
          <>
            {phone ? null : (
              <View style={styles.filters} role="tablist">
                {(["all", "edit"] as const).map((key) => (
                  <PressRow
                    key={key}
                    role="tab"
                    accessibilityLabel={key === "all" ? "All" : "Can edit"}
                    selected={filter === key}
                    onPress={() => setFilter(key)}
                    radius={radii.pill}
                    style={[styles.chip, filter === key && styles.chipOn]}
                    testID={`shared-filter-${key}`}
                  >
                    <Text variant="mini" style={filter === key ? styles.chipOnText : undefined}>
                      {key === "all" ? "All" : "Can edit"}
                    </Text>
                  </PressRow>
                ))}
              </View>
            )}
            {filter === "edit" ? (
              <Text variant="rowSub" style={styles.nothingToEdit} testID="shared-none-editable">
                Nothing is shared with you to edit yet. Everything here you can read.
              </Text>
            ) : (
              groups.map((group) => (
                <View key={group.heading} style={styles.group}>
                  {phone ? null : (
                    <Text variant="eyebrow" style={styles.heading}>
                      {group.heading}
                    </Text>
                  )}
                  {group.items.map((item) => {
                    const key = sharedItemKey(item);
                    // The report sits beside the row rather than inside it, so
                    // it is its own control and never a press on the row. A share
                    // is reported by its token, a grant by its note id.
                    return (
                      <View key={key} style={styles.rowLine}>
                        <View style={styles.grow}>
                          <SharedRow item={item} now={now} fresh={isNew(item)} phone={phone} onOpen={onOpen} />
                        </View>
                        {/* One slot width for every row, so pills and times line up. */}
                        <View style={phone ? styles.reportSlotPhone : styles.reportSlot}>
                          <ReportLink
                            target={reportTargetOf(item)}
                            person={reportPersonOf(item)}
                            label={phone || reportPersonOf(item) === null ? "Report" : "Report or block"}
                            testID={`shared-report-${key}`}
                          />
                        </View>
                      </View>
                    );
                  })}
                </View>
              ))
            )}
          </>
        )}
      </View>
    </ScreenScroll>
  );
}

function SharedRow({
  item,
  now,
  fresh,
  phone,
  onOpen,
}: {
  item: SharedItem;
  now: number;
  fresh: boolean;
  phone: boolean;
  onOpen: (key: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const key = sharedItemKey(item);
  const title = itemTitle(item);
  const who = sharerLabel(item);
  const place = placeLabel(item);
  const when = shortWhen(item.createdAt, now);
  const byline = [who, place === null ? null : phone ? place : `in ${place}`, phone ? when : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <PressRow
      accessibilityLabel={`${title}, shared by ${who}${place === null ? "" : ` in ${place}`}, ${when}${
        fresh ? ", new" : ""
      }. You can read it.`}
      onPress={() => onOpen(key)}
      radius={radii.sm}
      style={[styles.row, phone && styles.rowPhone]}
      hoverStyle={styles.rowHover}
      testID={`shared-row-${key}`}
    >
      {phone ? null : (
        <View style={styles.dotSlot}>{fresh ? <View style={styles.dot} testID={`shared-new-${key}`} /> : null}</View>
      )}
      <Icon name="file" size={14} />
      <View style={styles.rowText}>
        <View style={styles.titleLine}>
          <Text variant="tree" numberOfLines={1} style={styles.rowTitle}>
            {title}
          </Text>
          {phone && fresh ? <View style={styles.dot} testID={`shared-new-${key}`} /> : null}
        </View>
        <View style={styles.byline}>
          <PersonFace name={sharerFace(item)} size={14} />
          <Text variant="treeMeta" numberOfLines={1} style={styles.grow}>
            {byline}
          </Text>
        </View>
      </View>
      <Pill>Can read</Pill>
      {phone ? null : (
        <Text variant="treeMeta" style={styles.when}>
          {when}
        </Text>
      )}
    </PressRow>
  );
}

/** The reader's own `@name`, from their personal workspace's slug. */
export function meLabel(slug: string | undefined): string | null {
  return slug === undefined ? null : atName(slug);
}

const POINTER_GUTTER = { top: space.x7, bottom: space.x8 } as const;
const PHONE_GUTTER = { top: space.x2, bottom: space.x6 } as const;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    content: { paddingHorizontal: space.x7 },
    contentPhone: { paddingHorizontal: space.x5 },
    measure: { width: "100%", maxWidth: SHARED_MEASURE, alignSelf: "center", gap: space.x4 },
    back: {
      width: 36,
      height: 36,
      borderRadius: radii.pill,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface2,
    },
    head: { gap: space.x1 },
    title: { fontSize: t.h3, fontWeight: "600" },
    filters: { flexDirection: "row", gap: space.x2 },
    chip: {
      paddingHorizontal: space.x3,
      paddingVertical: 5,
      borderRadius: radii.pill,
      borderWidth: 1,
      borderColor: colors.line,
    },
    chipOn: { backgroundColor: colors.text, borderColor: colors.text },
    chipOnText: { color: colors.pageSurface },
    nothingToEdit: { paddingVertical: space.x4 },
    group: { gap: 2 },
    heading: { paddingBottom: space.x1 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x2,
      paddingVertical: space.x2,
      paddingHorizontal: space.x2,
    },
    rowPhone: { paddingHorizontal: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
    rowHover: { backgroundColor: colors.surface3 },
    dotSlot: { width: 6, alignItems: "center", marginLeft: -space.x2 - 6, marginRight: 0 },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
    rowText: { flex: 1, minWidth: 0, gap: 2 },
    titleLine: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
    rowTitle: { flexShrink: 1, color: colors.text },
    byline: { flexDirection: "row", alignItems: "center", gap: 5, minWidth: 0 },
    grow: { flex: 1, minWidth: 0 },
    rowLine: { flexDirection: "row", alignItems: "center", gap: space.x2 },
    reportSlot: { width: 104, alignItems: "flex-end" },
    reportSlotPhone: { width: 52, alignItems: "flex-end" },
    when: { minWidth: 64, textAlign: "right" },
    empty: { alignItems: "center", gap: space.x2, paddingVertical: space.x8 * 2 },
    emptyTitle: { fontSize: t.h3, fontWeight: "600", marginTop: space.x2 },
    emptyText: { textAlign: "center", maxWidth: 520 },
  });
