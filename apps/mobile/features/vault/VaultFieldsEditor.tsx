import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { DeleteButton } from "../design/components/DeleteButton";
import { TextField } from "../design/components/Input";
import { Switch } from "../design/components/Switch";
import { Text } from "../design/components/Text";
import { TextLink } from "../design/components/TextLink";
import { radii } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { SecretInput } from "./SecretInput";
import {
  ENVS,
  ENV_LABEL,
  MAX_FIELDS,
  SINGLE,
  emptyField,
  type Env,
  type FieldDraft,
  type FieldProblems,
} from "./vaultFields";

/**
 * The named fields on the add form: a name, whether it has a value per
 * environment, and the value or values, each a secret input. A row can be
 * removed; a row left blank is simply not saved.
 *
 * Accessible names and test ids come from the row's position and its name,
 * never from a value, because both reach the DOM and a click breadcrumb.
 */
export function VaultFieldsEditor({
  fields,
  onChange,
  problems,
  busy,
  addLabel,
  defaultPerEnv,
  trailing,
}: {
  fields: FieldDraft[];
  onChange: (next: FieldDraft[]) => void;
  problems: FieldProblems;
  busy: boolean;
  /** "Add a field" or "Add another field". */
  addLabel: string;
  /** Whether a new row starts with dev, staging and prod. */
  defaultPerEnv: boolean;
  /** Drawn beside "Add a field", e.g. the .env paste link. */
  trailing?: ReactNode;
}) {
  const styles = useThemedStyles(makeStyles);
  const update = (id: string, change: (field: FieldDraft) => FieldDraft) =>
    onChange(fields.map((field) => (field.id === id ? change(field) : field)));

  return (
    <View style={styles.list}>
      {fields.map((field, index) => (
        <FieldRow
          key={field.id}
          field={field}
          index={index}
          busy={busy}
          nameError={problems.names[field.id]}
          valueErrors={problems.values[field.id] ?? {}}
          onName={(name) => update(field.id, (row) => ({ ...row, name }))}
          onPerEnv={(perEnv) => update(field.id, (row) => ({ ...row, perEnv }))}
          onValue={(key, value) =>
            update(field.id, (row) => ({
              ...row,
              values: { ...row.values, [key]: value },
            }))
          }
          onRemove={() => onChange(fields.filter((row) => row.id !== field.id))}
        />
      ))}
      <View style={styles.links}>
        {fields.length < MAX_FIELDS ? (
          <TextLink
            label={addLabel}
            disabled={busy}
            onPress={() => onChange([...fields, emptyField(defaultPerEnv)])}
            testID="vault-field-add"
          />
        ) : (
          <Text variant="rowSub">{`That's the most an entry can hold (${MAX_FIELDS}).`}</Text>
        )}
        {trailing}
      </View>
    </View>
  );
}

function FieldRow({
  field,
  index,
  busy,
  nameError,
  valueErrors,
  onName,
  onPerEnv,
  onValue,
  onRemove,
}: {
  field: FieldDraft;
  index: number;
  busy: boolean;
  nameError: string | undefined;
  valueErrors: Partial<Record<Env | typeof SINGLE, string>>;
  onName: (name: string) => void;
  onPerEnv: (perEnv: boolean) => void;
  onValue: (key: Env | typeof SINGLE, value: string) => void;
  onRemove: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const id = `vault-field-${index}`;
  const called = field.name.trim() || `Field ${index + 1}`;

  return (
    <View style={styles.row} testID={id}>
      <Text variant="eyebrow" style={styles.eyebrowTight}>
        Field name
      </Text>
      <View style={styles.nameRow}>
        {/*
          Every row's labels read the same, so each draws its own and gives its
          input a name that says which row: `TextField`'s label row would
          announce every one of them as just "Field name".
        */}
        <TextField
          label="Field name"
          labelHidden
          value={field.name}
          onChangeText={onName}
          placeholder="e.g. STRIPE_SECRET_KEY"
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          editable={!busy}
          error={nameError}
          accessibilityLabel={`Field ${index + 1} name`}
          containerStyle={styles.name}
          testID={`${id}-name`}
        />
        <View style={styles.remove}>
          <DeleteButton
            accessibilityLabel={`Remove ${called}`}
            onPress={onRemove}
            disabled={busy}
            testID={`${id}-remove`}
          />
        </View>
      </View>

      <View style={styles.toggleRow}>
        <Text variant="rowSub" style={styles.toggleText}>
          Different value for dev, staging and prod
        </Text>
        <Switch
          value={field.perEnv}
          onValueChange={onPerEnv}
          disabled={busy}
          label={`${called}: a value for each environment`}
          testID={`${id}-envs`}
        />
      </View>

      {field.perEnv ? (
        ENVS.map((env) => (
          <ValueInput
            key={env}
            inline
            label={ENV_LABEL[env]}
            value={field.values[env]}
            onChange={(value) => onValue(env, value)}
            error={valueErrors[env]}
            busy={busy}
            revealName={`${called} for ${env}`}
            testID={`${id}-${env}`}
          />
        ))
      ) : (
        <ValueInput
          label="Value"
          value={field.values[SINGLE]}
          onChange={(value) => onValue(SINGLE, value)}
          error={valueErrors[SINGLE]}
          busy={busy}
          revealName={called}
          testID={`${id}-value`}
        />
      )}
    </View>
  );
}

function ValueInput({
  inline = false,
  label,
  value,
  onChange,
  error,
  busy,
  revealName,
  testID,
}: {
  /** The label beside the well rather than over it: three environments stack shorter that way. */
  inline?: boolean;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error: string | undefined;
  busy: boolean;
  revealName: string;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View>
      <View style={inline ? styles.inline : undefined}>
        <Text
          variant="eyebrow"
          style={inline ? styles.inlineLabel : styles.eyebrow}
        >
          {label}
        </Text>
        <View style={inline ? styles.inlineWell : undefined}>
          <SecretInput
            label={label}
            labelHidden
            value={value}
            onChangeText={onChange}
            editable={!busy}
            accessibilityLabel={`${revealName}, value`}
            revealName={revealName}
            autoComplete="off"
            testID={testID}
          />
        </View>
      </View>
      {/* Under the input, not inside `TextField`, so the reveal stays centred in the well. */}
      {error ? (
        <Text variant="error" role="alert" style={styles.valueError}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    list: { gap: 12 },
    row: {
      gap: 12,
      padding: 14,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radii.card,
      backgroundColor: colors.surface2,
    },
    nameRow: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
    name: { flex: 1, minWidth: 0 },
    // Centred on the input's 48pt well: the bin is 36.
    remove: { paddingTop: 6 },
    eyebrowTight: { marginBottom: -6 },
    eyebrow: { marginBottom: 6 },
    toggleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    toggleText: { flex: 1, minWidth: 0 },
    valueError: { marginTop: 6 },
    inline: { flexDirection: "row", alignItems: "center", gap: 10 },
    inlineLabel: { width: 62 },
    inlineWell: { flex: 1, minWidth: 0 },
    links: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      columnGap: 20,
    },
  });
