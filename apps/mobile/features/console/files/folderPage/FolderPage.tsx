/**
 * A folder page's head and body, around the file listing `FolderView` draws.
 *
 * A projects folder's page, and every page beneath it (`isProjectsFolder`),
 * can be seen two ways — **List**, the listing with a status dot, a grey
 * "2/3" and owners' faces on each task (`rowExtras.tsx`), and **Board**, the
 * tasks as columns — switched by two words on the title's row and remembered
 * per viewer, per folder (`viewMemory.ts`). It opens in List. Any other folder
 * is its listing with no switch and no `Set status`.
 *
 * There were three views until the owner, 2026-10-14, merged Notes into List:
 * "they are very similar. It's just that for projects, we have special UI on
 * it." List had been the Notes rows with thin extras since 2026-10-10, so the
 * two drew the same rows and differed only in the extras.
 *
 * Anything with a status is a task. A note's status goes in its own
 * frontmatter, a folder's in its front note, and a folder with none gets an
 * `about.md` holding just that. The page itself is one too — a project folder
 * is titled by its front note and says its status, owner and first paragraph
 * under the title (`Head.tsx`). A row opens what it names; somebody who may
 * write changes a task's status from its dot and its owner from its face
 * (`rowExtras.tsx`), and adds, moves and changes tasks on the Board — "+ Add",
 * a right-click, a selection, a drag — each write undoable from its toast (`tasks/useFolderTasks.tsx`), and on a desktop page
 * a card opens beside the Board in the side panel (`panel/`).
 *
 * Nothing new is stored and nothing is read that a list block could not read:
 * the notes are the device's copy at the role's clearance, and every change is
 * one frontmatter line written against the version read. Without a host —
 * no device copy for this role, or a surface that passes none — the page is
 * the listing exactly as before, with no switch to offer.
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Reveal } from "../../../design/components/Reveal";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import type { FileEntry } from "../types";
import type { ListNote } from "../listBlock/model";
import { FolderBoard } from "./Board";
import { boardWidth } from "./pageMeasures";
import { makeItTaskStatus, tasksWithSubtasks } from "./taskBasics";
import { rowExtras, RowExtrasProvider, type RowEdit } from "./rowExtras";
import { faceFor } from "./taskFace";
import { useTaskOwners } from "./useTaskOwners";
import { estimateOf } from "./taskProps";
import { FolderHead, PropertyLine, ViewSwitch } from "./Head";
import type { LedeEditing } from "./LedeEditor";
import { AboutBlock } from "./AboutBlock";
import { AboutSheet } from "./AboutSheet";
import { AboutPanel } from "./panel/AboutPanel";
import { ownerChoiceFor, textOf, type ItemActions, type OwnerChoice } from "./items";
import { localOwnerSearch, ownersInUse } from "../owners";
import { useOwnerLabels } from "./useOwnerLabels";
import { useAgents } from "./useAgents";
import { agentShown } from "./agents";
import {
  folderItems,
  groupFolderItems,
  isProjectsFolder,
  NOTE_STATUS,
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
import { rememberView, rememberedView } from "./viewMemory";
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
  aboutPath = null,
  host,
  fallbackTitle,
  icon = null,
  compact,
  pageWidth = 0,
  onSelect,
  rule,
  titleActions,
  files,
}: {
  folder: string;
  /** The listing as `FolderView` draws it: placeholder dropped, in the tree's order. */
  rows: readonly FileEntry[];
  /** The folder's about note as the listing names it (`aboutNoteOf`), which `rows` leaves out. */
  aboutPath?: string | null;
  host: FolderPageHost | undefined;
  /** The folder's own name, for a folder no note names. */
  fallbackTitle: string;
  /** The folder's own emoji, drawn before its title. */
  icon?: string | null;
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
  /** On a phone, the folder's own buttons, on the title's row as Home's are (board 07). */
  titleActions?: ReactNode;
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
  const [pickedFor, setPickedFor] = useState(folder);
  // The page is reconciled across folders without a key; a choice is per folder.
  if (pickedFor !== folder) {
    setPickedFor(folder);
    setPicked(host === undefined ? null : rememberedView(host.workspaceId, folder));
  }

  const now = Date.now();
  // The folder's own front note says what the title and description are, and is read ahead of the rest.
  const described = notes ?? loaded.front;
  const summary = useMemo(
    () => (described === null || folder === "" ? null : summarizeFolder(folder, described)),
    [described, folder],
  );
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
  // A writer is always shown somewhere to park; a reader only what is parked.
  const writer = loaded.canEdit && host?.tasks !== undefined;
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
  // The whole about note, in a sheet where the side panel has no room.
  const [sheet, setSheet] = useState<string | null>(null);
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
    backlogFolder: parkedIn?.path ?? null,
  });

  // The List: the Notes rows, each with its status dot, its "3/9" and its owners' faces (`rowExtras.tsx`).
  const faceOf = taskOwners.faceOf;
  const extras = useMemo(
    // The Backlog folder is where projects are parked, not one of them: it has no status circle.
    () => rowExtras(items, toneOf, (owner) => faceFor({ faceOf, owners }, owner), (item) => item.path === parkedIn?.path),
    [items, toneOf, faceOf, owners, parkedIn],
  );

  if (host === undefined) {
    return (
      <>
        <FolderHead title={fallbackTitle} icon={icon} switcher={null} large={compact} actions={titleActions} folder={folder}>
          {rule}
        </FolderHead>
        <View style={styles.contents}>{files}</View>
      </>
    );
  }

  // Only a projects folder and what is under it tracks progress; anywhere else a view once picked is ignored.
  const tracks = isProjectsFolder(folder);
  const view: FolderPageView = tracks ? (picked ?? "list") : "list";
  // Until the notes can say which group each item is in, a Board holds its place, empty, rather
  // than drawing every card under No status first. The List is the listing, drawn at once.
  const waiting = view === "board" && !loaded.settled;
  const choose = (view: FolderPageView) => {
    setPicked(view);
    rememberView(host.workspaceId, folder, view);
  };
  const status = summary === null ? "" : textOf(summary.properties, "status");
  const isProject = tracks && status !== "";
  // A folder is offered a status on its own page when it is not a top-level
  // area and is not being shown as the list of what is in it.
  const offersStatus = tracks && summary !== null && loaded.canEdit && folder.includes("/") && view === "list";
  const edit = loaded.canEdit ? loaded.choose : null;
  // Every status in the folder's list is a column, empty or not: somewhere to drop a card.
  const bands = statusBands(groups, list);
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
    sized: allTasks.some((task) => estimateOf(task.properties) !== null),
  };
  // A List row's dot and face, for somebody who may write: the same menus a card's are.
  const rowEdit: RowEdit | null =
    actions.onChoose === null
      ? null
      : { onChoose: actions.onChoose, statusMenu: menuSections, onEditStatuses, owners, noteWord: NOTE_STATUS };
  // The Board's rail, where Backlog is a folder: what is in it, and the moves in and out of it.
  const parked = parkedOnBoard(parkedIn, notes ?? [], tasks.controls, writer);
  // The about note drawn atop the page: the listing's, else the device copy's front note. A
  // listed README may be the untouched placeholder New folder used to write, which the device
  // copy can tell (`frontNoteOf`) and a listing cannot, so a README waits for the copy's word.
  const fromCopy = summary !== null && !summary.creates ? summary.target : null;
  const about = aboutPath !== null && !aboutPath.endsWith("/README.md") ? aboutPath : fromCopy;
  // With none, a writer's first sentence creates one: `about.md`, or at the top of the workspace its front page.
  const setLede = host.source.setLede;
  const createTarget = folder === "" ? "index.md" : summary?.creates === true ? summary.target : null;
  const createAbout: LedeEditing | null =
    createTarget === null || setLede === undefined || !loaded.canEdit
      ? null
      : { read: async () => "", save: (text) => setLede(createTarget, text, { create: true }) };
  const problem = loaded.problem ?? tidyProblem ?? tasks.controls?.problem ?? null;
  const peeking = panel.path;
  // The Board's width on a wide page, centred on the column; the panel keeps it when it lies over the Board.
  const wideBoard = compact || pageWidth <= 0 || view !== "board" ? null : boardWidth(columnCount, bands.length, pageWidth);
  // Drawn at the width the peek gives it (`PanelBeside`).
  const beside =
    peeking !== null && peeking === about
      ? (width: number) => (
          <AboutPanel
            path={peeking}
            title={summary?.title ?? fallbackTitle}
            source={host.source}
            width={width}
            onNavigate={onSelect}
            onClose={panel.close}
            {...(host.editing === undefined ? {} : { editing: host.editing })}
          />
        )
      : view !== "board" || waiting || peeking === null
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
        large={compact} folder={folder}
        title={summary?.title ?? fallbackTitle}
        icon={icon}
        onOpenTitle={summary !== null && !summary.creates && summary.title !== null ? () => onSelect(summary.target) : undefined}
        switcher={tracks ? <ViewSwitch view={view} onChange={choose} compact={compact} /> : null}
        actions={
          <>
            {host !== undefined && isWebsiteFolder(folder) ? <PublishWebsite workspaceId={host.workspaceId} /> : null}
            {titleActions}
          </>
        }
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
        <AboutBlock
          path={about}
          title={summary?.heading ?? fallbackTitle}
          source={host.source}
          compact={compact}
          create={createAbout}
          setLede={setLede === undefined || !loaded.canEdit ? null : (path, text) => setLede(path, text)}
          onReadMore={(path) => (panel.fits ? panel.show(path) : setSheet(path))}
          // The device's copy holds the front note's opening paragraph before the bucket answers.
          hint={summary !== null && summary.target === about ? summary.lede : null}
        />
        {isProject ? null : rule}
      </FolderHead>
      {/* Lines that come and go above the list ease in and out rather than shoving it. */}
      <Reveal open={problem !== null || loaded.saving}>
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
      </Reveal>
      {editing && edits.savesTo !== null ? (
        <StatusesDialog
          list={list}
          undeclared={undeclared}
          edits={edits}
          inherited={statuses.from !== null && statuses.from !== folder ? statuses.from : null}
          onClose={() => setEditing(false)}
        />
      ) : null}
      {sheet !== null && sheet === about ? (
        <AboutSheet path={sheet} title={summary?.title ?? fallbackTitle} source={host.source} onOpenNote={onSelect} onClose={() => setSheet(null)} />
      ) : null}
      <PanelBeside panel={beside} pageWidth={pageWidth} wide={view === "board"} mainWidth={wideBoard} style={styles.contents}>
        {view === "list" ? (
          tracks ? (
            <RowExtrasProvider extras={extras} edit={rowEdit}>
              {files}
            </RowExtrasProvider>
          ) : (
            files
          )
        ) : waiting ? (
          <View style={styles.waiting} accessibilityLabel="Loading" testID="folder-waiting" />
        ) : view === "board" && items.length === 0 ? (
          <Text variant="meta" style={styles.aside}>
            Nothing here to track yet. A note or folder added here can be given a status.
          </Text>
        ) : view === "board" ? (
          allTasks.length === 0 ? (
            <Text variant="meta" style={styles.aside} testID="folder-no-tasks">
              Nothing here is a task yet. Give something a status and it shows here.
            </Text>
          ) : (
            <View style={wideBoard === null || beside !== null ? undefined : [styles.wide, { width: wideBoard }]}>
              <FolderBoard bands={bands} compact={compact} now={now} actions={actions} parked={parked} />
            </View>
          )
        ) : null}
        <Reveal open={tracks && !waiting && !loaded.complete && notes !== null}>
          <Text variant="treeMeta" style={styles.aside}>
            This device is still fetching some notes, so a status may be missing.
          </Text>
        </Reveal>
        {view === "board" && skipped > 0 ? (
          <Text variant="treeMeta" style={styles.aside} onPress={() => choose("list")} role="link" testID="folder-skipped">
            {skipped === 1 ? "1 other file is in the List" : `${skipped} other files are in the List`}
          </Text>
        ) : null}
      </PanelBeside>
    </>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    contents: { marginTop: space.x3 },
    addBar: { flexDirection: "row", justifyContent: "flex-end", marginBottom: space.x2 },
    // Wider than the column it sits in, and centred on it, so it overflows both sides alike.
    wide: { alignSelf: "center" },
    // About a short column of cards, so the page does not collapse and grow back.
    waiting: { minHeight: 240 },
    aside: { paddingVertical: space.x2, color: colors.muted },
    link: { color: colors.text2, textDecorationLine: "underline" },
    problem: { marginTop: space.x2, color: colors.critText },
    saving: { marginTop: space.x2, color: colors.muted },
  });
