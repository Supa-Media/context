import { useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View, type TextInput } from "react-native";
import { Button } from "../design/components/Button";
import { FormError, TextField } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { leading } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import { DotenvPaste } from "./DotenvPaste";
import { Segmented } from "./Segmented";
import { SecretInput } from "./SecretInput";
import { VaultFieldsEditor } from "./VaultFieldsEditor";
import {
  anyValue,
  fieldProblems,
  initialFields,
  submitFields,
  type FieldDraft,
  type SubmitField,
} from "./vaultFields";
import type { EntryType, FormProblem, VaultPrefill } from "./vaultLink";

type Field = TextInput;

/** What `saveVaultLogin` is called with, less the token. */
export interface VaultDraft {
  type: EntryType;
  name: string;
  site: string;
  username: string;
  password: string;
  fields: SubmitField[];
}

/** Previews only: a form already typed into. */
export interface VaultInitialDraft {
  type: EntryType;
  name: string;
  site: string;
  username: string;
  password: string;
  fields: FieldDraft[];
}

/**
 * The form on an `add` link: a login (site, username, password, and any
 * fields of its own) or a secret (named fields, most with a value each for
 * dev, staging and prod).
 *
 * Every value lives in this component's state and nowhere else: it is not
 * logged, not put in the URL, and cleared the moment the save succeeds. The
 * agent's prefills are a starting point the person can change. Nothing
 * submits until Save is pressed (or Return on the password, which is the
 * same deliberate act).
 */
export function VaultAddForm({
  prefill,
  initialDraft,
  busy,
  problem,
  onSave,
  onType,
}: {
  prefill: VaultPrefill;
  initialDraft?: Partial<VaultInitialDraft>;
  busy: boolean;
  problem: FormProblem | null;
  onSave: (draft: VaultDraft) => Promise<boolean>;
  /** Tells the page which kind is chosen, so its heading can follow. */
  onType: (type: EntryType) => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [type, setType] = useState<EntryType>(initialDraft?.type ?? prefill.type);
  const [name, setName] = useState(initialDraft?.name ?? prefill.name);
  const [site, setSite] = useState(initialDraft?.site ?? prefill.site);
  const [username, setUsername] = useState(initialDraft?.username ?? "");
  const [password, setPassword] = useState(initialDraft?.password ?? "");
  // One list per kind, so switching back and forth loses nothing typed.
  const [loginFields, setLoginFields] = useState<FieldDraft[]>(() =>
    initialDraft?.fields && (initialDraft.type ?? prefill.type) === "login"
      ? initialDraft.fields
      : initialFields(prefill.type === "login" ? prefill.fields : [], prefill.type === "login" && prefill.envs, false),
  );
  const [secretFields, setSecretFields] = useState<FieldDraft[]>(() =>
    initialDraft?.fields && (initialDraft.type ?? prefill.type) === "secret"
      ? initialDraft.fields
      : initialFields(prefill.type === "secret" ? prefill.fields : [], prefill.type === "secret" ? prefill.envs : true, true),
  );
  // The fields are `TextField`s, sized by `useFieldFont` there.
  const siteRef = useRef<Field>(null);
  const userRef = useRef<Field>(null);
  const passRef = useRef<Field>(null);

  const secret = type === "secret";
  const fields = secret ? secretFields : loginFields;
  const setFields = secret ? setSecretFields : setLoginFields;
  const problems = useMemo(() => fieldProblems(fields), [fields]);

  const ready =
    name.trim().length > 0 &&
    !problems.any &&
    (secret ? anyValue(fields) : site.trim().length > 0 && password.length > 0);

  const choose = (next: EntryType) => {
    setType(next);
    onType(next);
  };

  const submit = () => {
    if (!ready || busy) return;
    const draft: VaultDraft = {
      type,
      name: name.trim(),
      site: site.trim(),
      username: secret ? "" : username,
      password: secret ? "" : password,
      fields: submitFields(fields),
    };
    void onSave(draft).then((ok) => {
      if (!ok) return;
      setPassword("");
      setLoginFields([]);
      setSecretFields([]);
    });
  };

  return (
    <View style={styles.form}>
      <Segmented
        label="What you're saving"
        options={[
          { value: "login", label: "Login" },
          { value: "secret", label: "API key or secret", accessibilityLabel: "API key, secret or environment variables" },
        ]}
        value={type}
        onChange={choose}
        disabled={busy}
        testID="vault-type"
      />
      <TextField
        label="Name"
        value={name}
        onChangeText={setName}
        placeholder={secret ? "e.g. Stripe" : "e.g. Netflix"}
        autoCapitalize="words"
        returnKeyType="next"
        onSubmitEditing={() => siteRef.current?.focus()}
        editable={!busy}
        testID="vault-name"
      />
      <TextField
        ref={siteRef}
        label={secret ? "Fills on" : "Site"}
        optional={secret}
        hint={secret ? "A site where Tex may paste these for you. Leave it blank to keep them for copying only." : undefined}
        value={site}
        onChangeText={setSite}
        placeholder={secret ? "e.g. dashboard.stripe.com" : "e.g. netflix.com"}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        inputMode="url"
        returnKeyType="next"
        onSubmitEditing={() => (secret ? undefined : userRef.current?.focus())}
        editable={!busy}
        testID="vault-site"
      />
      {secret ? null : (
        <>
          <TextField
            ref={userRef}
            label="Username or email"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            textContentType="username"
            returnKeyType="next"
            onSubmitEditing={() => passRef.current?.focus()}
            editable={!busy}
            testID="vault-username"
          />
          <SecretInput
            ref={passRef}
            label="Password"
            revealName="password"
            value={password}
            onChangeText={setPassword}
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="done"
            onSubmitEditing={submit}
            editable={!busy}
            testID="vault-password"
          />
        </>
      )}

      <View style={styles.section}>
        {secret ? (
          <>
            <Text variant="eyebrow">Fields</Text>
            <Text variant="rowSub">
              Name each one the way your code reads it. Leave any environment blank that doesn't use it.
            </Text>
          </>
        ) : fields.length > 0 ? (
          <Text variant="eyebrow">More fields</Text>
        ) : null}
        <VaultFieldsEditor
          fields={fields}
          onChange={setFields}
          problems={problems}
          busy={busy}
          addLabel={fields.length === 0 ? "Add a field" : "Add another field"}
          defaultPerEnv={secret}
          trailing={secret ? <DotenvPaste fields={fields} onChange={setFields} busy={busy} /> : null}
        />
      </View>

      {problem ? <FormError headline={problem.headline} next={problem.next} /> : null}

      <Button
        label={busy ? "Saving…" : "Save"}
        variant="accent"
        style={styles.save}
        disabled={!ready || busy}
        accessibilityLabel={secret ? "Save secret" : "Save login"}
        onPress={submit}
        trailing={busy ? <ActivityIndicator color={colors.ink} size="small" /> : null}
        testID="vault-save"
      />
      <Text variant="foot" style={styles.foot}>
        {secret
          ? "Tex never sees these values. They're sealed in your own storage, and only you can reveal them."
          : "Tex never sees your password. It's sealed in your own storage and filled in for you."}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    form: { marginTop: 26, gap: 16 },
    section: { gap: 10 },
    save: { alignSelf: "stretch", justifyContent: "center", marginTop: 4 },
    foot: { color: colors.muted, lineHeight: leading(12.5, 1.5), textAlign: "center" },
  });
