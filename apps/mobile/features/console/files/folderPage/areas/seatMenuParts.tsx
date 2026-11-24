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
import { Path, Svg } from "react-native-svg";
import { Icon, type IconName } from "../../../../design/components/Icon";
import { Text } from "../../../../design/components/Text";
import { radii, space, touchType } from "../../../../design/tokens";
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
  /** The seat has sub-areas, so opening it draws a chart of its own. */
  readonly hasAreas: boolean;
  /** Where "Up to" goes from the open folder's own seat ("areas", or the area above), or null at the top. */
  readonly upTo: string | null;
  readonly canEdit: boolean;
  readonly face: Face;
  readonly label: (owner: string) => string;
  readonly card: (holder: string, kind: Card["kind"]) => Card;
  readonly isAgent: (owner: string) => boolean;
}

export function seatMenuModel(input: SeatMenuInputs): SeatMenuModel {
  const { seat, title, isRoot, hasAreas, upTo, canEdit, face, label, card, isAgent } = input;
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
  if (!isRoot && hasAreas) items.push({ id: "open", label: "Open chart", leading: <OrgGlyph /> });
  if (isRoot && upTo !== null) items.push({ id: "up", label: `Up to ${upTo}`, leading: glyph("chevronLeft") });
  items.push({ id: "edit", label: canEdit ? "Edit seat…" : "View seat…", leading: glyph("more") });
  if (canEdit) {
    items.push({ id: "add", label: "Add a sub-area…", leading: glyph("plus") });
    items.push({ id: "owner", label: owner === null ? "Assign owner…" : "Change owner…", leading: <OwnerFace face={face} size={16} /> });
    if (owner !== null) items.push({ id: "reach", label: `Edit how to reach ${ownerName}…`, leading: <ReachGlyph name="phone" size={14} /> });
    items.push({ id: "metric", label: "Add a metric…", leading: glyph("plus") });
  }
  items.push({ id: "about", label: "Open about.md", leading: glyph("folder") });
  const subtitle = [ownerName, seat.modes.join(", ")].filter((part) => part !== "").join(" · ");
  return { title, subtitle, face, reach, items };
}

function MenuGlyph({ name }: { name: IconName }) {
  const colors = useColors();
  return <Icon name={name} size={14} color={colors.chromeMuted} />;
}

/** The prototype's handset and envelope, drawn at its 1.5px stroke; the icon set's `phone` is a device. */
const REACH_PATHS = {
  phone: "M5 3h3l1.5 4-2 1.2a10 10 0 0 0 4.3 4.3L13 10.5l4 1.5v3a2 2 0 0 1-2 2A13 13 0 0 1 3 5a2 2 0 0 1 2-2z",
  mail: "M3 5h14v10H3z M3 5l7 6 7-6",
} as const;

function ReachGlyph({ name, size }: { name: keyof typeof REACH_PATHS; size: number }) {
  const colors = useColors();
  return (
    <Svg width={size} height={size} viewBox="0 0 20 20" aria-hidden>
      <Path d={REACH_PATHS[name]} fill="none" stroke={colors.chromeMuted} strokeWidth={1.5} strokeLinejoin="round" />
    </Svg>
  );
}

/** The prototype's chart mark beside "Open chart": a box over two, joined. */
function OrgGlyph() {
  const colors = useColors();
  const box = { position: "absolute" as const, width: 5, height: 5, borderWidth: 1.25, borderColor: colors.chromeMuted, borderRadius: 1 };
  const rule = { position: "absolute" as const, backgroundColor: colors.chromeMuted };
  return (
    <View style={{ width: 14, height: 14 }} aria-hidden>
      <View style={[box, { left: 4.5, top: 0.5 }]} />
      <View style={[rule, { left: 6.5, top: 5.5, width: 1.25, height: 2.5 }]} />
      <View style={[rule, { left: 2.5, top: 7.5, width: 9.25, height: 1.25 }]} />
      <View style={[box, { left: 0.5, top: 8.5 }]} />
      <View style={[box, { left: 8.5, top: 8.5 }]} />
    </View>
  );
}

/**
 * The head and the reach blocks: drawn above the actions in both
 * presentations, to the prototype's measures (`.st-menu .mh`, `.reachm`).
 */
export function SeatMenuHead({ model, onCopy, touch }: { model: SeatMenuModel; onCopy: (text: string) => void; touch: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View testID="seat-menu-head">
      <View style={styles.head}>
        <OwnerFace face={model.face} size={20} />
        <View style={styles.headText}>
          <Text variant="rowTitle" numberOfLines={1} style={touch && styles.titleTouch}>
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
              style={(state) => [styles.line, (state as { hovered?: boolean }).hovered === true && line.copy !== undefined && styles.lineHover]}
            >
              <View style={styles.lineIcon}>
                {line.icon === "tex" ? (
                  <View style={styles.texRing}>
                    <Text variant="treeMeta" style={[styles.texMark, { color: colors.accentText }]}>
                      #
                    </Text>
                  </View>
                ) : line.icon === "phone" || line.icon === "mail" ? (
                  <ReachGlyph name={line.icon} size={13} />
                ) : (
                  <Icon name={line.icon} size={13} color={colors.chromeMuted} />
                )}
              </View>
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

/** One action, as the prototype draws it (`.st-menu .mi`): a 16px icon slot, then the label in the text color. */
export function SeatMenuRow({
  item,
  touch,
  focused,
  onActivate,
  onHover,
}: {
  item: MenuItem<SeatMenuId>;
  touch: boolean;
  focused: boolean;
  onActivate: () => void;
  onHover: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable
      role="menuitem"
      accessibilityLabel={item.label}
      testID={`menu-item-${item.id}`}
      onPress={onActivate}
      onHoverIn={onHover}
      style={(state) => [styles.row, touch && styles.rowTouch, (focused || (state as { hovered?: boolean }).hovered === true) && styles.rowLit]}
    >
      <View style={styles.rowIcon}>{item.leading}</View>
      <Text variant={touch ? "treeTouch" : "tree"} numberOfLines={1} testID={`menu-label-${item.id}`} style={[styles.rowLabel, touch && styles.rowLabelTouch]}>
        {item.label}
      </Text>
    </Pressable>
  );
}

/** `.st-menu .sep`. */
export function SeatMenuSeparator() {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.sep} />;
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    // `.mh`: padding 6 8 8, gap 10, a 1px rule and 4 under it.
    head: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingTop: 6,
      paddingHorizontal: space.x2,
      paddingBottom: space.x2,
      marginBottom: space.x1,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    headText: { flex: 1, minWidth: 0 },
    titleTouch: { fontSize: touchType.ui, lineHeight: 22 },
    // `.reachm`: gap 2, padding 2 4 8, a 1px rule and 4 under it.
    reach: {
      gap: 2,
      paddingTop: 2,
      paddingHorizontal: space.x1,
      paddingBottom: space.x2,
      marginBottom: space.x1,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
    },
    eyebrow: { paddingTop: 2, paddingHorizontal: space.x1, paddingBottom: space.x1 },
    // `.rl`: top-aligned, gap 8, padding 5 4.
    line: { flexDirection: "row", alignItems: "flex-start", gap: space.x2, paddingVertical: 5, paddingHorizontal: space.x1, borderRadius: radii.sm },
    lineHover: { backgroundColor: "rgba(127,127,127,0.12)" },
    lineIcon: { width: 18, height: 17, alignItems: "center", justifyContent: "center" },
    lineText: { flex: 1, minWidth: 0, lineHeight: 17 },
    // The Tex mark: a "#" in a 16px ring.
    texRing: { width: 16, height: 16, borderRadius: 8, borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
    texMark: { fontWeight: "700", lineHeight: 14 },
    // `.mi`: 32 high, padding 0 8, gap 10, radius 6; 48 and 16px on a phone.
    row: { flexDirection: "row", alignItems: "center", gap: 10, height: 32, paddingHorizontal: space.x2, borderRadius: radii.sm },
    rowTouch: { height: 48 },
    rowLit: { backgroundColor: colors.chipFill },
    rowIcon: { width: 16, alignItems: "center", justifyContent: "center" },
    rowLabel: { flex: 1, minWidth: 0, color: colors.text },
    rowLabelTouch: { fontSize: touchType.ui },
    sep: { height: 1, backgroundColor: colors.line, marginVertical: space.x1 },
  });
