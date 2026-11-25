/**
 * The List's rows: the listing, with three thin extras on each (the owner,
 * 2026-10-10, board 11: "I almost want the list view to look exactly like the
 * notes view, just with some thin extras").
 *
 * A row that is a task gets a small status dot in its icon's place (a ring
 * for Not started, half for In progress, full for Done), and after its name a
 * grey "3/9" when it has parts and the face of whoever owns it. A finished
 * one is drawn in grey. A row with no status is a project item all the same,
 * with an empty dashed circle for its dot (the owner, 2026-10-14: "all items
 * in project folders should have statuses and be treated like an project item
 * with no status if status is not set unless it explicitly has status:note").
 * Only a row that says `status: note` is a note, and keeps its icon; the
 * status menu's Just a note writes that.
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
import { Pressable, StyleSheet, View } from "react-native";
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
  /** A project item with no status yet: an empty circle where the dot goes. */
  readonly unset?: boolean;
  /**
   * The area a project serves, as a quiet tag before its count: its folder and
   * name, or a null folder and "No area" for one in progress that serves none
   * (the owner, 2026-11-25). Only in the Projects folder.
   */
  readonly area?: { readonly folder: string | null; readonly label: string };
}

/** How a writer changes a row from the List: the page's own write and menus. */
export interface RowEdit {
  readonly onChoose: (item: FolderItem, key: string, value: string | null) => void;
  readonly statusMenu: readonly StatusMenuSection[];
  readonly onEditStatuses: (() => void) | null;
  /** What Just a note writes (`status: note`). */
  readonly noteWord: string;
  readonly owners: OwnerChoice;
}

/** At most this many faces on a row; more owners than that are one "+N". */
export const MAX_FACES = 2;

/** Each row's extras by its listing path. A row with no item (a drawing, a file the copy has not read) has none. */
export function rowExtras(
  items: readonly FolderItem[],
  toneOf: (status: string) => StatusTone,
  faceOf: (owner: string) => Face,
  /** A row with no status that is not a project item all the same: the Backlog folder. */
  quiet?: (item: FolderItem) => boolean,
  /** The area tag a project row shows (`RowExtra.area`); absent outside the Projects folder. */
  areaOf?: (item: FolderItem, tone: StatusTone | null) => RowExtra["area"],
): ReadonlyMap<string, RowExtra> {
  const extras = new Map<string, RowExtra>();
  for (const item of items) {
    if (item.noted || (item.status === "" && quiet?.(item) === true)) {
      extras.set(item.path, { tone: null, progress: null, faces: [], item });
      continue;
    }
    const progress = item.progress !== null && item.progress.total > 0 ? item.progress : null;
    const faces = ownersOf(item.properties).map(faceOf);
    const tone = item.status === "" ? null : toneOf(item.status);
    const area = areaOf?.(item, tone);
    const tag = area === undefined ? {} : { area };
    if (item.status === "") extras.set(item.path, { tone: null, progress, faces, item, unset: true, ...tag });
    else extras.set(item.path, { tone, progress, faces, item, ...tag });
  }
  return extras;
}

interface RowExtrasValue {
  readonly extras: ReadonlyMap<string, RowExtra>;
  readonly edit: RowEdit | null;
  /** Opens an area from a project's tag; absent where nothing can be opened. */
  readonly onArea?: (folder: string) => void;
}

const RowExtrasContext = createContext<RowExtrasValue | null>(null);

/** Turns the listing's rows inside into List rows; `edit` null for somebody who may only read. */
export function RowExtrasProvider({ extras, edit = null, onArea, children }: { extras: ReadonlyMap<string, RowExtra>; edit?: RowEdit | null; onArea?: (folder: string) => void; children: ReactNode }) {
  return <RowExtrasContext.Provider value={{ extras, edit, ...(onArea === undefined ? {} : { onArea }) }}>{children}</RowExtrasContext.Provider>;
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

/** Whether a row is a project item: a status, or none yet. */
export function isItem(extra: RowExtra | null | undefined): boolean {
  return extra != null && (extra.tone !== null || extra.unset === true);
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
  if (extra.progress !== null || extra.faces.length > 0 || extra.area !== undefined) return true;
  return edit !== null && isItem(extra) && extra.item !== undefined;
}

/** A task's status dot, in its row's icon slot; for a writer, the button to its status menu. */
export function RowExtraLead({ extra }: { extra: RowExtra | null }) {
  const styles = useThemedStyles(makeStyles);
  const edit = useRowEdit();
  const item = extra?.item;
  const dot =
    extra?.tone != null ? <StatusDot tone={extra.tone} /> : extra?.unset === true ? <View style={styles.unset} testID="folder-row-status-unset" /> : null;
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
        noteWord={edit.noteWord}
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
  const onArea = useContext(RowExtrasContext)?.onArea;
  const shows = useRowTrailShows(extra);
  if (extra === null || !shows) return null;
  const item = extra.item;
  const sole = item === undefined || !isItem(extra) ? null : soleOwner(item);
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
      {extra.area === undefined ? null : <AreaTag area={extra.area} onArea={onArea} />}
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

/** A project's area, quiet before its count; it opens the area. "No area" is fainter still and opens nothing. */
function AreaTag({ area, onArea }: { area: NonNullable<RowExtra["area"]>; onArea: ((folder: string) => void) | undefined }) {
  const styles = useThemedStyles(makeStyles);
  const folder = area.folder;
  const word = (
    <Text variant="treeMeta" style={folder === null ? styles.noArea : styles.areaWord} numberOfLines={1}>
      {area.label}
    </Text>
  );
  if (folder === null || onArea === undefined) {
    return (
      <View style={folder === null ? undefined : styles.areaTag} testID="folder-row-area">
        {word}
      </View>
    );
  }
  return (
    <Pressable onPress={() => onArea(folder)} role="link" accessibilityLabel={`Open area ${area.label}`} hitSlop={4} style={styles.areaTag} testID="folder-row-area">
      {word}
    </Pressable>
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
    areaTag: { maxWidth: 140, paddingHorizontal: 6, paddingVertical: 1, borderRadius: radii.sm, backgroundColor: colors.chipFill },
    areaWord: { color: colors.text2 },
    noArea: { color: colors.chromeMuted },
    overlap: { marginLeft: -4 },
    // A status not set yet: the dot's own ring, dashed (StatusDot is 15pt).
    unset: { width: 15, height: 15, borderRadius: radii.pill, borderWidth: 1.5, borderStyle: "dashed", borderColor: colors.chromeMuted },
    // Where a face goes once somebody owns it: the face's own size, dashed.
    nobody: { width: FACE, height: FACE, borderRadius: radii.pill, borderWidth: 1, borderStyle: "dashed", borderColor: colors.lineStrong },
  });
