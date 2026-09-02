import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { ChoiceGroup, FormError, Notice, TextField } from "../../design/components/Input";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { leading } from "../../design/tokens";
import { useColors, useThemedStyles, type Colors } from "../../design/theme";
import {
  ASSIGNABLE_ROLES,
  describeMembersFailure,
  describeRole,
  type AssignableRole,
} from "../../console/members/members";
import { describeInviteDraftRejection, peopleCaveat, peopleLede } from "../create";
import type { CreateWorkspaceController } from "../useCreateWorkspace";

/**
 * Step 4 — the people. The step that makes this a workspace rather than a
 * second brain.
 *
 * ## Why the invitations are queued rather than sent one at a time
 *
 * `inviteMember` is rate limited per account, and a box that fires on every
 * press is the shape most likely to meet that limit and least likely to say
 * which of five people it got to. A list you can edit before committing is also
 * simply the right shape for "invite the team": it is four colleagues and a
 * typo, and the typo is easier to fix before it is a live invitation than
 * after.
 *
 * ## What this screen must never do
 *
 * **Say whether the person exists.** Nothing here may and nothing here can: an
 * invitation is addressed to a *string*, resolved to an account only when
 * somebody accepts, precisely so that inviting `@lk` and inviting
 * `@does-not-exist` are indistinguishable. Anybody with an account has an
 * invite box, and a box that answered would be a name-enumeration endpoint. So
 * the only refusals below are about the *shape* of what was typed, which is a
 * fact about the string and could not have been about who exists.
 *
 * **Imply anybody has access yet.** An invitation is an offer. Until it is
 * answered the workspace has one member, and this screen says "outstanding",
 * never "invited" and never a headcount.
 */
export function WorkspacePeopleStep({
  controller,
}: {
  controller: CreateWorkspaceController;
}) {
  const colors = useColors();
  const styles = useThemedStyles(makeStyles);
  const { queued, sending, sendResult, draftRejection } = controller;
  const caveat = peopleCaveat(controller.shape);
  const slug = controller.created?.slug ?? "this workspace";

  return (
    <View>
      <Text variant="rowSub" style={styles.lede}>
        {peopleLede(slug)}
      </Text>

      {caveat ? (
        <Notice tone="warn" style={styles.caveat}>
          <Text variant="check" role="status" style={styles.warnText}>
            {caveat}
          </Text>
        </Notice>
      ) : null}

      <TextField
        label="Who"
        value={controller.inviteDraft}
        onChangeText={controller.setInviteDraft}
        placeholder="@lk or lk@example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        editable={!sending}
        onSubmitEditing={controller.addInvite}
        error={draftRejection ? describeInviteDraftRejection(draftRejection) : undefined}
        hint="A @name if they already use Context, an email address if they do not."
        testID="workspace-invite-draft"
        containerStyle={styles.field}
      />

      <ChoiceGroup<AssignableRole>
        label="As"
        options={ASSIGNABLE_ROLES.map((role) => ({
          value: role.value,
          label: role.label,
          detail: role.detail,
        }))}
        value={controller.draftRole}
        onChange={controller.setDraftRole}
        disabled={sending}
        style={styles.roles}
        testID="workspace-invite-role"
      />

      <View style={styles.addRow}>
        <Button
          label="Add to the list"
          disabled={sending}
          onPress={controller.addInvite}
          testID="workspace-invite-add"
        />
        <Text variant="foot" style={styles.addNote}>
          Nothing is sent until you press Send below. Owners are not assignable here — handing a
          workspace over is a separate, deliberate act.
        </Text>
      </View>

      {queued.length > 0 ? (
        <Card style={styles.list}>
          {queued.map((invite, index) => (
            <Row key={`${invite.invitee}-${index}`}>
              <Grow>
                <Text variant="rowTitle">{invite.invitee}</Text>
                <Text variant="rowSub">{describeRole(invite.role)}</Text>
              </Grow>
              <Pill>{invite.role}</Pill>
              <Button
                label="Remove"
                accessibilityLabel={`Remove ${invite.invitee} from the list`}
                variant="ghost"
                disabled={sending}
                onPress={() => controller.dropInvite(index)}
                testID={`workspace-invite-remove-${index}`}
              />
            </Row>
          ))}
        </Card>
      ) : null}

      {/*
        A partial send. The successes are already real invitations — re-sending
        one supersedes a live row — so they are reported and dropped from the
        queue, and only what failed is still in the list above.
      */}
      {sendResult !== null && sendResult.failed.length > 0 ? (
        <FormError
          headline={
            sendResult.sent.length > 0
              ? `${sendResult.sent.length} sent; ${sendResult.failed.length} did not.`
              : "None of those could be sent."
          }
          next={describeMembersFailure(sendResult.failed[0]!.error).headline}
          style={styles.failure}
        />
      ) : null}

      <View style={styles.actions}>
        <Button
          label={
            sending
              ? "Sending…"
              : queued.length === 0
                ? "Continue"
                : queued.length === 1
                  ? "Send 1 invitation"
                  : `Send ${queued.length} invitations`
          }
          variant="white"
          disabled={sending}
          onPress={() => void controller.sendInvites()}
          trailing={sending ? <ActivityIndicator color={colors.ink} size="small" /> : null}
          testID="workspace-invite-send"
        />
        {queued.length > 0 ? (
          <Button
            label="Skip for now"
            variant="ghost"
            disabled={sending}
            onPress={controller.skipInvites}
            testID="workspace-invite-skip"
          />
        ) : null}
      </View>

      <Text variant="foot" style={styles.disclosure}>
        Context never says whether a @name or an address belongs to a real account — that would
        let anybody use this box to find out who is on the platform. An unanswered invitation is
        the same silence either way.
      </Text>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  lede: { marginBottom: 18, lineHeight: leading(12.5, 1.7) },
  caveat: { marginBottom: 16 },
  warnText: { color: colors.warnText },
  field: { marginBottom: 16 },
  roles: { marginBottom: 16 },
  addRow: { flexDirection: "row", alignItems: "center", gap: 14, flexWrap: "wrap" },
  addNote: { flex: 1, minWidth: 200 },
  list: { marginTop: 16, gap: 10 },
  failure: { marginTop: 16 },
  actions: { marginTop: 20, flexDirection: "row", alignItems: "center", gap: 14 },
  disclosure: { marginTop: 18, lineHeight: leading(12.5, 1.7) },
});
