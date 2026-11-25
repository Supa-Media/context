/**
 * The Areas folder's page body: List or Chart of the open area folder, the
 * seat menu a right-click or ⋯ opens, the seat pop-up, and "Add a sub-area".
 *
 * Everything it writes is a few frontmatter lines, through the folder page's
 * own `chooseMany`, so each write is drawn at once and taken back if refused:
 * the seat goes to the area's `about.md`, a holder's card to the Areas
 * folder's `people/<holder>.md`, and a new area is its folder's `about.md`.
 * See `seat.ts` for the shape and `docs/decisions/app-and-console/areas-as-seats.md`
 * for why.
 */

import type { OwnerSearch } from "../../owners";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Modal, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Button } from "../../../../design/components/Button";
import { Text } from "../../../../design/components/Text";
import { fonts, pointerType, radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { useFieldFont } from "../../../../design/fieldFont";
import type { ListNote } from "../../listBlock/model";
import type { Face } from "../Glyphs";
import type { PropertyChanges } from "../useFolderPage";
import { AreaPanel, type AreaPanelProps } from "./AreaPanel";
import { AreasChart } from "./AreasChart";
import { AreasList } from "./AreasList";
import { SeatDialog } from "./SeatDialog";
import { SeatMenu } from "./SeatMenu";
import { seatMenuModel, type SeatMenuId } from "./seatMenuParts";
import type { Listings } from "../../data/useDataWorkspace";
import { useDataMaking } from "../../data/useDataMaking";
import type { FolderPageHost } from "../useFolderPage";
import { areaReading, metricOptions, pickedEdit, workspaceMetricFor } from "./areaMetric";
import { MetricPicker } from "./MetricPicker";
import { useReadings, type ReadBody } from "./useReadings";
import { useWorkspaceMetrics } from "./useWorkspaceMetrics";
import {
  AREA_KEY,
  areaTree,
  cardChanges,
  cardOf,
  cardPath,
  areaTitle,
  cardSlug,
  notesUnder,
  PEOPLE_ABOUT,
  peopleFolder,
  reachLine,
  seatChanges,
  type AreaNode,
  type Card,
  type Seat,
  type SeatEdit,
} from "./seat";
import { mailNotesOf } from "./areaMail";
import { useAreaProjects } from "./useAreaProjects";
import { projectsFolderNow } from "../../jobIcons/jobFoldersNow";

export type AreasPageView = "list" | "chart";

export interface AreasViewProps {
  folder: string;
  /** The Areas folder, by job. */
  root: string;
  /** What the workspace is called, drawn as the top of the chart and the list in the Areas folder itself. */
  rootName: string;
  notes: readonly ListNote[];
  view: AreasPageView;
  compact: boolean;
  canEdit: boolean;
  faceOf: (owner: string | null) => Face;
  label: (owner: string) => string;
  isAgent: (owner: string) => boolean;
  /** The workspace's people, searched in the pop-up's owner picker. */
  people: OwnerSearch;
  /** The workspace's agents (`agents:`), offered as an owner or a person's agent. */
  agents: readonly string[];
  /** Adds a name to the workspace's agents (a new bot); absent for somebody who may not. */
  addAgent?: (name: string) => Promise<string | null>;
  /** The workspace's handle, `@supa`, named in a bot's prompt. */
  workspace?: string;
  chooseMany: (target: string, changes: PropertyChanges, creates: boolean) => Promise<string | null>;
  onSelect: (path: string) => void;
  /** Reads a note's text at the reader's clearance: each area's `metrics.csv`. Absent where nothing can be read. */
  readBody?: ReadBody;
  /**
   * Where the page has room for the side panel: hands the page what to draw
   * there (`PanelBeside`), or null to close it. Absent on a phone, where a
   * press opens the area as it always has.
   */
  onPanel?: (panel: ((width: number) => ReactNode) | null) => void;
  /**
   * The file browser's listings, which find the data folder's sources and
   * metrics, and the page's host, whose source reads them and whose create
   * makes a metric or a source. Without them every area reads its own
   * `metrics.csv`, as before there were workspace metrics.
   */
  listings?: Listings;
  host?: FolderPageHost;
}

/** Two presses on one area this close together are a double click: they open it. */
export const DOUBLE_PRESS_MS = 400;

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

export function AreasView(props: AreasViewProps) {
  const { folder, root, rootName, notes, view, compact, canEdit, faceOf: plainFace, label, isAgent, people, agents, addAgent, workspace: handle, chooseMany, onSelect, readBody, onPanel, listings, host } = props;
  const tree = useMemo(() => areaTree(folder, root, notes), [folder, root, notes]);
  const readings = useReadings(tree, notes, readBody);
  // The projects that serve each area: the Projects folder's own read, front matter only.
  const projectTools = useAreaProjects(host, projectsFolderNow());
  // The workspace's metrics, worked out as they are read; an area naming one reads it, any other its metrics.csv.
  const { metrics: workspace, ws } = useWorkspaceMetrics(host?.source, listings);
  const readingOf = useCallback(
    (seat: Seat) => areaReading(seat.metrics[0], workspace, readings.get(seat.folder)),
    [readings, workspace],
  );
  const [picking, setPicking] = useState<Seat | null>(null);
  const options = useMemo(() => metricOptions(workspace), [workspace]);
  const making = useDataMaking({ host, listings, ws, compact, open: onSelect, stay: true });
  const pick = useCallback((seat: Seat) => setPicking(seat), []);
  const [menu, setMenu] = useState<{ seat: Seat; at: { x: number; y: number } | undefined } | null>(null);
  const [editing, setEditing] = useState<{ seat: Seat; start?: "metric" } | null>(null);
  const [adding, setAdding] = useState<Seat | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Who a new conversation in an area's mail is from: the reader's own @handle, as the owner search knows them.
  const [myHandle, setMyHandle] = useState<string | undefined>(undefined);
  useEffect(() => {
    let live = true;
    people("", [])
      .then((found) => live && setMyHandle(found.people.find((person) => person.isMe && person.value.startsWith("@"))?.value))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [people]);

  const cardFor = useCallback(
    (holder: string, kind: Card["kind"]) => cardOf(holder, kind, root, notes),
    [root, notes],
  );
  // A bot whose card names its logo is drawn as that logo, read through its card (the owner, 2026-11-25).
  const readPicture = host?.source.readPicture;
  const faceOf = useCallback(
    (owner: string | null): Face => {
      const face = plainFace(owner);
      if (owner === null || face.kind !== "agent" || readPicture === undefined) return face;
      const avatar = cardFor(owner, "agent").avatar;
      if (avatar === "") return face;
      const card = cardPath(root, owner);
      return { kind: "agent", picture: { key: `${host?.workspaceId ?? ""}|${avatar}`, read: () => readPicture(card, avatar) } };
    },
    [plainFace, readPicture, cardFor, root, host?.workspaceId],
  );
  // A mail note is named for its sender (`pipeline`): a bot's is drawn with its face.
  const senderFace = useCallback(
    (sender: string): Face | null => {
      const agent = agents.find((name) => cardSlug(name) === sender || name.toLowerCase() === sender.toLowerCase());
      return agent === undefined ? null : faceOf(agent);
    },
    [agents, faceOf],
  );
  // Every area a holder names itself the owner of, from the Areas folder down: a bot's setup prompt covers them all.
  const ownedAreas = useCallback(
    (holder: string) => {
      const out: { folder: string; title: string; modes: readonly string[] }[] = [];
      const walk = (node: AreaNode) => {
        if (node.seat.ownOwner !== null && node.seat.ownOwner.trim().toLowerCase() === holder.trim().toLowerCase()) {
          out.push({ folder: node.seat.folder, title: areaTitle(node.seat.name), modes: node.seat.modes });
        }
        for (const child of node.areas) walk(child);
      };
      walk(areaTree(root, root, notes));
      return out;
    },
    [root, notes],
  );
  const reach = useCallback(
    (owner: string) => reachLine(cardFor(owner, isAgent(owner) ? "agent" : "person")),
    [cardFor, isAgent],
  );
  const openMenu = useCallback((seat: Seat, at: { x: number; y: number } | null) => setMenu({ seat, at: at ?? undefined }), []);

  const save = useCallback(
    async (seat: Seat, edit: SeatEdit, cards: readonly Card[]): Promise<string | null> => {
      const wrote = await chooseMany(seat.about.target, seatChanges(edit), seat.about.creates);
      if (wrote !== null) return wrote;
      // A card is written only when it says something new: opening a seat never creates one.
      const same = (a: Card, b: Card) => JSON.stringify(cardChanges(a)) === JSON.stringify(cardChanges(b));
      const changed = cards.filter((card) => card.holder.trim() !== "" && !same(card, cardOf(card.holder, card.kind, root, notes)));
      if (changed.length === 0) return null;
      const peopleAbout = `${peopleFolder(root)}/about.md`;
      if (!notes.some((note) => note.path === peopleAbout)) {
        const made = await chooseMany(peopleAbout, PEOPLE_ABOUT, true);
        if (made !== null) return made;
      }
      for (const card of changed) {
        const was = cardOf(card.holder, card.kind, root, notes);
        const problemSaving = await chooseMany(`${peopleFolder(root)}/${cardSlug(card.holder)}.md`, cardChanges(card), was.creates);
        if (problemSaving !== null) return problemSaving;
      }
      return null;
    },
    [chooseMany, root, notes],
  );

  const addArea = useCallback(
    async (parent: Seat, name: string): Promise<string | null> => {
      const slug = cardSlug(name);
      if (name.trim() === "") return "Give the area a name.";
      if (notes.some((note) => note.path.startsWith(`${parent.folder}/${slug}/`))) return `${parent.folder}/${slug} already exists.`;
      return chooseMany(`${parent.folder}/${slug}/about.md`, [[AREA_KEY, "true"]], true);
    },
    [chooseMany, notes],
  );

  const onMenu = (id: SeatMenuId) => {
    const seat = menu?.seat;
    setMenu(null);
    if (seat === undefined) return;
    if (id === "open") onSelect(seat.folder);
    else if (id === "up") onSelect(parentOf(folder));
    else if (id === "edit" || id === "owner" || id === "reach") setEditing({ seat });
    else if (id === "metric") setPicking(seat);
    else if (id === "add") setAdding(seat);
    else if (id === "about") onSelect(seat.about.target);
  };

  const dismissMenu = useCallback(() => setMenu(null), []);

  // One press shows the area in the side panel; a second on the same area opens it (the owner, 2026-11-24).
  const [peek, setPeek] = useState<string | null>(null);
  const lastPress = useRef<{ folder: string; at: number } | null>(null);
  const onArea = useCallback(
    (area: string) => {
      const now = Date.now();
      const last = lastPress.current;
      lastPress.current = { folder: area, at: now };
      // The top row is this page already: pressing it only ever shows it in the panel.
      const again = last !== null && last.folder === area && now - last.at < DOUBLE_PRESS_MS && area !== tree.seat.folder;
      if (onPanel === undefined || again) {
        lastPress.current = null;
        setPeek(null);
        onSelect(area);
        return;
      }
      setPeek(area);
    },
    [onPanel, onSelect, tree],
  );
  const closePeek = useCallback(() => setPeek(null), []);
  // A folder change (opening an area) closes the panel.
  useEffect(() => setPeek(null), [folder]);
  const rootTitle = folder === root ? rootName : areaTitle(tree.seat.name);
  const peekNode = peek === null ? undefined : findNode(tree, peek);
  // The panel's contents follow this view's every render through a slot of
  // their own, so the page only hears when the panel opens or closes.
  const slot = useRef(panelSlot()).current;
  const panelProps: Omit<AreaPanelProps, "width"> | null =
    peekNode === undefined
      ? null
      : {
          node: peekNode,
          ...(peekNode === tree ? { top: rootTitle } : {}),
          canEdit,
          faceOf,
          readingOf,
          ...(canEdit ? { onPick: pick } : {}),
          onSave: save,
          ...(projectTools === null || peekNode === tree
            ? {}
            : {
                projects: {
                  projects: projectTools.of(peekNode.seat.folder),
                  choices: projectTools.choices(peekNode.seat.folder),
                  faceOf,
                  open: onSelect,
                  ...(canEdit && projectTools.attach !== undefined ? { attach: projectTools.attach } : {}),
                },
              }),
          mail: {
            notesIn: (area: string) => mailNotesOf(area, notes),
            ...(readBody === undefined ? {} : { read: readBody }),
            ...(canEdit && host?.tasks !== undefined ? { create: (path: string, text: string) => host.tasks!.io.create(path, text) } : {}),
            ...(myHandle === undefined ? {} : { me: myHandle }),
            open: onSelect,
            faceOf: senderFace,
          },
          tools: { people, agents, isAgent, cardFor, label, cardPath: (holder: string) => cardPath(root, holder), ownedAreas, ...(canEdit && host?.source.storePicture !== undefined ? { storePicture: host.source.storePicture } : {}), ...(addAgent === undefined ? {} : { addAgent }), ...(handle === undefined ? {} : { workspace: handle }), ...(host === undefined ? {} : { workspaceId: host.workspaceId }) },
          onPeek: setPeek,
          onOpen: (area) => {
            setPeek(null);
            onSelect(area);
          },
          onClose: closePeek,
        };
  useEffect(() => slot.set(panelProps));
  const peekOpen = peekNode !== undefined;
  useEffect(() => {
    onPanel?.(peekOpen ? (width: number) => <PanelSlot slot={slot} width={width} /> : null);
  }, [onPanel, peekOpen, slot]);
  useEffect(() => () => onPanel?.(null), [onPanel]);
  const countNotes = useCallback((path: string) => notesUnder(path, notes), [notes]);
  const shared = { tree, rootTitle, notesUnder: countNotes, compact, faceOf, label, reach, onMenu: openMenu, readingOf, ...(projectTools === null ? {} : { projectsOf: projectTools.of }) };
  const pickingTitle = picking === null ? "" : picking.folder === folder ? rootTitle : areaTitle(picking.name);
  return (
    <View testID="areas-view">
      {problem !== null ? (
        <Text variant="treeMeta" role="alert" testID="areas-problem">
          {problem}
        </Text>
      ) : null}
      {view === "chart" ? (
        <AreasChart
          {...shared}
          onOpen={onSelect}
          onArea={onArea}
          onAdd={canEdit ? (parent) => setAdding(parent) : null}
          onAssign={canEdit ? (seat) => setEditing({ seat }) : null}
        />
      ) : (
        <AreasList {...shared} onOpen={onSelect} onArea={onArea} selected={peek} rootPeeks={onPanel !== undefined} {...(canEdit ? { onPick: pick } : {})} />
      )}
      {menu !== null ? (
        <SeatMenu
          model={seatMenuModel({
            seat: menu.seat,
            title: menu.seat.folder === folder ? rootTitle : areaTitle(menu.seat.name),
            isRoot: menu.seat.folder === folder,
            hasAreas: (findNode(tree, menu.seat.folder)?.areas.length ?? 0) > 0,
            upTo: folder === root ? null : parentOf(folder) === root ? "areas" : areaTitle(baseName(parentOf(folder))),
            canEdit,
            face: faceOf(menu.seat.owner),
            label,
            card: cardFor,
            isAgent,
          })}
          {...(menu.at === undefined ? {} : { anchor: menu.at })}
          onSelect={onMenu}
          onDismiss={dismissMenu}
        />
      ) : null}
      {editing !== null ? (
        <SeatDialog
          seat={editing.seat}
          {...(editing.start === undefined ? {} : { start: editing.start })}
          cardFor={cardFor}
          isAgent={isAgent}
          people={people}
          agents={agents}
          label={label}
          canEdit={canEdit}
          onSave={(edit, cards) => save(editing.seat, edit, cards)}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {picking !== null ? (
        <MetricPicker
          area={pickingTitle}
          face={faceOf(picking.owner)}
          owner={picking.owner === null ? null : label(picking.owner)}
          aboutPath={picking.about.target}
          options={options}
          known={workspace.known}
          current={picking.metrics[0] === undefined ? null : (workspaceMetricFor(picking.metrics[0].name, workspace.metrics)?.path ?? null)}
          target={picking.metrics[0]?.target ?? null}
          sheet={compact}
          {...(making.newMetric === undefined
            ? {}
            : {
                onNewMetric: () => {
                  setPicking(null);
                  making.newMetric?.();
                },
              })}
          {...(making.connect === undefined
            ? {}
            : {
                onConnect: () => {
                  setPicking(null);
                  making.connect?.();
                },
              })}
          onSave={async (option, mode, value) => {
            const seat = picking;
            const why = await save(seat, pickedEdit(seat, option.name, mode, value), []);
            if (why === null) host?.tasks?.say(`${pickingTitle} now tracks ${option.name}.`);
            return why;
          }}
          onClose={() => setPicking(null)}
        />
      ) : null}
      {making.dialogs}
      {adding !== null ? (
        <AddArea
          parent={adding}
          onAdd={async (name) => {
            const result = await addArea(adding, name);
            if (result === null) setProblem(null);
            return result;
          }}
          onClose={() => setAdding(null)}
        />
      ) : null}
    </View>
  );
}

type PanelProps = Omit<AreaPanelProps, "width"> | null;

/** The side panel's latest contents, which the panel reads as they change. */
function panelSlot() {
  let current: PanelProps = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (next: PanelProps) => {
      current = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function PanelSlot({ slot, width }: { slot: ReturnType<typeof panelSlot>; width: number }) {
  const props = useSyncExternalStore(slot.subscribe, slot.get, slot.get);
  return props === null ? null : <AreaPanel {...props} width={width} />;
}

function findNode(node: AreaNode, folder: string): AreaNode | undefined {
  if (node.seat.folder === folder) return node;
  for (const child of node.areas) {
    const found = findNode(child, folder);
    if (found !== undefined) return found;
  }
  return undefined;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** "Add a sub-area": one name, written as the new folder's `about.md`. */
function AddArea({ parent, onAdd, onClose }: { parent: Seat; onAdd: (name: string) => Promise<string | null>; onClose: () => void }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  const fieldFont = useFieldFont();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    const result = await onAdd(name);
    setBusy(false);
    if (result === null) onClose();
    else setProblem(result);
  };
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.scrim} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={styles.card} onPress={() => undefined} testID="area-add-dialog">
          <Text variant="paneTitle" role="heading" aria-level={2}>Add an area under {parent.name}</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Name, e.g. Marketing"
            placeholderTextColor={colors.muted}
            style={[styles.input, fieldFont]}
            autoFocus
            onSubmitEditing={() => void submit()}
            testID="area-add-name"
          />
          {problem !== null ? <Text variant="treeMeta" style={styles.problem}>{problem}</Text> : null}
          <Text variant="treeMeta" style={styles.muted}>
            Makes {parent.folder}/{cardSlug(name || "name")}/ with an about.md that holds its seat.
          </Text>
          <View style={styles.row}>
            <Button label="Cancel" variant="dialog" onPress={onClose} />
            <Button label="Add" variant="dialogPrimary" onPress={() => void submit()} disabled={busy || name.trim() === ""} testID="area-add-save" />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: { flex: 1, backgroundColor: "rgba(3,3,4,.72)", alignItems: "center", justifyContent: "center", padding: 24 },
    card: {
      width: "100%",
      maxWidth: 380,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
      padding: 20,
      gap: space.x3,
    },
    input: {
      fontFamily: fonts.body,
      fontSize: pointerType.ui,
      color: colors.text,
      height: 32,
      paddingHorizontal: 8,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.sm,
    },
    row: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
    problem: { color: colors.critText },
    muted: { color: colors.muted },
  });
