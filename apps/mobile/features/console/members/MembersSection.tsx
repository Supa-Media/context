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
  ownerChoices,
  type AssignableRole,
  type OwnerChoice,
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
 */
export function MembersSection({
  view,
  shareBackWith,
}: {
  view: MembersView;
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
  const styles = useThemedStyles(makeStyles);
  const { actions } = view;
  const now = Date.now();
  const [inviting, setInviting] = useState(false);

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
        <Text variant="noteTitle">
          People
        </Text>
        {actions !== undefined ? (
          <Button
            label={inviting ? "Close" : "+ Invite"}
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
  // Making a co-owner and handing the workspace over each ask once too, with
  // what they give said beside the Confirm (`ownerHint`); the server then asks
  // for the owner's email code.
  const coOwner = useArming(() => run(() => actions!.setOwnerRole(member.userId, "owner")));
  const handOver = useArming(() => run(() => actions!.handOver(member.userId)));
  const choices = ownerChoices(member, actions);
  const coOwnerRow = member.role === "owner";

  // The owner's row never carries a menu: the owner cannot be removed or
  // demoted, so a menu there would only ever refuse. A co-owner's row carries
  // one only for the owner, and for the co-owner themself (to step down).
  const manageable = actions !== undefined && (coOwnerRow ? choices.length > 0 : true);
  const label = roleLabel(member.role, member.isOwner === true);
  const armed = [removal, coOwner, handOver].find((arming) => arming.stage === "armed");

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
            {detail ?? describeRole(member.role === "owner" && member.isOwner !== true ? "co-owner" : member.role)}
          </Text>
        </Grow>
        {manageable ? (
          <PickMenu<RowChoice>
            label={label}
            accessibilityLabel={`${memberLabel(member)}: ${label}. Change`}
            options={rowOptions(member, choices)}
            selected={coOwnerRow ? null : member.role === "editor" || member.role === "member" ? member.role : null}
            disabled={busy}
            onPick={(key) => {
              if (key === "remove") return removal.press();
              if (key === "co-owner") return coOwner.press();
              if (key === "hand-over") return handOver.press();
              // Stepping a co-owner down, or a co-owner stepping themself down, goes through the owner-role path.
              if (key === "step-down") return void run(() => actions!.setOwnerRole(member.userId, "editor"));
              if (coOwnerRow) return void run(() => actions!.setOwnerRole(member.userId, key));
              if (key !== member.role) void run(() => actions!.setRole(member.userId, key));
            }}
            testID={`member-role-${member.userId}`}
          />
        ) : (
          <Text variant="rowSub" style={styles.roleWord}>
            {label}
          </Text>
        )}
      </View>
      {armed !== undefined ? (
        <Hint>
          {armed === handOver ? (
            <Text variant="hint" style={styles.oneWay}>
              {`${memberLabel(member)} becomes the owner and you become a co-owner. Only ${memberLabel(member)} can hand it back or step you down.`}
            </Text>
          ) : (
            <Text variant="hint">
              {armed === coOwner
                ? `${memberLabel(member)} will see every private note and run the workspace with you. Only you can delete it, hand it over, change its storage or card, or add co-owners. You can step them down any time.`
                : `Removing ${memberLabel(member)} cuts off every AI client they have connected to this workspace, immediately.`}
            </Text>
          )}
          {/* Under the words rather than in the row, so a long name keeps its width on a phone. */}
          <View style={styles.confirmRow}>
            <Button
              label="Confirm"
              variant={armed === coOwner ? "dialogPrimary" : "danger"}
              disabled={busy}
              accessibilityLabel={`Confirm: ${armedWhat(armed === removal ? "remove" : armed === coOwner ? "co-owner" : "hand-over", memberLabel(member))}`}
              testID={`member-${armed === removal ? "remove" : armed === coOwner ? "co-owner" : "hand-over"}-${member.userId}`}
              onPress={armed.press}
            />
          </View>
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
            {`${invitedLine(invitation.role)} · ${expiryLabel(invitation.expiresAt, now)}`}
          </Text>
        </Grow>
        {actions !== undefined ? (
          <Button
            label={busy ? "Cancelling…" : "Cancel invite"}
            variant="mini"
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

type RowChoice = AssignableRole | "remove" | OwnerChoice;

/**
 * A row's menu. An editor's or member's: Can edit, Can view, Co-owner… for the
 * owner, and Remove. A co-owner's, for the owner: Make the owner…, then Can edit
 * and Can view (stepping them down); for the co-owner themself: Step down.
 */
function rowOptions(member: ConsoleMember, choices: OwnerChoice[]): { key: RowChoice; label: string; danger?: boolean }[] {
  if (member.role === "owner") {
    if (choices.includes("hand-over")) {
      return [
        { key: "hand-over", label: "Make the owner…", danger: true },
        { key: "editor", label: roleLabel("editor") },
        { key: "member", label: roleLabel("member") },
      ];
    }
    return choices.includes("step-down") ? [{ key: "step-down", label: "Step down to Can edit" }] : [];
  }
  return [
    { key: "editor", label: roleLabel("editor") },
    { key: "member", label: roleLabel("member") },
    ...(choices.includes("co-owner") ? [{ key: "co-owner" as const, label: "Co-owner…" }] : []),
    { key: "remove", label: "Remove from workspace", danger: true },
  ];
}

function armedWhat(kind: "remove" | "co-owner" | "hand-over", name: string): string {
  if (kind === "co-owner") return `make ${name} a co-owner`;
  if (kind === "hand-over") return `make ${name} the owner`;
  return `remove ${name}`;
}

/**
 * "Owner", "Co-owner", "Can edit", "Can view": the artboard's words for the
 * roles. Both owners hold the `owner` role; `isOwner` tells the owner apart.
 */
export function roleLabel(role: string, isOwner = true): string {
  switch (role) {
    case "owner":
      return isOwner ? "Owner" : "Co-owner";
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
        label="@name, email or phone"
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
  // A step nobody can take back: bold red, inline (`docs/decisions/app-and-console`).
  oneWay: { color: colors.crit, fontWeight: "700" },
  confirmRow: { flexDirection: "row", marginTop: 8 },
});
