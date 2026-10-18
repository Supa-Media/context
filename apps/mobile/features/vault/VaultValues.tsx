import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Text } from "../design/components/Text";
import { TextLink } from "../design/components/TextLink";
import { useThemedStyles, type Colors } from "../design/theme";
import { radii } from "../design/tokens";
import { useCopy } from "../design/useCopy";
import { ENVS, ENV_LABEL, SINGLE, isEnv, type RevealedField } from "./vaultFields";

/** What a key holds, as opened on its view link. */
export type VaultValuesShape = { username: string; password: string; fields: RevealedField[] };

/**
 * A picked key's values in Settings › Vault, read-only: one quiet row per
 * value, a secret as dots until Show, Copy on every row. A field's name is
 * said once above its environments rather than on each, so a long
 * `CONVEX_DEPLOY_KEY` never wraps or repeats. Changing them is Edit's job
 * (`VaultKeyEditor`); this only shows them, and only while it is mounted.
 */
export function VaultValues({ login, values }: { login: boolean; values: VaultValuesShape }) {
  const styles = useThemedStyles(makeStyles);
  const fields = values.fields.filter((field) => Object.keys(field.values).length > 0);
  return (
    <View style={styles.wrap} testID="vault-values">
      {login ? (
        <View style={styles.group}>
          <ValueRow label="Username" value={values.username} secret={false} name="username" testID="vault-value-username" />
          <ValueRow label="Password" value={values.password} secret name="password" divided testID="vault-value-password" />
        </View>
      ) : null}
      {fields.map((field, fieldIndex) => (
        <View key={field.name} style={styles.field}>
          <Text variant="mono" style={styles.fieldName} numberOfLines={1} ellipsizeMode="middle" selectable>
            {field.name}
          </Text>
          <View style={styles.group}>
            {slots(field).map(([slot, value], index) => (
              <ValueRow
                key={slot}
                label={slot === SINGLE ? "Value" : isEnv(slot) ? ENV_LABEL[slot] : slot}
                value={value}
                secret
                name={slot === SINGLE ? field.name : `${field.name} for ${slot}`}
                divided={index > 0}
                testID={`vault-value-${fieldIndex}-${slot}`}
              />
            ))}
          </View>
        </View>
      ))}
      {!login && fields.length === 0 ? <Text variant="hint">No values saved.</Text> : null}
    </View>
  );
}

/** A field's values in environment order (dev, staging, prod), or its one value. */
function slots(field: RevealedField): [string, string][] {
  const order = field.perEnv ? [...ENVS] : [SINGLE];
  return order.flatMap((slot) => (typeof field.values[slot] === "string" ? [[slot, field.values[slot]] as [string, string]] : []));
}

const DOTS = "••••••••••••";

function ValueRow({
  label,
  value,
  secret,
  name,
  divided = false,
  testID,
}: {
  label: string;
  value: string;
  secret: boolean;
  /** Names the thing in the buttons' own labels ("Copy password"), never the value. */
  name: string;
  divided?: boolean;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const [shown, setShown] = useState(!secret);
  const { label: copyLabel, copy } = useCopy(value);
  return (
    <View style={[styles.row, divided && styles.divided]} testID={testID}>
      <Text variant="rowSub" style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <Text variant="mono" style={[styles.value, !shown && styles.dots]} numberOfLines={1} selectable={shown} testID={`${testID}-text`}>
        {value === "" ? "—" : shown ? value : DOTS}
      </Text>
      {secret && value !== "" ? (
        <TextLink
          label={shown ? "Hide" : "Show"}
          accessibilityLabel={`${shown ? "Hide" : "Show"} ${name}`}
          onPress={() => setShown((now) => !now)}
          testID={`${testID}-reveal`}
        />
      ) : null}
      {value !== "" ? <TextLink label={copyLabel} accessibilityLabel={`Copy ${name}`} onPress={copy} testID={`${testID}-copy`} /> : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { gap: 14 },
    field: { gap: 6 },
    fieldName: { color: colors.text, fontWeight: "600" },
    group: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.lineStrong,
      borderRadius: radii.md,
      paddingHorizontal: 12,
    },
    row: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 42, paddingVertical: 8 },
    divided: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
    label: { width: 72 },
    value: { flex: 1, minWidth: 0, color: colors.text },
    dots: { letterSpacing: 1.5, color: colors.muted },
  });
