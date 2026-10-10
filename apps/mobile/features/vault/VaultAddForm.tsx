import { useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View, type TextInput } from "react-native";
import { Button } from "../design/components/Button";
import { TextLink } from "../design/components/TextLink";
import { FormError, TextField } from "../design/components/Input";
import { Text } from "../design/components/Text";
import { leading } from "../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../design/theme";
import type { FormProblem, VaultPrefill } from "./vaultLink";

type Field = TextInput;

export interface VaultDraft {
  name: string;
  site: string;
  username: string;
  password: string;
}

/**
 * The login form on an `add` link.
 *
 * The password lives in this component's state and nowhere else: it is not
 * logged, not put in the URL, and cleared the moment the save succeeds. The
 * agent's prefills are a starting point the person can change. Nothing
 * submits until Save is pressed (or Return on the last field, which is the
 * same deliberate act).
 */
export function VaultAddForm({
  prefill,
  initialDraft,
  busy,
  problem,
  onSave,
}: {
  prefill: VaultPrefill;
  initialDraft?: Partial<VaultDraft>;
  busy: boolean;
  problem: FormProblem | null;
  onSave: (draft: VaultDraft) => Promise<boolean>;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const [name, setName] = useState(initialDraft?.name ?? prefill.name);
  const [site, setSite] = useState(initialDraft?.site ?? prefill.site);
  const [username, setUsername] = useState(initialDraft?.username ?? "");
  const [password, setPassword] = useState(initialDraft?.password ?? "");
  const [shown, setShown] = useState(false);
  // The fields are `TextField`s, sized by `useFieldFont` there.
  const siteRef = useRef<Field>(null);
  const userRef = useRef<Field>(null);
  const passRef = useRef<Field>(null);

  const ready = name.trim().length > 0 && site.trim().length > 0 && password.length > 0;
  const submit = () => {
    if (!ready || busy) return;
    void onSave({ name: name.trim(), site: site.trim(), username, password }).then((ok) => {
      if (ok) setPassword("");
    });
  };

  return (
    <View style={styles.form}>
      <TextField
        label="Name"
        value={name}
        onChangeText={setName}
        placeholder="e.g. Netflix"
        autoCapitalize="words"
        returnKeyType="next"
        onSubmitEditing={() => siteRef.current?.focus()}
        editable={!busy}
        testID="vault-name"
      />
      <TextField
        ref={siteRef}
        label="Site"
        value={site}
        onChangeText={setSite}
        placeholder="e.g. netflix.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        inputMode="url"
        returnKeyType="next"
        onSubmitEditing={() => userRef.current?.focus()}
        editable={!busy}
        testID="vault-site"
      />
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
      <View style={styles.passwordWrap}>
        <TextField
          ref={passRef}
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry={!shown}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="done"
          onSubmitEditing={submit}
          editable={!busy}
          style={styles.passwordInput}
          testID="vault-password"
        />
        <TextLink
          label={shown ? "Hide" : "Show"}
          style={styles.reveal}
          accessibilityLabel={shown ? "Hide password" : "Show password"}
          onPress={() => setShown((value) => !value)}
          testID="vault-password-reveal"
        />
      </View>

      {problem ? <FormError headline={problem.headline} next={problem.next} /> : null}

      <Button
        label={busy ? "Saving…" : "Save"}
        variant="accent"
        style={styles.save}
        disabled={!ready || busy}
        onPress={submit}
        trailing={busy ? <ActivityIndicator color={colors.ink} size="small" /> : null}
        testID="vault-save"
      />
      <Text variant="foot" style={styles.foot}>
        Tex never sees your password. It's sealed in your own storage and filled in for you.
      </Text>
    </View>
  );
}

// The reveal sits inside the password well, over its right edge; the well's
// height is its 13pt padding twice plus one line, so 48 centres it.
const WELL_HEIGHT = 48;

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    form: { marginTop: 26, gap: 16 },
    passwordWrap: { position: "relative" },
    passwordInput: { paddingRight: 64 },
    reveal: {
      position: "absolute",
      right: 14,
      bottom: 0,
      lineHeight: WELL_HEIGHT,
      paddingVertical: 0,
      textDecorationLine: "none",
    },
    save: { alignSelf: "stretch", justifyContent: "center", marginTop: 4 },
    foot: { color: colors.muted, lineHeight: leading(12.5, 1.5), textAlign: "center" },
  });
