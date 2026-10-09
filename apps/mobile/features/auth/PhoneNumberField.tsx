import { useState } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { Text } from "../design/components/Text";
import { fonts, pointerType as t, radii, space } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { useFieldFont } from "../design/fieldFont";
import {
  composePhone,
  countryOfNumber,
  flagOf,
  searchCountries,
  splitPhone,
  type PhoneCountry,
} from "./phoneCountries";

/**
 * The phone number field: a country button (United States unless changed)
 * beside the number, so nobody types a country code (Dev2, 2026-10-09). The
 * button opens a searchable list of every country a code can be texted to.
 *
 * `value` is the whole `+<code><number>` the server takes; the field keeps
 * what was typed, spaces and all, and hands up the composed number on every
 * change. A number typed or autofilled with its own `+` moves the button to
 * that country.
 */
export function PhoneNumberField({
  value,
  onChangeText,
  editable = true,
  onSubmitEditing,
  testID,
}: {
  value: string;
  onChangeText: (phone: string) => void;
  editable?: boolean;
  onSubmitEditing?: () => void;
  testID: string;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const fieldFont = useFieldFont(t.lede);
  const [initial] = useState(() => splitPhone(value));
  const [country, setCountry] = useState<PhoneCountry>(initial.country);
  const [typed, setTyped] = useState(initial.national);
  const [focused, setFocused] = useState(false);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");

  function type(text: string) {
    const own = countryOfNumber(text);
    if (own !== null) setCountry(own);
    setTyped(text);
    onChangeText(composePhone(own ?? country, text));
  }

  function pick(next: PhoneCountry) {
    setCountry(next);
    setPicking(false);
    setQuery("");
    // A number typed with its own `+` would ignore the pick; keep only its digits after the code.
    const rest = typed.trim().startsWith("+")
      ? splitPhone(typed).national
      : typed;
    setTyped(rest);
    onChangeText(composePhone(next, rest));
  }

  return (
    <View>
      <Text variant="eyebrow" nativeID={`${testID}-label`} style={styles.label}>
        Phone number
      </Text>
      <View style={[styles.row, focused && styles.rowFocused]}>
        <Pressable
          role="button"
          accessibilityLabel={`Country: ${country.name}, +${country.dial}. Change`}
          disabled={!editable}
          onPress={() => setPicking(true)}
          style={styles.country}
          testID={`${testID}-country`}
        >
          <Text style={styles.flag}>{flagOf(country.iso)}</Text>
          <Text style={[styles.dial, fieldFont]}>+{country.dial}</Text>
          <Text style={styles.caret}>▾</Text>
        </Pressable>
        <TextInput
          value={typed}
          onChangeText={type}
          placeholder={country.dial === "1" ? "555 555 0100" : "Phone number"}
          placeholderTextColor={colors.muted}
          keyboardType="phone-pad"
          autoComplete="tel"
          textContentType="telephoneNumber"
          editable={editable}
          onSubmitEditing={onSubmitEditing}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-labelledby={`${testID}-label`}
          accessibilityLabel="Phone number"
          style={[styles.input, fieldFont]}
          testID={testID}
        />
      </View>
      <Modal
        visible={picking}
        transparent
        animationType="fade"
        onRequestClose={() => setPicking(false)}
      >
        <View style={styles.stage}>
          <Pressable
            style={styles.scrim}
            onPress={() => setPicking(false)}
            accessibilityLabel="Close"
          />
          <View style={styles.sheet} testID={`${testID}-countries`}>
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search countries"
              placeholderTextColor={colors.muted}
              autoFocus
              accessibilityLabel="Search countries"
              style={[styles.search, fieldFont]}
              testID={`${testID}-country-search`}
            />
            <FlatList
              data={searchCountries(query)}
              keyExtractor={(c) => c.iso}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable
                  role="button"
                  onPress={() => pick(item)}
                  style={({ pressed }) => [
                    styles.option,
                    (pressed || item.iso === country.iso) && styles.optionOn,
                  ]}
                  testID={`${testID}-country-${item.iso}`}
                >
                  <Text style={styles.flag}>{flagOf(item.iso)}</Text>
                  <Text style={styles.optionName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.optionDial}>+{item.dial}</Text>
                </Pressable>
              )}
              ListEmptyComponent={
                <Text style={styles.empty}>No country matches that.</Text>
              }
            />
            <Pressable
              role="button"
              onPress={() => setPicking(false)}
              style={styles.cancel}
              testID={`${testID}-country-cancel`}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    label: { marginBottom: 6 },
    row: {
      flexDirection: "row",
      alignItems: "stretch",
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.xl,
      backgroundColor: colors.well,
      overflow: "hidden",
    },
    rowFocused: { borderColor: colors.accent },
    country: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingLeft: 14,
      paddingRight: 10,
      borderRightWidth: 1,
      borderRightColor: colors.lineStrong,
    },
    flag: { fontSize: 18 },
    dial: { fontSize: t.lede, fontFamily: fonts.body, color: colors.text },
    caret: { color: colors.muted, fontSize: 12 },
    input: {
      flex: 1,
      minWidth: 0,
      paddingHorizontal: 12,
      paddingVertical: 13,
      fontSize: t.lede,
      fontFamily: fonts.body,
      color: colors.text,
    },
    scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.scrim },
    stage: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: space.x4,
    },
    sheet: {
      width: "100%",
      maxWidth: 420,
      height: "76%",
      backgroundColor: colors.surface,
      borderRadius: radii.xl,
      borderWidth: 1,
      borderColor: colors.lineStrong,
      padding: space.x3,
      gap: space.x2,
    },
    search: {
      borderWidth: 1,
      borderColor: colors.lineStrong,
      borderRadius: radii.xl,
      backgroundColor: colors.well,
      paddingHorizontal: 14,
      paddingVertical: 11,
      fontSize: t.lede,
      fontFamily: fonts.body,
      color: colors.text,
    },
    option: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 10,
      paddingHorizontal: 10,
      borderRadius: radii.md,
    },
    optionOn: { backgroundColor: colors.well },
    optionName: { flex: 1, color: colors.text, fontFamily: fonts.body },
    optionDial: { color: colors.muted, fontFamily: fonts.body },
    empty: { padding: space.x3, color: colors.muted },
    cancel: {
      alignSelf: "flex-end",
      paddingVertical: 8,
      paddingHorizontal: 12,
    },
    cancelText: { color: colors.accent, fontWeight: "600" },
  });
