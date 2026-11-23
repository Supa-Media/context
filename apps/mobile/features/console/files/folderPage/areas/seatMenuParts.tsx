/**
 * What the seat menu says, shared by the popover (`SeatMenu.web.tsx`) and the
 * sheet (`SeatMenu.tsx`): a head naming the area and who holds it, how to
 * reach the holder and the helper, then the actions, each with its icon.
 *
 * The approved prototype draws it this way (the owner, 2026-11-23: "do these
 * 2 things look alike?" of a plain four-line menu). How to reach whoever holds
 * the seat comes first because the person opening it is usually triaging:
 * who fixes this, and how do I reach them?
 */

import { Pressable, StyleSheet, View } from "react-native";
import { Icon, type IconName } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { radii, space } from "../../../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../../../design/theme";
import type { MenuItem } from "../../menu";
import { OwnerFace, type Face } from "../Glyphs";
import type { Card, Seat } from "./seat";

export type SeatMenuId = "open" | "up" | "edit" | "add" | "owner" | "reach" | "metric" | "about";

export interface ReachLine {
  readonly icon: IconName | "tex";
  readonly text: string;
  /** What a press copies; none for a line that only says something. */
  readonly copy?: string;
}

export interface ReachBlock {
  readonly title: string;
  readonly lines: readonly ReachLine[];
}

export interface SeatMenuModel {
  readonly title: string;
  readonly subtitle: string;
  readonly face: Face;
  readonly reach: readonly ReachBlock[];
  readonly items: readonly MenuItem<SeatMenuId>[];
}

/** The lines of one holder's card, as the menu lists them. */
export function reachLines(card: Card, name: string): ReachLine[] {
  const out: ReachLine[] = [];
  if (card.kind === "person") {
    if (card.phone !== "") out.push({ icon: "phone", text: card.phone, copy: card.phone });
    if (card.email !== "") out.push({ icon: "mail", text: card.email, copy: card.email });
    const deleg = card.delegation.trim();
    if (deleg.toLowerCase() === "tex") out.push({ icon: "tex", text: `Delegates to Tex: text Tex and it answers for ${name}` });
    else if (deleg !== "") out.push({ icon: "robot", text: `Delegates to ${deleg}${card.delegationHow === "" ? "" : `. ${card.delegationHow}`}` });
    if (out.length === 0) out.push({ icon: "more", text: "No contact yet" });
  } else {
    out.push({ icon: "robot", text: card.access === "" ? "No access notes yet" : card.access });
    if (card.vault !== "") out.push({ icon: "lock", text: `Login in the vault: ${card.vault}` });
  }
  return out;
}

export interface SeatMenuInputs {
  readonly seat: Seat;
  readonly title: string;
  /** The open folder's own seat: the top of the list or chart. */
  readonly isRoot: boolean;
  /** The open folder is an area under the Areas folder, so there is somewhere to go up to. */
  readonly canGoUp: boolean;
  readonly canEdit: boolean;
  readonly face: Face;
  readonly label: (owner: string) => string;
  readonly card: (holder: string, kind: Card["kind"]) => Card;
  readonly isAgent: (owner: string) => boolean;
}

export function seatMenuModel(input: SeatMenuInputs): SeatMenuModel {
  const { seat, title, isRoot, canGoUp, canEdit, face, label, card, isAgent } = input;
  const owner = seat.owner;
  const ownerName = owner === null ? "No owner" : label(owner);
  const reach: ReachBlock[] = [];
  if (owner !== null) {
    const ownerCard = card(owner, isAgent(owner) ? "agent" : "person");
    reach.push({ title: `${seat.helper === null ? "" : "Owner · "}Reach ${ownerName}`, lines: reachLines(ownerCard, ownerName) });
  }
  if (seat.helper !== null) {
    reach.push({ title: `Helper · Reach ${seat.helper}`, lines: reachLines(card(seat.helper, "agent"), seat.helper) });
  }
  const items: MenuItem<SeatMenuId>[] = [];
  const glyph = (name: IconName) => <MenuGlyph name={name} />;
  if (!isRoot) items.push({ id: "open", label: "Open", leading: glyph("grid") });
  if (isRoot && canGoUp) items.push({ id: "up", label: "Up to the area above", leading: glyph("chevronLeft") });
  items.push({ id: "edit", label: canEdit ? "Edit seat…" : "View seat…", leading: glyph("more") });
  if (canEdit) {
    items.push({ id: "add", label: "Add a sub-area…", leading: glyph("plus") });
    items.push({ id: "owner", label: owner === null ? "Assign owner…" : "Change owner…", leading: <OwnerFace face={face} size={16} /> });
    if (owner !== null) items.push({ id: "reach", label: `Edit how to reach ${ownerName}…`, leading: glyph("phone") });
    items.push({ id: "metric", label: "Add a metric…", leading: glyph("plus") });
  }
  items.push({ id: "about", label: "Open about.md", leading: glyph("folder") });
  const subtitle = [ownerName, seat.modes.join(", ")].filter((part) => part !== "").join(" · ");
  return { title, subtitle, face, reach, items };
}

function MenuGlyph({ name }: { name: IconName }) {
  const colors = useColors();
  return <Icon name={name} size={14} color={colors.muted} />;
}

/** The head and the reach blocks: drawn above the actions in both presentations. */
export function SeatMenuHead({ model, onCopy, touch }: { model: SeatMenuModel; onCopy: (text: string) => void; touch: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View testID="seat-menu-head">
      <View style={styles.head}>
        <OwnerFace face={model.face} size={touch ? 28 : 20} />
        <View style={styles.headText}>
          <Text variant="rowTitle" numberOfLines={1}>
            {model.title}
          </Text>
          <Text variant="treeMeta" numberOfLines={1} testID="seat-menu-holder">
            {model.subtitle}
          </Text>
        </View>
      </View>
      {model.reach.map((block) => (
        <View key={block.title} style={styles.reach} testID="seat-menu-reach">
          <Text variant="eyebrow" style={styles.eyebrow}>
            {block.title}
          </Text>
          {block.lines.map((line) => (
            <Pressable
              key={`${line.icon}-${line.text}`}
              onPress={line.copy === undefined ? undefined : () => onCopy(line.copy as string)}
              disabled={line.copy === undefined}
              accessibilityLabel={line.copy === undefined ? line.text : `Copy ${line.text}`}
              style={(state) => [styles.line, touch && styles.lineTouch, (state as { hovered?: boolean }).hovered === true && line.copy !== undefined && styles.lineHover]}
            >
              {line.icon === "tex" ? (
                <Text variant="rowTitle" style={[styles.texMark, { color: colors.accentText }]}>
                  #
                </Text>
              ) : (
                <Icon name={line.icon} size={13} color={colors.muted} />
              )}
              <Text variant="treeMeta" numberOfLines={2} style={styles.lineText}>
                {line.text}
              </Text>
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    head: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.x3,
      paddingHorizontal: space.x3,
      paddingTop: space.x2,
      paddingBottom: space.x3,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    headText: { flex: 1, minWidth: 0 },
    reach: {
      paddingHorizontal: space.x1,
      paddingTop: space.x2,
      paddingBottom: space.x1,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    eyebrow: { paddingHorizontal: space.x2, paddingBottom: space.x1 },
    line: { flexDirection: "row", alignItems: "center", gap: space.x3, minHeight: 30, paddingHorizontal: space.x2, borderRadius: radii.sm },
    lineTouch: { minHeight: 40 },
    lineHover: { backgroundColor: colors.chipFill },
    lineText: { flex: 1, minWidth: 0 },
    texMark: { width: 13, textAlign: "center" },
  });
