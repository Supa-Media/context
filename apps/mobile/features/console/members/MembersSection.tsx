import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../design/components/Button";
import { Card, Grow, Row } from "../../design/components/Card";
import { Dot } from "../../design/components/Dot";
import { Hint } from "../../design/components/Field";
import { ChoiceGroup, FormError, TextField } from "../../design/components/Input";
import { Pill } from "../../design/components/Pill";
import { Text } from "../../design/components/Text";
import { colors } from "../../design/tokens";
import {
  ASSIGNABLE_ROLES,
  describeMembersFailure,
  describeRole,
  expiryLabel,
  memberDetail,
  memberLabel,
  oppositeRole,
  type AssignableRole,
  type ConsoleInvitation,
  type ConsoleMember,
  type MemberActions,
  type MembersFailure,
  type MembersView,
} from "./members";
import { memberReachSentence } from "../visibility";

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
}) {
  const { actions } = view;
  const now = Date.now();
  /*
    The owner's half of the tier: what inviting these people did and did not
    hand over. `null` for everybody else, because it describes a decision only
    the owner made — a member reading "anything you marked private is yours
    alone" on somebody else's context would be reading a claim about the wrong
    person's notes. Their half is the chip in Browse and Settings.
  */
  const reach = memberReachSentence(viewerRole);

  // A query that came back as an error is neither an empty context nor a
  // permanent "Loading…", which is how both halves of this card would otherwise
  // read. It only reaches here at all because `useMembers` subscribes with
  // `useQueries`; a `useQuery` threw it past every layout in the app.
  if (view.failure !== null) {
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
      <Card>
        <Row style={styles.head}>
          <Grow>
            <Text variant="rowTitle">People</Text>
          </Grow>
          <Pill tone="neutral">
            {`${view.members.length} with access`}
          </Pill>
        </Row>

        {view.members.length === 0 ? (
          <Row divided>
            <Grow>
              <Text variant="rowSub">
                {view.loading ? "Loading…" : "Nobody has access to this context yet."}
              </Text>
            </Grow>
          </Row>
        ) : null}

        {view.members.map((member) => (
          <MemberRow key={member.userId} member={member} actions={actions} />
        ))}

        {reach !== null ? (
          <Hint>
            <Text variant="hint" testID="members-tier-rule">
              {reach}
            </Text>
          </Hint>
        ) : null}
      </Card>

      <Card style={styles.spaced}>
        <Row style={styles.head}>
          <Grow>
            <Text variant="rowTitle">Invitations</Text>
          </Grow>
          <Pill tone={view.invitations.length > 0 ? "warn" : "neutral"}>
            {`${view.invitations.length} pending`}
          </Pill>
        </Row>

        {view.invitations.length === 0 ? (
          <Row divided>
            <Grow>
              <Text variant="rowSub">
                {view.loading ? "Loading…" : "Nobody is waiting on an invitation."}
              </Text>
            </Grow>
          </Row>
        ) : null}

        {view.invitations.map((invitation) => (
          <InvitationRow
            key={invitation.invitationId}
            invitation={invitation}
            now={now}
            actions={actions}
          />
        ))}
      </Card>

      {actions !== undefined ? (
        <InviteForm invite={actions.invite} shareBackWith={shareBackWith ?? []} />
      ) : view.readOnlyReason !== undefined ? (
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
}: {
  member: ConsoleMember;
  actions?: MemberActions;
}) {
  const [failure, setFailure] = useState<MembersFailure | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Removing somebody is not undoable and takes their AI clients with it, so it
   * asks once. Two taps rather than a modal: the section has to survive being
   * mounted anywhere, and a dialog would drag a layer of the app in with it.
   */
  const [confirming, setConfirming] = useState(false);

  const swap = oppositeRole(member.role);
  // The owner's row never carries controls: an owner cannot be removed and
  // cannot be demoted, so a disabled pair of buttons there would be two
  // affordances that can only ever refuse.
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
      setConfirming(false);
    }
  }

  const detail = memberDetail(member);

  return (
    <View>
      <Row divided style={styles.wrapRow}>
        <Dot tone={member.role === "owner" ? "ok" : "neutral"} />
        <Grow>
          <Text variant="rowTitle">
            {member.isMe ? `${memberLabel(member)} · you` : memberLabel(member)}
          </Text>
          <Text variant="rowSub" style={styles.rowSub}>
            {detail ?? describeRole(member.role)}
          </Text>
        </Grow>
        <Pill tone="neutral">{member.role}</Pill>
        {manageable && swap !== null ? (
          <Button
            label={`Make ${swap}`}
            variant="mini"
            disabled={busy}
            accessibilityLabel={`Change ${memberLabel(member)} to ${swap}`}
            testID={`member-role-${member.userId}`}
            onPress={() => {
              void run(() => actions!.setRole(member.userId, swap));
            }}
          />
        ) : null}
        {manageable ? (
          <Button
            label={confirming ? "Confirm" : "Remove"}
            variant="danger"
            disabled={busy}
            accessibilityLabel={
              confirming
                ? `Confirm removing ${memberLabel(member)}`
                : `Remove ${memberLabel(member)}`
            }
            testID={`member-remove-${member.userId}`}
            onPress={() => {
              if (!confirming) {
                setConfirming(true);
                return;
              }
              void run(() => actions!.remove(member.userId));
            }}
          />
        ) : null}
      </Row>
      {confirming ? (
        <Hint>
          <Text variant="hint">
            {`Removing ${memberLabel(member)} cuts off every AI client they have connected to this context, immediately.`}
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
  const [failure, setFailure] = useState<MembersFailure | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <View>
      <Row divided style={styles.wrapRow}>
        <Dot tone="warn" />
        <Grow>
          <Text variant="rowTitle">{invitation.invitee}</Text>
          <Text variant="rowSub" style={styles.rowSub}>
            {`Invited as ${invitation.role} · ${expiryLabel(invitation.expiresAt, now)}`}
          </Text>
        </Grow>
        {actions !== undefined ? (
          <Button
            label="Withdraw"
            variant="danger"
            disabled={busy}
            accessibilityLabel={`Withdraw the invitation to ${invitation.invitee}`}
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
      </Row>
      {failure !== null ? (
        <FormError headline={failure.headline} next={failure.next} style={styles.rowError} />
      ) : null}
    </View>
  );
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
  const [invitee, setInvitee] = useState("");
  const [role, setRole] = useState<AssignableRole>("member");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<MembersFailure | null>(null);
  const [sent, setSent] = useState(false);

  async function send() {
    setBusy(true);
    setFailure(null);
    setSent(false);
    try {
      await invite(invitee, role);
      setInvitee("");
      setSent(true);
    } catch (error) {
      setFailure(describeMembersFailure(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={styles.spaced}>
      <Text variant="eyebrow" style={styles.eyebrow}>
        Invite somebody
      </Text>

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
                  setSent(false);
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
          setSent(false);
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
        variant="white"
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

      {sent ? (
        <Hint>
          <Text variant="hint">
            <Text variant="hint" style={styles.hintStrong}>
              Invitation sent.
            </Text>{" "}
            It appears above until they answer it, and expires in a week. Context
            never says whether a @name or an address belongs to a real account —
            that would let anybody use this box to find out who is on the
            platform.
          </Text>
        </Hint>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { marginBottom: 13 },
  spaced: { marginTop: 11 },
  eyebrow: { marginBottom: 10 },
  rowSub: { marginTop: 2 },
  rowError: { marginTop: 8 },
  wrapRow: { flexWrap: "wrap" },
  shareBack: { gap: 8, marginBottom: 4 },
  shareBackRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  roles: { marginTop: 13 },
  send: { marginTop: 13, alignSelf: "flex-start" },
  readOnly: { marginTop: 13 },
  hintStrong: { color: colors.hintStrong, fontWeight: "600" },
});
