import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import { Figure, SectionHead, T } from "./TexPageParts";
import { Minion } from "./TexHome";
import type { ViewProps } from "./TexPageBody";
import type { Overview, Slot } from "./texPageTypes";
import type { SlotPlace } from "./texMachineTypes";
import { at12, freeRange } from "./texMachineFormat";
import { busyLine } from "./texPageFormat";
import { DotLine, Glyph, RowLink } from "./TexMachineParts";

/**
 * The Tex home's minion pool (design screen 6, `06-minion-pool`): every slot
 * grouped by the place it runs in, Tex's cloud first, then each machine. A
 * busy slot keeps its card; the free slots of a place fold into one dashed
 * card. On a desktop the cards sit two to a row in the compact layout; on a
 * phone they stack. An offline place is dimmed and says where its jobs went.
 */
export function MinionPool({ overview, now, wide, go }: { overview: Overview; now: number; wide: boolean; go: ViewProps["go"] }) {
  const styles = useThemedStyles(makeStyles);
  const places = overview.places ?? [];

  return (
    <View style={styles.pool} testID="tex-pool">
      <View style={styles.head}>
        <SectionHead>{busyLine(overview.minions, overview.places)}</SectionHead>
        <RowLink label="Your machines ›" onPress={() => go({ view: "machines" })} testID="tex-pool-machines" />
      </View>

      {places.map((place) => {
        const slots = overview.minions.filter((s) => s.place === place.key);
        const busy = slots.filter((s) => s.job !== null);
        const free = slots.filter((s) => s.job === null);
        const cells: PoolCell[] = busy.map((slot) => ({
          key: `slot-${slot.slot}`,
          full: false,
          node: <Minion slot={slot} now={now} wide={false} go={go} />,
        }));
        if (free.length > 0) {
          // A place with nothing running, or offline, folds to one full-width card, on the desktop too.
          cells.push({ key: "free", full: place.offline === true || busy.length === 0, node: <FreeCard place={place} slots={free} /> });
        }
        return (
          <View key={place.key} style={[styles.place, place.offline ? styles.offline : null]} testID={`tex-pool-place-${place.key}`}>
            <PlaceHead place={place} busy={busy.length} />
            <PoolGrid cells={cells} wide={wide} />
          </View>
        );
      })}
    </View>
  );
}

/** One card in a place's grid. `full` cards always take a row to themselves. */
interface PoolCell {
  key: string;
  full: boolean;
  node: ReactNode;
}

/**
 * The cards of one place. On a phone they stack. On a desktop they sit two to a
 * row, each taking half the row with the gap between, and an odd last card is
 * paired with an empty spacer so it keeps its half.
 */
function PoolGrid({ cells, wide }: { cells: PoolCell[]; wide: boolean }) {
  const styles = useThemedStyles(makeStyles);
  if (!wide) {
    return (
      <View style={styles.stack}>
        {cells.map((cell) => (
          <View key={cell.key} style={styles.cellFull}>
            {cell.node}
          </View>
        ))}
      </View>
    );
  }
  const rows: PoolCell[][] = [];
  for (const cell of cells) {
    const last = rows[rows.length - 1];
    if (!cell.full && last && last.length === 1 && !last[0]!.full) last.push(cell);
    else rows.push([cell]);
  }
  return (
    <View style={styles.stack}>
      {rows.map((row) =>
        row[0]!.full ? (
          <View key={row[0]!.key} style={styles.cellFull}>
            {row[0]!.node}
          </View>
        ) : (
          <View key={row[0]!.key} style={styles.pair}>
            {row.map((cell) => (
              <View key={cell.key} style={styles.cellHalf}>
                {cell.node}
              </View>
            ))}
            {row.length === 1 ? <View style={styles.cellHalf} /> : null}
          </View>
        ),
      )}
    </View>
  );
}

/** Tex's cloud is a cloud; a machine is a terminal when it runs the command-line runner, else a laptop (the Mac app). */
function placeGlyph(place: SlotPlace): "cloud" | "terminal" | "laptop" {
  if (place.kind === "cloud") return "cloud";
  return place.machineKind === "cli" ? "terminal" : "laptop";
}

/** `● Seyi's MacBook Pro · 4` with its busy count on the right, or the offline line. */
function PlaceHead({ place, busy }: { place: SlotPlace; busy: number }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.placeHead}>
      <View style={styles.placeName}>
        <Glyph glyph={placeGlyph(place)} color={colors.muted} size={13} />
        <T size={13} weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
          {place.name}
        </T>
        <T size={13} tone="muted" numberOfLines={1}>
          {` · ${place.slots}`}
        </T>
      </View>
      {place.offline ? (
        <DotLine tone="off" size={13}>
          {place.since ? `Offline since ${at12(place.since)}` : "Offline"}
        </DotLine>
      ) : (
        <T size={13} tone="muted">
          {`${busy} busy`}
        </T>
      )}
    </View>
  );
}

/** One dashed card for a place's free slots: `Minions 2–3 · Free · Ready for the next job`. */
function FreeCard({ place, slots }: { place: SlotPlace; slots: Slot[] }) {
  const styles = useThemedStyles(makeStyles);
  const first = slots[0]!.slot;
  const last = slots[slots.length - 1]!.slot;
  const offline = place.offline === true;
  return (
    <View style={styles.free} testID={`tex-pool-free-${place.key}`}>
      <Figure mood="rest" size={52} />
      <View style={styles.freeText}>
        <T size={11} weight="600" tone="muted" upper>
          {freeRange(first, last)}
        </T>
        <T size={15} weight="600" tone="muted">
          {offline ? "Offline" : "Free"}
        </T>
        <T size={13} tone="muted">
          {offline ? "Its jobs go to the cloud until it is back" : "Ready for the next job"}
        </T>
      </View>
    </View>
  );
}

/**
 * A line of the Earlier today list with the place it ran on under the title
 * (`On Seyi's MacBook Pro`). The row is `JobRow` from TexPageParts, with the
 * second line; the lead swaps it in for `JobRow` on the home.
 */
export function EarlierRow({
  title,
  ranOn,
  right,
  onPress,
  testID,
}: {
  title: string;
  ranOn?: string;
  right: string;
  onPress: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <Pressable accessibilityRole="button" onPress={onPress} testID={testID} style={styles.row}>
      <View style={styles.rowMain}>
        <T size={14} weight="500">
          {title}
        </T>
        {ranOn ? (
          <T size={13} tone="muted" numberOfLines={1}>
            {ranOn}
          </T>
        ) : null}
      </View>
      <T size={13} tone="muted" numberOfLines={1} style={styles.rowRight}>
        {right}
      </T>
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    pool: { gap: 14 },
    head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
    place: { gap: 8 },
    offline: { opacity: 0.55 },
    placeHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, minWidth: 0 },
    placeName: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, minWidth: 0 },
    stack: { gap: 10 },
    pair: { flexDirection: "row", gap: 10 },
    cellFull: { width: "100%", minWidth: 0 },
    cellHalf: { flex: 1, minWidth: 0 },
    free: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.line,
      borderRadius: 12,
      minWidth: 0,
    },
    freeText: { gap: 2, minWidth: 0, flexShrink: 1 },
    row: {
      flexDirection: "row",
      gap: 10,
      alignItems: "flex-start",
      paddingVertical: 9,
      borderBottomWidth: 1,
      borderBottomColor: colors.line,
      width: "100%",
    },
    rowMain: { flex: 1, minWidth: 0, gap: 2 },
    rowRight: { marginTop: 1 },
  });
