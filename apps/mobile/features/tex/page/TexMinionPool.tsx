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
        <SectionHead>{busyLine(overview.minions)}</SectionHead>
        <RowLink label="Your machines ›" onPress={() => go({ view: "machines" })} testID="tex-pool-machines" />
      </View>

      {places.map((place) => {
        const slots = overview.minions.filter((s) => s.place === place.key);
        const busy = slots.filter((s) => s.job !== null);
        const free = slots.filter((s) => s.job === null);
        return (
          <View key={place.key} style={[styles.place, place.offline ? styles.offline : null]} testID={`tex-pool-place-${place.key}`}>
            <PlaceHead place={place} busy={busy.length} />
            <View style={styles.grid}>
              {busy.map((slot) => (
                <View key={slot.slot} style={wide ? styles.cellWide : styles.cellPhone}>
                  <Minion slot={slot} now={now} wide={false} go={go} />
                </View>
              ))}
              {free.length > 0 ? (
                <View style={wide ? styles.cellWide : styles.cellPhone}>
                  <FreeCard place={place} slots={free} />
                </View>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** `● Seyi's MacBook Pro · 4` with its busy count on the right, or the offline line. */
function PlaceHead({ place, busy }: { place: SlotPlace; busy: number }) {
  const styles = useThemedStyles(makeStyles);
  const colors = useColors();
  return (
    <View style={styles.placeHead}>
      <View style={styles.placeName}>
        <Glyph glyph={place.kind === "cloud" ? "cloud" : "laptop"} color={colors.muted} size={13} />
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
          <T size={12} tone="muted" numberOfLines={1}>
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
    grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    cellPhone: { width: "100%", minWidth: 0 },
    cellWide: { width: "48.9%", minWidth: 0 },
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
