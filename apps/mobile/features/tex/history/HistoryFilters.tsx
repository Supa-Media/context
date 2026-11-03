import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useThemedStyles } from "../../design/theme";
import { useFieldFont } from "../../design/fieldFont";
import { texPageType } from "../../design/tokens";
import { pageStyles, T } from "../page/TexPageParts";
import { TexSelect } from "../page/TexSelect";
import { DAY_LABEL, SHOW_LABEL, SHOWS, type DayChoice } from "./historyLines";
import type { HistoryRead } from "./useHistoryRead";

const DAY_OPTIONS = (["today", "yesterday", "all", "pick"] as const).map((key) => ({ key, label: DAY_LABEL[key] }));

/**
 * One row of filters: which day, then Texts, Tool calls, Thinking and
 * Background as plain words, the ones that are off struck through (Dev,
 * 2026-11-03: "I like the strike through more than the pills"). A picked day
 * is typed in the field below the row.
 */
export function HistoryFilters({ history, slide = false }: { history: HistoryRead; /** The kinds slide sideways when the row is wider than a phone, the day menu staying put, so the row stays one line. */ slide?: boolean }) {
  const styles = useThemedStyles(makeStyles);
  const page = useThemedStyles(pageStyles);
  const field = useFieldFont(texPageType.field);
  const { day, setDay, picked, setPicked, shown, toggle } = history;
  const kinds = SHOWS.map((s) => (
    <Pressable
      key={s}
      accessibilityRole="button"
      accessibilityState={{ selected: shown[s] }}
      onPress={() => toggle(s)}
      style={styles.toggle}
      testID={`tex-history-show-${s}`}
    >
      <T size={14} weight={slide ? "500" : shown[s] ? "600" : "400"} tone={shown[s] ? "text" : "muted"} style={shown[s] ? null : styles.off}>
        {SHOW_LABEL[s]}
      </T>
    </Pressable>
  ));
  return (
    <>
      <View style={styles.filters}>
        <TexSelect options={DAY_OPTIONS} selected={day} onPick={(k) => setDay(k as DayChoice)} label="Which day" look="pick" testID="tex-history-day-choice" />
        {slide ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.slide} contentContainerStyle={styles.kinds}>
            {kinds}
          </ScrollView>
        ) : (
          kinds
        )}
      </View>
      {day === "pick" ? (
        <TextInput
          accessibilityLabel="Day, as YYYY-MM-DD"
          value={picked}
          onChangeText={setPicked}
          placeholder="YYYY-MM-DD"
          style={[page.input, styles.day, field]}
          testID="tex-history-day"
        />
      ) : null}
    </>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    filters: { flexDirection: "row", flexWrap: "nowrap", gap: 6, alignItems: "center", zIndex: 2 },
    toggle: { paddingVertical: 10, paddingHorizontal: 6 },
    slide: { flex: 1, minWidth: 0 },
    kinds: { flexDirection: "row", gap: 6, alignItems: "center" },
    off: { textDecorationLine: "line-through" },
    day: { width: 150 },
  });
