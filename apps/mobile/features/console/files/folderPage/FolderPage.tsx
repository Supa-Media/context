/**
 * A folder page's head and body, around the file listing `FolderView` draws.
 *
 * Every folder page can be seen three ways — **Files**, the listing as it has
 * always been; **List**, its folders and notes grouped by status; **Board**,
 * the same groups as columns — switched by three words on the title's row and
 * remembered per viewer, per folder (`viewMemory.ts`). A folder opens in List
 * once anything in it has a status, and in Files otherwise.
 *
 * Any folder or note in it becomes a tracked item by getting a status: a
 * note's goes in its own frontmatter, a folder's in its front note, and a
 * folder with none gets an `overview.md` holding just that. The page itself
 * is one too — a project folder is titled by its front note and says its
 * status, owner and first paragraph under the title (`Head.tsx`).
 *
 * Nothing new is stored and nothing is read that a list block could not read:
 * the notes are the device's copy at the role's clearance, and every change is
 * one frontmatter line written against the version read. Without a host —
 * no device copy for this role, or a surface that passes none — the page is
 * the Files listing exactly as before, with no switch to offer.
 */

import { useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import type { FileEntry } from "../types";
import { noteColumnWidth } from "../../../app/frame";
import { BOARD_COLUMN, FolderBoard } from "./Board";
import { FolderGroups } from "./Groups";
import { FolderHead, Lede, PropertyLine, ViewSwitch } from "./Head";
import { textOf, type ItemActions } from "./items";
import {
  defaultFolderView,
  folderItems,
  groupFolderItems,
  propertyChoices,
  summarizeFolder,
  type FolderPageView,
} from "./model";
import { useFolderNotes, type FolderPageHost } from "./useFolderPage";
import { TrackNudge } from "./Nudge";
import { dismissNudge, nudgeDismissed, rememberView, rememberedView } from "./viewMemory";

export type { FolderPageHost } from "./useFolderPage";

export function FolderPage({
  folder,
  rows,
  host,
  fallbackTitle,
  compact,
  pageWidth = 0,
  onSelect,
  rule,
  files,
}: {
  folder: string;
  /** The listing as `FolderView` draws it: placeholder dropped, in the tree's order. */
  rows: readonly FileEntry[];
  host: FolderPageHost | undefined;
  /** The folder's own name, for a folder no note names. */
  fallbackTitle: string;
  compact: boolean;
  /**
   * The page's own width. A board is the one view that breaks the note's
   * measure (spec A2): it takes the page less a margin each side, centred on
   * the column, so four columns are on screen rather than two and a half.
   */
  pageWidth?: number;
  onSelect: (path: string) => void;
  /** The visibility sentence. Left out on a project's page, whose property line takes its place. */
  rule: ReactNode;
  /** The Files view: the listing itself. */
  files: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const loaded = useFolderNotes(host, folder);
  const notes = loaded.notes;
  const [picked, setPicked] = useState<FolderPageView | null>(() =>
    host === undefined ? null : rememberedView(host.workspaceId, folder),
  );
  const [pickedFor, setPickedFor] = useState(folder);
  const [, setDismissals] = useState(0);
  // The page is reconciled across folders without a key; a choice is per folder.
  if (pickedFor !== folder) {
    setPickedFor(folder);
    setPicked(host === undefined ? null : rememberedView(host.workspaceId, folder));
  }

  const now = Date.now();
  const summary = useMemo(() => (notes === null || folder === "" ? null : summarizeFolder(folder, notes)), [notes, folder]);
  const { items, skipped } = useMemo(() => folderItems(folder, rows, notes ?? []), [folder, rows, notes]);
  const groups = useMemo(() => groupFolderItems(items, "status"), [items]);
  const people = host?.people;
  const choices = useMemo(() => {
    const memo = new Map<string, readonly string[]>();
    return (key: string) => {
      let found = memo.get(key);
      if (found === undefined) {
        found = propertyChoices(items, key, people ?? []);
        memo.set(key, found);
      }
      return found;
    };
  }, [items, people]);
  const siblingChoices = useMemo(() => {
    // A project folder offers what its siblings use: the parent's items.
    if (notes === null || folder === "") return choices;
    const parent = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
    const siblings = notes
      .filter((note) => note.path.startsWith(parent === "" ? "" : `${parent}/`))
      .map((note) => ({ path: note.path, properties: note.properties }));
    return (key: string) => propertyChoices(siblings, key, people ?? []);
  }, [notes, folder, choices, people]);

  if (host === undefined) {
    return (
      <>
        <FolderHead title={fallbackTitle} switcher={null}>
          {rule}
        </FolderHead>
        <View style={styles.contents}>{files}</View>
      </>
    );
  }

  const view: FolderPageView = picked ?? (notes === null ? "files" : defaultFolderView(items));
  const choose = (view: FolderPageView) => {
    setPicked(view);
    rememberView(host.workspaceId, folder, view);
  };
  const status = summary === null ? "" : textOf(summary.properties, "status");
  const isProject = status !== "";
  // A folder is offered a status on its own page when it is not a top-level
  // area and is not being shown as the list of what is in it.
  const offersStatus = summary !== null && loaded.canEdit && folder.includes("/") && view === "files";
  const edit = loaded.canEdit ? loaded.choose : null;
  // Spec A7: subfolders that could be tracked, none tracked yet, and nobody has picked a view here.
  const nudge =
    view === "files" &&
    picked === null &&
    notes !== null &&
    items.filter((item) => item.kind === "folder").length >= 2 &&
    !items.some((item) => item.status !== "") &&
    !nudgeDismissed(host.workspaceId, folder);
  const actions: ItemActions = {
    onOpen: (item) => onSelect(item.path),
    choices,
    onChoose: edit === null ? null : (item, key, value) => void edit(item.target, key, value, item.creates),
  };

  return (
    <>
      <FolderHead
        title={summary?.title ?? fallbackTitle}
        onOpenTitle={summary !== null && !summary.creates && summary.title !== null ? () => onSelect(summary.target) : undefined}
        switcher={<ViewSwitch view={view} onChange={choose} compact={compact} />}
      >
        {summary !== null && (isProject || offersStatus) ? (
          <PropertyLine
            summary={summary}
            compact={compact}
            now={now}
            choices={siblingChoices}
            onChoose={edit === null ? null : (key, value) => void edit(summary.target, key, value, summary.creates)}
          />
        ) : null}
        {isProject && summary?.lede ? <Lede text={summary.lede} /> : null}
        {isProject ? null : rule}
      </FolderHead>
      {loaded.problem === null ? null : (
        <Text variant="treeMeta" style={styles.problem} role="alert" testID="folder-problem">
          {loaded.problem}
        </Text>
      )}
      {nudge ? (
        <View style={styles.nudge}>
          <TrackNudge
            compact={compact}
            onShow={() => choose("list")}
            onDismiss={() => {
              dismissNudge(host.workspaceId, folder);
              setDismissals((count) => count + 1);
            }}
          />
        </View>
      ) : null}
      <View style={styles.contents}>
        {view === "files" ? (
          files
        ) : items.length === 0 ? (
          <Text variant="meta" style={styles.aside}>
            Nothing here to track yet. A note or folder added here can be given a status.
          </Text>
        ) : view === "board" ? (
          <View style={compact || pageWidth <= 0 ? undefined : [styles.wide, { width: boardWidth(groups.length, pageWidth) }]}>
            <FolderBoard groups={groups} compact={compact} now={now} actions={actions} />
          </View>
        ) : (
          <FolderGroups groups={groups} compact={compact} now={now} actions={actions} />
        )}
        {view !== "files" && !loaded.complete && notes !== null ? (
          <Text variant="treeMeta" style={styles.aside}>
            This device is still fetching some notes, so a status may be missing.
          </Text>
        ) : null}
        {view !== "files" && skipped > 0 ? (
          <Text variant="treeMeta" style={styles.aside} onPress={() => choose("files")} role="link" testID="folder-skipped">
            {skipped === 1 ? "1 other file is in Files" : `${skipped} other files are in Files`}
          </Text>
        ) : null}
      </View>
    </>
  );
}

/** What a board leaves either side of itself on a wide page. */
const BOARD_MARGIN = 48;

/**
 * As wide as its columns want, never narrower than the note's measure (so a
 * two-column board lines up under the title) and never wider than the page
 * less a margin each side, where its columns narrow and then scroll.
 */
function boardWidth(columns: number, pageWidth: number): number {
  const wanted = columns * BOARD_COLUMN + Math.max(0, columns - 1) * space.x4;
  const room = Math.max(0, pageWidth - 2 * BOARD_MARGIN);
  return Math.min(room, Math.max(wanted, Math.min(noteColumnWidth, room)));
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    contents: { marginTop: space.x3 },
    nudge: { marginTop: space.x3 },
    // Wider than the column it sits in, and centred on it, so it overflows both sides alike.
    wide: { alignSelf: "center" },
    aside: { paddingVertical: space.x2, color: colors.muted },
    problem: { color: colors.critText },
  });
