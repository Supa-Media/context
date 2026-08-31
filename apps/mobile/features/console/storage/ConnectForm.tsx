import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card } from "../../design/components/Card";
import { Hint } from "../../design/components/Field";
import { ChoiceGroup, FormError, TextField } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { leading } from "../../design/tokens";
import { useColors } from "../../design/theme";
import {
  STORAGE_TIMEOUT_FAILURE,
  describeThrownStorageError,
  type StorageFailure,
} from "./errors";
import { CONNECT_TIMEOUT_MS, raceTimeout } from "./timeout";
import {
  ADDRESSING_OPTIONS,
  PROVIDERS,
  addressingToForcePathStyle,
  emptyConnectForm,
  forcePathStyleToAddressing,
  hasErrors,
  needsAddressingChoice,
  providerSpec,
  validateConnectForm,
  withProvider,
  type ConnectErrors,
  type ConnectFormValues,
  type Provider,
} from "./connect";

/**
 * Connect a bucket you own.
 *
 * This is the moment someone hands us a credential, so the copy says what
 * happens to it — encrypted at rest, used only to read and write their bucket,
 * revocable at their provider without asking us — and the form does not ask for
 * anything it does not need.
 *
 * The `forcePathStyle` question is the one deliberate piece of restraint here.
 * Some S3 endpoints genuinely cannot be disambiguated (the bucket name is the
 * endpoint's first host label) and the adapter refuses to guess, because
 * guessing wrong writes to the wrong bucket. But that is a handful of
 * configurations, and making everyone answer a question about URL addressing
 * styles to connect a bucket is a worse product for everybody else. So the
 * field appears only once the endpoint and bucket in the form actually make it
 * a question — see `needsAddressingChoice` — or once the backend says so with
 * `AMBIGUOUS_ADDRESSING`.
 */
export function ConnectForm({
  connect,
  /** Prefilled when re-binding an existing binding rather than starting fresh. */
  initial,
  onCancel,
}: {
  connect: (values: ConnectFormValues) => Promise<{ status: string }>;
  initial?: Partial<ConnectFormValues>;
  onCancel?: () => void;
}) {
  const colors = useColors();
  const [values, setValues] = useState<ConnectFormValues>({
    ...emptyConnectForm(),
    ...initial,
  });
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<StorageFailure | null>(null);

  const errors: ConnectErrors = validateConnectForm(values);
  const shown: ConnectErrors = touched ? errors : {};
  const spec = providerSpec(values.provider);

  // Either the form can already see the ambiguity, or the backend told us. The
  // second is the safety net for a rule that drifts; see `errors.ts`.
  const askAddressing = needsAddressingChoice(values) || failure?.needsAddressingChoice === true;
  const addressing = forcePathStyleToAddressing(values.forcePathStyle);
  const addressingMissing = askAddressing && addressing === null;

  const set = <K extends keyof ConnectFormValues>(key: K, value: ConnectFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  /**
   * Connect the bucket — and give up waiting rather than locking the form.
   *
   * `submitting` is what makes every field `editable={false}` and what disables
   * Connect **and Cancel**. `bindStorage` is a Convex action doing real network
   * I/O against an endpoint we have never spoken to, and
   * `ConvexReactClient.action()` has no client-side timeout, so a hang left a
   * form nobody could type in, submit, or leave — with a freshly-pasted secret
   * sitting in it. Same trap as the note editor, same fix, same pattern as
   * `reverify.ts`. See `./timeout.ts`.
   */
  async function submit() {
    setTouched(true);
    if (hasErrors(errors) || addressingMissing) return;
    setFailure(null);
    setSubmitting(true);

    const settled = await raceTimeout(connect(values), {
      ms: CONNECT_TIMEOUT_MS,
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (handle) => clearTimeout(handle),
    });

    setSubmitting(false);
    if (settled.kind === "failed") setFailure(describeThrownStorageError(settled.error));
    else if (settled.kind === "timeout") setFailure(STORAGE_TIMEOUT_FAILURE);
  }

  return (
    <Card>
      <Text variant="rowTitle">Connect your bucket</Text>
      <Text variant="rowSub" style={styles.lede}>
        Context stores nothing of its own. Point it at an S3-compatible bucket you own and
        every note stays in it, as plain Markdown you can read without us.
      </Text>

      <View style={styles.section}>
        <ChoiceGroup
          label="Provider"
          options={PROVIDERS.map((entry) => ({
            value: entry.value,
            label: entry.label,
            detail: entry.detail,
          }))}
          value={values.provider}
          onChange={(provider: Provider) => setValues((current) => withProvider(current, provider))}
          disabled={submitting}
          testID="connect-provider"
        />
      </View>

      <View style={styles.fields}>
        <TextField
          label="Endpoint"
          value={values.endpoint}
          onChangeText={(text) => set("endpoint", text)}
          placeholder={spec.endpointPlaceholder}
          autoCapitalize="none"
          autoCorrect={false}
          inputMode="url"
          editable={!submitting}
          error={shown.endpoint}
          hint="The S3 API URL for your account, not the dashboard you log into."
          testID="connect-endpoint"
        />

        <View style={styles.pair}>
          <TextField
            containerStyle={styles.pairItem}
            label="Region"
            value={values.region}
            onChangeText={(text) => set("region", text)}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!submitting}
            error={shown.region}
            hint={spec.regionHint}
            testID="connect-region"
          />
          <TextField
            containerStyle={styles.pairItem}
            label="Bucket"
            value={values.bucket}
            onChangeText={(text) => set("bucket", text)}
            placeholder="my-context"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!submitting}
            error={shown.bucket}
            testID="connect-bucket"
          />
        </View>

        <TextField
          label="Access key id"
          value={values.accessKeyId}
          onChangeText={(text) => set("accessKeyId", text)}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          editable={!submitting}
          error={shown.accessKeyId}
          testID="connect-access-key"
        />

        <TextField
          label="Secret access key"
          value={values.secretAccessKey}
          onChangeText={(text) => set("secretAccessKey", text)}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          editable={!submitting}
          error={shown.secretAccessKey}
          testID="connect-secret"
        />

        <TextField
          label="Root prefix"
          optional
          value={values.rootPrefix}
          onChangeText={(text) => set("rootPrefix", text)}
          placeholder="context/"
          autoCapitalize="none"
          autoCorrect={false}
          editable={!submitting}
          error={shown.rootPrefix}
          hint="Only if your context lives in a folder inside the bucket. Leave this empty and notes sit at the root, which is what an existing Obsidian vault expects."
          testID="connect-root-prefix"
        />

        {askAddressing ? (
          <View>
            <ChoiceGroup
              label="How is this bucket addressed?"
              hint={`Your endpoint's first host label is "${values.bucket.trim()}" — the same as the bucket name — so nothing can tell which of these it is. Getting it wrong writes to the wrong bucket, so nothing will guess for you.`}
              options={ADDRESSING_OPTIONS}
              value={addressing}
              onChange={(choice) => set("forcePathStyle", addressingToForcePathStyle(choice))}
              disabled={submitting}
              testID="connect-addressing"
            />
            {touched && addressingMissing ? (
              <Text variant="error" role="alert" style={styles.addressingError}>
                Pick one before connecting.
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>

      <Hint>
        <Text variant="hint">
          Your secret is encrypted before it is stored and is decrypted only at request time,
          inside the gateway. It is never written to a log, a URL, or your bucket. Revoke the
          key at your provider whenever you like — Context loses access immediately and every
          file stays exactly where it is.
        </Text>
      </Hint>

      {failure ? (
        <FormError
          headline={failure.headline}
          next={[failure.next, failure.detail].filter(Boolean).join(" ")}
          style={styles.failure}
        />
      ) : null}

      <View style={styles.actions}>
        <Button
          label={submitting ? "Connecting…" : "Connect"}
          variant="white"
          disabled={submitting}
          onPress={() => void submit()}
          trailing={submitting ? <ActivityIndicator color={colors.ink} size="small" /> : null}
          testID="connect-submit"
        />
        {onCancel ? (
          <Button
            label="Cancel"
            variant="ghost"
            disabled={submitting}
            onPress={onCancel}
            testID="connect-cancel"
          />
        ) : null}
      </View>

      {submitting ? (
        <Text variant="rowSub" role="status" style={styles.progress}>
          Checking that we can list and write to your bucket…
        </Text>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  lede: { marginTop: 4, lineHeight: leading(12.5, 1.6) },
  section: { marginTop: 18 },
  fields: { marginTop: 18, gap: 16 },
  pair: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  pairItem: { flexGrow: 1, flexShrink: 1, flexBasis: 190, minWidth: 0 },
  addressingError: { marginTop: 8 },
  failure: { marginTop: 16 },
  actions: { marginTop: 18, flexDirection: "row", alignItems: "center", gap: 16 },
  progress: { marginTop: 12 },
});
