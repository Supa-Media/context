import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Button } from "../../../design/components/Button";
import { Card, Grow, Row } from "../../../design/components/Card";
import { Hint } from "../../../design/components/Field";
import { FormError, TextField } from "../../../design/components/Input";
import { Pill } from "../../../design/components/Pill";
import { Text } from "../../../design/components/Text";
import { useThemedStyles, type Colors } from "../../../design/theme";
import { useArming } from "../../useArming";
import {
  addableMembers,
  canSubmitLabel,
  danglingNote,
  groupRuleToken,
  groupSummary,
  memberLabel,
  type ConsoleGroup,
  type ConsoleGroupMember,
  type GroupActions,
  type GroupsView,
} from "../../groups/groups";
import type { ConsoleMember } from "../../members/members";

/**
 * The named sets of people a folder rule can point at.
 *
 * **Nobody should have to come here first.** A group is what you get when you
 * have handed the same two people the same folder three times; this page is
 * where you rename one, or drop somebody from every folder at once. Sharing a
 * single note with a single person needs none of it — that is the share
 * dialog, and a group is the thing that stops it being six presses next time.
 *
 * ## What this page must say out loud
 *
 * **A name here grants nothing on its own.** The control plane intersects a
 * group's names with live workspace membership, so somebody who has left
 * reaches nothing — `live: false` on the row. That is the intersection
 * working, not a fault, and the copy says so: hiding the name would leave an
 * owner believing the group is smaller than their `privacy.md` says, and
 * alarming about it would send them hunting for a breach that is not there.
 *
 * **The prefix is not yours to type.** `@supa-` is the workspace's own slug,
 * derived by `buildGroupName` from the workspace rather than accepted from the
 * form, because group names share one global namespace with every username and
 * workspace slug. The field shows the prefix, greyed, and takes the label —
 * which is the interface telling the truth about where the name comes from.
 *
 * Every control comes from `view.actions`, **absent** as a whole object for
 * anybody who is not an owner and in the demo: `listGroups` and every mutation
 * beside it are owner-only on the backend, for the reason the note census is.
 */
export function GroupsPanel({
  view,
  members,
  slug,
}: {
  view: GroupsView;
  /** This context's people, for the add control. */
  members: readonly ConsoleMember[];
  /** The workspace's own slug, shown as the fixed half of a new name. */
  slug: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { actions } = view;

  // A query that came back as an error is neither an empty list nor a
  // permanent "Loading…" — the same guard `SharedLinksPanel` makes.
  if (view.failure) {
    return (
      <View testID="groups-failure">
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
            <Text variant="rowTitle">Groups</Text>
          </Grow>
          <Pill tone="neutral">{`${view.groups.length}`}</Pill>
        </Row>

        <Row divided>
          <Grow>
            <Text variant="rowSub">
              A group is a name you can put on a folder. The name goes in privacy.md so it
              travels with your notes; the people stay here, so removing somebody from this
              workspace closes every folder at once.
            </Text>
          </Grow>
        </Row>

        {view.groups.length === 0 ? (
          <Row divided>
            <Grow>
              <Text variant="rowSub">
                {view.loading
                  ? "Loading…"
                  : "No groups yet. Make one when you find yourself naming the same people twice."}
              </Text>
            </Grow>
          </Row>
        ) : null}

        {view.groups.map((group) => (
          <GroupRow key={group.groupId} group={group} members={members} actions={actions} />
        ))}
      </Card>

      {actions === undefined ? (
        <Text variant="foot" style={styles.readOnly}>
          Only an owner of this context can see or change its groups.
        </Text>
      ) : (
        <NewGroup slug={slug} actions={actions} />
      )}
    </View>
  );
}

function GroupRow({
  group,
  members,
  actions,
}: {
  group: ConsoleGroup;
  members: readonly ConsoleMember[];
  actions?: GroupActions;
}) {
  const styles = useThemedStyles(makeStyles);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Two presses, and the second expires — the arming `MembersSection`'s Remove
   * and `SharedLinksPanel`'s Revoke both use. Deleting a group does not
   * rewrite anybody's manifest, but a folder rule naming it stops resolving to
   * people the moment it goes, which is exactly the kind of change a mis-tap
   * must not make.
   */
  const removal = useArming(() => run(() => actions!.remove(group.groupId)));
  const note = danglingNote(group);
  const addable = addableMembers(group, members);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Row divided>
      <Grow>
        <Text variant="rowTitle" style={styles.name}>
          {groupRuleToken(group)}
        </Text>
        <Text variant="rowSub">{groupSummary(group)}</Text>

        <View style={styles.chips}>
          {group.members.map((member) => (
            <MemberChip
              key={member.userId}
              member={member}
              onRemove={
                actions === undefined
                  ? undefined
                  : () => run(() => actions.removeMember(group.groupId, member.userId))
              }
            />
          ))}
        </View>

        {note === null ? null : (
          <Text variant="foot" style={styles.note}>
            {note}
          </Text>
        )}

        {actions === undefined || addable.length === 0 ? null : (
          <View style={styles.chips}>
            {addable.map((member) => (
              <Button
                key={member.userId}
                label={`Add ${member.name ?? member.email ?? member.userId}`}
                variant="ghost"
                disabled={busy}
                onPress={() => run(() => actions.addMember(group.groupId, member.userId))}
                testID={`group-add-${member.userId}`}
              />
            ))}
          </View>
        )}

        {failure === null ? null : <FormError headline={failure} />}
      </Grow>

      {actions === undefined ? null : (
        <Button
          label={removal.stage === "armed" ? "Press again to delete" : "Delete"}
          variant={removal.stage === "armed" ? "danger" : "ghost"}
          disabled={busy}
          onPress={removal.press}
          testID={`group-delete-${group.groupId}`}
        />
      )}
    </Row>
  );
}

function MemberChip({
  member,
  onRemove,
}: {
  member: ConsoleGroupMember;
  onRemove?: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={[styles.chip, member.live ? null : styles.chipDead]}>
      <Text
        variant="meta"
        style={member.live ? styles.chipText : styles.chipDeadText}
        accessibilityLabel={
          member.live
            ? memberLabel(member)
            : `${memberLabel(member)}, no longer a member of this workspace`
        }
      >
        {memberLabel(member)}
      </Text>
      {onRemove === undefined ? null : (
        <Button label="×" variant="ghost" onPress={onRemove} testID={`group-drop-${member.userId}`} />
      )}
    </View>
  );
}

/**
 * The prefix is shown and cannot be edited.
 *
 * `@supa-` is this workspace's own slug, and `buildGroupName` derives it
 * server-side rather than trusting the form. Showing it greyed beside the
 * field is the honest version of that: it tells somebody where the name comes
 * from before they wonder why they cannot type it, and it is what stops the
 * question "can I call this @leads?" being answered by a refusal.
 */
function NewGroup({ slug, actions }: { slug: string; actions: GroupActions }) {
  const styles = useThemedStyles(makeStyles);
  const [label, setLabel] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setFailure(null);
    try {
      await actions.create(label);
      setLabel("");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.new}>
      <Row>
        <Text variant="rowSub" style={styles.prefix}>{`@${slug}-`}</Text>
        <Grow>
          <TextField
            label="New group"
            value={label}
            onChangeText={setLabel}
            placeholder="leads"
            autoCapitalize="none"
            autoCorrect={false}
            testID="group-new-label"
          />
        </Grow>
        <Button
          label="Create"
          variant="white"
          disabled={busy || !canSubmitLabel(label)}
          onPress={submit}
          testID="group-create"
        />
      </Row>
      <Hint>
        The <Text variant="meta">{`@${slug}-`}</Text> is this workspace's own name and cannot be
        edited. Group names share one list with every username, so the prefix is what keeps
        yours yours.
      </Hint>
      {failure === null ? null : <FormError headline={failure} />}
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  head: { alignItems: "center" },
  name: { fontFamily: "JetBrainsMono_400Regular" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    backgroundColor: colors.sharedWash,
    borderColor: colors.sharedText,
  },
  chipText: { color: colors.sharedText },
  /* Dashed and muted: it is a name that reaches nobody, not a fault. */
  chipDead: {
    backgroundColor: "transparent",
    borderStyle: "dashed",
    borderColor: colors.lineStrong,
  },
  chipDeadText: { color: colors.muted, textDecorationLine: "line-through" },
  note: { marginTop: 8 },
  new: { marginTop: 12, gap: 8 },
  prefix: { fontFamily: "JetBrainsMono_400Regular", color: colors.muted },
  readOnly: { marginTop: 12 },
});
