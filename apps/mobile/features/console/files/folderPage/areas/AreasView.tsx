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

import { useCallback, useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Button } from "../../../../design/components/Button";
import { Menu } from "../../../../design/components/Menu";
import { Text } from "../../../../design/components/Text";
import { fonts, pointerType, radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import { useFieldFont } from "../../../../design/fieldFont";
import type { MenuItem } from "../../menu";
import type { ListNote } from "../../listBlock/model";
import type { Face } from "../Glyphs";
import type { PropertyChanges } from "../useFolderPage";
import { AreasChart } from "./AreasChart";
import { AreasList } from "./AreasList";
import { SeatDialog } from "./SeatDialog";
import {
  AREA_KEY,
  areaTree,
  cardChanges,
  cardOf,
  cardSlug,
  PEOPLE_ABOUT,
  peopleFolder,
  reachLine,
  seatChanges,
  type Card,
  type Seat,
  type SeatEdit,
} from "./seat";

export type AreasPageView = "list" | "chart";

type SeatMenuId = "open" | "up" | "edit" | "add" | "owner" | "about";

export interface AreasViewProps {
  folder: string;
  /** The Areas folder, by job. */
  root: string;
  notes: readonly ListNote[];
  view: AreasPageView;
  compact: boolean;
  canEdit: boolean;
  faceOf: (owner: string | null) => Face;
  label: (owner: string) => string;
  isAgent: (owner: string) => boolean;
  /** Owners in use and the workspace's agents, offered as chips in the pop-up. */
  suggestions: readonly string[];
  chooseMany: (target: string, changes: PropertyChanges, creates: boolean) => Promise<string | null>;
  onSelect: (path: string) => void;
}

const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

export function AreasView(props: AreasViewProps) {
  const { folder, root, notes, view, compact, canEdit, faceOf, label, isAgent, suggestions, chooseMany, onSelect } = props;
  const tree = useMemo(() => areaTree(folder, root, notes), [folder, root, notes]);
  const [menu, setMenu] = useState<{ seat: Seat; at: { x: number; y: number } | undefined } | null>(null);
  const [editing, setEditing] = useState<Seat | null>(null);
  const [adding, setAdding] = useState<Seat | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const cardFor = useCallback(
    (holder: string, kind: Card["kind"]) => cardOf(holder, kind, root, notes),
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

  const items = (seat: Seat): MenuItem<SeatMenuId>[] => {
    const isRoot = seat.folder === folder;
    const out: MenuItem<SeatMenuId>[] = [];
    if (!isRoot) out.push({ id: "open", label: "Open" });
    if (isRoot && folder !== root) out.push({ id: "up", label: "Up to the area above" });
    out.push({ id: "edit", label: canEdit ? "Edit seat…" : "View seat…" });
    if (canEdit) out.push({ id: "add", label: "Add a sub-area…" });
    if (canEdit) out.push({ id: "owner", label: seat.owner === null ? "Assign owner…" : "Change owner…" });
    out.push({ id: "about", label: "Open about.md" });
    return out;
  };
  const onMenu = (id: SeatMenuId) => {
    const seat = menu?.seat;
    setMenu(null);
    if (seat === undefined) return;
    if (id === "open") onSelect(seat.folder);
    else if (id === "up") onSelect(parentOf(folder));
    else if (id === "edit" || id === "owner") setEditing(seat);
    else if (id === "add") setAdding(seat);
    else if (id === "about") onSelect(seat.about.target);
  };

  const shared = { tree, compact, faceOf, label, reach, onMenu: openMenu };
  return (
    <View testID="areas-view">
      {problem !== null ? (
        <Text variant="treeMeta" role="alert" testID="areas-problem">
          {problem}
        </Text>
      ) : null}
      {view === "chart" ? (
        <AreasChart {...shared} onOpen={onSelect} onAdd={canEdit ? (parent) => setAdding(parent) : null} />
      ) : (
        <AreasList {...shared} onOpen={onSelect} />
      )}
      {menu !== null ? (
        <Menu<SeatMenuId>
          items={items(menu.seat)}
          {...(menu.at === undefined ? {} : { anchor: menu.at })}
          title={menu.seat.name}
          {...(menu.seat.owner === null ? {} : { titleDetail: `${label(menu.seat.owner)}${reach(menu.seat.owner) === "" ? "" : ` · ${reach(menu.seat.owner)}`}` })}
          onSelect={onMenu}
          onDismiss={() => setMenu(null)}
        />
      ) : null}
      {editing !== null ? (
        <SeatDialog
          seat={editing}
          cardFor={cardFor}
          isAgent={isAgent}
          suggestions={suggestions}
          label={label}
          canEdit={canEdit}
          onSave={(edit, cards) => save(editing, edit, cards)}
          onClose={() => setEditing(null)}
        />
      ) : null}
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
