import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { Hint } from "../../design/components/Field";
import { ChoiceGroup, FormError, TextField } from "../../design/components/Input";
import { Text } from "../../design/components/Text";
import { useThemedStyles, type Colors } from "../../design/theme";
import {
  ASSIGNABLE_ROLES,
  describeMembersFailure,
  describeRole,
  expiryLabel,
  memberDetail,
  inviteOutcomeMessage,
  memberLabel,
  type AssignableRole,
  type ConsoleInvitation,
  type ConsoleMember,
  type MemberActions,
  type MembersFailure,
  type MembersView,
} from "./members";
import { useArming } from "../useArming";
import { FaceView } from "../faces/PersonFace";
import { useFace } from "../faces/useFace";
import { PickMenu } from "../settings/panels/PickMenu";
import { memberReachSentence, tierExplanation } from "../visibility";

/**
 * Who can reach this context, and the controls to change it.
 *
 * **Self-contained on purpose.** It takes one prop and imports nothing from
 * Convex, from Expo Router, or from the console shell, so it can be dropped into
 * a settings pane, a context view, or anywhere else the navigation ends up
 * without a rewrite. `useMembers` is what binds it to the backend.
 *
 * Every control here comes from `view.actions`, which is **absent** — the whole
 * object — for anyone who is not the owner of this context, and in the demo
 * console. `inviteMember`, `removeMember`, `setMemberRole` and
 * `revokeInvitation` are all owner-only on the backend, so rendering them for an
 * editor would be offering a button whose only possible outcome is a permission
 * error. A control that is never offered cannot mislead; a disabled one that an
 * editor could reasonably expect to work does.
 *
 * The invitations card lists what is **pending** and nothing else, because that
 * is all `listInvitations` returns: a declined invitation, a withdrawn one and
 * an expired one are the same absence, deliberately, so that answering "no"
 * never tells the person who sent it that you exist.
 *
 * `viewerRole` is the second prop, and it stays a plain string for the same
 * reason the first one is a plain view model: it is the caller's role in the
 * selected context, read straight off `ConsoleContext.role`, so this section
 * still imports nothing from Convex, Expo Router, or the shell. It is passed in
 * rather than dug out of `view.members` — the row a member holds and the role
 * the context list reports come from the same membership, and reading it from
 * two places is how they get to disagree.
 */
export function MembersSection({
  view,
  viewerRole,
  shareBackWith,
  showReachRule = true,
}: {
  view: MembersView;
  /** The caller's role in this context. Absent until the context list lands. */
  viewerRole?: string;
  /**
   * Handles of people who shared a context with *you* and are not already in
   * this one — offered as one-tap invitees.
   *
   * Optional and empty-by-default so the demo console and any future mounting
   * of this card get the plain invite box rather than a suggestion list built
   * from nothing. See `shareBackSuggestions` in `members.ts`.
   */
  shareBackWith?: readonly string[];
  /**
   * Whether to print the owner's paragraph about what having members hands
   * over. On by default, and off in exactly one place: Sharing & Access, where
   * the Privacy block two blocks below states the same rule in the words that
   * section is held to.
   *
   * `PrivacyPanel`'s own docstring made this call the other way round when the
   * two were separate screens — it dropped `memberReachSentence` from *its*
   * copy and left the paragraph here, "one point, two voices, one screen
   * apart". They are not a screen apart any more, so the same rule now points
   * the other way: the block whose whole subject is who can read what keeps
   * the sentence, and the member list stops repeating it in retired
   * vocabulary.
   */
  showReachRule?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  const { actions } = view;
  const now = Date.now();
  const [inviting, setInviting] = useState(false);
  /*
    The owner's half of the tier: what inviting these people did and did not
    hand over. `null` for everybody else, because it describes a decision only
    the owner made — a member reading "anything you marked private is yours
    alone" on somebody else's context would be reading a claim about the wrong
    person's notes.
  */
  const reach = showReachRule ? memberReachSentence(viewerRole) : null;
  /*
    And the reader's half, which had nowhere to be drawn.

    A member or an editor sees one line about this on every screen of the
    context — "Team access — notes marked private are not shown here." That line
    is deliberately only the *state*: the argument behind it is a paragraph, and
    a paragraph reprinted over every note is one nobody finishes reading.
    `tierExplanation` says exactly that in its own docstring, and named a
    surface to keep it on; until now nothing rendered it, so the reasoning was
    written down and unreachable.

    This card, because this is the card that answers "who can read this" — the
    owner's half of the same fact is one row down, and the two halves living on
    different screens is how the console came to state one of them and not the
    other. Never both at once: one is `owner` only, the other is everybody else.
  */
  const filtered = tierExplanation(viewerRole);

  // A query that came back as an error is neither an empty context nor a
  // permanent "Loading…", which is how both halves of this card would otherwise
  // read. It only reaches here at all because `useMembers` subscribes with
  // `useQueries`; a `useQuery` threw it past every layout in the app.
  /*
    Truthiness rather than `!== null`: the type says `ConsoleFailure | null`,
    and a view assembled without the field at all — which is what a fixture
    that only cares about storage produces — is `undefined`, which is not
    `null` and would take this branch to read `.headline` off nothing. Both
    absences mean the same thing here, and this component now has more than
    one caller.
  */
  if (view.failure) {
    return (
      <View testID="members-failure">
        <FormError
          headline={view.failure.headline}
          next={[view.failure.next, view.failure.detail].filter(Boolean).join(" ")}
        />
      </View>
    );
  }

  return (
    <View>
      {/*
        The settings artboard (2026-09-29): "People" as the block's heading,
        with the one action an owner comes here for beside it, and the list
        under it — people first, then who is still invited.
      */}
      <View style={styles.headRow}>
        <Text variant="rowTitle" style={styles.heading}>
          People
        </Text>
        {actions !== undefined ? (
          <Button
            label={inviting ? "Close" : "Invite someone"}
            variant={inviting ? "mini" : "accent"}
            accessibilityLabel={inviting ? "Close the invite form" : "Invite someone to this workspace"}
            onPress={() => setInviting((open) => !open)}
            testID="members-invite-open"
          />
        ) : null}
      </View>

      {actions !== undefined && inviting ? (
        <InviteForm invite={actions.invite} shareBackWith={shareBackWith ?? []} />
      ) : null}

      <Card style={styles.list}>
        {view.members.length === 0 ? (
          <Row>
            <Grow>
              <Text variant="rowSub">
                {view.loading ? "Loading…" : "Nobody has access to this workspace yet."}
              </Text>
            </Grow>
          </Row>
        ) : null}

        {view.members.map((member, index) => (
          <MemberRow
            key={member.userId}
            member={member}
            actions={actions}
            first={index === 0}
            // Each row above the next, so an open role menu is drawn over the
            // rows below it rather than under them.
            layer={view.members.length - index}
          />
        ))}

        {/*
          Sent invitations sit in the same list, under the people who already
          have access (settings cleanup, 2026-09-29). They were a card of their
          own titled "Invitations", which on an owner's screen stood beside the
          account-level "Invitations" row about invitations *to* them: one word
          for two different lists.
        */}
        {view.invitations.map((invitation) => (
          <InvitationRow
            key={invitation.invitationId}
            invitation={invitation}
            now={now}
            actions={actions}
          />
        ))}

        {reach !== null ? (
          <Hint>
            <Text variant="hint" testID="members-tier-rule">
              {reach}
            </Text>
          </Hint>
        ) : null}

        {filtered !== null ? (
          <Hint>
            <Text variant="hint" testID="members-tier-filtered">
              {filtered}
            </Text>
          </Hint>
        ) : null}
      </Card>

      {actions === undefined && view.readOnlyReason !== undefined ? (
        <Text variant="foot" style={styles.readOnly}>
          {view.readOnlyReason}
        </Text>
      ) : null}
    </View>
  );
}

function MemberRow({
  member,
  actions,
  first,
  layer,
}: {
  member: ConsoleMember;
  actions?: MemberActions;
  first: boolean;
  layer: number;
}) {
  const styles = useThemedStyles(makeStyles);
  const [failure, setFailure] = useState<MembersFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const face = useFace(member.name ?? member.email ?? null);
  /**
   * Removing somebody is not undoable and takes their AI clients with it, so it
   * asks once: Remove in the role menu arms, and a Confirm button beside the
   * menu does it. The arming expires — `useArming`, not a bare flag — so a
   * press minutes later near the same row removes nobody.
   */
  const removal = useArming(() => run(() => actions!.remove(member.userId)));

  // The owner's row never carries a menu: an owner cannot be removed and
  // cannot be demoted, so a menu there would only ever refuse.
  const manageable = actions !== undefined && member.role !== "owner";

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(describeMembersFailure(error));
    } finally {
      setBusy(false);
    }
  }

  const detail = memberDetail(member);

  return (
    <View style={[styles.rowWrap, first ? null : styles.divided, { zIndex: layer }]}>
      <View style={styles.row}>
        <FaceView face={face} name={member.name ?? member.email ?? null} size={30} />
        <Grow>
          <Text variant="rowTitle">
            {member.isMe ? `${memberLabel(member)} · you` : memberLabel(member)}
          </Text>
          <Text variant="rowSub" style={styles.rowSub}>
            {detail ?? describeRole(member.role)}
          </Text>
        </Grow>
        {removal.stage === "armed" ? (
          <Button
            label="Confirm"
            variant="danger"
            disabled={busy}
            accessibilityLabel={`Confirm removing ${memberLabel(member)}`}
            testID={`member-remove-${member.userId}`}
            onPress={removal.press}
          />
        ) : null}
        {manageable ? (
          <PickMenu<AssignableRole | "remove">
            label={roleLabel(member.role)}
            accessibilityLabel={`${memberLabel(member)}: ${roleLabel(member.role)}. Change`}
            options={[
              { key: "editor", label: roleLabel("editor") },
              { key: "member", label: roleLabel("member") },
              { key: "remove", label: "Remove from workspace", danger: true },
            ]}
            selected={member.role === "editor" || member.role === "member" ? member.role : null}
            disabled={busy}
            onPick={(key) => {
              if (key === "remove") {
                removal.press();
                return;
              }
              if (key !== member.role) void run(() => actions!.setRole(member.userId, key));
            }}
            testID={`member-role-${member.userId}`}
          />
        ) : (
          <Text variant="rowSub" style={styles.roleWord}>
            {roleLabel(member.role)}
          </Text>
        )}
      </View>
      {removal.stage === "armed" ? (
        <Hint>
          <Text variant="hint">
            {`Removing ${memberLabel(member)} cuts off every AI client they have connected to this workspace, immediately.`}
          </Text>
        </Hint>
      ) : null}
      {failure !== null ? (
        <FormError headline={failure.headline} next={failure.next} style={styles.rowError} />
      ) : null}
    </View>
  );
}

function InvitationRow({
  invitation,
  now,
  actions,
}: {
  invitation: ConsoleInvitation;
  now: number;
  actions?: MemberActions;
}) {
  const styles = useThemedStyles(makeStyles);
  const [failure, setFailure] = useState<MembersFailure | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <View style={[styles.rowWrap, styles.divided]}>
      <View style={styles.row}>
        {/* A dashed ring where a face will be: somebody who has not joined yet. */}
        <View style={styles.pending} aria-hidden />
        <Grow>
          <Text variant="rowTitle">{invitation.invitee}</Text>
          <Text variant="rowSub" style={[styles.rowSub, styles.waiting]}>
            {`${invitedLine(invitation.role)} · waiting · ${expiryLabel(invitation.expiresAt, now)}`}
          </Text>
        </Grow>
        {actions !== undefined ? (
          <Button
            label={busy ? "Cancelling…" : "Cancel invite"}
            variant="ghost"
            disabled={busy}
            accessibilityLabel={`Cancel the invitation to ${invitation.invitee}`}
            testID={`invitation-withdraw-${invitation.invitationId}`}
            onPress={() => {
              setBusy(true);
              setFailure(null);
              void actions
                .withdraw(invitation.invitationId)
                .catch((error: unknown) => setFailure(describeMembersFailure(error)))
                .finally(() => setBusy(false));
            }}
          />
        ) : null}
      </View>
      {failure !== null ? (
        <FormError headline={failure.headline} next={failure.next} style={styles.rowError} />
      ) : null}
    </View>
  );
}

/** "Owner", "Can edit", "Can view": the artboard's words for the three roles. */
export function roleLabel(role: string): string {
  switch (role) {
    case "owner":
      return "Owner";
    case "editor":
      return "Can edit";
    case "member":
      return "Can view";
    default:
      return role;
  }
}

/** "Invited to edit" / "Invited to view", from the role the invitation carries. */
export function invitedLine(role: string): string {
  if (role === "editor") return "Invited to edit";
  if (role === "member") return "Invited to view";
  return `Invited as ${role}`;
}

/**
 * The invite box.
 *
 * It says the same thing whatever happens, because the backend does: inviting a
 * name nobody holds, an address with no account behind it, and a colleague who
 * turned you down last week are one outcome with one message. Reporting "sent"
 * for one and "no such person" for another would turn this field into a
 * name-enumeration endpoint for the whole platform — which is exactly what
 * `functions/invitations.ts` is shaped to prevent, and the interface must not
 * hand it back.
 */
function InviteForm({
  invite,
  shareBackWith,
}: {
  invite: (invitee: string, role: AssignableRole) => Promise<void>;
  shareBackWith: readonly string[];
}) {
  const styles = useThemedStyles(makeStyles);
  const [invitee, setInvitee] = useState("");
  const [role, setRole] = useState<AssignableRole>("member");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<MembersFailure | null>(null);
  const [sent, setSent] = useState<{ headline: string; detail: string } | null>(null);

  async function send() {
    setBusy(true);
    setFailure(null);
    setSent(null);
    try {
      await invite(invitee, role);
      setInvitee("");
      setSent(inviteOutcomeMessage(invitee));
    } catch (error) {
      setFailure(describeMembersFailure(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={styles.spaced} testID="members-invite-form">

      {/*
        The people who shared with you first. Reciprocity is the highest-
        converting invitation there is and it needs no address book — somebody
        who arrived through an invitation already knows exactly one person who
        is here. These fill the field rather than sending, because who they can
        write is still a choice and sending on one tap would make it silently.
      */}
      {shareBackWith.length > 0 ? (
        <View style={styles.shareBack} testID="invite-share-back">
          <Text variant="foot">Shared their context with you:</Text>
          <View style={styles.shareBackRow}>
            {shareBackWith.map((handle) => (
              <Button
                key={handle}
                label={`@${handle}`}
                variant="mini"
                disabled={busy}
                accessibilityLabel={`Invite @${handle} to this context`}
                testID={`invite-share-back-${handle}`}
                onPress={() => {
                  setInvitee(`@${handle}`);
                  setSent(null);
                }}
              />
            ))}
          </View>
        </View>
      ) : null}

      <TextField
        label="@name or email"
        value={invitee}
        onChangeText={(text) => {
          setInvitee(text);
          setSent(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="@lk"
        testID="invite-invitee"
        error={failure?.headline}
      />

      <ChoiceGroup<AssignableRole>
        label="They can"
        options={ASSIGNABLE_ROLES}
        value={role}
        onChange={setRole}
        disabled={busy}
        testID="invite-role"
        style={styles.roles}
      />

      <Button
        label={busy ? "Sending…" : "Send invitation"}
        variant="accent"
        disabled={busy || invitee.trim().length === 0}
        accessibilityLabel="Send the invitation"
        testID="invite-send"
        style={styles.send}
        onPress={() => {
          void send();
        }}
      />

      {failure !== null && failure.next !== undefined ? (
        <Hint>
          <Text variant="hint">{failure.next}</Text>
        </Hint>
      ) : null}

      {sent !== null ? (
        <Hint>
          <Text variant="hint">
            <Text variant="hint" style={styles.hintStrong}>
              {sent.headline}
            </Text>{" "}
            {sent.detail}
          </Text>
        </Hint>
      ) : null}
    </Card>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  headRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 10,
  },
  heading: { fontSize: 17 },
  spaced: { marginBottom: 11 },
  list: { paddingVertical: 0 },
  rowWrap: { paddingVertical: 10 },
  divided: { borderTopWidth: 1, borderTopColor: colors.line },
  row: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
  roleWord: { color: colors.text2 },
  pending: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.muted,
  },
  waiting: { color: colors.warnText },
  rowSub: { marginTop: 2 },
  rowError: { marginTop: 8 },
  shareBack: { gap: 8, marginBottom: 4 },
  shareBackRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  roles: { marginTop: 13 },
  send: { marginTop: 13, alignSelf: "flex-start" },
  readOnly: { marginTop: 13 },
  hintStrong: { color: colors.hintStrong, fontWeight: "600" },
});
