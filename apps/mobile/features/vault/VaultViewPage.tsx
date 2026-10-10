import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../design/components/Button";
import { Card } from "../design/components/Card";
import { FieldList } from "../design/components/Field";
import { FormError } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { TextLink } from "../design/components/TextLink";
import { leading, pointerType as t } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { useCopy } from "../design/useCopy";
import { Title } from "../invite/InviteScreen";
import { Segmented } from "./Segmented";
import {
  ENVS,
  ENV_LABEL,
  SINGLE,
  buildDotenv,
  dotenvCount,
  valueIn,
  type Env,
  type RevealedField,
} from "./vaultFields";
import type { FieldSummary, VaultLinkView } from "./vaultLink";

type ViewState = Extract<VaultLinkView, { kind: "view" }>;

const DOTS = "••••••••••••";

/**
 * A `view` link: one entry's fields, values hidden until the person presses
 * Reveal. Reveal asks once; the answer is kept in the page's memory and "Hide
 * values" only covers it again. Copy writes one value, or one environment as
 * a `.env` file, to the clipboard.
 *
 * Nothing that names a value reaches an accessible name or a test id: both
 * end up in the DOM, and a click breadcrumb is built from them.
 */
export function VaultViewPage({
  view,
  titleSize,
  onReveal,
  initialHidden = false,
}: {
  view: ViewState;
  titleSize: number;
  onReveal: () => void;
  /** Previews only: revealed, then covered again. */
  initialHidden?: boolean;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [env, setEnv] = useState<Env>(view.env);
  const [covered, setCovered] = useState(initialHidden);
  const { entry, revealed } = view;
  // What is on screen: the revealed values, unless covered again.
  const shown = covered ? null : revealed;
  const sites = entry.sites.join(", ");
  const login = entry.type === "login";
  const perEnv = entry.fields.some((field) => field.perEnv);
  const where = view.workspace.kind === "personal" ? "your personal vault" : `the ${view.workspace.name} vault`;

  return (
    <View testID="vault-link-view">
      <Title size={titleSize}>{entry.name}</Title>
      <Text variant="heroSub" style={styles.sub}>
        {`${login ? "A login" : "A secret"} in ${where}. Values stay hidden until you reveal them, and each reveal is recorded.`}
      </Text>
      <Card style={styles.facts}>
        <FieldList
          testIDPrefix="vault-view"
          fields={[
            { label: "Workspace", value: view.workspace.name },
            ...(sites ? [{ label: "Fills on", value: sites }] : []),
          ]}
        />
      </Card>

      {perEnv ? (
        <Segmented
          label="Environment"
          options={ENVS.map((value) => ({ value, label: ENV_LABEL[value] }))}
          value={env}
          onChange={setEnv}
          style={styles.envs}
          testID="vault-view-env"
        />
      ) : null}

      <Card style={styles.values} testID="vault-view-values">
        {login ? (
          <>
            <ValueRow
              label="Username"
              value={shown?.username || null}
              set={shown === null || shown.username !== ""}
              first
              testID="vault-view-username"
            />
            <ValueRow
              label="Password"
              value={shown?.password || null}
              set={shown === null || shown.password !== ""}
              testID="vault-view-password"
            />
          </>
        ) : null}
        {entry.fields.map((field, index) => (
          <ValueRow
            key={field.name}
            label={field.name}
            tag={field.perEnv ? env : undefined}
            value={shown ? revealedValue(shown.fields, field.name, env) : null}
            set={isSet(field, env)}
            first={!login && index === 0}
            testID={`vault-view-field-${index}`}
          />
        ))}
        {!login && entry.fields.length === 0 ? (
          <Text variant="rowSub">This entry has no fields.</Text>
        ) : null}
      </Card>

      {view.problem ? <FormError headline={view.problem.headline} next={view.problem.next} style={styles.error} /> : null}

      {shown ? (
        <View style={styles.actions}>
          {entry.fields.length > 0 ? (
            <DotenvCopy name={entry.name} fields={shown.fields} env={env} perEnv={perEnv} />
          ) : null}
          <TextLink label="Hide values" onPress={() => setCovered(true)} testID="vault-view-hide" />
        </View>
      ) : (
        <Button
          label={view.busy ? "Revealing…" : "Reveal values"}
          variant="accent"
          style={styles.reveal}
          disabled={view.busy}
          onPress={revealed !== null ? () => setCovered(false) : onReveal}
          accessibilityLabel={`Reveal the values in ${entry.name}`}
          trailing={view.busy ? <ActivityIndicator color={colors.ink} size="small" /> : null}
          testID="vault-view-reveal"
        />
      )}
      <Text variant="foot" style={styles.foot}>
        Nothing you reveal is saved on this device. This link works for 30 minutes.
      </Text>
    </View>
  );
}

function isSet(field: FieldSummary, env: Env): boolean {
  return field.set.includes(field.perEnv ? env : SINGLE);
}

function revealedValue(fields: readonly RevealedField[], name: string, env: Env): string | null {
  const field = fields.find((candidate) => candidate.name === name);
  return field === undefined ? null : valueIn(field, env);
}

/**
 * One name and its value. `value` null with `set` true is a value still
 * hidden; `set` false is one this environment does not have, said in words.
 */
function ValueRow({
  label,
  tag,
  value,
  set,
  first = false,
  testID,
}: {
  label: string;
  tag?: Env;
  value: string | null;
  set: boolean;
  first?: boolean;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const missing = !set && value === null;
  return (
    <View style={[styles.row, first ? null : styles.ruled]} testID={testID}>
      <View style={styles.rowText}>
        <View style={styles.rowHead}>
          <Text variant="rowTitle" numberOfLines={1} style={styles.rowName}>
            {label}
          </Text>
          {tag ? <Text variant="meta" style={styles.tag}>{tag}</Text> : null}
        </View>
        {missing ? (
          <Text variant="rowSub" testID={`${testID}-missing`}>
            {tag ? `Not set for ${tag}` : "Not set"}
          </Text>
        ) : value === null ? (
          <Text variant="mono" aria-label="Hidden" testID={`${testID}-hidden`} style={styles.dots}>
            {DOTS}
          </Text>
        ) : (
          <Text variant="mono" numberOfLines={2} selectable style={styles.value} testID={`${testID}-value`}>
            {value}
          </Text>
        )}
      </View>
      {value !== null ? <CopyValue value={value} name={tag ? `${label} for ${tag}` : label} testID={`${testID}-copy`} /> : null}
    </View>
  );
}

function CopyValue({ value, name, testID }: { value: string; name: string; testID: string }) {
  const { label, copy } = useCopy(value);
  return <Button label={label} variant="mini" accessibilityLabel={`Copy ${name}`} onPress={copy} testID={testID} />;
}

function DotenvCopy({
  name,
  fields,
  env,
  perEnv,
}: {
  name: string;
  fields: readonly RevealedField[];
  env: Env;
  perEnv: boolean;
}) {
  const count = dotenvCount(fields, env);
  const idle = perEnv ? `Copy ${env} as .env` : "Copy as .env";
  const { label, copy } = useCopy(buildDotenv(name, fields, env), idle);
  return (
    <Button
      label={label}
      variant="accent"
      disabled={count === 0}
      onPress={copy}
      accessibilityLabel={
        count === 0
          ? `Nothing set for ${env}`
          : `Copy ${count} ${count === 1 ? "value" : "values"}${perEnv ? ` for ${env}` : ""} as a .env file`
      }
      testID="vault-view-dotenv"
    />
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    sub: { marginTop: 14, fontSize: t.body, lineHeight: leading(t.body, 1.55) },
    facts: { marginTop: 24 },
    envs: { marginTop: 20 },
    values: { marginTop: 12, paddingVertical: 6 },
    row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 11 },
    ruled: { borderTopWidth: 1, borderTopColor: colors.line },
    rowText: { flex: 1, minWidth: 0, gap: 2 },
    rowHead: { flexDirection: "row", alignItems: "baseline", gap: 8 },
    rowName: { flexShrink: 1 },
    tag: { color: colors.muted },
    dots: { color: colors.muted, letterSpacing: 1 },
    value: { color: colors.text },
    error: { marginTop: 16 },
    actions: { marginTop: 20, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 16 },
    reveal: { alignSelf: "stretch", justifyContent: "center", marginTop: 20 },
    foot: { marginTop: 16, color: colors.muted, lineHeight: leading(12.5, 1.5), textAlign: "center" },
  });
