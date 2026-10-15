import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../design/components/Button";
import { Notice, TextField } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { TextLink } from "../design/components/TextLink";
import { fonts, radii } from "../design/tokens";
import { useThemedStyles, type Colors } from "../design/theme";
import { Segmented } from "./Segmented";
import { ENVS, ENV_LABEL, applyDotenv, parseDotenv, type Env, type FieldDraft } from "./vaultFields";

/**
 * Fill one environment's column from a pasted `.env` file. The pasted text is
 * held only until Fill or Cancel, then dropped; what was read lands in the
 * secret inputs above, hidden like anything typed there. The parsing is
 * `parseDotenv`, pure and tested.
 */
export function DotenvPaste({
  fields,
  onChange,
  busy,
  initialOpen = false,
}: {
  fields: FieldDraft[];
  onChange: (next: FieldDraft[]) => void;
  busy: boolean;
  /** Previews only. */
  initialOpen?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(initialOpen);
  const [env, setEnv] = useState<Env>("dev");
  const [text, setText] = useState("");
  const [said, setSaid] = useState<{ tone: "ok" | "warn"; line: string } | null>(null);

  const close = () => {
    setText("");
    setOpen(false);
  };

  const fill = () => {
    const parsed = parseDotenv(text);
    const applied = applyDotenv(fields, parsed.entries, env);
    setText("");
    if (applied.filled === 0) {
      setSaid({ tone: "warn", line: "No KEY=value lines in that. Nothing changed." });
      return;
    }
    onChange(applied.drafts);
    const left = parsed.skipped + applied.dropped;
    setSaid({
      tone: left > 0 ? "warn" : "ok",
      line: `Filled ${applied.filled} ${applied.filled === 1 ? "value" : "values"} for ${env}.${
        left > 0 ? ` ${left} ${left === 1 ? "line was" : "lines were"} left out.` : ""
      }`,
    });
    setOpen(false);
  };

  // Drawn in the fields' link row: the link sits beside "Add a field", and the
  // panel and the line saying what was filled each take a full row under it.
  if (!open) {
    return (
      <>
        <TextLink
          label="Paste a .env file"
          disabled={busy}
          onPress={() => {
            setSaid(null);
            setOpen(true);
          }}
          testID="vault-dotenv-open"
        />
        {said ? (
          <Notice tone={said.tone} style={styles.full} testID="vault-dotenv-said">
            <Text variant="rowSub">{said.line}</Text>
          </Notice>
        ) : null}
      </>
    );
  }

  return (
    <View style={[styles.panel, styles.full]} testID="vault-dotenv">
      <Text variant="eyebrow">Paste a .env file</Text>
      <Text variant="rowSub">
        Each KEY=value line fills that field for one environment, and adds the field if it isn't here yet.
      </Text>
      <Segmented
        label="Environment to fill"
        options={ENVS.map((value) => ({ value, label: ENV_LABEL[value] }))}
        value={env}
        onChange={setEnv}
        disabled={busy}
        testID="vault-dotenv-env"
      />
      <TextField
        label=".env contents"
        labelHidden
        value={text}
        onChangeText={setText}
        multiline
        numberOfLines={5}
        placeholder={"STRIPE_SECRET_KEY=sk_test_…\nexport WEBHOOK_SECRET=\"whsec_…\""}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        editable={!busy}
        style={styles.text}
        testID="vault-dotenv-text"
      />
      <View style={styles.actions}>
        <Button
          label={`Fill ${ENV_LABEL[env].toLowerCase()}`}
          variant="accent"
          disabled={busy || text.trim() === ""}
          onPress={fill}
          accessibilityLabel={`Fill the ${env} values from this file`}
          testID="vault-dotenv-fill"
        />
        <TextLink label="Cancel" onPress={close} testID="vault-dotenv-cancel" />
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    full: { width: "100%", marginTop: 8 },
    panel: {
      gap: 12,
      padding: 14,
      borderWidth: 1,
      borderStyle: "dashed",
      borderColor: colors.lineStrong,
      borderRadius: radii.card,
    },
    text: { minHeight: 150, fontFamily: fonts.mono, textAlignVertical: "top" },
    actions: { flexDirection: "row", alignItems: "center", gap: 16 },
  });
