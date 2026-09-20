/**
 * A form on a shared note, filled in by somebody with no account.
 *
 * ## This is the only write on a share page, and it is a narrow one
 *
 * `shareReadOnly.test.ts` has said since the beginning that nothing on a share
 * page may write, and it was right: the page draws somebody else's note to
 * whoever holds a URL. Collect mode is the argued exception, not a loosening —
 * and what keeps it narrow is not this file's good manners:
 *
 *  - The only action reachable from here is `submitThroughLink`. There is no
 *    path argument on it, no text argument, and no way to name a destination:
 *    the link names the note, the note's own block names the answers file, and
 *    what lands there is rendered by the server from values checked against
 *    the block's declared fields.
 *  - What it writes is stamped with the **link**, never a name, so nothing it
 *    writes can be edited by anybody claiming to be its author.
 *  - It is refused unless a human check passed, the link is live, and the
 *    link has room.
 *
 * So the rule that file defends — "a page somebody arrived at on a link cannot
 * write arbitrary content anywhere in somebody's context" — is intact, and its
 * allow-list now names this one action with that reasoning written down.
 *
 * ## An answer is final, and the page says so before it is sent
 *
 * A stranger cannot read the responses file, and "you can only delete what you
 * can see" already decided the rest: there is no edit, no withdraw, no vote
 * and no receipt. That is stated above the button rather than discovered
 * afterwards.
 */

import { useCallback, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { Button } from "../design/components/Button";
import { Switch } from "../design/components/Switch";
import { Text } from "../design/components/Text";
import { ChoiceGroup, FormError, Notice, TextField } from "../design/components/Input";
import { useThemedStyles, type Colors } from "../design/theme";
import { HUMAN_CHECK_AVAILABLE, HumanCheck } from "./HumanCheck";
import {
  blankAnswers,
  fieldLabel,
  refusalText,
  sendable,
  type CollectField,
  type CollectForm,
} from "./collectForm";
import type { ShortLinkAddress } from "./share";

/** How the link this page was opened at is addressed on the wire. */
export type CollectAddress =
  | { kind: "token"; token: string }
  | { kind: "short"; handle: string; slug: string };

export function collectAddress(
  token: string | null,
  shortLink: ShortLinkAddress | undefined,
): CollectAddress | null {
  if (shortLink !== undefined) {
    return { kind: "short", handle: shortLink.handle, slug: shortLink.slug };
  }
  return token === null ? null : { kind: "token", token };
}

type Phase = "filling" | "sending" | "sent";

export function ShareForm({
  form,
  address,
}: {
  form: CollectForm;
  address: CollectAddress;
}) {
  const styles = useThemedStyles(makeStyles);
  const submit = useAction(api.functions.collect.submitThroughLink);

  const [answers, setAnswers] = useState<Record<string, string>>(() => blankAnswers(form));
  const [challenge, setChallenge] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [phase, setPhase] = useState<Phase>("filling");
  const [error, setError] = useState<string | null>(null);

  const set = useCallback((name: string, value: string) => {
    setAnswers((current) => ({ ...current, [name]: value }));
    // Clearing on edit rather than on send: an error that stays on screen
    // while somebody fixes the field it named reads as a second failure.
    setError(null);
  }, []);

  const send = useCallback(async () => {
    /*
      Checked here only to save a round trip. `validateSubmission` is the same
      function the server runs, so a refusal it would give arrives without the
      network — and the server runs it again, on what actually arrives, which
      is the answer that decides.
    */
    const ready = sendable(form, answers);
    if (!ready.ok) {
      setError(ready.error);
      return;
    }
    if (challenge === null) {
      setError("Complete the check below, then send.");
      return;
    }

    setPhase("sending");
    setError(null);
    try {
      await submit({
        ...(address.kind === "token"
          ? { token: address.token }
          : { handle: address.handle, slug: address.slug }),
        formId: form.id,
        values: ready.values,
        challenge,
      });
      setPhase("sent");
    } catch (thrown: unknown) {
      const data = (thrown as { data?: { code?: string; message?: string } })?.data;
      setError(refusalText(data?.code ?? null, data?.message ?? ""));
      setPhase("filling");
      // The token is spent whether or not the answer landed, so the widget is
      // rebuilt before a second attempt. Without this, every retry fails on
      // the check rather than on whatever went wrong the first time.
      setChallenge(null);
      setResetKey((key) => key + 1);
    }
  }, [address, answers, challenge, form, submit]);

  if (phase === "sent") {
    return (
      <View style={styles.form} testID="share-form-sent">
        <Notice tone="ok">
          <Text variant="rowSub">
            Sent. Your answer has gone to whoever sent you this link — it cannot
            be changed or taken back from here.
          </Text>
        </Notice>
      </View>
    );
  }

  /*
    The check comes FIRST, before the fields are drawn.

    With no site key on this build there is no way to produce a token, and the
    server refuses every submission without one. Drawing the fields anyway
    would collect somebody's typing and then refuse it, which is the failure
    `turnstile.ts` describes from the other end.
  */
  if (!HUMAN_CHECK_AVAILABLE) {
    return (
      <View style={styles.form}>
        <HumanCheck onToken={setChallenge} resetKey={resetKey} />
      </View>
    );
  }

  return (
    <View style={styles.form} testID={`share-form-${form.id}`}>
      {form.fields.map((field) => (
        <FieldInput
          key={field.name}
          field={field}
          value={answers[field.name] ?? ""}
          disabled={phase === "sending"}
          onChange={(value) => set(field.name, value)}
        />
      ))}

      <HumanCheck onToken={setChallenge} resetKey={resetKey} />

      {error === null ? null : <FormError headline={error} />}

      <Text variant="meta" style={styles.final}>
        Your answer is final. You are not signed in, so there is no way to come
        back and change it, and you will not be able to read what anybody else
        sent.
      </Text>

      <Button
        label={phase === "sending" ? "Sending…" : "Send"}
        variant="accent"
        onPress={() => void send()}
        disabled={phase === "sending"}
        testID="share-form-send"
      />
    </View>
  );
}

/**
 * One declared field, as the control its type asks for.
 *
 * The mapping is the block's, not this file's judgement: `text` is the only
 * multiline type the grammar has, `select` is the only one with options, and
 * `checkbox` is the only one whose value is two words. A field type this does
 * not know falls back to a single line, which is what the grammar's `line`
 * already is — an unknown type cannot reach here today, and the fallback is
 * the one that cannot lose what somebody typed.
 */
function FieldInput({
  field,
  value,
  disabled,
  onChange,
}: {
  field: CollectField;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const label = useMemo(() => fieldLabel(field.name), [field.name]);
  const testID = `share-form-field-${field.name}`;

  if (field.type === "checkbox") {
    return (
      <View style={styles.row}>
        <Switch
          value={value === "yes"}
          onValueChange={(next) => onChange(next ? "yes" : "no")}
          label={label}
          disabled={disabled}
          testID={testID}
        />
        <Text variant="rowSub">{label}</Text>
      </View>
    );
  }

  if (field.type === "select") {
    const options = (field.options ?? []).map((option) => ({ value: option, label: option }));
    return (
      <ChoiceGroup
        label={label}
        options={options}
        value={value === "" ? null : value}
        onChange={onChange}
        disabled={disabled}
        testID={testID}
      />
    );
  }

  return (
    <TextField
      label={label}
      value={value}
      onChangeText={onChange}
      editable={!disabled}
      optional={!field.required}
      multiline={field.type === "text"}
      // `max` is a character cap on `line` and `text`, and a *value* bound on
      // `number` — so it is only a length limit for the first two. Passing it
      // on a number field would stop somebody typing 100000 into a field whose
      // maximum is 100000.
      {...(field.type === "number" || field.max === undefined
        ? {}
        : { maxLength: field.max })}
      {...(field.type === "number" ? { keyboardType: "numeric" as const } : {})}
      {...(field.type === "date" ? { placeholder: "YYYY-MM-DD" } : {})}
      testID={testID}
    />
  );
}

const makeStyles = (_colors: Colors) =>
  StyleSheet.create({
    form: { gap: 14, marginTop: 6 },
    row: { flexDirection: "row", alignItems: "center", gap: 10 },
    final: { marginTop: 2 },
  });
