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

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { Reveal } from "../../../design/components/Reveal";
import { Text } from "../../../design/components/Text";
import { space } from "../../../design/tokens";
import { useThemedStyles, type Colors } from "../../../design/theme";
import type { FileEntry } from "../types";
import { ABOUT_NOTE } from "../paths";
import type { ListNote } from "../listBlock/model";
import { FolderBoard } from "./Board";
import { boardWidth } from "./pageMeasures";

import { makeItTaskStatus, tasksWithSubtasks } from "./taskBasics";
import { rowExtras, RowExtrasProvider, type RowEdit } from "./rowExtras";
import { faceFor } from "./taskFace";
import { useTaskOwners } from "./useTaskOwners";
import { estimateOf } from "./taskProps";
import { AREA_VIEWS, AREAS_ROOT_VIEWS, FolderHead, PropertyLine, ViewSwitch } from "./Head";
import { AreasView } from "./areas/AreasView";
import { areaTree } from "./areas/seat";
import { areasFolderNow, inAreasNow, projectsFolderNow } from "../jobIcons/jobFoldersNow";
import { projectAreaTag } from "./areas/areaProjects";
import { useAreaChoices } from "./areas/useAreaChoices";
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
  frontNoteOf,
  groupFolderItems,
  isProjectsFolder,
  NOTE_STATUS,
  propertyChoices,
  rowsAreProjects,
  summarizeFolder,
  type FolderItem,
  type FolderPageView,
} from "./model";
import { SETTLE_AFTER, useFolderNotes, type FolderPageHost } from "./useFolderPage";
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
import { AREA_PANEL_WIDTH } from "./panel/panelModel";
import { useOfferPageSide } from "../../aside/pageSide";

import { TaskPanel } from "./panel/TaskPanel";
import { useTaskPanel } from "./panel/useTaskPanel";
import type { RowNesting } from "../NestedRows";
import { usePendingNotes } from "./tasks/usePendingNotes";
import { backlogFolderOf } from "./tasks/backlogFolder";
import { parkedOnBoard } from "./boardLayout";
import { useFolderTasks } from "./tasks/useFolderTasks";

export type { FolderPageHost } from "./useFolderPage";

/** What the area's trend is drawn across in the right panel: its default 340 less its padding. */
const AREA_SIDE_WIDTH = 300;

const NO_WORDS: readonly string[] = [];
const NO_NOTES: readonly ListNote[] = [];

export function FolderPage({
  folder,
  rows,
  aboutPath = null,
  host,
  fallbackTitle,
  workspaceName = "Areas",
  workspaceHandle,
  icon = null,
  compact,
  pageWidth = 0,
  onSelect,
  rule,
  titleActions,
  files,
  listings,
}: {
  folder: string;
  /** The listing as `FolderView` draws it: placeholder dropped, in the tree's order. */
  rows: readonly FileEntry[];
  /** The folder's about note as the listing names it (`aboutNoteOf`), which `rows` leaves out. */
  aboutPath?: string | null;
  host: FolderPageHost | undefined;
  /** The folder's own name, for a folder no note names. */
  fallbackTitle: string;
  /** What the workspace is called ("Supa"): the top of the Areas folder's List and Chart. */
  workspaceName?: string;
  /** The workspace's handle, `@supa`, which a bot's prompt names. */
  workspaceHandle?: string;
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
  /** The file browser's listings: the Areas page finds the data folder's metrics by them. */
  listings?: RowNesting;
}) {
  const styles = useThemedStyles(makeStyles);
  const loaded = useFolderNotes(host, folder);
  // What the List itself just wrote, drawn before the device's copy and the listing catch up.
  const pending = usePendingNotes(folder, loaded.notes, rows);
  const notes = pending.notes;
  // How long the Areas folder waits, empty, for its notes before it draws the plain listing instead.
  const [gaveUp, setGaveUp] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setGaveUp(folder), SETTLE_AFTER);
    return () => clearTimeout(timer);
  }, [folder]);
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
  const projectsRoot = projectsFolderNow();
  const projectsParent = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
  /** The rows here are projects: the Projects folder, or a folder of projects in it with no status of its own. */
  const projectRows = folder === projectsRoot || (projectsParent === projectsRoot && textOf(frontNoteOf(folder, notes ?? NO_NOTES)?.properties ?? {}, "status") === "");
  /** This page is a project: directly in the Projects folder, or in a folder of projects there. */
  const projectPage =
    projectsRoot !== "" &&
    (projectsParent === projectsRoot || (projectsParent.startsWith(`${projectsRoot}/`) && !projectsParent.slice(projectsRoot.length + 1).includes("/")));
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
  // What the Areas page draws in the side panel: an area's details (`areas/AreaPanel.tsx`), or null.
  const [areaPanel, setAreaPanelState] = useState<((width: number) => ReactNode) | null>(null);
  const setAreaPanel = useCallback((next: ((width: number) => ReactNode) | null) => setAreaPanelState(() => next), []);
  // The area goes in the console's right panel, where Meetings is (`aside/pageSide.tsx`); with no
  // console around the page, beside the list (`beside` below). Only an Areas page sets one.
  const offered = useMemo(() => (areaPanel === null ? null : areaPanel(AREA_SIDE_WIDTH)), [areaPanel]);
  const inAside = useOfferPageSide(offered);
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
    () =>
      rowExtras(
        items,
        toneOf,
        (owner) => faceFor({ faceOf, owners }, owner),
        (item) => item.path === parkedIn?.path,
        // In the Projects folder, and in a folder of projects in it (`backlog/`), each project says which area it serves.
        projectRows ? (item, tone) => (item.path === parkedIn?.path ? undefined : projectAreaTag(item.properties, tone)) : undefined,
      ),
    [items, toneOf, faceOf, owners, parkedIn, projectRows],
  );
  // A project's own page offers the areas it can serve.
  const areaChoices = useAreaChoices(host, areasFolderNow(), projectPage);

  if (host === undefined) {
    return (
      <>
        <FolderHead title={fallbackTitle} icon={icon} switcher={null} large={compact} actions={titleActions}>
          {rule}
        </FolderHead>
        <View style={styles.contents}>{files}</View>
      </>
    );
  }

  // Only a projects folder and what is under it tracks progress; anywhere else a view once picked is ignored.
  const tracks = isProjectsFolder(folder);
  // The Areas folder and every area in it is drawn as seats: List or Chart (`areas/AreasView.tsx`).
  // Decided by the folder, so the page does not draw the plain listing first and swap to the seats
  // once the notes arrive (the owner saw that flicker in production): until they land it waits,
  // empty, under its switch. A device whose notes have not come by `SETTLE_AFTER` gets the plain
  // listing rather than a blank page.
  // A personal workspace has one owner for every area, so its Areas folder is the plain listing.
  const areasHere = !tracks && host.personal !== true && inAreasNow(folder);
  const seats = areasHere && notes !== null;
  const seatsWaiting = areasHere && notes === null && gaveUp !== folder;
  // The Areas folder itself also shows its Bots and the Mail between them; an area below it, only List and Chart.
  const areasRoot = areasHere && folder === areasFolderNow();
  const seatView = picked === "chart" || (areasRoot && (picked === "bots" || picked === "talks")) ? picked : "list";
  const view: FolderPageView = tracks ? (picked === "chart" || picked === "bots" || picked === "talks" ? "list" : (picked ?? "list")) : seats || seatsWaiting ? seatView : "list";
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
  // The about note drawn atop the page: the folder's `about.md` (`aboutNoteName`), as the listing
  // names it, else as the device copy holds it. An `overview.md` is never drawn here: it is the
  // project's main note and stays a row (the owner, 2026-11-17).
  const ownAbout = folder === "" ? null : `${folder}/${ABOUT_NOTE}`;
  const fromCopy = ownAbout !== null && described?.some((note) => note.path === ownAbout) === true ? ownAbout : null;
  const about = aboutPath ?? fromCopy;
  // With none, a writer's first sentence creates one: `about.md`, or at the top of the workspace its front page.
  const setLede = host.source.setLede;
  const createTarget = folder === "" ? "index.md" : summary !== null && about === null ? ownAbout : null;
  const createAbout: LedeEditing | null =
    createTarget === null || setLede === undefined || !loaded.canEdit
      ? null
      : { read: async () => "", save: (text) => setLede(createTarget, text, { create: true }) };
  const problem = loaded.problem ?? tidyProblem ?? tasks.controls?.problem ?? null;
  const peeking = panel.path;
  // The Board's width on a wide page, centred on the column; the panel keeps it when it lies over the Board.
  const wideBoard = compact || pageWidth <= 0 || view !== "board" ? null : boardWidth(columnCount, bands.length, pageWidth);
  // The Areas chart spreads like the Board: one column per area, plus its "Add area".
  const chartColumns = seats && view === "chart" && !compact && pageWidth > 0 ? areaTree(folder, areasFolderNow(), notes ?? NO_NOTES).areas.length + 1 : 0;
  // Each column is 232 wide with 20 between (the owner's board, 2026-11-24).
  const wideChart = chartColumns === 0 ? null : Math.min(pageWidth - 96, Math.max(chartColumns * 252, boardWidth(1, 1, pageWidth)));
  // The Areas list and a projects List keep the page's own column, so their edges line up with the
  // title and the List · Chart switch above them, as in the prototype (the owner, 2026-11-24:
  // "spacing still looks off" beside an 820 list that overhung the title on both sides).
  const wideAreas = wideChart;
  // The Areas panel docks at the page region's right edge, full height, where the region hosts a
  // dock (the pointer layout's `DocumentSurface`); elsewhere it is drawn beside the list as below.
  // Drawn at the width the peek gives it (`PanelBeside`).
  const beside =
    seats && areaPanel !== null
      ? inAside
        ? null
        : areaPanel
      : peeking !== null && peeking === about
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
        large={compact}
        title={summary?.title ?? fallbackTitle}
        icon={icon}
        onOpenTitle={summary !== null && !summary.creates && summary.title !== null ? () => onSelect(summary.target) : undefined}
        switcher={
          tracks ? (
            <ViewSwitch view={view} onChange={choose} compact={compact} />
          ) : seats || seatsWaiting ? (
            <ViewSwitch view={view} onChange={choose} compact={compact} views={areasRoot ? AREAS_ROOT_VIEWS : AREA_VIEWS} />
          ) : null
        }
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
            {...(areaChoices === undefined ? {} : { area: areaChoices })}
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
      <PanelBeside panel={beside} pageWidth={pageWidth} wide={view === "board" || wideAreas !== null} mainWidth={wideBoard ?? wideAreas} panelWidth={seats ? AREA_PANEL_WIDTH : null} style={styles.contents}>
        {seatsWaiting ? (
          <View style={styles.waiting} accessibilityLabel="Loading" testID="areas-waiting" />
        ) : seats ? (
          <View style={wideAreas === null || beside !== null ? undefined : [styles.wide, { width: wideAreas }]}>
          <AreasView
            folder={folder}
            root={areasFolderNow()}
            rootName={workspaceName}
            notes={notes ?? NO_NOTES}
            view={view === "chart" || view === "bots" || view === "talks" ? view : "list"}
            compact={compact}
            canEdit={loaded.canEdit}
            faceOf={(owner) => faceFor({ faceOf, owners }, owner ?? undefined)}
            label={label}
            isAgent={agents.isAgent}
            people={searchOwners}
            agents={agentList}
            {...(agents.addAgent === null ? {} : { addAgent: agents.addAgent })}
            {...(workspaceHandle === undefined ? {} : { workspace: workspaceHandle })}
            chooseMany={loaded.chooseMany}
            onSelect={onSelect}
            {...(host?.source.readBody === undefined ? {} : { readBody: host.source.readBody })}
            {...(host === undefined ? {} : { host })}
            {...(listings === undefined ? {} : { listings })}
            // In the right panel an area shows at any pointer width; drawn beside the list, only where it fits.
            {...((inAside ? !compact : panel.fits) ? { onPanel: setAreaPanel } : {})}
          />
          </View>
        ) : view === "list" ? (
          tracks ? (
            <RowExtrasProvider extras={extras} edit={rowEdit} onArea={onSelect}>
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
