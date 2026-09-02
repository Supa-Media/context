import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Field } from "../../design/components/Field";
import { FormError, TextField } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { leading } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import {
  isPreviewable,
  nameFeedback,
  rejectionFeedback,
  NAME_MAX_LENGTH,
} from "../../onboarding/name";
import {
  WORKSPACE_DISPLAY_NAME_MAX,
  workspaceNameConsequences,
} from "../create";
import type { CreateWorkspaceController } from "../useCreateWorkspace";

/**
 * Step 1 — what the workspace is called, and what it is addressed by.
 *
 * ## Two fields, where onboarding has one
 *
 * Onboarding asks for a name and uses it as the display name too, because a
 * person's handle and a person's label are usually the same word. An
 * organisation's are not: "Acme Engineering" is what it is called and
 * `acme-eng` is what fits in `@acme-eng/1-projects/note.md`. Forcing one field
 * gets you either a handle nobody can read or a label nobody can type.
 *
 * The handle follows the label until it is touched, and then it stops — see
 * `slugSuggestion`. A field that keeps overwriting what somebody typed is how a
 * permanent name gets claimed that nobody chose.
 *
 * ## Two consequences, not three
 *
 * The onboarding version of this panel shows a capture address. A shared
 * context does not have one — mail lands in a personal context and nowhere else
 * — so showing one here would promise a mailbox that will never receive
 * anything. `workspaceNameConsequences` returns two entries for that reason,
 * and the missing third is called out below the panel rather than left as a
 * silence somebody discovers by emailing it.
 */
export function WorkspaceNameStep({
  controller,
  onCancel,
}: {
  controller: CreateWorkspaceController;
  onCancel: () => void;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const { displayName, slug, nameStatus: status, creating, createFailure } = controller;
  const rejection = createFailure?.nameRejection;
  const feedback =
    rejection === undefined
      ? nameFeedback(status)
      : rejectionFeedback(rejection, status.kind === "empty" ? slug : status.normalized);
  const shown = workspaceNameConsequences(isPreviewable(status) ? status.normalized : "");

  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        A workspace is a context several people share — one bucket, one access map, one audit
        trail, and a member list you control. Give it a name people will recognise and a handle
        they can type.
      </Text>

      <TextField
        label="What it is called"
        value={displayName}
        onChangeText={controller.setDisplayName}
        placeholder="Acme Engineering"
        maxLength={WORKSPACE_DISPLAY_NAME_MAX}
        editable={!creating}
        hint="Shown in the rail and on invitations. You can change this later."
        testID="workspace-display-name"
        containerStyle={styles.field}
      />

      <TextField
        label="Its handle"
        value={slug}
        onChangeText={controller.setSlug}
        placeholder="acme-eng"
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={NAME_MAX_LENGTH}
        editable={!creating}
        onSubmitEditing={() => {
          if (controller.canCreate) void controller.create();
        }}
        hint={
          controller.slugAuto
            ? "Lowercase letters, numbers and hyphens. Following the name above until you edit it."
            : "Lowercase letters, numbers and hyphens."
        }
        testID="workspace-slug"
        containerStyle={styles.field}
      />

      {feedback ? (
        <Text
          variant={feedback.tone === "crit" ? "error" : "rowSub"}
          role={feedback.tone === "crit" ? "alert" : "status"}
          style={[styles.feedback, feedback.tone === "ok" ? styles.feedbackOk : undefined]}
          testID="workspace-slug-feedback"
        >
          {feedback.message}
        </Text>
      ) : null}

      <View style={styles.consequences}>
        <Text variant="rowSub" style={styles.consequencesHead}>
          Which makes it:
        </Text>
        <View style={styles.fields}>
          <Field label="The workspace" value={shown.context} />
          <Field label="How a note in it is addressed" value={shown.path} />
        </View>
      </View>

      <Text variant="foot" style={styles.permanent}>
        Handles are one namespace with people's names, so `@acme-eng` is taken from the same
        pool as `@seyi` — and, like a person's, it cannot be renamed or released once claimed.
        A workspace has no capture address: mail is forwarded into a personal brain, never into
        a shared one.
      </Text>

      {createFailure !== null && rejection === undefined ? (
        <FormError
          headline={createFailure.headline}
          next={createFailure.next}
          style={styles.failure}
        />
      ) : null}

      <View style={styles.actions}>
        <Button
          label={
            creating
              ? "Creating…"
              : status.kind === "available"
                ? `Create @${status.normalized}`
                : "Create the workspace"
          }
          variant="white"
          disabled={!controller.canCreate}
          onPress={() => void controller.create()}
          trailing={creating ? <ActivityIndicator color={colors.ink} size="small" /> : null}
          testID="workspace-name-submit"
        />
        <Button
          label="Cancel"
          variant="ghost"
          disabled={creating}
          onPress={onCancel}
          testID="workspace-name-cancel"
        />
      </View>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  lede: { marginBottom: 20, lineHeight: leading(12.5, 1.7) },
  field: { marginBottom: 16 },
  feedback: { marginTop: 8 },
  feedbackOk: { color: colors.okText },
  consequences: { marginTop: 14 },
  consequencesHead: { marginBottom: 12 },
  fields: { gap: 11 },
  permanent: { marginTop: 20, lineHeight: leading(12.5, 1.7) },
  failure: { marginTop: 16 },
  actions: { marginTop: 20, flexDirection: "row", alignItems: "center", gap: 14 },
});
