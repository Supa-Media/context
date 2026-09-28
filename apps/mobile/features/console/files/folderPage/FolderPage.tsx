/**
 * A folder page's head and body, around the file listing `FolderView` draws.
 *
 * A projects folder's page, and every page beneath it (`isProjectsFolder`),
 * can be seen three ways — **Notes**, the listing as it has always been;
 * **List**, its tasks by status and then its plain notes; **Board**, the
 * tasks as columns — switched by three words on the title's row and
 * remembered per viewer, per folder (`viewMemory.ts`). A folder opens in List
 * once anything in it has a status, and in Notes otherwise. Any other folder
 * is its listing with no switch, no nudge and no `Set status`.
 *
 * Anything with a status is a task; anything without is a plain note, drawn
 * below the tasks with "Make it a task" (`listLayout.ts`). A note's status
 * goes in its own frontmatter, a folder's in its front note, and a folder
 * with none gets an `overview.md` holding just that. The page itself is one
 * too — a project folder is titled by its front note and says its status,
 * owner and first paragraph under the title (`Head.tsx`). Above the List,
 * "Show" narrows it to whose tasks, per viewer (`ShowBar.tsx`). Somebody who
 * may write adds, nests, moves and changes tasks from the List — "+ Add
 * task", a right-click, a selection, a drag — each write undoable from its
 * toast (`tasks/useFolderTasks.tsx`). On a desktop page any row — a task, a
 * note, a project — opens beside the List or Board in the side panel
 * (`panel/`); on a phone, on its own page.
 *
 * Nothing new is stored and nothing is read that a list block could not read:
 * the notes are the device's copy at the role's clearance, and every change is
 * one frontmatter line written against the version read. Without a host —
 * no device copy for this role, or a surface that passes none — the page is
 * the listing exactly as before, with no switch to offer.
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import type { FileEntry } from "../types";
import type { ListNote } from "../listBlock/model";
import { noteColumnWidth } from "../../../app/frame";
import { BOARD_COLUMN, FolderBoard } from "./Board";
import { FolderGroups } from "./Groups";
import { listLayout, makeItTaskStatus } from "./listLayout";
import { ShowBar } from "./ShowBar";
import { chipCounts, EVERYONE, filterMatch, tasksWithSubtasks, type ShowFilter } from "./showFilter";
import { useTaskOwners } from "./useTaskOwners";
import { FolderHead, Lede, PropertyLine, ViewSwitch } from "./Head";
import { ownerChoiceFor, textOf, type ItemActions, type OwnerChoice } from "./items";
import { localOwnerSearch, ownersInUse } from "../owners";
import { useOwnerLabels } from "./useOwnerLabels";
import { useAgents } from "./useAgents";
import { agentShown } from "./agents";
import {
  defaultFolderView,
  folderItems,
  groupFolderItems,
  isProjectsFolder,
  propertyChoices,
  rowsAreProjects,
  summarizeFolder,
  type FolderItem,
  type FolderPageView,
} from "./model";
import { useFolderNotes, type FolderPageHost } from "./useFolderPage";
import {
  folderStatuses,
  governingFolder,
  groupOfStatus,
  statusBands,
  statusMenu,
  undeclaredStatuses,
  type StatusGroup,
} from "./statuses";
import { StatusesDialog } from "./StatusesDialog";
import { useStatusEdits } from "./useStatusEdits";
import { TrackNudge } from "./Nudge";
import { dismissNudge, nudgeDismissed, rememberFilter, rememberView, rememberedFilter, rememberedView } from "./viewMemory";
import { PublishWebsite, isWebsiteFolder } from "../../website/PublishWebsite";
import { PanelBeside } from "./panel/PanelBeside";
import { TaskPanel } from "./panel/TaskPanel";
import { useTaskPanel } from "./panel/useTaskPanel";
import { usePendingNotes } from "./tasks/usePendingNotes";
import { backlogFolderOf } from "./tasks/backlogFolder";
import { parkedOnBoard } from "./boardLayout";
import { useFolderTasks } from "./tasks/useFolderTasks";

export type { FolderPageHost } from "./useFolderPage";

const NO_WORDS: readonly string[] = [];
const NO_NOTES: readonly ListNote[] = [];

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
  /** The Notes view: the listing itself. */
  files: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const loaded = useFolderNotes(host, folder);
  // What the List itself just wrote, drawn before the device's copy and the listing catch up.
  const pending = usePendingNotes(folder, loaded.notes, rows);
  const notes = pending.notes;
  const [picked, setPicked] = useState<FolderPageView | null>(() =>
    host === undefined ? null : rememberedView(host.workspaceId, folder),
  );
  const [filter, setFilter] = useState<ShowFilter>(() =>
    host === undefined ? EVERYONE : (rememberedFilter(host.workspaceId, folder) ?? EVERYONE),
  );
  const [pickedFor, setPickedFor] = useState(folder);
  const [, setDismissals] = useState(0);
  // The page is reconciled across folders without a key; a choice is per folder.
  if (pickedFor !== folder) {
    setPickedFor(folder);
    setPicked(host === undefined ? null : rememberedView(host.workspaceId, folder));
    setFilter(host === undefined ? EVERYONE : (rememberedFilter(host.workspaceId, folder) ?? EVERYONE));
  }

  const now = Date.now();
  const summary = useMemo(() => (notes === null || folder === "" ? null : summarizeFolder(folder, notes)), [notes, folder]);
  const { items, skipped } = useMemo(() => folderItems(folder, pending.rows, notes ?? []), [folder, pending.rows, notes]);
  // The folder's status list says what its children's statuses mean; its parent's, what its own means.
  const statuses = useMemo(() => folderStatuses(folder, notes ?? []), [folder, notes]);
  const parentFolder = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
  const parentStatuses = useMemo(() => folderStatuses(parentFolder, notes ?? []), [parentFolder, notes]);
  const list = statuses.list;
  // `backlog/` in this folder is its Backlog: drawn as the band, never as a row (`tasks/backlogFolder.ts`).
  const parkedIn = useMemo(() => backlogFolderOf(items, folder), [items, folder]);
  // The Board draws tasks only: a child with no status is a note, not a card; the Backlog folder is its rail.
  const groups = useMemo(
    () => groupFolderItems(items.filter((item) => item.status !== "" && item.path !== parkedIn?.path), "status", list),
    [items, list, parkedIn],
  );
  const people = host?.people;
  const choices = useMemo(() => {
    const memo = new Map<string, readonly string[]>();
    return (key: string) => {
      let found = memo.get(key);
      if (found === undefined) {
        found = propertyChoices(items, key, list);
        memo.set(key, found);
      }
      return found;
    };
  }, [items, list]);
  const siblings = useMemo(
    () => (notes ?? []).filter((note) => note.path.startsWith(parentFolder === "" ? "" : `${parentFolder}/`)),
    [notes, parentFolder],
  );
  const siblingChoices = useMemo(() => {
    // A project folder offers what its siblings use: the parent's items.
    if (notes === null || folder === "") return choices;
    return (key: string) => propertyChoices(siblings, key, parentStatuses.list);
  }, [notes, folder, choices, siblings, parentStatuses]);
  // An owner is picked from the workspace's people and agents, searched on the
  // server; with no server (the landing page's demo), from the people it was handed.
  const serverOwners = host?.source.searchOwners;
  const searchOwners = useMemo(() => serverOwners ?? localOwnerSearch(people ?? []), [serverOwners, people]);
  const suggestFor = host?.source.suggestOwner;
  const inUse = useMemo(() => ownersInUse(items), [items]);
  const siblingsInUse = useMemo(() => ownersInUse(siblings), [siblings]);
  // The viewer's own words are asked about only where a List can say "Mine": a projects folder.
  const me = isProjectsFolder(folder) ? host?.me : undefined;
  const ownerWords = useMemo(() => [...inUse, ...siblingsInUse, ...(me ?? [])], [inUse, siblingsInUse, me]);
  const resolved = useOwnerLabels(host?.source.resolveOwners, ownerWords);
  // Agents are the workspace's own short list, and somebody may add to it here (`agents.ts`).
  const agents = useAgents(loaded, folder, notes, searchOwners);
  const agentList = agents.list;
  // An agent that claimed work notes its thread in brackets; the column shows the agent, the note is for hovering.
  const label = useCallback(
    (value: string) => resolved(agentShown(value, agentList) ?? value),
    [resolved, agentList],
  );
  const taskOwners = useTaskOwners(me ?? NO_WORDS, label, agents.isAgent, agentList);
  const allTasks = useMemo(() => tasksWithSubtasks(items, notes ?? []), [items, notes]);
  const counts = useMemo(() => chipCounts(allTasks, taskOwners.who), [allTasks, taskOwners.who]);
  // A filter remembered from when there were tasks narrows nothing once there are none: its bar is gone.
  const shown = allTasks.length === 0 ? EVERYONE : filter;
  // A writer is always shown somewhere to park; a reader only what is parked.
  const writer = loaded.canEdit && host?.tasks !== undefined;
  const layout = useMemo(
    () => listLayout(items, list, notes ?? [], filterMatch(shown, taskOwners.who), { folder: parkedIn, always: writer }),
    [items, list, notes, shown, taskOwners.who, parkedIn, writer],
  );
  const suggestAgents = useMemo(
    () => (suggestFor === undefined ? undefined : (path: string, prefer: readonly string[]) => suggestFor(path, prefer, agentList)),
    [suggestFor, agentList],
  );
  const shared = useMemo(
    () => ({
      search: agents.search,
      label,
      isAgent: agents.isAgent,
      ...(suggestAgents === undefined ? {} : { suggestFor: suggestAgents }),
      ...(agents.addAgent === null ? {} : { addAgent: agents.addAgent }),
    }),
    [agents.search, agents.addAgent, agents.isAgent, label, suggestAgents],
  );
  const owners = useMemo<OwnerChoice>(() => ({ ...shared, prefer: inUse }), [shared, inUse]);
  const siblingOwners = useMemo<OwnerChoice>(() => ({ ...shared, prefer: siblingsInUse }), [shared, siblingsInUse]);
  const menuSections = useMemo(() => statusMenu(list), [list]);
  const parentMenu = useMemo(() => statusMenu(parentStatuses.list), [parentStatuses]);
  const undeclared = useMemo(() => undeclaredStatuses(items, list), [items, list]);
  const edits = useStatusEdits(loaded, folder, statuses, summary === null ? null : { target: summary.target, creates: summary.creates });
  const [editing, setEditing] = useState(false);
  const [tidyProblem, setTidyProblem] = useState<string | null>(null);
  const toneOf = useCallback((status: string) => groupOfStatus(status, list) ?? ("unplaced" as const), [list]);
  // Any row pressed on a desktop page opens beside the list (`panel/`); on a phone, on its own page.
  const panel = useTaskPanel(folder, compact, pageWidth);
  const openItem = (item: FolderItem) => (panel.fits ? panel.show(item.path) : onSelect(item.path));
  const makeTaskLabel = rowsAreProjects(folder) ? "Make it a project" : "Make it a task";
  const tasks = useFolderTasks({
    host: host?.tasks,
    loaded,
    folder,
    notes: notes ?? NO_NOTES,
    rows: pending.rows,
    items,
    list,
    record: pending.record,
    owners,
    label,
    me,
    onOpen: openItem,
    makeTaskLabel,
    compact,
    backlogFolder: parkedIn?.path ?? null,
  });

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

  // Only a projects folder and what is under it tracks progress; anywhere else a view once picked is ignored.
  const tracks = isProjectsFolder(folder);
  // Until the notes can say which view fits, and which group each item is in, a List or Board waits.
  const view: FolderPageView = !tracks ? "files" : picked ?? (!loaded.settled ? "files" : defaultFolderView(items));
  // A List or Board somebody picked holds its place, empty, rather than drawing everything as a note first.
  const waiting = view !== "files" && !loaded.settled;
  const choose = (view: FolderPageView) => {
    setPicked(view);
    rememberView(host.workspaceId, folder, view);
  };
  const status = summary === null ? "" : textOf(summary.properties, "status");
  const isProject = tracks && status !== "";
  // A folder is offered a status on its own page when it is not a top-level
  // area and is not being shown as the list of what is in it.
  const offersStatus = tracks && summary !== null && loaded.canEdit && folder.includes("/") && view === "files";
  const edit = loaded.canEdit ? loaded.choose : null;
  // Spec A7: subfolders that could be tracked, none tracked yet, and nobody has picked a view here.
  // Only to somebody who could then set a status: a member would be offered
  // a list of notes with nothing on them to press.
  const nudge =
    tracks &&
    loaded.canEdit &&
    view === "files" &&
    picked === null &&
    notes !== null &&
    items.filter((item) => item.kind === "folder").length >= 2 &&
    !items.some((item) => item.status !== "") &&
    !nudgeDismissed(host.workspaceId, folder);
  // Every status in the folder's list is a column, empty or not: somewhere to drop a card.
  const bands = statusBands(groups, list);
  const showFilter = (next: ShowFilter) => {
    setFilter(next);
    rememberFilter(host.workspaceId, folder, next);
  };
  const columnCount = bands.reduce((sum, band) => sum + band.columns.length, 0);
  const onEditStatuses = edits.savesTo === null ? null : () => setEditing(true);
  const actions: ItemActions = {
    onOpen: openItem,
    onPeek: panel.fits ? (item) => panel.show(item.path) : null,
    selected: panel.path,
    choices,
    onChoose: tasks.choose ?? (edit === null ? null : (item, key, value) => void edit(item.target, key, value, item.creates)),
    statusMenu: menuSections,
    toneOf,
    onEditStatuses,
    onPlaceStatus:
      edits.savesTo === null
        ? null
        : (word: string, group: StatusGroup) => {
            setTidyProblem(null);
            void edits.place(word, group).then((problem) => setTidyProblem(problem));
          },
    owners,
    faceOf: taskOwners.faceOf,
    // The first To do of the list that describes the item: a note inside a task folder is read by that folder's.
    onMakeTask:
      tasks.makeTask ??
      (edit === null
        ? null
        : (item) => void edit(item.target, "status", makeItTaskStatus(folderStatuses(governingFolder(item.target), notes ?? []).list), item.creates)),
    makeTaskLabel,
    tasks: tasks.controls,
    taskMenu: tasks.menu,
  };
  // The Board's rail, where Backlog is a folder: what is in it, and the moves in and out of it.
  const parked = parkedOnBoard(parkedIn, notes ?? [], tasks.controls, writer);
  const problem = loaded.problem ?? tidyProblem ?? tasks.controls?.problem ?? null;
  const peeking = panel.path;
  // Drawn at the width the peek gives it (`PanelBeside`).
  const beside =
    view === "files" || waiting || peeking === null
      ? null
      : (width: number) => (
          <TaskPanel
            path={peeking}
            folder={folder}
            notes={notes ?? []}
            projectTitle={summary?.title ?? fallbackTitle}
            actions={actions}
            chooseMany={loaded.canEdit ? loaded.chooseMany : null}
            perform={tasks.controls?.perform ?? null}
            paths={pending.rows.map((row) => row.path)}
            now={now}
            source={host.source}
            width={width}
            onShow={panel.show}
            onNavigate={onSelect}
            onClose={panel.close}
            {...(host.editing === undefined ? {} : { editing: host.editing })}
          />
        );

  return (
    <>
      <FolderHead
        title={summary?.title ?? fallbackTitle}
        onOpenTitle={summary !== null && !summary.creates && summary.title !== null ? () => onSelect(summary.target) : undefined}
        switcher={tracks ? <ViewSwitch view={view} onChange={choose} compact={compact} /> : null}
        actions={host !== undefined && isWebsiteFolder(folder) ? <PublishWebsite workspaceId={host.workspaceId} /> : null}
      >
        {summary !== null && (isProject || offersStatus) ? (
          <PropertyLine
            summary={summary}
            compact={compact}
            now={now}
            choices={siblingChoices}
            statusMenu={parentMenu}
            owners={ownerChoiceFor(siblingOwners, summary.creates ? null : summary.target)}
            onChoose={edit === null ? null : (key, value) => void edit(summary.target, key, value, summary.creates)}
          />
        ) : null}
        {isProject && summary?.lede ? <Lede text={summary.lede} /> : null}
        {isProject ? null : rule}
      </FolderHead>
      {problem !== null ? (
        <Text variant="treeMeta" style={styles.problem} role="alert" testID="folder-problem">
          {problem}
        </Text>
      ) : loaded.saving ? (
        // Said while a choice is on its way, so a value that moved is not mistaken for one that is saved.
        <Text variant="treeMeta" style={styles.saving} role="status" testID="folder-saving">
          Saving…
        </Text>
      ) : null}
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
      {editing && edits.savesTo !== null ? (
        <StatusesDialog
          list={list}
          undeclared={undeclared}
          edits={edits}
          inherited={statuses.from !== null && statuses.from !== folder ? statuses.from : null}
          onClose={() => setEditing(false)}
        />
      ) : null}
      <PanelBeside panel={beside} pageWidth={pageWidth} wide={view === "board"} style={styles.contents}>
        {view === "files" ? (
          files
        ) : waiting ? (
          <View style={styles.waiting} accessibilityLabel="Loading" testID="folder-waiting" />
        ) : items.length === 0 && (view === "board" || tasks.controls === null) ? (
          <Text variant="meta" style={styles.aside}>
            Nothing here to track yet. A note or folder added here can be given a status.
          </Text>
        ) : view === "board" ? (
          allTasks.length === 0 ? (
            <Text variant="meta" style={styles.aside} testID="folder-no-tasks">
              Nothing here is a task yet. Give something a status and it shows here.
            </Text>
          ) : (
            <View style={compact || pageWidth <= 0 || beside !== null ? undefined : [styles.wide, { width: boardWidth(columnCount, bands.length, pageWidth) }]}>
              <FolderBoard bands={bands} compact={compact} now={now} actions={actions} parked={parked} />
            </View>
          )
        ) : (
          <>
            {allTasks.length === 0 ? (
              tasks.addButton === null ? null : <View style={styles.addBar}>{tasks.addButton}</View>
            ) : (
              <ShowBar
                filter={filter}
                onChange={showFilter}
                tasks={allTasks}
                who={taskOwners.who}
                me={taskOwners.myName}
                counts={counts}
                faceOf={taskOwners.faceOf}
                compact={compact}
                end={tasks.addButton ?? undefined}
              />
            )}
            <FolderGroups layout={layout} compact={compact} now={now} actions={actions} />
            {tasks.overlays}
            {layout.filtered && layout.sections.length === 0 ? (
              <Text variant="meta" style={styles.aside} testID="folder-filter-empty">
                No tasks match. Choose Everyone to see them all.
              </Text>
            ) : null}
            {tasks.phoneBar}
          </>
        )}
        {view !== "files" && !waiting && !loaded.complete && notes !== null ? (
          <Text variant="treeMeta" style={styles.aside}>
            This device is still fetching some notes, so a status may be missing.
          </Text>
        ) : null}
        {view !== "files" && skipped > 0 ? (
          <Text variant="treeMeta" style={styles.aside} onPress={() => choose("files")} role="link" testID="folder-skipped">
            {skipped === 1 ? "1 other file is in Notes" : `${skipped} other files are in Notes`}
          </Text>
        ) : null}
      </PanelBeside>
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
function boardWidth(columns: number, bands: number, pageWidth: number): number {
  const wanted = columns * BOARD_COLUMN + Math.max(0, columns - bands) * space.x4 + Math.max(0, bands - 1) * space.x6;
  const room = Math.max(0, pageWidth - 2 * BOARD_MARGIN);
  return Math.min(room, Math.max(wanted, Math.min(noteColumnWidth, room)));
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    contents: { marginTop: space.x3 },
    nudge: { marginTop: space.x3 },
    addBar: { flexDirection: "row", justifyContent: "flex-end", marginBottom: space.x2 },
    // Wider than the column it sits in, and centred on it, so it overflows both sides alike.
    wide: { alignSelf: "center" },
    // About a short column of cards, so the page does not collapse and grow back.
    waiting: { minHeight: 240 },
    aside: { paddingVertical: space.x2, color: colors.muted },
    problem: { marginTop: space.x2, color: colors.critText },
    saving: { marginTop: space.x2, color: colors.muted },
  });
