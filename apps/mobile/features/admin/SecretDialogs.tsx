/**
 * The two dialogs of the Credentials tab: set (or replace) one, and delete one.
 *
 * Set used to be a three-field form permanently open above the list, so the
 * rare action came first and the hero-sized button sat on every visit. It is
 * now a dialog on a pointer and a sheet on a phone, opened from "Add
 * credential", from a Not-set row (name prefilled) or from Replace (no name
 * field — the same `setSecret`, without retyping a name that must match).
 *
 * Delete used to fire on the first press. It now asks, and for a name the
 * code knows it says what stops working until it is set again.
 *
 * ## What must not change here
 *
 *  - **The value is cleared on success and never rendered.** A form that keeps
 *    a credential in component state after the write is a credential sitting
 *    in a browser tab for as long as the tab is open. The dialog also unmounts
 *    on close, which drops it again — the explicit clear is the rule, the
 *    unmount is a second line.
 *  - **`messageFor`, never `String(error)`.** A raw error can carry a stack
 *    and, from a failed action, the arguments it was called with — which on
 *    this screen is a credential.
 */

import { useState, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { useAction, useMutation } from "convex/react";
import { api } from "@context/convex/_generated/api";
import {
  Button,
  Text,
  TextField,
  fonts,
  leading,
  radii,
  space,
  useThemedStyles,
  type Colors,
} from "../design";
import { pointerType, touchType } from "../design/tokens";
import { useCompact } from "./AdminKit";
import { KNOWN_SECRETS, type KnownSecret } from "./report";

/**
 * The message from a `ConvexError`, or a flat sentence.
 *
 * Never `String(error)`: see the header.
 */
export function messageFor(error: unknown): string {
  const data = (error as { data?: unknown })?.data;
  if (data !== null && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "That did not work. Check the name and try again.";
}

// -- the shell ------------------------------------------------------------

/**
 * A centred card pinned from the top on a pointer, a sheet from the bottom
 * edge on a phone — the share dialog's frame, for the same reasons: a centred
 * card moves every time a line is added, and the field being typed in jumps
 * with it.
 */
function DialogShell({
  title,
  sub,
  children,
  actions,
  onClose,
  alert = false,
  width = 480,
  testID,
}: {
  title: ReactNode;
  sub: ReactNode;
  children?: ReactNode;
  actions: ReactNode;
  onClose: () => void;
  alert?: boolean;
  width?: number;
  testID?: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const view = useWindowDimensions();
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose} visible>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable
          style={[
            styles.scrim,
            compact ? styles.scrimSheet : { paddingTop: Math.round(view.height * 0.12) },
          ]}
          accessibilityLabel="Close"
          onPress={onClose}
        >
          <Pressable
            role={alert ? "alertdialog" : "dialog"}
            aria-modal
            onPress={() => {}}
            style={[styles.card, { maxWidth: width }, compact && styles.sheet]}
            testID={testID}
          >
            {compact ? <View style={styles.handle} aria-hidden /> : null}
            <ScrollView
              style={{ maxHeight: Math.round(view.height * (compact ? 0.8 : 0.72)) }}
              contentContainerStyle={[styles.body, compact && styles.bodyCompact]}
              keyboardShouldPersistTaps="handled"
            >
              <Text
                role="heading"
                aria-level={2}
                style={[styles.title, compact && styles.titleCompact]}
              >
                {title}
              </Text>
              <View style={styles.sub}>{sub}</View>
              {children ? <View style={styles.fields}>{children}</View> : null}
              <View style={[styles.actions, compact && styles.actionsCompact]}>{actions}</View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** A credential name inside a sentence: mono, in the key colour. */
function Name({ children }: { children: string }) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  // A step below the title rather than inheriting it: mono runs wide, and at
  // the title's size a long name wraps where the sentence around it would not.
  return <Text style={[styles.name, compact ? styles.nameCompact : styles.nameWide]}>{children}</Text>;
}

// -- set / replace --------------------------------------------------------

export function SetSecretDialog({
  replacing,
  initialName,
  unset,
  onClose,
  onSaved,
}: {
  /** Replace an existing one: the name is fixed and not shown as a field. */
  replacing: boolean;
  initialName: string;
  /** Known names not yet set, offered as the name is typed. */
  unset: readonly KnownSecret[];
  onClose: () => void;
  onSaved: (result: { name: string; fingerprint: string }) => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const setSecret = useAction(api.functions.admin.setSecret);
  const [name, setName] = useState(initialName);
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typed = name.trim().toUpperCase();
  const suggestions =
    replacing || typed.length === 0
      ? []
      : unset.filter((known) => known.name.startsWith(typed) && known.name !== typed).slice(0, 3);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = await setSecret({
        name,
        value,
        description: description.length > 0 ? description : undefined,
      });
      // The value is cleared on success and never re-rendered — see the header.
      setValue("");
      setDescription("");
      setName("");
      onSaved(result);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  const disabled = busy || name.trim().length === 0 || value.length === 0;
  const primaryLabel = busy ? "Saving…" : replacing ? "Replace credential" : "Set credential";
  const buttonStyle = compact ? styles.actionCompact : undefined;
  const cancel = (
    <Button key="cancel" label="Cancel" variant="dialog" onPress={onClose} style={buttonStyle} />
  );
  const primary = (
    <Button
      key="save"
      label={primaryLabel}
      variant="dialogPrimary"
      disabled={disabled}
      onPress={save}
      style={buttonStyle}
      testID="admin-secret-save"
    />
  );

  return (
    <DialogShell
      title={
        replacing ? (
          <>
            Replace <Name>{initialName}</Name>
          </>
        ) : (
          "Set a credential"
        )
      }
      sub={<Text variant="paneSub">Written once. There is no way to read it back from here.</Text>}
      actions={compact ? [primary, cancel] : [cancel, primary]}
      onClose={onClose}
      testID="admin-secret-dialog"
    >
      {replacing ? null : (
        <View>
          <TextField
            label="Name"
            value={name}
            onChangeText={setName}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="SEARCH_D1_API_TOKEN"
            hint={
              suggestions.length > 0
                ? undefined
                : "Uppercase, digits and underscore — the name the code reads."
            }
            style={styles.mono}
            testID="admin-secret-name"
          />
          {suggestions.length > 0 ? (
            <View style={styles.suggest}>
              {suggestions.map((known, index) => (
                <Pressable
                  key={known.name}
                  role="button"
                  accessibilityLabel={`Use ${known.name}`}
                  onPress={() => setName(known.name)}
                  style={[styles.suggestRow, index > 0 && styles.suggestRuled]}
                  testID={`admin-secret-suggest-${known.name}`}
                >
                  <Text style={styles.suggestName}>{known.name}</Text>
                  <Text variant="meta" style={styles.warn}>
                    not set
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      )}
      <TextField
        label="Value"
        value={value}
        onChangeText={setValue}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus={replacing || initialName.length > 0}
        style={styles.mono}
        testID="admin-secret-value"
      />
      <TextField
        label="What it is for"
        value={description}
        onChangeText={setDescription}
        optional
        autoCapitalize="sentences"
        placeholder="e.g. D1:Edit token, customer-data account"
        testID="admin-secret-description"
      />
      {error ? (
        <Text variant="error" role="alert" testID="admin-secret-error">
          {error}
        </Text>
      ) : null}
    </DialogShell>
  );
}

// -- delete ---------------------------------------------------------------

export function DeleteSecretDialog({
  name,
  onClose,
  onDeleted,
}: {
  name: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const compact = useCompact();
  const deleteSecret = useMutation(api.functions.admin.deleteSecret);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const known = KNOWN_SECRETS.find((entry) => entry.name === name);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await deleteSecret({ name });
      onDeleted();
    } catch (caught) {
      setError(messageFor(caught));
      setBusy(false);
    }
  }

  const buttonStyle = compact ? styles.actionCompact : undefined;
  const cancel = (
    <Button key="cancel" label="Cancel" variant="dialog" onPress={onClose} style={buttonStyle} />
  );
  const destroy = (
    <Button
      key="delete"
      label={busy ? "Deleting…" : "Delete credential"}
      variant="dialogDanger"
      disabled={busy}
      onPress={confirm}
      style={buttonStyle}
      testID="admin-secret-confirm-delete"
    />
  );

  return (
    <DialogShell
      alert
      width={420}
      title={
        <>
          Delete <Name>{name}</Name>?
        </>
      }
      sub={
        <>
          <Text variant="check" style={[styles.consequence, compact && styles.consequenceCompact]}>
            The value is gone for good — it cannot be shown or recovered.
            {known ? (
              <>
                {" "}Until it is set again:{" "}
                <Text
                  variant="check"
                  style={[styles.warn, compact && styles.consequenceCompact]}
                >
                  {lowerFirst(known.unsetMeans).replace(/\.$/, "")}
                </Text>
                .
              </>
            ) : null}
          </Text>
          {error ? (
            <Text variant="error" role="alert" style={styles.deleteError} testID="admin-secret-delete-error">
              {error}
            </Text>
          ) : null}
        </>
      }
      actions={compact ? [destroy, cancel] : [cancel, destroy]}
      onClose={onClose}
      testID="admin-secret-delete-dialog"
    />
  );
}

function lowerFirst(sentence: string): string {
  return sentence.length === 0 ? sentence : sentence[0].toLowerCase() + sentence.slice(1);
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    fill: { flex: 1 },
    scrim: {
      flex: 1,
      backgroundColor: colors.scrim,
      alignItems: "center",
      justifyContent: "flex-start",
      paddingHorizontal: space.x4,
    },
    scrimSheet: { justifyContent: "flex-end", paddingTop: 0, paddingHorizontal: 0 },
    card: {
      width: "100%",
      borderRadius: radii.console,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
      boxShadow: "0 30px 70px -24px rgba(26,23,20,.40)",
    },
    sheet: {
      maxWidth: undefined,
      borderRadius: 0,
      borderTopLeftRadius: radii.sheet,
      borderTopRightRadius: radii.sheet,
      borderWidth: 0,
      paddingTop: space.x3,
    },
    handle: {
      width: 36,
      height: 5,
      alignSelf: "center",
      borderRadius: radii.pill,
      backgroundColor: colors.lineStrong,
    },
    body: { padding: space.x6 },
    bodyCompact: { paddingHorizontal: space.x4, paddingTop: 14, paddingBottom: 34 },
    title: {
      fontSize: pointerType.h3,
      lineHeight: leading(pointerType.h3, 1.35),
      fontWeight: "600",
      letterSpacing: -0.4,
      color: colors.text,
    },
    titleCompact: { fontSize: touchType.h3, lineHeight: leading(touchType.h3, 1.35) },
    sub: { marginTop: space.x1 },
    fields: { gap: space.x4, marginTop: space.x5 },
    actions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: space.x2,
      marginTop: space.x6,
    },
    actionsCompact: { flexDirection: "column", alignItems: "stretch", gap: space.x3 },
    actionCompact: { alignSelf: "stretch", paddingVertical: 13, borderRadius: 14 },
    name: {
      fontFamily: fonts.mono,
      fontWeight: "500",
      color: colors.codeKey,
    },
    nameWide: { fontSize: pointerType.body },
    nameCompact: { fontSize: touchType.lede },
    mono: { fontFamily: fonts.mono },
    suggest: {
      marginTop: space.x1,
      borderRadius: radii.card,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surface,
      overflow: "hidden",
    },
    suggestRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      gap: space.x3,
      paddingVertical: space.x2,
      paddingHorizontal: space.x3,
    },
    suggestRuled: { borderTopWidth: 1, borderTopColor: colors.line },
    suggestName: { fontFamily: fonts.mono, fontSize: pointerType.meta, color: colors.codeKey },
    warn: { color: colors.warnText },
    consequence: { marginTop: space.x1, color: colors.text2 },
    consequenceCompact: { fontSize: pointerType.lede, lineHeight: leading(pointerType.lede, 1.55) },
    deleteError: { marginTop: space.x3 },
  });
