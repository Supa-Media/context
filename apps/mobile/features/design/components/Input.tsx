import { useState, type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { colors, fonts, radii } from "../tokens";
import { FocusRing } from "./FocusRing";
import { Text } from "./Text";

/**
 * Editable counterparts to `Field` — same eyebrow label, same near-black well,
 * but you can type in them.
 *
 * The mockup has no forms in it (it is a console screenshot, not a signup
 * flow), so the shape here is the one the sign-in screen already established:
 * uppercase eyebrow label, a `--well` input with a `--line-strong` hairline
 * that turns accent-blue on focus. Nothing new is invented; the tokens are the
 * same ones every other surface uses.
 */

export interface TextFieldProps extends TextInputProps {
  label: string;
  /** Explanatory line under the control. Never used to carry an error. */
  hint?: string;
  /** Field-level validation message. Renders in the critical tone. */
  error?: string;
  /** Renders a "· optional" marker beside the label. */
  optional?: boolean;
  testID?: string;
  containerStyle?: ViewStyle;
}

export function TextField({
  label,
  hint,
  error,
  optional = false,
  testID,
  containerStyle,
  ...props
}: TextFieldProps) {
  const [focused, setFocused] = useState(false);
  const labelId = testID ? `${testID}-label` : undefined;
  const describedBy = testID && (hint || error) ? `${testID}-note` : undefined;

  return (
    <View style={containerStyle}>
      <View style={styles.labelRow}>
        <Text variant="eyebrow" nativeID={labelId}>
          {label}
        </Text>
        {optional ? (
          <Text variant="eyebrow" style={styles.optional}>
            optional
          </Text>
        ) : null}
      </View>
      <TextInput
        {...props}
        testID={testID}
        aria-labelledby={labelId}
        aria-describedby={describedBy}
        aria-invalid={error !== undefined}
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        onFocus={(event) => {
          setFocused(true);
          props.onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          props.onBlur?.(event);
        }}
        style={[
          styles.input,
          focused && styles.inputFocused,
          error !== undefined && styles.inputError,
          props.style,
        ]}
      />
      {error !== undefined ? (
        <Text variant="error" role="alert" nativeID={describedBy} style={styles.note}>
          {error}
        </Text>
      ) : hint ? (
        <Text variant="rowSub" nativeID={describedBy} style={styles.note}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  /** One line under the label. This is where the trade-off gets explained. */
  detail?: string;
}

/**
 * A radio group, drawn as stacked cards.
 *
 * Deliberately a radio group and not a segmented control or a toggle: the two
 * places this is used — picking which context an AI client gets, and picking a
 * URL addressing style — are both decisions where neither option may be
 * pre-selected as "the safe one", and where each option needs a sentence of
 * its own. A row of pills has nowhere to put that sentence.
 *
 * `value` may be `null`, which renders with nothing selected. That is a real
 * state, not an oversight: a consent screen must not arrive with an answer
 * already filled in.
 */
export function ChoiceGroup<T extends string>({
  label,
  hint,
  options,
  value,
  onChange,
  disabled = false,
  testID,
  style,
}: {
  label: string;
  hint?: string;
  options: ReadonlyArray<ChoiceOption<T>>;
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
  testID?: string;
  style?: ViewStyle;
}) {
  return (
    <View style={style} role="radiogroup" aria-label={label}>
      <Text variant="eyebrow">{label}</Text>
      {hint ? (
        <Text variant="rowSub" style={styles.groupHint}>
          {hint}
        </Text>
      ) : null}
      <View style={styles.options}>
        {options.map((option) => (
          <ChoiceRow
            key={option.value}
            option={option}
            selected={option.value === value}
            disabled={disabled}
            onPress={() => onChange(option.value)}
            testID={testID ? `${testID}-${option.value}` : undefined}
          />
        ))}
      </View>
    </View>
  );
}

function ChoiceRow<T extends string>({
  option,
  selected,
  disabled,
  onPress,
  testID,
}: {
  option: ChoiceOption<T>;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  return (
    <Pressable
      role="radio"
      accessibilityState={{ selected, checked: selected, disabled }}
      aria-checked={selected}
      accessibilityLabel={option.detail ? `${option.label}. ${option.detail}` : option.label}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      testID={testID}
      style={[
        styles.choice,
        hovered && !selected && styles.choiceHover,
        selected && styles.choiceOn,
        disabled && styles.choiceDisabled,
      ]}
    >
      <View style={[styles.radio, selected && styles.radioOn]} aria-hidden>
        {selected ? <View style={styles.radioPip} /> : null}
      </View>
      <View style={styles.choiceText}>
        <Text variant="rowTitle" style={selected ? styles.choiceLabelOn : undefined}>
          {option.label}
        </Text>
        {option.detail ? (
          <Text variant="rowSub" style={styles.choiceDetail}>
            {option.detail}
          </Text>
        ) : null}
      </View>
      <FocusRing visible={focused && !disabled} radius={radii.xl} />
    </Pressable>
  );
}

/** A form-level failure: what went wrong on the first line, what to do on the second. */
export function FormError({
  headline,
  next,
  style,
}: {
  headline: string;
  next?: string;
  style?: ViewStyle;
}) {
  return (
    <View style={[styles.formError, style]} role="alert">
      <Text variant="error" style={styles.formErrorHead}>
        {headline}
      </Text>
      {next ? (
        <Text variant="rowSub" style={styles.formErrorNext}>
          {next}
        </Text>
      ) : null}
    </View>
  );
}

/** A neutral inline note, for progress lines like "Checking your bucket…". */
export function Notice({
  tone = "neutral",
  children,
  style,
}: {
  tone?: "neutral" | "ok" | "warn";
  children: ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View style={[styles.notice, styles[`notice_${tone}` as const], style]} role="status">
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 6,
  },
  optional: { color: colors.heroDim, textTransform: "lowercase" },
  input: {
    borderWidth: 1,
    borderColor: colors.lineStrong,
    borderRadius: radii.xl,
    backgroundColor: colors.well,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 15,
    fontFamily: fonts.body,
    color: colors.text,
  },
  inputFocused: { borderColor: colors.accent },
  inputError: { borderColor: colors.critBorder },
  note: { marginTop: 6 },

  groupHint: { marginTop: 6 },
  options: { marginTop: 10, gap: 8 },
  choice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 11,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.xl,
    backgroundColor: colors.surface,
  },
  choiceHover: { borderColor: colors.lineStrong, backgroundColor: colors.surface3 },
  choiceOn: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  choiceDisabled: { opacity: 0.45 },
  choiceText: { flex: 1, minWidth: 0 },
  choiceLabelOn: { color: colors.accentText },
  choiceDetail: { marginTop: 3 },
  radio: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  radioOn: { borderColor: colors.accent },
  radioPip: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },

  formError: {
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: radii.xl,
    borderWidth: 1,
    borderColor: colors.critBorder,
    backgroundColor: colors.critWash,
  },
  formErrorHead: { fontWeight: "600" },
  formErrorNext: { marginTop: 4, color: colors.text2 },

  notice: {
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: radii.xl,
    borderWidth: 1,
  },
  notice_neutral: { borderColor: colors.line, backgroundColor: colors.surface },
  notice_ok: { borderColor: colors.okBorder, backgroundColor: colors.okWash },
  notice_warn: { borderColor: colors.warnBorder, backgroundColor: colors.warnWash },
});
