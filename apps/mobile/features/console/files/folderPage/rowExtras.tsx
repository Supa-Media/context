/**
 * The List view: the Notes rows, with three thin extras on each (the owner,
 * 2026-10-10, board 11: "I almost want the list view to look exactly like the
 * notes view, just with some thin extras").
 *
 * A row that is a task gets a small status dot before its name (a ring for
 * Not started, half for In progress, full for Done), and after it a grey
 * "3/9" when it has parts and the face of whoever owns it. A finished one is
 * drawn in grey. A row with no status is a note and gets nothing, but keeps
 * the dot's room so every name starts at the same place.
 *
 * Nothing else: no filter bar, no groups, no Add lines. That is the decision,
 * not an omission — the earlier List drew all of those and was "pretty
 * cluttered". The rows are `FolderRow`, drawn by `FolderView` exactly as Notes
 * draws them, and these extras reach them through a context so that one list
 * of rows serves both views.
 */

import { createContext, useContext, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { OwnerFace, StatusDot, type Face } from "./Glyphs";
import type { StatusTone } from "./StatusPill";
import type { FolderItem } from "./model";
import { ownersOf } from "./taskProps";

/** What one row adds to its Notes self: `null` tone for a row with no status. */
export interface RowExtra {
  readonly tone: StatusTone | null;
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly faces: readonly Face[];
}

/** At most this many faces on a row; more owners than that are one "+N". */
export const MAX_FACES = 2;

/** Each row's extras by its listing path. A row with no item (a drawing, a file the copy has not read) has none. */
export function rowExtras(
  items: readonly FolderItem[],
  toneOf: (status: string) => StatusTone,
  faceOf: (owner: string) => Face,
): ReadonlyMap<string, RowExtra> {
  const extras = new Map<string, RowExtra>();
  for (const item of items) {
    if (item.status === "") {
      extras.set(item.path, { tone: null, progress: null, faces: [] });
      continue;
    }
    const progress = item.progress !== null && item.progress.total > 0 ? item.progress : null;
    extras.set(item.path, { tone: toneOf(item.status), progress, faces: ownersOf(item.properties).map(faceOf) });
  }
  return extras;
}

const RowExtrasContext = createContext<ReadonlyMap<string, RowExtra> | null>(null);

/** Turns the Notes rows inside into List rows. */
export function RowExtrasProvider({ extras, children }: { extras: ReadonlyMap<string, RowExtra>; children: ReactNode }) {
  return <RowExtrasContext.Provider value={extras}>{children}</RowExtrasContext.Provider>;
}

/**
 * `undefined` outside the List (the row is a Notes row and draws nothing
 * extra); `null` inside it for a row with no extras, which still keeps the
 * dot's room.
 */
export function useRowExtra(path: string): RowExtra | null | undefined {
  const extras = useContext(RowExtrasContext);
  if (extras === null) return undefined;
  return extras.get(path) ?? null;
}

/** The status dot, or its empty room. */
export function RowExtraLead({ extra }: { extra: RowExtra | null }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.lead}>{extra?.tone == null ? null : <StatusDot tone={extra.tone} />}</View>;
}

/** The grey "3/9" and the faces, at the end of the row. */
export function RowExtraTrail({ extra }: { extra: RowExtra | null }) {
  const styles = useThemedStyles(makeStyles);
  if (extra === null || (extra.progress === null && extra.faces.length === 0)) return null;
  const shown = extra.faces.slice(0, MAX_FACES);
  const more = extra.faces.length - shown.length;
  return (
    <View style={styles.trail} testID="folder-row-extras">
      {extra.progress === null ? null : (
        <Text
          variant="treeMeta"
          style={styles.count}
          aria-label={`${extra.progress.done} of ${extra.progress.total} done`}
          testID="folder-row-progress"
        >
          {`${extra.progress.done}/${extra.progress.total}`}
        </Text>
      )}
      {shown.length === 0 ? null : (
        <View style={styles.faces}>
          {shown.map((face, index) => (
            <View key={index} style={index > 0 ? styles.overlap : undefined}>
              <OwnerFace face={face} size={FACE} />
            </View>
          ))}
          {more > 0 ? (
            <Text variant="treeMeta" style={styles.count}>
              {`+${more}`}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

const FACE = 20;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    // The dot is 15pt; the room is the same whether or not one is drawn, so names line up.
    lead: { width: 15, alignItems: "center", justifyContent: "center", flexShrink: 0 },
    trail: { flexDirection: "row", alignItems: "center", gap: space.x3, flexShrink: 0, marginLeft: "auto" as never },
    count: { color: colors.chromeMuted, fontVariant: ["tabular-nums"] },
    faces: { flexDirection: "row", alignItems: "center" },
    overlap: { marginLeft: -4 },
  });
