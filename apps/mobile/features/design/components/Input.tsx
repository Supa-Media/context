import { useState, type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from "react-native";
import { fonts, radii } from "../tokens";
import { useColors, useThemedStyles, type Colors } from "../theme";
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
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
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
        // The visible label is the default, but a caller may override it. A
        // repeated row — "Folder", "What goes in it" — shows its labels once at
        // the top and leaves the rest blank, and every input in it still has to
        // announce which row it belongs to. Spreading `props` above is not
        // enough to allow that: this line runs after it and would win.
        accessibilityLabel={props.accessibilityLabel ?? label}
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
  const styles = useThemedStyles(makeStyles);
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
  const styles = useThemedStyles(makeStyles);
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

export interface ToggleOption {
  value: string;
  label: string;
  /** One line under the label. This is where the trade-off gets explained. */
  detail?: string;
  /** Whether this one is on. Each row is independent of the others. */
  on: boolean;
  /**
   * Shown, greyed, and not answerable.
   *
   * For a permission that was asked for and cannot be handed over. It stays on
   * the list because a screen that silently dropped part of the request would
   * be hiding the reason somebody's AI client half-works afterwards.
   */
  locked?: boolean;
}

/**
 * Independent tick boxes, drawn in `ChoiceGroup`'s visual language.
 *
 * A checkbox group and not a radio group, because these answers genuinely are
 * independent: "read" and "write" are not two answers to one question, and a
 * person narrowing an OAuth request is turning individual permissions off, not
 * picking a preset. RFC 6749 §3.3 lets an authorization server grant less than
 * was asked for, and this is what that looks like on a screen.
 *
 * Rows arrive ticked, because they show what the client requested — the
 * starting point is the request, and unticking is the narrowing. Nothing here
 * decides anything: the backend clamps whatever is submitted, so a locked row
 * is a courtesy rather than a control.
 */
export function ToggleGroup({
  label,
  hint,
  options,
  onToggle,
  disabled = false,
  testID,
  style,
}: {
  label: string;
  hint?: string;
  options: ReadonlyArray<ToggleOption>;
  onToggle: (value: string, next: boolean) => void;
  disabled?: boolean;
  testID?: string;
  style?: ViewStyle;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={style} role="group" aria-label={label}>
      <Text variant="eyebrow">{label}</Text>
      {hint ? (
        <Text variant="rowSub" style={styles.groupHint}>
          {hint}
        </Text>
      ) : null}
      <View style={styles.options}>
        {options.map((option) => (
          <ToggleRow
            key={option.value}
            option={option}
            disabled={disabled || option.locked === true}
            onPress={() => onToggle(option.value, !option.on)}
            testID={testID ? `${testID}-${option.value}` : undefined}
          />
        ))}
      </View>
    </View>
  );
}

function ToggleRow({
  option,
  disabled,
  onPress,
  testID,
}: {
  option: ToggleOption;
  disabled: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const on = option.on;

  return (
    <Pressable
      role="checkbox"
      accessibilityState={{ checked: on, disabled }}
      aria-checked={on}
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
        hovered && !on && styles.choiceHover,
        on && styles.choiceOn,
        disabled && styles.choiceDisabled,
      ]}
    >
      <View style={[styles.tick, on && styles.tickOn]} aria-hidden>
        {on ? <View style={styles.tickMark} /> : null}
      </View>
      <View style={styles.choiceText}>
        <Text variant="rowTitle" style={on ? styles.choiceLabelOn : undefined}>
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
  const styles = useThemedStyles(makeStyles);
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
  testID,
}: {
  tone?: "neutral" | "ok" | "warn";
  children: ReactNode;
  style?: ViewStyle;
  /**
   * So a test can assert the whole notice is **absent** rather than merely
   * empty. A rule of the form "nothing is drawn here" cannot be checked by
   * reading the rendered text — a placeholder put inside it reads as ordinary
   * copy — so the container itself has to be findable.
   */
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View
      style={[styles.notice, styles[`notice_${tone}` as const], style]}
      role="status"
      testID={testID}
    >
      {children}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
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

  // Square where the radio is round, so "one of these" and "any of these" are
  // distinguishable at a glance rather than only by behaviour.
  tick: {
    width: 16,
    height: 16,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  tickOn: { borderColor: colors.accent, backgroundColor: colors.accent },
  tickMark: {
    width: 8,
    height: 8,
    borderRadius: 2,
    backgroundColor: colors.ground,
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
