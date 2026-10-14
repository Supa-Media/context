/**
 * The List's rows: the listing, with three thin extras on each (the owner,
 * 2026-10-10, board 11: "I almost want the list view to look exactly like the
 * notes view, just with some thin extras").
 *
 * A row that is a task gets a small status dot in its icon's place (a ring
 * for Not started, half for In progress, full for Done), and after its name a
 * grey "3/9" when it has parts and the face of whoever owns it. A finished
 * one is drawn in grey. A row with no status is a note and keeps its icon.
 *
 * For somebody who may write, the dot and the face are the controls (the
 * owner, 2026-10-14: "I'm not able to click on the status circle to change
 * it", and "even if it's not assigned to anyone, there should still be like a
 * placeholder circle there to assign it"):
 *
 * - **The dot** opens the status menu a card's status opens, in the folder's
 *   groups.
 * - **The face** opens the owner picker. A task nobody owns shows an empty
 *   dashed ring where the face would be. A task with several owners keeps
 *   its faces as they are: one pick would replace them all, so that is the
 *   side panel's, where each is added and removed on its own.
 *
 * Nothing else: no filter bar, no groups, no Add lines. That is the decision,
 * not an omission — the earlier List drew all of those and was "pretty
 * cluttered". The rows are `FolderRow`, drawn by `FolderView`, and these
 * extras reach them through a context so the listing has one row component.
 */

import { createContext, useContext, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { radii, space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { OwnerFace, StatusDot, type Face } from "./Glyphs";
import type { StatusTone } from "./StatusPill";
import { ownerChoiceFor, textOf, type OwnerChoice } from "./items";
import { NEW_FRONT_NOTE, type FolderItem } from "./model";
import { PropertyValue } from "./PropertyValue";
import type { StatusMenuSection } from "./statuses";
import { ownersOf } from "./taskProps";

/** What one row adds to its plain self: `null` tone for a row with no status. */
export interface RowExtra {
  readonly tone: StatusTone | null;
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly faces: readonly Face[];
  /** What the row's dot and face write to; absent only in tests that build extras by hand. */
  readonly item?: FolderItem;
}

/** How a writer changes a row from the List: the page's own write and menus. */
export interface RowEdit {
  readonly onChoose: (item: FolderItem, key: string, value: string | null) => void;
  readonly statusMenu: readonly StatusMenuSection[];
  readonly onEditStatuses: (() => void) | null;
  readonly owners: OwnerChoice;
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
      extras.set(item.path, { tone: null, progress: null, faces: [], item });
      continue;
    }
    const progress = item.progress !== null && item.progress.total > 0 ? item.progress : null;
    extras.set(item.path, { tone: toneOf(item.status), progress, faces: ownersOf(item.properties).map(faceOf), item });
  }
  return extras;
}

interface RowExtrasValue {
  readonly extras: ReadonlyMap<string, RowExtra>;
  readonly edit: RowEdit | null;
}

const RowExtrasContext = createContext<RowExtrasValue | null>(null);

/** Turns the listing's rows inside into List rows; `edit` null for somebody who may only read. */
export function RowExtrasProvider({ extras, edit = null, children }: { extras: ReadonlyMap<string, RowExtra>; edit?: RowEdit | null; children: ReactNode }) {
  return <RowExtrasContext.Provider value={{ extras, edit }}>{children}</RowExtrasContext.Provider>;
}

/**
 * `undefined` outside the List (the row draws nothing extra); `null` inside
 * it for a row with no extras, which still keeps the dot's room.
 */
export function useRowExtra(path: string): RowExtra | null | undefined {
  const value = useContext(RowExtrasContext);
  if (value === null) return undefined;
  return value.extras.get(path) ?? null;
}

/** The write a row's controls make, or null where the List is only read. */
function useRowEdit(): RowEdit | null {
  return useContext(RowExtrasContext)?.edit ?? null;
}

/** The task's owner one pick replaces: its only one, or "" for none; null when it has several. */
function soleOwner(item: FolderItem): string | null {
  const owners = ownersOf(item.properties);
  if (owners.length > 1) return null;
  return owners.length === 0 ? "" : textOf(item.properties, "owner");
}

/** Whether the row's end draws anything: a count, a face, or a writer's empty one. */
export function useRowTrailShows(extra: RowExtra | null | undefined): boolean {
  const edit = useRowEdit();
  if (extra == null) return false;
  if (extra.progress !== null || extra.faces.length > 0) return true;
  return edit !== null && extra.tone !== null && extra.item !== undefined;
}

/** A task's status dot, in its row's icon slot; for a writer, the button to its status menu. */
export function RowExtraLead({ extra }: { extra: RowExtra | null }) {
  const styles = useThemedStyles(makeStyles);
  const edit = useRowEdit();
  const item = extra?.item;
  const dot = extra?.tone == null ? null : <StatusDot tone={extra.tone} />;
  if (edit === null || item === undefined || dot === null) {
    return <View style={styles.lead}>{dot}</View>;
  }
  return (
    <View style={styles.lead}>
      <PropertyValue
        property="status"
        value={item.status}
        choices={[]}
        sections={edit.statusMenu}
        onEditList={edit.onEditStatuses}
        savesTo={item.creates ? NEW_FRONT_NOTE : null}
        onChoose={(value) => edit.onChoose(item, "status", value)}
        lead={dot}
        glyph
        testID="folder-row-status"
      />
    </View>
  );
}

/** The grey "3/9" and the faces, at the end of the row. */
export function RowExtraTrail({ extra }: { extra: RowExtra | null }) {
  const styles = useThemedStyles(makeStyles);
  const edit = useRowEdit();
  const shows = useRowTrailShows(extra);
  if (extra === null || !shows) return null;
  const item = extra.item;
  const sole = item === undefined || extra.tone === null ? null : soleOwner(item);
  const shown = extra.faces.slice(0, MAX_FACES);
  const more = extra.faces.length - shown.length;
  const faces =
    edit !== null && item !== undefined && sole !== null ? (
      <PropertyValue
        property="owner"
        value={sole}
        choices={[]}
        owners={ownerChoiceFor(edit.owners, item.creates ? null : item.target)}
        savesTo={item.creates ? NEW_FRONT_NOTE : null}
        onChoose={(value) => edit.onChoose(item, "owner", value)}
        lead={shown[0] === undefined ? <View style={styles.nobody} testID="owner-face-placeholder" /> : <OwnerFace face={shown[0]} size={FACE} />}
        glyph
        testID="folder-row-owner"
      />
    ) : shown.length === 0 ? null : (
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
    );
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
      {faces}
    </View>
  );
}

const FACE = 20;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    // The dot is 15pt, in the icon's 16pt slot.
    lead: { width: 15, alignItems: "center", justifyContent: "center", flexShrink: 0 },
    trail: { flexDirection: "row", alignItems: "center", gap: space.x3, flexShrink: 0, marginLeft: "auto" as never },
    count: { color: colors.chromeMuted, fontVariant: ["tabular-nums"] },
    faces: { flexDirection: "row", alignItems: "center" },
    overlap: { marginLeft: -4 },
    // Where a face goes once somebody owns it: the face's own size, dashed.
    nobody: { width: FACE, height: FACE, borderRadius: radii.pill, borderWidth: 1, borderStyle: "dashed", borderColor: colors.lineStrong },
  });
