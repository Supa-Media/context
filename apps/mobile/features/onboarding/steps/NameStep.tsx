import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Field } from "../../design/components/Field";
import { FormError, TextField } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { colors, leading } from "../../design/tokens";
import {
  isPreviewable,
  nameConsequences,
  nameFeedback,
  rejectionFeedback,
  NAME_MAX_LENGTH,
} from "../name";
import type { OnboardingController } from "../useOnboarding";

/**
 * Step 1 — the name.
 *
 * The single thing this screen has to get across is that **the name is the
 * context**, not a label on it. People arrive expecting to pick a username and
 * then, separately, to make a folder somewhere; here those are the same act.
 * So the three things it becomes are shown live, updating as they type, rather
 * than described in a paragraph nobody reads.
 *
 * The second thing is that it is permanent. There is no release, rename, or
 * reclaim path in the control plane (issue #10), so this says so plainly and up
 * front. Finding that out later, from a support reply, is the outcome this
 * sentence exists to prevent.
 *
 * ## Two rules about what is shown back
 *
 * **A refused claim is a state of the field, not a panel below it.** The server
 * re-checks the name inside `createWorkspace`'s transaction and can refuse for
 * any of the reasons the live check can — reserved, malformed, genuinely taken.
 * So the failure goes back under the field with that reason's own sentence, and
 * the `FormError` panel is kept for the failures that are not about the name.
 *
 * **The consequences panel only renders a name that could be theirs.** It shows
 * a live note path and a live capture address, and rendering those for a name
 * the field is currently rejecting put `seyi olujide@context.lc` on screen
 * beside an error saying that is not a valid name.
 */
export function NameStep({ controller }: { controller: OnboardingController }) {
  const { name, setName, nameStatus: status, claiming, claimFailure } = controller;
  const rejection = claimFailure?.nameRejection;
  const feedback =
    rejection === undefined
      ? nameFeedback(status)
      : rejectionFeedback(rejection, status.kind === "empty" ? name : status.normalized);
  const shown = nameConsequences(isPreviewable(status) ? status.normalized : "");

  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        Pick the name for your personal context. It is the context — not a label on one — so
        this is the name your notes live under, the name other people reach you by, and the
        address you forward mail to.
      </Text>

      <TextField
        label="Your name"
        value={name}
        onChangeText={setName}
        placeholder="yourname"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username"
        maxLength={NAME_MAX_LENGTH}
        editable={!claiming}
        onSubmitEditing={() => {
          if (controller.canClaim) void controller.claim();
        }}
        hint="Lowercase letters, numbers and hyphens."
        testID="welcome-name"
        containerStyle={styles.field}
      />

      {feedback ? (
        <Text
          variant={feedback.tone === "crit" ? "error" : "rowSub"}
          role={feedback.tone === "crit" ? "alert" : "status"}
          style={[styles.feedback, feedback.tone === "ok" ? styles.feedbackOk : undefined]}
          testID="welcome-name-feedback"
        >
          {feedback.message}
        </Text>
      ) : null}

      <View style={styles.consequences}>
        {/*
          Sentence case, not the design system's uppercase eyebrow. Every
          `Field` below already carries one, and two uppercase lines stacked a
          few pixels apart read as one doubled label rather than as a lead-in
          and its list.
        */}
        <Text variant="rowSub" style={styles.consequencesHead}>
          Which makes it:
        </Text>
        <View style={styles.fields}>
          <Field label="Your brain" value={shown.context} />
          <Field label="How others address a note in it" value={shown.path} />
          <Field label="Your capture address" value={shown.mailbox} />
        </View>
      </View>

      <Text variant="foot" style={styles.permanent}>
        One personal context per person, and the name cannot be changed once it is claimed —
        there is no rename yet. It is the path your notes are addressed by and a live mailbox,
        so pick one you will still want in a year.
      </Text>

      {/*
        Only the failures that are not about the name itself. A refused name is
        already back under the field, in the feedback line, where the fix is.
      */}
      {claimFailure !== null && rejection === undefined ? (
        <FormError
          headline={claimFailure.headline}
          next={claimFailure.next}
          style={styles.failure}
        />
      ) : null}

      <View style={styles.actions}>
        <Button
          label={
            claiming
              ? "Claiming…"
              : status.kind === "available"
                ? `Claim @${status.normalized}`
                : "Claim your name"
          }
          variant="white"
          disabled={!controller.canClaim}
          onPress={() => void controller.claim()}
          trailing={claiming ? <ActivityIndicator color={colors.ink} size="small" /> : null}
          testID="welcome-name-submit"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  lede: { marginBottom: 20, lineHeight: leading(12.5, 1.7) },
  field: { marginBottom: 0 },
  feedback: { marginTop: 8 },
  feedbackOk: { color: colors.okText },
  consequences: { marginTop: 22 },
  consequencesHead: { marginBottom: 12 },
  fields: { gap: 11 },
  permanent: { marginTop: 20, lineHeight: leading(12.5, 1.7) },
  failure: { marginTop: 16 },
  actions: { marginTop: 20, flexDirection: "row", alignItems: "center", gap: 14 },
});
